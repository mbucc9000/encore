'use strict';
// Other people's profiles (0.10.0, DESIGN-PROFILES.md §2): look a person up, their public playlists, their followers and
// who they follow, search people, follow / unfollow a person (P2) and follow someone else's playlist (P3).
//  - The private APIs Spotify's own clients use: spclient's user-profile-view (profiles, playlists, people lists) and
//    pathfinder's persisted queries (searchUsers, isFollowingUsers, followUsers, unfollowUsers). Both take the engine's
//    own access token (POST /token, a login5 renewal): kept in memory only, 45 min, at most one fetch per 30 s.
//  - One gate for every spclient / pathfinder call: 1 in flight, 1 s between starts, 60 starts per rolling 5 min, a
//    queue of 6 (8 s each), a 429 holds everything. The Web API (P3's /me/library) keeps webapi.js's own gate.
//  - Caches under cacheDir/social (JsonCache, file names are sha1 keys): profiles, playlist pages, people lists; user
//    searches and 404 misses in memory. A failed refetch answers the copy it has with stale: 1.
//  - Persisted-query hashes from config, overridden by social/hashes.json; a stale hash refreshes them from the web
//    player's public bundle at most once an hour. Capabilities (social/caps.json): follow / save, unknown | ok | off.
// Never logged at any level: ids, names, queries, uris, picture URLs, tokens. Every Error thrown here has a generic
// message (http.js logs e.message for 5xx).
const crypto = require('crypto');
const path = require('path');
const log = require('./log');
const { t } = require('./i18n');
const { JsonCache } = require('./jsoncache');
const { tokenFor } = require('./image');
const { memo, clean, pickImg, userIdOk } = require('./catalog');

const PLAYLIST_URI = /^spotify:playlist:[0-9A-Za-z]{22}$/;
const ARTIST_URI = /^spotify:artist:[0-9A-Za-z]{22}$/;
const STALE_HASH = /persisted[ _]?query|PersistedQueryNotFound/i;       // (DESIGN: /persisted ?query/; also Apollo's PERSISTED_QUERY_NOT_FOUND code)
const OP_RE = /"(\w+)","(query|mutation)","([0-9a-f]{64})"/g;
const HEX64 = /^[0-9a-f]{64}$/;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// cfg.profiles (config.js); the same values when a cfg leaves it out
const DEFAULTS = {
  spclient: 'https://spclient.wg.spotify.com',
  pathfinder: 'https://api-partner.spotify.com',
  web: 'https://open.spotify.com',
  cdn: 'https://open.spotifycdn.com/cdn/build/web-player/',
  spUA: 'Spotify/127700358 Linux/0 (PC desktop)',
  pfPlatform: 'Win32_x86_64', pfVersion: '1.2.77.358', pfUA: 'Spotify/127700358 Win32_x86_64/0 (PC desktop)',
  hashes: {
    searchUsers: '8f358dd82e62f61dd4ceaa9f8cd0889e644c9b707f1b724fbfb356a757cb7e5a',
    isFollowingUsers: 'c00e0cb6c7766e7230fc256cf4fe07aec63b53d1160a323940fce7b664e95596',
    followUsers: 'c00e0cb6c7766e7230fc256cf4fe07aec63b53d1160a323940fce7b664e95596',
    unfollowUsers: 'c00e0cb6c7766e7230fc256cf4fe07aec63b53d1160a323940fce7b664e95596',
  },
};

// Timings and limits (tests shrink them).
const TIMING = {
  tokenTtl: 45 * 60000,        // the engine's token is used this long (each fetch is a login5 renewal)
  tokenGap: 30000,             // at most one token fetch this often, even after a 401
  noSessionGap: 5000,          // ... after the engine answered 204 (no session: nothing went to Spotify)
  tokenTimeout: 10000,
  minGapMs: 1000,              // the gate: between starts
  window: 300000,              // ... rolling window
  budget: 60,                  // ... starts in the window
  queueMax: 6,
  queueWait: 8000,
  timeout: 12000,              // one spclient / pathfinder request
  retryMs: 1500,               // the one retry of a read after a 5xx or a network error
  holdDefault: 30,             // a 429 without Retry-After (s)
  holdMin: 5,
  holdMax: 900,
  jitterMs: 1000,
  profileTtl: 600000,
  pageTtl: 600000,
  peopleTtl: 1800000,
  searchTtl: 600000,
  searchMax: 50,
  missTtl: 600000,
  missMax: 200,
  freshAge: 30000,             // fresh=1 refetches a copy older than this
  hintMax: 500,
  hashGap: 3600000,            // hash refresh: at most this often (a failed one counts)
  hashTimeout: 20000,
  hashMaxBytes: 15 * 1024 * 1024,
  saveRecheck: 3000,           // P3: a library that doesn't show the change yet is read once more after this
};

const MSG = {
  bad_id: t('en', 'That isn\'t a Spotify profile.'),
  bad_q: t('en', 'Search needs 1 to 100 characters.'),
  bad_pl_offset: 'offset must be 0 to 950 in steps of 50.',
  bad_u_offset: 'offset must be 0 to 90 in steps of 10.',
  bad_following: 'following must be true or false.',
  bad_saved: 'saved must be true or false.',
  bad_uri: t('en', 'Only playlists (spotify:playlist:…) can be saved here.'),
  self: t('en', 'You can\'t follow yourself.'),
  user_not_found: t('en', 'This profile isn\'t available on Spotify.'),
  busy: t('en', 'Encore is busy loading profiles. Try again in a moment.'),
  unavailable: t('en', 'Profiles aren\'t available right now. Try again in a moment.'),
  no_follow: t('en', 'Following people isn\'t available right now.'),
  no_save: t('en', 'Saving other people\'s playlists isn\'t available right now.'),
  not_saved: t('en', 'Spotify didn\'t confirm the change. Try again.'),
  spotify_error: t('en', 'Spotify didn\'t answer. Try again in a moment.'),
};

// a GET with a copy answers it (stale: 1) instead of these
const STALE_OK = new Set(['spotify_error', 'rate_limited', 'busy', 'profiles_unavailable']);

const fail = (status, code, message, extra) => Object.assign(new Error(message), { status, code }, extra);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => (typeof v === 'string' && v ? v : undefined);
const pos = (v) => (Number.isFinite(v) && v > 0 ? v : undefined);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// spotify:user:<id> -> the decoded id ('' when it isn't a user: another kind, a further ':', a bad id)
function userIdOf(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('spotify:user:')) return '';
  const rest = uri.slice(13);
  if (!rest || rest.includes(':')) return '';
  let id;
  try { id = decodeURIComponent(rest); } catch (e) { return ''; }
  return userIdOk(id) ? id : '';
}

// A picture as spclient gives it -> an https URL ('' when it isn't one we know)
function imageUrl(s) {
  if (typeof s !== 'string' || !s) return '';
  if (s.startsWith('https://')) return s;
  let m = s.match(/^spotify:image:([0-9a-f]{40})$/i);
  if (m) return 'https://i.scdn.co/image/' + m[1].toLowerCase();
  m = s.match(/^spotify:mosaic:(.+)$/);
  if (m) {
    const ids = m[1].split(':');
    if (!ids.every((x) => /^[0-9a-f]{40}$/i.test(x))) return '';
    if (ids.length === 4) return 'https://mosaic.scdn.co/640/' + ids.join('').toLowerCase();
    if (ids.length === 1) return 'https://i.scdn.co/image/' + ids[0].toLowerCase();
  }
  return '';
}
const pic = (s) => tokenFor(imageUrl(s)) || undefined;

// A pathfinder answer that says the persisted query's hash is unknown (and carries no data)
function staleHash(status, j) {
  if (![200, 400, 404, 412].includes(status) || !j || typeof j !== 'object') return false;
  const d = j.data;
  if (d && typeof d === 'object' && Object.values(d).some((v) => v != null)) return false;
  const errs = Array.isArray(j.errors) ? j.errors : [];
  if (errs.some((e) => e && STALE_HASH.test(String(e.message || '') + ' ' + JSON.stringify(e.extensions || {})))) return true;
  return !!(j.error && STALE_HASH.test(String(j.error.message || j.error)));
}

// The web player's main bundle -> the lazy search chunk's file name (null when the chunk map isn't there)
function searchChunk(main) {
  const end = main.indexOf(')[e]+".js"');
  if (end < 0) return null;
  const start = main.lastIndexOf('=e=>""+', end);
  if (start < 0) return null;
  const maps = [...main.slice(start, end + 1).matchAll(/\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  if (!maps.length) return null;
  const names = [...maps[0].matchAll(/(\d+):"([^"]+)"/g)];
  const hashes = new Map([...maps[maps.length - 1].matchAll(/(\d+):"([0-9a-f]+)"/g)].map((m) => [m[1], m[2]]));
  const hit = names.find((m) => m[2] === 'xpui-routes-search');
  return hit && hashes.has(hit[1]) ? `xpui-routes-search.${hashes.get(hit[1])}.js` : null;
}

function collectOps(text) {
  const ops = {};
  for (const m of text.matchAll(OP_RE)) ops[m[1]] = m[3];
  return ops;
}

async function readCapped(r, cap) {
  const len = Number(r.headers && r.headers.get ? r.headers.get('content-length') : NaN);
  if (len > cap) throw new Error('too big');
  if (!r.body || typeof r.body.getReader !== 'function') {
    const t = await r.text();
    if (t.length > cap) throw new Error('too big');
    return t;
  }
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { reader.cancel().catch(() => {}); throw new Error('too big'); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts).toString('utf8');
}

// The profile as the phone gets it; cf is the capability's and the person's (§2.4), stale a failed refetch's
function profileOut(b, cf, stale) {
  return clean({ u: b.u, id: b.id, n: b.n, i: b.i, fol: b.fol, fing: b.fing, me: b.me, vf: b.vf, f: b.f, cf: cf ? 1 : undefined,
    plt: b.plt, pl: b.pl, ar: b.ar, stale: stale ? 1 : undefined });
}

class Social {
  constructor({ cfg, engine, webapi, catalog, fetch: f, now, timing }) {
    Object.assign(this, { cfg, engine, webapi, catalog });
    this.P = { ...DEFAULTS, ...(cfg.profiles || {}) };
    this.P.hashes = { ...DEFAULTS.hashes, ...((cfg.profiles && cfg.profiles.hashes) || {}) };
    for (const k of ['spclient', 'pathfinder', 'web']) this.P[k] = String(this.P[k]).replace(/\/$/, '');
    this.T = { ...TIMING, ...timing };
    this.fetch = f || ((...a) => fetch(...a));
    this.now = now || (() => Date.now());
    this.store = new JsonCache(path.join(cfg.cacheDir, 'social'), {
      top: { mem: 2, keep: 0, sub: '' }, p: { mem: 30, keep: 300 }, pg: { mem: 20, keep: 300 }, fo: { mem: 10, keep: 100 } });
    // the gate
    this.queue = [];               // { resolve, reject, timer }
    this.inflight = 0;
    this.lastStart = 0;            // real time (spacing)
    this.starts = [];              // this.now() of each start in the window
    this.calls = 0;
    this.n429 = 0;
    this.blockedUntil = 0;
    this.budgetLogged = false;
    // the engine token (memory only)
    this.tok = null;               // { v, at }
    this.tokFlight = null;
    this.tokNext = 0;              // no token fetch before this
    this.tokNoSession = false;
    this.fetches = 0;
    this.unavail = false;          // profiles_unavailable is logged once when it starts
    // caches
    this.searches = new Map();     // q|offset -> { at, obj }
    this.misses = new Map();       // id -> at (the profile answered 404 / 400)
    this.hints = new Map();        // playlist id -> PL
    this.flights = new Map();
    this.chains = new Map();
    this.views = new WeakMap();    // profile entry -> { key: object }
    this.stales = new WeakMap();   // entry -> its stale copy
    // hashes and capabilities
    const h = this.store.getSync('top', 'hashes');
    this.hashes = { ...this.P.hashes };
    if (h && h.ops && typeof h.ops === 'object') for (const [op, v] of Object.entries(h.ops)) if (this.hashes[op] && HEX64.test(v)) this.hashes[op] = v;
    this.hashAt = (h && Number(h.at)) || 0;
    this.hashTried = this.hashAt;
    this.hashFlight = null;
    const c = this.store.getSync('top', 'caps');
    const capOk = (v) => (['unknown', 'ok', 'off'].includes(v) ? v : 'unknown');
    this.caps = { follow: capOk(c && c.follow), save: capOk(c && c.save) };
  }

  // ------------------------------------------------------------------ helpers
  single(key, fn) {
    let p = this.flights.get(key);
    if (!p) {
      p = Promise.resolve().then(fn).finally(() => this.flights.delete(key));
      this.flights.set(key, p);
    }
    return p;
  }

  serial(key, fn) {
    const job = (this.chains.get(key) || Promise.resolve()).then(fn);
    const tail = job.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return job;
  }

  idOf(raw) {
    let id = '';
    try { id = decodeURIComponent(String(raw == null ? '' : raw)); } catch (e) { id = ''; }
    if (!userIdOk(id)) throw fail(400, 'bad_request', MSG.bad_id);
    return id;
  }

  offsetOf(raw, step, max, message) {
    const n = raw == null || raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > max || n % step) throw fail(400, 'bad_request', message);
    return n;
  }

  isMe(id) { const me = this.catalog.username(); return !!me && id === me; }
  userUri(id) { return 'spotify:user:' + encodeURIComponent(id); }
  spotifyErr() { return fail(502, 'spotify_error', MSG.spotify_error); }

  // profiles_unavailable, logged once where the state starts
  unavailable(why, retry) {
    if (!this.unavail) { this.unavail = true; log.warn(`social: profiles unavailable (${why})`); }
    return fail(503, 'profiles_unavailable', MSG.unavailable, { retry_after: retry });
  }

  limitErr(until) {
    const s = Math.max(1, Math.ceil((until - this.now()) / 1000));
    return fail(503, 'rate_limited', t('en', 'Spotify is limiting requests. Try again in {s} s.', { s }), { retry_after: s });
  }

  busyErr() { return fail(503, 'busy', MSG.busy, { retry_after: 3 }); }

  // ------------------------------------------------------------------ the engine token (memory only, never logged)
  async token() {
    const now = this.now();
    if (this.tok && now - this.tok.at < this.T.tokenTtl) return this.tok.v;
    if (this.tokFlight) return this.tokFlight;
    if (now < this.tokNext) throw this.unavailable('no token', this.tokNoSession ? 5 : 30);
    this.tokNext = now + this.T.tokenGap;
    this.tokFlight = (async () => {
      let r = null;
      try { r = await this.engine.send('POST', '/token', {}, { timeoutMs: this.T.tokenTimeout }); } catch (e) { r = null; }
      this.fetches++;
      if (r && r.status === 200 && r.json && typeof r.json.token === 'string' && r.json.token) {
        this.tok = { v: r.json.token, at: this.now() };
        this.tokNoSession = false;
        log.info('social: token fetched');
        return this.tok.v;
      }
      this.tokNoSession = !!r && r.status === 204;
      if (this.tokNoSession) this.tokNext = this.now() + this.T.noSessionGap;      // nothing went to Spotify
      throw this.unavailable(this.tokNoSession ? 'the engine has no session' : `engine token ${r ? r.status : 'unreachable'}`, this.tokNoSession ? 5 : 30);
    })().finally(() => { this.tokFlight = null; });
    return this.tokFlight;
  }

  // ------------------------------------------------------------------ the gate
  windowCount() {
    const t = this.now() - this.T.window;
    while (this.starts.length && this.starts[0] <= t) this.starts.shift();
    return this.starts.length;
  }

  // one start: refused while a 429 holds or the budget is spent; recorded otherwise
  admit() {
    const now = this.now();
    if (now < this.blockedUntil) throw this.limitErr(this.blockedUntil);
    if (this.windowCount() >= this.T.budget) {
      if (!this.budgetLogged) { this.budgetLogged = true; log.warn(`social: ${this.T.budget} calls in ${Math.round(this.T.window / 1000)} s, holding`); }
      throw this.limitErr(this.starts[0] + this.T.window);
    }
    this.budgetLogged = false;
    this.starts.push(now);
    this.lastStart = Date.now();
    this.calls++;
  }

  acquire() {
    if (this.now() < this.blockedUntil) return Promise.reject(this.limitErr(this.blockedUntil));
    if (this.queue.length >= this.T.queueMax) return Promise.reject(this.busyErr());
    return new Promise((resolve, reject) => {
      const job = { resolve, reject };
      job.timer = setTimeout(() => {
        const i = this.queue.indexOf(job);
        if (i < 0) return;
        this.queue.splice(i, 1);
        reject(this.busyErr());
      }, this.T.queueWait);
      this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    while (this.queue.length && this.inflight < 1) {
      const wait = this.lastStart + this.T.minGapMs - Date.now();
      if (wait > 0) {
        if (!this.pumpTimer) this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, wait);
        return;
      }
      const job = this.queue.shift();
      clearTimeout(job.timer);
      try { this.admit(); } catch (e) { job.reject(e); continue; }
      this.inflight++;
      job.resolve();
    }
  }

  release() { this.inflight--; this.pump(); }

  // a retry inside a call that holds the slot: the gap, the hold and the budget still apply
  async again() {
    const wait = this.lastStart + this.T.minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.admit();
  }

  hold(ra) {
    const s = Math.min(this.T.holdMax, Math.max(this.T.holdMin, ra || this.T.holdDefault));
    const was = this.now() < this.blockedUntil;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + s * 1000 + Math.random() * this.T.jitterMs);
    this.n429++;
    if (!was) log.warn(`social: 429, holding ${s} s`);
    for (const job of this.queue.splice(0)) { clearTimeout(job.timer); job.reject(this.limitErr(this.blockedUntil)); }
  }

  // One spclient / pathfinder request through the gate: the token, a 401's one refetch, a 429's hold, a read's one
  // retry after a 5xx or a network error. -> { status, json } (json undefined: an unreadable body) for anything else.
  // The token comes first (outside the gate: a refused one costs no start).
  async call(kind, make, { read }) {
    if (this.now() < this.blockedUntil) throw this.limitErr(this.blockedUntil);
    let tok = await this.token();
    await this.acquire();
    const t0 = Date.now();
    try {
      let retried401 = false;
      let retried = false;
      for (;;) {
        const { url, init } = make(tok);
        let r;
        let text;
        try {
          r = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.T.timeout) });
          text = await r.text();
        } catch (e) {
          if (read && !retried) { retried = true; await sleep(this.T.retryMs); await this.again(); continue; }
          log.warn(`social: ${kind} failed (${e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network'})`);
          throw this.spotifyErr();
        }
        if (r.status === 401) {
          if (retried401) throw this.unavailable('401 with a fresh token', 30);
          retried401 = true;
          if (this.tok && this.tok.v === tok) this.tok = null;
          tok = await this.token();
          await this.again();
          continue;
        }
        if (r.status === 429) {
          const ra = Number(r.headers.get('retry-after'));
          this.hold(Number.isFinite(ra) && ra > 0 ? ra : 0);
          throw this.limitErr(this.blockedUntil);
        }
        if (r.status >= 500) {
          if (read && !retried) { retried = true; await sleep(this.T.retryMs); await this.again(); continue; }
          log.warn(`social: ${kind} ${r.status}`);
          throw this.spotifyErr();
        }
        let json;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = undefined; }
        log.info(`social: ${kind} ${r.status} in ${Date.now() - t0} ms`);
        if (r.status !== 403 && this.unavail) { this.unavail = false; log.info('social: profiles available again'); }
        return { status: r.status, json };
      }
    } finally {
      this.release();
    }
  }

  sp(kind, p) {
    return this.call(kind, (tok) => ({ url: `${this.P.spclient}/user-profile-view/v3${p}`,
      init: { method: 'GET', headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': this.P.spUA } } }), { read: true });
  }

  // A persisted query; a stale hash refreshes the hashes (at most once an hour) and the call is made once more.
  async pf(op, variables, write) {
    for (let refreshed = false; ; refreshed = true) {
      const body = JSON.stringify({ variables, operationName: op, extensions: { persistedQuery: { version: 1, sha256Hash: this.hashes[op] } } });
      const r = await this.call(op, (tok) => ({ url: `${this.P.pathfinder}/pathfinder/v2/query`,
        init: { method: 'POST', body, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json',
          'App-Platform': this.P.pfPlatform, 'Spotify-App-Version': this.P.pfVersion, 'User-Agent': this.P.pfUA } } }), { read: !write });
      if (!staleHash(r.status, r.json)) return r;
      const found = refreshed ? null : await this.refreshHashes();
      if (!found || !found[op]) { log.warn(`social: ${op} hash is stale`); throw this.spotifyErr(); }
    }
  }

  // a read's answer: 403 = the private API refuses the engine's token; anything but a 200 with a JSON object = an error
  readOk(r) {
    if (r.status === 403) throw this.unavailable('403', 30);
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') throw this.spotifyErr();
    return r.json;
  }

  // ------------------------------------------------------------------ persisted-query hashes (public files only)
  async getText(url) {
    const r = await this.fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(this.T.hashTimeout) });
    if (r.status !== 200) throw new Error('status ' + r.status);
    return readCapped(r, this.T.hashMaxBytes);
  }

  // -> the ops found ({op: hash}), or null (refreshed less than an hour ago, or the refresh failed)
  refreshHashes() {
    if (this.hashFlight) return this.hashFlight;
    if (this.hashTried && this.now() - this.hashTried < this.T.hashGap) return Promise.resolve(null);
    this.hashTried = this.now();
    this.hashFlight = (async () => {
      try {
        const home = await this.getText(this.P.web + '/');
        const m = home.match(new RegExp(escRe(this.P.cdn) + 'web-player\\.[0-9a-f]+\\.js'));
        if (!m) throw new Error('no main bundle');
        const main = await this.getText(m[0]);
        const ops = collectOps(main);
        const chunk = searchChunk(main);
        if (chunk) Object.assign(ops, collectOps(await this.getText(this.P.cdn + chunk)));
        const found = {};
        let changed = 0;
        for (const op of Object.keys(this.P.hashes)) {
          if (!ops[op]) continue;
          found[op] = ops[op];
          if (ops[op] !== this.hashes[op]) { this.hashes[op] = ops[op]; changed++; }
        }
        this.hashAt = this.now();
        this.store.put('top', 'hashes', { at: this.hashAt, ops: { ...this.hashes } });
        log.info(`social: hashes refreshed (${changed} changed)`);
        return found;
      } catch (e) {
        log.warn('social: hash refresh failed');
        return null;
      }
    })().finally(() => { this.hashFlight = null; });
    return this.hashFlight;
  }

  // ------------------------------------------------------------------ capabilities
  setCap(which, v, why) {
    if (this.caps[which] === v) return;
    this.caps[which] = v;
    this.store.put('top', 'caps', { ...this.caps });
    log.info(`social: ${which} capability ${v}${why ? ' (' + why + ')' : ''}`);
  }

  resetCaps(b) {
    if (!b || b.reset !== true) throw fail(400, 'bad_request', 'Send {"reset": true}.');     // a request format: not translated
    this.caps = { follow: 'unknown', save: 'unknown' };
    this.store.put('top', 'caps', { ...this.caps });
    log.info('social: capabilities reset');
    return { caps: { ...this.caps } };
  }

  statusInfo() {
    return { v: 1, follow: this.caps.follow !== 'off' ? 1 : 0, sp: this.caps.save !== 'off' && this.webapi.ready ? 1 : 0 };
  }

  // ------------------------------------------------------------------ rows
  hint(id) { return this.hints.get(id); }

  hintPut(pl) {
    const id = pl.u.slice(17);
    this.hints.delete(id);
    this.hints.set(id, pl);
    while (this.hints.size > this.T.hintMax) this.hints.delete(this.hints.keys().next().value);
  }

  // every PL served fills the hints, a copy from the cache too (after a restart the playlist page still has its header)
  hintAll(rows) { if (Array.isArray(rows)) for (const pl of rows) if (pl && typeof pl.u === 'string') this.hintPut(pl); }

  plOf(p) {
    if (!p || typeof p.uri !== 'string' || !PLAYLIST_URI.test(p.uri)) return null;
    const oid = userIdOf(p.owner_uri);
    const mine = !!oid && this.isMe(oid);
    const pl = clean({ u: p.uri, n: str(p.name), i: pic(p.image_url), o: mine ? this.catalog.myName() : oid === 'spotify' ? 'Spotify' : str(p.owner_name) || oid || undefined,
      ou: oid ? p.owner_uri : undefined, fol: pos(p.followers_count), own: mine ? 1 : undefined });
    return pl;
  }

  // a person or (in a following list) an artist from spclient
  personOf(p) {
    if (!p || typeof p.uri !== 'string') return null;
    if (ARTIST_URI.test(p.uri)) return clean({ k: 'artist', u: p.uri, n: str(p.name), i: pic(p.image_url), fol: pos(p.followers_count) });
    const id = userIdOf(p.uri);
    if (!id) return null;
    return clean({ k: 'user', u: p.uri, id, n: str(p.name) || id, i: pic(p.image_url), fol: pos(p.followers_count), f: p.is_following === true ? 1 : undefined });
  }

  // ------------------------------------------------------------------ caches
  // The copy when it is young enough, else one refetch (fetchFn -> the entry's fields: { body, ... }); a failed refetch
  // answers the copy with stale: 1. view(entry, stale) -> the memo.
  async cachedGet(kind, key, ttl, fresh, fetchFn, view) {
    const ent = await this.store.get(kind, key);
    const age = ent ? this.now() - ent.at : Infinity;
    if (ent && age < ttl && !(fresh && age >= this.T.freshAge)) return view(ent, false);
    return this.single(kind + ':' + key, async () => {
      try {
        const e2 = { at: this.now(), ...(await fetchFn()) };
        this.store.put(kind, key, e2);
        return view(e2, false);
      } catch (e) {
        if (ent && STALE_OK.has(e.code)) return view(ent, true);
        throw e;
      }
    });
  }

  plain(ent, stale) {
    if (!stale) return memo(ent.body);
    let s = this.stales.get(ent);
    if (!s) { s = { ...ent.body, stale: 1 }; this.stales.set(ent, s); }
    return memo(s);
  }

  profView(ent, stale) {
    const cf = !!ent.allow && this.caps.follow !== 'off' && !ent.body.me;
    const k = (cf ? 'c' : '-') + (stale ? 's' : '-');
    let v = this.views.get(ent);
    if (!v) { v = {}; this.views.set(ent, v); }
    if (!v[k]) v[k] = profileOut(ent.body, cf, stale);
    return memo(v[k]);
  }

  missCheck(id) {
    const at = this.misses.get(id);
    if (at == null) return;
    if (this.now() - at < this.T.missTtl) throw fail(404, 'user_not_found', MSG.user_not_found);
    this.misses.delete(id);
  }

  missPut(id) {
    this.misses.delete(id);
    this.misses.set(id, this.now());
    while (this.misses.size > this.T.missMax) this.misses.delete(this.misses.keys().next().value);
  }

  notFound() { return fail(404, 'user_not_found', MSG.user_not_found); }

  // ------------------------------------------------------------------ routes
  // GET /v1/users/<id> -> PROFILE
  async profile(raw, fresh) {
    const id = this.idOf(raw);
    this.missCheck(id);
    const key = sha1(id);
    return this.cachedGet('p', key, this.T.profileTtl, fresh, async () => {
      const r = await this.sp('profile', `/profile/${encodeURIComponent(id)}?playlist_limit=10&artist_limit=10&episode_limit=0&market=from_token`);
      if (r.status === 404 || r.status === 400) {
        this.missPut(id);
        await this.store.del('p', key);
        throw this.notFound();
      }
      const j = this.readOk(r);
      const uid = userIdOf(j.uri);
      const pid = uid || id;
      const me = j.is_current_user === true || this.isMe(pid);
      const pl = (Array.isArray(j.public_playlists) ? j.public_playlists : []).map((p) => this.plOf(p)).filter(Boolean).slice(0, 10);
      const ar = (Array.isArray(j.recently_played_artists) ? j.recently_played_artists : [])
        .filter((a) => a && typeof a.uri === 'string' && ARTIST_URI.test(a.uri)).slice(0, 10).map((a) => clean({ u: a.uri, n: str(a.name), i: pic(a.image_url) }));
      const body = clean({ u: uid ? j.uri : this.userUri(id), id: pid, n: str(j.name) || pid, i: pic(j.image_url), fol: num(j.followers_count), fing: num(j.following_count),
        me: me ? 1 : undefined, vf: j.is_verified === true ? 1 : undefined, f: !me && j.is_following === true ? 1 : undefined,
        plt: num(j.total_public_playlists_count), pl, ar: ar.length ? ar : undefined });
      return { allow: j.allow_follows === true, body };
    }, (ent, stale) => { this.hintAll(ent.body.pl); return this.profView(ent, stale); });
  }

  // GET /v1/users/<id>/playlists?offset=N -> PAGE
  async playlists(raw, offRaw, fresh) {
    const id = this.idOf(raw);
    const off = this.offsetOf(offRaw, 50, 950, MSG.bad_pl_offset);
    this.missCheck(id);
    return this.cachedGet('pg', sha1(id + '|' + off), this.T.pageTtl, fresh, async () => {
      const r = await this.sp('playlists', `/profile/${encodeURIComponent(id)}/playlists?offset=${off}&limit=50`);
      if (r.status === 404 || r.status === 400) throw this.notFound();
      const j = this.readOk(r);
      const list = Array.isArray(j.public_playlists) ? j.public_playlists : [];
      const items = list.map((p) => this.plOf(p)).filter(Boolean);
      let total = Number.isFinite(j.total_public_playlists_count) ? j.total_public_playlists_count : -1;
      if (total < 0) {
        const pe = this.store.peek('p', sha1(id));
        total = Math.max(pe && pe.body ? pe.body.plt || 0 : 0, off + list.length);
      }
      const body = { total, offset: off, items };
      if (off + 50 < total && off + 50 <= 950) body.next = off + 50;
      return { body };
    }, (ent, stale) => { this.hintAll(ent.body.items); return this.plain(ent, stale); });
  }

  // GET /v1/users/<id>/followers | following -> PEOPLE
  async people(raw, which, fresh) {
    if (which !== 'followers' && which !== 'following') throw fail(400, 'bad_request', MSG.bad_id);
    const id = this.idOf(raw);
    this.missCheck(id);
    return this.cachedGet('fo', sha1(id + '|' + which), this.T.peopleTtl, fresh, async () => {
      const r = await this.sp(which, `/profile/${encodeURIComponent(id)}/${which}`);
      if (r.status === 404 || r.status === 400) throw this.notFound();
      const j = this.readOk(r);
      const list = Array.isArray(j.profiles) ? j.profiles : [];
      const rows = list.map((p) => this.personOf(p)).filter(Boolean);
      const cap = which === 'followers' ? 200 : 500;
      const body = { total: list.length, items: rows.slice(0, cap) };
      if (rows.length > cap) body.trunc = 1;
      return { body };
    }, (ent, stale) => this.plain(ent, stale));
  }

  // GET /v1/search/users?q=&offset=N -> USERS
  async searchUsers(qRaw, offRaw) {
    const q = String(qRaw == null ? '' : qRaw).trim().replace(/\s+/g, ' ');
    if (!q || q.length > 100) throw fail(400, 'bad_request', MSG.bad_q);
    const off = this.offsetOf(offRaw, 10, 90, MSG.bad_u_offset);
    const ql = q.toLowerCase();
    const key = ql + '|' + off;
    const c = this.searches.get(key);
    if (c) { this.searches.delete(key); this.searches.set(key, c); }
    if (c && this.now() - c.at < this.T.searchTtl) return memo(c.obj);
    return this.single('su:' + key, async () => {
      try {
        const r = await this.pf('searchUsers', { searchTerm: q, offset: off, limit: 10, numberOfTopResults: 20, includeAudiobooks: true,
          includePreReleases: false, includeAlbumPreReleases: false, includeAuthors: false, includeEpisodeContentRatingsV2: false }, false);
        const j = this.readOk(r);
        const u = j.data && j.data.searchV2 && j.data.searchV2.users;
        if (!u || typeof u !== 'object') throw this.spotifyErr();
        const items = [];
        for (const x of Array.isArray(u.items) ? u.items : []) {
          const d = x && x.data;
          if (!d || d.__typename !== 'User') continue;
          const uid = userIdOf(d.uri);
          if (!uid) continue;
          const id = typeof d.username === 'string' && userIdOk(d.username) ? d.username : uid;
          items.push(clean({ k: 'user', u: d.uri, id, n: str(d.displayName) || id, i: pic(pickImg(d.avatar && d.avatar.sources, 300)) }));
        }
        const total = Number.isFinite(u.totalCount) ? u.totalCount : off + items.length;
        const obj = { q: ql, total, items };
        const nx = u.pagingInfo && u.pagingInfo.nextOffset;
        if (Number.isInteger(nx) && nx > off && nx <= 90 && nx < total) obj.next = nx;
        log.info(`social: searchUsers 200 (${items.length})`);
        this.searches.set(key, { at: this.now(), obj });
        while (this.searches.size > this.T.searchMax) this.searches.delete(this.searches.keys().next().value);
        return memo(obj);
      } catch (e) {
        if (c && STALE_OK.has(e.code)) {
          let s = this.stales.get(c);
          if (!s) { s = { ...c.obj, stale: 1 }; this.stales.set(c, s); }
          return memo(s);
        }
        throw e;
      }
    });
  }

  // POST /v1/users/<id>/follow {"following": bool} -> {u, f, fol?} (P2; never run before 0.10.0: a hard refusal turns it off)
  async follow(raw, b) {
    const id = this.idOf(raw);
    if (!b || typeof b.following !== 'boolean') throw fail(400, 'bad_request', MSG.bad_following);
    if (this.caps.follow === 'off') throw fail(501, 'not_supported', MSG.no_follow);
    if (this.isMe(id)) throw fail(400, 'bad_request', MSG.self);
    const want = b.following;
    return this.serial('follow:' + id, async () => {
      if (this.caps.follow === 'off') throw fail(501, 'not_supported', MSG.no_follow);
      const op = want ? 'followUsers' : 'unfollowUsers';
      const r = await this.pf(op, { usernames: [id] }, true);
      const refuse = (why) => { this.setCap('follow', 'off', why); return fail(501, 'not_supported', MSG.no_follow); };
      if (r.status === 400 || r.status === 403 || r.status === 404) throw refuse(`pathfinder ${r.status}`);
      if (r.status !== 200 || !r.json || typeof r.json !== 'object') throw this.spotifyErr();
      // Live 2026-10-07: followUsers answered FollowUserResult, but unfollowUsers answered 200 with another shape while it
      // DID unfollow. So any answer under data is checked with isFollowingUsers; only an unconfirmed odd one turns it off.
      const data = r.json.data && typeof r.json.data === 'object' ? r.json.data : null;
      const node = data && (data[op] || Object.values(data).find((v) => v && Array.isArray(v.responses)));
      const res = node && Array.isArray(node.responses) ? node.responses[0] : null;
      if (!res && Array.isArray(r.json.errors) && r.json.errors.length) throw refuse('GraphQL errors');
      const tn = res && typeof res.__typename === 'string' ? res.__typename.replace(/[^A-Za-z]/g, '').slice(0, 40) : '';
      const known = /^(Un)?[Ff]ollowUserResult$/.test(tn);
      if (!known) log.info(`social: ${op} answered ${tn || 'no result'} (data ${data ? Object.keys(data).join(',').replace(/[^A-Za-z,]/g, '').slice(0, 60) : '-'}): checking with isFollowingUsers`);
      // the check: does Spotify say we follow them now?
      const uri = this.userUri(id);
      let confirmed = false;
      try {
        const c = await this.pf('isFollowingUsers', { uris: [uri] }, false);
        const users = c.status === 200 && c.json && c.json.data && Array.isArray(c.json.data.users) ? c.json.data.users : [];
        const hit = users.find((x) => x && userIdOf(x.uri) === id) || (users.length === 1 ? users[0] : null);
        confirmed = !!hit && typeof hit.following === 'boolean' && hit.following === want;
      } catch (e) { confirmed = false; }
      if (!confirmed) {
        if (!known) throw refuse('unexpected answer');
        log.warn(`social: ${op} not confirmed`); throw fail(502, 'not_saved', MSG.not_saved);
      }
      this.setCap('follow', 'ok');
      // the cached profile shows it; the user's own profile and following list, and their followers, are read again
      const key = sha1(id);
      const ent = await this.store.get('p', key);
      let out = { u: uri, f: want ? 1 : 0 };
      if (ent && ent.body) {
        const was = !!ent.body.f;
        const fol = was === want ? ent.body.fol : Math.max(0, (ent.body.fol || 0) + (want ? 1 : -1));
        const body = clean({ ...ent.body, f: want ? 1 : undefined, fol });
        this.store.put('p', key, { ...ent, body });
        out = { u: ent.body.u || uri, f: want ? 1 : 0, fol };
      }
      await this.store.del('fo', sha1(id + '|followers'));
      const me = this.catalog.username();
      if (me) {
        await this.store.del('fo', sha1(me + '|following'));
        await this.store.del('p', sha1(me));
      }
      return out;
    });
  }

  // POST /v1/me/playlists {"uri", "saved": bool} -> {u, saved} (P3: follow someone else's playlist; the Web API's
  // generic library route, checked against the engine's rootlist; a hard refusal turns it off)
  async savePlaylist(b) {
    if (!b || typeof b.uri !== 'string' || !PLAYLIST_URI.test(b.uri)) throw fail(400, 'bad_request', MSG.bad_uri);
    if (typeof b.saved !== 'boolean') throw fail(400, 'bad_request', MSG.bad_saved);
    if (this.caps.save === 'off') throw fail(501, 'not_supported', MSG.no_save);
    const { uri, saved } = b;
    return this.serial('save', async () => {
      if (this.caps.save === 'off') throw fail(501, 'not_supported', MSG.no_save);
      try {
        await this.webapi.api(saved ? 'PUT' : 'DELETE', '/me/library?uris=' + encodeURIComponent(uri));
      } catch (e) {
        if ([400, 403, 404].includes(e.spotifyStatus)) { this.setCap('save', 'off', `Web API ${e.spotifyStatus}`); throw fail(501, 'not_supported', MSG.no_save); }
        throw e;                                                       // rate_limited, busy, spotify_not_connected, spotify_error
      }
      const id = uri.slice(17);
      const has = () => !!(this.catalog.build && this.catalog.build.byId && this.catalog.build.byId.has(id));
      try { await this.catalog.settleRoot(); } catch (e) { /* checked below */ }
      if (has() !== saved) {
        await sleep(this.T.saveRecheck);
        try { await this.catalog.forceRoot(); } catch (e) { /* checked below */ }
      }
      if (has() !== saved) { log.warn('social: playlist save not confirmed'); throw fail(502, 'not_saved', MSG.not_saved); }
      this.setCap('save', 'ok');
      return { u: uri, saved: saved ? 1 : 0 };
    });
  }

  // ------------------------------------------------------------------ admin (never the token)
  info() {
    const now = this.now();
    const hashes = {};
    for (const [op, h] of Object.entries(this.hashes)) hashes[op] = String(h).slice(0, 8);
    return {
      calls: this.calls, window: this.windowCount(), inflight: this.inflight, queued: this.queue.length, n429: this.n429,
      blocked_until: now < this.blockedUntil ? this.blockedUntil : 0,
      token: { age_s: this.tok ? Math.round((now - this.tok.at) / 1000) : null, fetches: this.fetches },
      hashes, hash_refresh_at: this.hashAt || null, caps: { ...this.caps },
      cache: { profiles: this.store.values('p').length, pages: this.store.values('pg').length, people: this.store.values('fo').length,
        searches: this.searches.size, misses: this.misses.size, hints: this.hints.size },
    };
  }
}

module.exports = { Social, TIMING, DEFAULTS, MSG, userIdOf, imageUrl, staleHash, searchChunk, collectOps };
