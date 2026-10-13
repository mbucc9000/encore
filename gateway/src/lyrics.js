'use strict';
// Synced lyrics (gateway 0.8, app 0.8; DESIGN-LYRICS.md §1) from LRCLIB (https://lrclib.net): a free public lyrics
// database with LRC time-synced lines. No account, no key, nothing touches the Spotify account. The phone sends what it
// already knows about the song (uri, name, first artist, album, duration); the answer is kept per track in memory and on
// disk (found / plain / instrumental: 60 days, nothing found: 3 days, errors: never).
// Lyrics are copyrighted text that is only ever shown on the user's phone: never log lyric text (nor LRCLIB's bodies: a
// JSON parse error quotes them).
const path = require('path');
const log = require('./log');
const { t } = require('./i18n');
const { JsonCache } = require('./jsoncache');
const { memo } = require('./catalog');

// Timings and limits (tests shrink them).
const TIMING = {
  foundTtl: 60 * 86400000,   // synced / plain / instrumental
  noneTtl: 3 * 86400000,     // nothing found
  freshGap: 60000,           // fresh=1 refetches a cached "none" at most this often per track
  timeoutMs: 8000,           // each LRCLIB request
  maxFlights: 2,             // LRCLIB requests in flight gateway-wide (the rest wait in a small queue)
  phoneRecent: 600000,       // a new song's lyrics are prefetched while a phone was seen this recently
};

const LRCLIB = 'https://lrclib.net/api';
const UA = `Encore/${require('./config').version}`;          // LRCLIB asks clients to name themselves
const SRC = 'LRCLIB';
const TRACK_URI = /^spotify:track:[0-9A-Za-z]{22}$/;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
// A prefetch whose song is no longer playing gives up its place in the queue (not an error: nothing is logged).
const SKIPPED = Object.assign(new Error('a newer song is playing'), { code: 'skipped' });

// ------------------------------------------------------------------ names and LRC
// clean(n): the version suffixes Spotify adds to a name, for the search step ("Song - Remastered 2011" is "Song" on
// LRCLIB). Case-insensitive; the rest of the name stays as it is.
const SUFFIXES = [
  / - (?:\d{4} )?Remaster(?:ed)?(?: \d{4})?(?: Version)?$/i,       // - Remastered 2011, - 2011 Remaster
  / \((?:\d{4} )?Remaster(?:ed)?(?: \d{4})?(?: Version)?\)$/i,     // (Remastered 2020), (2015 Remaster)
  / - Single Version$/i,
  / - Radio Edit$/i,
  / - Mono(?: Version)?$/i,
  / - Live\b.*$/i,                                                 // - Live, - Live at Wembley Stadium / 1986
];
function cleanName(n) {
  let s = String(n || '').trim();
  let prev;
  do {
    prev = s;
    for (const re of SUFFIXES) {
      const t = s.replace(re, '').trim();
      if (t) s = t;                                                // never down to nothing
    }
  } while (s !== prev);
  return s;
}

// LRC: each line may carry one or more leading stamps [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] (one line per stamp);
// tag lines ([ar:], [ti:], [al:], [by:], [length:] ...) and unstamped text are dropped; [offset:±ms] shifts every stamp
// (a positive offset makes lines appear sooner: t - offset), clamped at 0. -> [{ t, l }] sorted by t (stable); l may be
// "" (an instrumental gap). Word stamps (<mm:ss.xx>, enhanced LRC) are taken out of the text.
const STAMP = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const OFFSET = /^\[offset:\s*([+-]?\d+)\s*\]/i;
const WORD_STAMP = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const rowsOf = (text) => String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/);

function parseLrc(text) {
  const rows = rowsOf(text).map((r) => r.trim());
  let offset = 0;
  for (const r of rows) { const m = r.match(OFFSET); if (m) offset = Number(m[1]); }
  const out = [];
  for (const r of rows) {
    let rest = r;
    const ts = [];
    let m;
    while ((m = rest.match(STAMP))) {
      ts.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + (m[3] ? Math.round(Number('0.' + m[3]) * 1000) : 0));
      rest = rest.slice(m[0].length).trimStart();
    }
    if (!ts.length) continue;
    const l = rest.replace(WORD_STAMP, '').trim();
    for (const t of ts) out.push({ t: Math.max(0, t - offset), l });
  }
  return out.sort((p, q) => p.t - q.t);
}

// Plain lyrics: one entry per line, empty lines kept as "" (but not before the first line or after the last).
function plainLines(text) {
  const rows = rowsOf(text).map((r) => r.trim());
  while (rows.length && !rows[0]) rows.shift();
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows.map((l) => ({ l }));
}

// An LRCLIB record -> the phone's answer, or null when it holds nothing to show (not a hit). A synced text without a
// single stamped line of text falls back to the plain lyrics.
function answer(u, x) {
  if (!x || typeof x !== 'object') return null;
  if (x.instrumental === true) return { u, inst: 1 };
  const synced = typeof x.syncedLyrics === 'string' ? parseLrc(x.syncedLyrics) : [];
  if (synced.some((r) => r.l)) return { u, s: 1, lines: synced, src: SRC };
  const plain = typeof x.plainLyrics === 'string' ? plainLines(x.plainLyrics) : [];
  if (plain.length) return { u, s: 0, lines: plain, src: SRC };
  return null;
}

// The search step's choice: when the duration is known only records within 3 s of it (none left: nothing found), then
// synced ones first, then the closest duration, then LRCLIB's order.
function pick(list, s) {
  const cands = [];
  list.forEach((x, i) => {
    if (!x || typeof x !== 'object') return;
    const dd = s.d != null ? Math.abs(Number(x.duration) - s.d / 1000) : 0;
    if (!(dd <= 3)) return;                                        // NaN (no duration) fails too
    const body = answer(s.u, x);
    if (body) cands.push({ body, dd, i });
  });
  cands.sort((p, q) => (q.body.s === 1) - (p.body.s === 1) || p.dd - q.dd || p.i - q.i);
  return cands.length ? cands[0].body : null;
}

class Lyrics {
  constructor({ cfg, engine, player, fetchImpl, timing }) {
    this.player = player || {};
    this.T = { ...TIMING, ...timing };
    this.fetch = fetchImpl || ((url, o) => fetch(url, o));
    this.store = new JsonCache(path.join(cfg.cacheDir, 'lyrics'), { l: { mem: 50, keep: 2000 } });   // key: the track id
    this.flights = new Map();      // track id -> { job: { uri, pri }, p }
    this.freshAt = new Map();      // track id -> its last fresh=1 refetch of a cached "none"
    this.waiting = [];             // LRCLIB requests waiting for a slot: { job, resolve, reject }
    this.busy = 0;                 // LRCLIB requests in flight
    this.nowUri = null;            // the engine's current song: a prefetch for another one gives up
    this.calls = 0;
    this.lastError = null;
    if (engine) engine.on('event', (type, d) => this.onEngine(type, d));
  }

  // The song to ask for (u, n and a required; al and d optional, dropped when they don't fit), or null.
  song(x) {
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const u = typeof x.u === 'string' ? x.u : '';
    const n = str(x.n);
    const a = str(x.a);
    if (!TRACK_URI.test(u) || !n || n.length > 300 || !a || a.length > 300) return null;
    const al = str(x.al);
    const d = x.d == null || x.d === '' ? NaN : Number(x.d);
    return { u, n, a, al: al.length <= 300 ? al : '', d: Number.isInteger(d) && d > 0 ? d : null };
  }

  // ------------------------------------------------------------------ the route
  // GET /v1/lyrics (q: the URL's searchParams) -> a catalog memo (sendCatalog: ETag, 304)
  async get(q, fresh) {
    const s = this.song({ u: q.get('u'), n: q.get('n'), a: q.get('a'), al: q.get('al'), d: q.get('d') });
    if (!s) throw fail(400, 'bad_request', t('en', 'Lyrics need the song\'s uri, name and artist.'));
    return memo(await this.lookup(s, fresh, true));
  }

  // -> the answer body: the stored one while it is current, else LRCLIB's (one flight per track: callers join). pri: a
  // phone is waiting (its LRCLIB requests go first, and a prefetch it joins becomes one). When LRCLIB fails, an expired
  // copy is the answer; with nothing stored it is a 502.
  async lookup(s, fresh, pri) {
    const id = s.u.slice(14);
    let f = this.flights.get(id);
    let c = null;
    if (!f) {
      c = (await this.store.get('l', id)) || this.store.peek('l', id);      // (peek: a put that landed during the read)
      if (c && (typeof c.at !== 'number' || !c.body || typeof c.body !== 'object')) c = null;     // a damaged file
      if (c && !this.expired(id, c, fresh)) return c.body;
      f = this.flights.get(id);                                     // one may have started while the disk was read
    }
    if (!f) {
      const job = { uri: s.u, pri };
      const n = { job };
      n.p = this.find(s, job)
        .then((body) => { this.store.put('l', id, { at: Date.now(), body }); return body; })
        .finally(() => { if (this.flights.get(id) === n) this.flights.delete(id); });
      this.flights.set(id, n);
      f = n;
    } else if (pri) f.job.pri = true;
    try {
      return await f.p;
    } catch (e) {
      if (e === SKIPPED && pri) return this.lookup(s, fresh, pri);   // joined a prefetch just as it gave up
      if (e === SKIPPED) throw e;
      const old = c || (await this.store.get('l', id));
      if (old && old.body && typeof old.body === 'object') return old.body;
      throw Object.assign(fail(502, 'lyrics_unavailable', t('en', 'Lyrics aren\'t available right now.')), { cause: e });
    }
  }

  // A stored answer is refetched once it is past its lifetime, or for fresh=1 when it is a "none" (at most once a minute
  // per track: a "none" found less than a minute ago is just as fresh).
  expired(id, c, fresh) {
    const now = Date.now();
    if (now - c.at >= (c.body.none ? this.T.noneTtl : this.T.foundTtl)) return true;
    if (!fresh || !c.body.none) return false;
    if (now - Math.max(c.at, this.freshAt.get(id) || 0) < this.T.freshGap) return false;
    this.freshAt.set(id, now);
    if (this.freshAt.size > 200) for (const [k, t] of this.freshAt) if (now - t >= this.T.freshGap) this.freshAt.delete(k);
    return true;
  }

  // ------------------------------------------------------------------ LRCLIB
  // Matching, in order, stopping at the first hit: /api/get with the album and duration (when known), /api/get without
  // the album, /api/search with the cleaned name (pick). Nothing: { u, none: 1 }. An LRCLIB failure throws (not cached).
  async find(s, job) {
    const base = { track_name: s.n, artist_name: s.a };
    const dur = s.d != null ? { duration: Math.round(s.d / 1000) } : {};
    let body = answer(s.u, await this.call(job, 'get', { ...base, ...(s.al ? { album_name: s.al } : {}), ...dur }));
    if (!body && s.al) body = answer(s.u, await this.call(job, 'get', { ...base, ...dur }));
    if (!body) body = pick(await this.call(job, 'search', { track_name: cleanName(s.n), artist_name: s.a }), s);
    return body || { u: s.u, none: 1 };
  }

  // One LRCLIB request -> its JSON (get: an object, search: an array), or null for a get's miss (404 TrackNotFound, or a
  // 400 ValidationError: LRCLIB turning the question down). Anything else throws, so it is never cached as "none": a
  // timeout, a network error, any other non-2xx (a 403 from a firewall in front of LRCLIB, a 429, a 5xx ...) or an
  // answer of the wrong shape. Waits for a slot first; the timeout covers the request and its body.
  async call(job, route, params) {
    await this.slot(job);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.T.timeoutMs);
    this.calls++;
    try {
      const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const r = await this.fetch(`${LRCLIB}/${route}?${qs}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
      const text = await r.text();
      if (route === 'get' && (r.status === 404 || r.status === 400)) return null;
      if (!r.ok) throw new Error(`answered ${r.status}`);
      let x;
      try { x = JSON.parse(text); } catch (e) { throw new Error('sent something that isn\'t JSON'); }   // (not e.message: it quotes the body)
      if (route === 'search' ? !Array.isArray(x) : !x || typeof x !== 'object' || Array.isArray(x)) throw new Error('sent an answer of the wrong shape');
      return x;
    } catch (e) {
      let why = ctl.signal.aborted ? 'timed out' : String((e && e.message) || e);
      if (!ctl.signal.aborted && e && e.cause && e.cause.code) why += ` (${e.cause.code})`;
      this.lastError = `${new Date().toISOString()} ${route}: ${why}`;
      throw new Error(`LRCLIB ${route} ${why}`);
    } finally {
      clearTimeout(timer);
      this.free();
    }
  }

  // At most maxFlights LRCLIB requests at once. A phone's requests go before prefetches; a prefetch whose song is no
  // longer playing gives up (SKIPPED) instead of taking a slot.
  slot(job) {
    if (!job.pri && job.uri !== this.nowUri) return Promise.reject(SKIPPED);
    if (this.busy < this.T.maxFlights) { this.busy++; return Promise.resolve(); }
    return new Promise((resolve, reject) => this.waiting.push({ job, resolve, reject }));
  }

  free() {
    for (;;) {
      let i = this.waiting.findIndex((w) => w.job.pri);
      if (i < 0) i = 0;
      const w = this.waiting.splice(i, 1)[0];
      if (!w) { this.busy--; return; }
      if (!w.job.pri && w.job.uri !== this.nowUri) { w.reject(SKIPPED); continue; }
      w.resolve();                                                  // the slot passes on
      return;
    }
  }

  // ------------------------------------------------------------------ prefetch
  // The engine's 'metadata' event (a new song): while a phone is around, fetch its lyrics in the background so opening
  // lyrics is instant. A failure is one log line (never lyric text).
  onEngine(type, d) {
    if (type !== 'metadata' || !d) return;
    const u = String(d.context_track_uri || d.uri || '');
    if (u === this.nowUri) return;
    this.nowUri = u;
    if (!TRACK_URI.test(u) || Date.now() - (this.player.lastPhone || 0) > this.T.phoneRecent) return;
    const s = this.song({ u, n: d.name, a: Array.isArray(d.artist_names) ? d.artist_names[0] : undefined, al: d.album_name,
      d: Number.isFinite(d.duration) ? Math.round(d.duration) : undefined });
    if (!s) return;
    this.lookup(s, false, false).catch((e) => { if (e !== SKIPPED) log.warn('lyrics prefetch:', (e.cause && e.cause.message) || e.message); });
  }

  info() {
    return { cached: this.store.values('l').length, flights: this.flights.size, lrclib_calls: this.calls, last_error: this.lastError };
  }
}

module.exports = { Lyrics, TIMING, cleanName, parseLrc };
