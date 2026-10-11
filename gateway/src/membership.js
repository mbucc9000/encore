'use strict';
// Which of your playlists hold a song (0.9, DESIGN-0.9.md §3a): GET /v1/playlists/containing?uri=spotify:track:… for
// the "Saved in" sheet, which shows a green check on every editable playlist that already has the song.
// The index keeps, per editable playlist, its song ids at one revision ({ v, ids }), in memory and on disk
// (cacheDir/membership, keep 500). A playlist is answered only while its entry is at the library's revision; the
// others are counted as pending, and the worker fills them in:
//  1. free: the catalog's own stored song list of it, when that is at the library's revision (no Spotify traffic);
//  2. else the engine's listing of it without metadata (catalog.readUris): one playlist at a time, at most one every
//     3 s, only when catalog.bgRoom() says the phone isn't using the engine (the worker keeps to half of the
//     limiter's enumerations), nothing for 60 s after a 429 or an engine error.
// Every editable playlist missing or stale is queued after each library rebuild; the ones a request found pending go
// in front (the most recent request first). Adds and removes (catalog writes) change the ids in place, so the index
// stays exact, and a song list the phone's own browsing stores is taken in as it is stored. A read that a write landed
// during is thrown away (its listing may predate the write) and done again.
// A listing the engine cut at metadata.max_tracks (trunc) answers only for the songs in it: the others are neither 0
// nor pending (they never become known).
// Logs never name a playlist or a song.
const crypto = require('crypto');
const path = require('path');
const log = require('./log');
const { JsonCache } = require('./jsoncache');
const { memo } = require('./catalog');

const TRACK_URI = /^spotify:track:[0-9A-Za-z]{22}$/;

// Timings (tests shrink them).
const TIMING = {
  gapMs: 3000,               // at most one engine read every this long (counted from the end of the last one)
  pauseMs: 60000,            // no engine read for this long after a 429 or an engine error
  roomMs: 2000,              // the catalog had no room: look again after this
  laterMs: 30000,            // a read that wasn't ready (or may not be refreshed yet): that playlist again after this
  goneMs: 600000,            // a playlist the engine can't list: again after this
  waitMs: 30000,             // an enumeration not done within this is left for later
  noRevTtl: 600000,          // an engine without revisions: an entry is good for this long
};

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const idsOf = (uris) => new Set(uris.filter((u) => typeof u === 'string' && TRACK_URI.test(u)).map((u) => u.slice(14)));

class Membership {
  constructor({ cfg, catalog, timing }) {
    this.catalog = catalog;
    this.T = { ...TIMING, ...timing };
    this.store = new JsonCache(path.join(cfg.cacheDir, 'membership'), { pl: { mem: 1, keep: 500, sub: '' } });
    this.idx = new Map();          // playlist uri -> { v, ids: Set of track ids, at, trunc } | null (not on disk either)
    this.queue = [];               // playlist uris to fill in, the next one first
    this.notBefore = new Map();    // uri -> no engine read of it before this
    this.looked = new Map();       // uri -> the library revision its stored list was looked at for (it didn't match)
    this.wrote = new Map();        // uri -> when the catalog last told of a write to it (a read spanning that is redone)
    this.timer = null;
    this.running = false;
    this.again = false;            // something was queued while a step ran
    this.lastRead = 0;             // when the last engine read ended
    this.pauseUntil = 0;
    this.scanning = false;
    this.rescan = false;           // the library was rebuilt again during a scan
    this.batch = null;             // what the worker did since the queue last ran dry (one log line)
    this.whyAt = 0;                // when the worker last said why it waits (at most once a minute)
    catalog.onChange((type, d) => {
      if (type === 'library') this.scanSoon();
      else if (type === 'list') this.onList(d);
      else if (type === 'write') this.onWrite(d).catch((e) => log.warn('membership write:', e.message));
    });
    this.scanSoon();
  }

  // ------------------------------------------------------------------ the index
  rows() { return ((this.catalog.build && this.catalog.build.obj && this.catalog.build.obj.items) || []).filter((pl) => pl.ed); }

  row(u) {
    const e = this.catalog.build && this.catalog.build.byId.get(String(u).slice(17));
    return e && e.pl.ed ? e.pl : null;
  }

  async entry(u) {
    if (this.idx.has(u)) return this.idx.get(u);
    const d = await this.store.get('pl', sha1(u));
    const e = d && d.u === u && Array.isArray(d.ids) ? { v: d.v || '', ids: new Set(d.ids), at: d.at || 0, trunc: !!d.trunc } : null;
    if (!this.idx.has(u)) this.idx.set(u, e);                          // (a put may have landed while we read)
    return this.idx.get(u);
  }

  put(u, v, ids, trunc) {
    const e = { v: v || '', ids, at: Date.now(), trunc: !!trunc };
    this.idx.set(u, e);
    this.looked.delete(u);
    this.store.put('pl', sha1(u), { u, v: e.v, at: e.at, trunc: e.trunc ? 1 : 0, ids: [...ids] });
    return e;
  }

  // a song list at revision v (made at `at`) is the playlist as the library shows it (an engine without revisions:
  // a young enough one)
  matches(v, at, pl) { return pl.v ? v === pl.v : Date.now() - at < this.T.noRevTtl; }
  current(e, pl) { return !!e && this.matches(e.v, e.at, pl); }

  // GET /v1/playlists/containing?uri=… -> { items: { playlist uri: 1|0 }, pending: n } over the library's editable
  // playlists; the pending ones go to the front of the queue. A cut listing without the song: no answer for it.
  async containing(uriRaw) {
    this.catalog.simCheck();
    const uri = String(uriRaw || '');
    if (!TRACK_URI.test(uri)) throw fail(400, 'bad_request', 'Send one song uri (spotify:track:…).');
    if (!this.catalog.build) await this.catalog.rootNow(false);
    const id = uri.slice(14);
    const rows = this.rows();
    const es = await Promise.all(rows.map((pl) => this.entry(pl.u)));
    const items = {};
    const stale = [];
    rows.forEach((pl, i) => {
      const e = es[i];
      if (!this.current(e, pl)) stale.push(pl.u);
      else if (e.ids.has(id)) items[pl.u] = 1;
      else if (!e.trunc) items[pl.u] = 0;
    });
    if (stale.length) this.enqueue(stale, true);
    return memo({ items, pending: stale.length });
  }

  // ------------------------------------------------------------------ catalog hooks
  // the phone's browsing stored a playlist's song list
  onList({ u, v, uris, trunc }) {
    const pl = this.row(u);
    if (pl && this.matches(v, Date.now(), pl)) this.put(u, v, idsOf(uris), trunc);
  }

  // An add or remove landed. An entry at the revision it was based on takes it in place: at the new revision when the
  // library already shows one, else still at the old one, which stays exact until the library moves on (then the
  // entry is stale and read again).
  async onWrite({ u, op, uris, before, after }) {
    this.wrote.delete(u);
    this.wrote.set(u, Date.now());
    if (this.wrote.size > 200) this.wrote.delete(this.wrote.keys().next().value);
    const e = await this.entry(u);
    if (!e || e.v !== (before || '')) return;                          // unknown or stale: it is read anyway
    const ids = new Set(e.ids);
    for (const x of idsOf(uris)) { if (op === 'add') ids.add(x); else ids.delete(x); }
    this.put(u, after && after !== before ? after : before, ids, e.trunc);
  }

  scanSoon() {
    if (this.scanning) { this.rescan = true; return; }
    this.scanning = true;
    this.rescan = false;
    setImmediate(() => this.scan().catch((e) => log.warn('membership scan:', e.message)).finally(() => {
      this.scanning = false;
      if (this.rescan) this.scanSoon();
    }));
  }

  // after a library rebuild: every editable playlist missing or stale goes to the back of the queue
  async scan() {
    if (!this.catalog.build) return;
    const rows = this.rows();
    const keep = new Set(rows.map((pl) => pl.u));
    for (const u of [...this.idx.keys()]) if (!keep.has(u)) this.idx.delete(u);    // (its file stays until pruned)
    const es = await Promise.all(rows.map((pl) => this.entry(pl.u)));
    const stale = rows.filter((pl, i) => !this.current(es[i], pl)).map((pl) => pl.u);
    if (stale.length) this.enqueue(stale, false);
  }

  // ------------------------------------------------------------------ the worker
  enqueue(uris, front) {
    if (front) {
      const set = new Set(uris);
      this.queue = [...uris, ...this.queue.filter((u) => !set.has(u))];
    } else {
      const have = new Set(this.queue);
      for (const u of uris) if (!have.has(u)) this.queue.push(u);
    }
    this.kick(0);
  }

  dequeue(u) { this.queue = this.queue.filter((x) => x !== u); this.notBefore.delete(u); }

  note(k) {
    if (!this.batch) this.batch = { at: Date.now(), stored: 0, read: 0, later: 0, errors: 0 };
    this.batch[k]++;
  }

  kick(ms) {
    if (this.running) { this.again = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.run(); }, Math.max(0, ms));
    if (this.timer.unref) this.timer.unref();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.again = false;
    let ms = this.T.roomMs;
    try { ms = await this.step(); }
    catch (e) { log.warn('membership:', e.message); }
    finally { this.running = false; }
    if (!this.queue.length) return this.batchDone();
    this.kick(this.again ? 0 : ms);
  }

  // One step: the free pass over the whole queue (what needs nothing is dropped, stored lists are taken), then at
  // most one engine read. -> ms until the next step.
  async step() {
    for (const u of [...this.queue]) {
      const pl = this.row(u);
      if (!pl || this.current(await this.entry(u), pl)) { this.dequeue(u); continue; }    // gone, or known meanwhile
      if (this.looked.has(u) && this.looked.get(u) === (pl.v || '')) continue;
      const st = await this.catalog.storedUris(u);
      if (st && this.matches(st.v, st.at, pl)) { this.put(u, st.v, idsOf(st.uris), st.trunc); this.dequeue(u); this.note('stored'); }
      else this.looked.set(u, pl.v || '');
    }
    const now = Date.now();
    const u = this.queue.find((x) => !(this.notBefore.get(x) > now));
    if (!u) {
      if (!this.queue.length) return 0;
      this.batchDone();                                                // only playlists that weren't ready are left
      return Math.max(this.T.roomMs, Math.min(...this.queue.map((x) => this.notBefore.get(x))) - now);
    }
    const wait = Math.max(this.pauseUntil, this.lastRead + this.T.gapMs) - now;
    if (wait > 0) return wait;
    if (!this.catalog.bgRoom()) { this.why(this.catalog.bgWhy ? this.catalog.bgWhy() : 'no room'); return this.T.roomMs; }
    const pl = this.row(u);
    if (!pl) { this.dequeue(u); return 0; }                            // (the library changed meanwhile)
    const t0 = Date.now();
    let r;
    try {
      r = await this.catalog.readUris(u, pl, this.T.waitMs);
    } catch (e) {
      this.note('errors');
      if (e.code === 'not_found') { this.notBefore.set(u, Date.now() + this.T.goneMs); return this.T.gapMs; }    // not listable
      this.pauseUntil = Date.now() + this.T.pauseMs;
      log.warn(`membership: a playlist read failed (${e.code || 'error'}): no reads for ${Math.round(this.T.pauseMs / 1000)} s`);
      return this.T.pauseMs;
    } finally {
      this.lastRead = Date.now();
    }
    if (!r) {
      this.why(`a read wasn't ready within ${Math.round(this.T.waitMs / 1000)} s`);
      this.notBefore.set(u, Date.now() + this.T.laterMs);
      this.note('later');
      return this.T.gapMs;
    }
    // A write to it landed while it was read: the listing may predate it (a Web API remove doesn't drop the engine's
    // copy), and the write had no current entry to change. Read again (the catalog refreshes a listing older than a
    // remove; an add dropped the engine's copy).
    if ((this.wrote.get(u) || 0) >= t0) { this.note('later'); return this.T.gapMs; }
    // (a listing newer than the library keeps its own revision: it is answered once the library shows it)
    this.put(u, r.v || pl.v || '', idsOf(r.uris), r.trunc);
    this.dequeue(u);
    this.note('read');
    return this.T.gapMs;
  }

  // one line at most once a minute while playlists wait: what the worker is waiting for (no names)
  why(msg) {
    if (Date.now() - this.whyAt < 60000) return;
    this.whyAt = Date.now();
    const b = this.batch;
    log.info(`membership: ${this.queue.length} playlists to index (${b ? b.stored + b.read : 0} done so far): ${msg}`);
  }

  batchDone() {
    const b = this.batch;
    this.batch = null;
    if (!b || !(b.stored + b.read)) return;                           // (failures are logged as they happen)
    log.info(`membership: ${b.stored + b.read} playlists indexed (${b.stored} from stored lists, ${b.read} read from the player)` +
      `${b.later ? `, ${b.later} reads not ready` : ''}${b.errors ? `, ${b.errors} failed` : ''} in ${Math.round((Date.now() - b.at) / 1000)} s`);
  }

  info() {
    const rows = this.rows();
    let known = 0;
    let current = 0;
    for (const pl of rows) {
      const e = this.idx.get(pl.u);
      if (e) { known++; if (this.current(e, pl)) current++; }
    }
    return { editable: rows.length, known, current, queued: this.queue.length, running: this.running,
      paused_s: Math.max(0, Math.ceil((this.pauseUntil - Date.now()) / 1000)) };
  }
}

module.exports = { Membership, TIMING };
