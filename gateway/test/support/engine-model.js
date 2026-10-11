'use strict';
// A model of go-librespot 4dbc099 + Encore patches 1 and 2 as the catalog sees it (DESIGN-3.md §4.8): the rootlist with
// revisions, context listings that fill over time (meta=0 summaries, from/limit pages, sweep=0, refresh, failed,
// sweeping, revision, fetched_at, truncated), liked, add_tracks, /status with context_track_uri, /player/*. After the
// review: a held sweep reports sweeping:true, and a failed enumeration makes /context/tracks answer 500 for a while.
// Every request is counted per context. opts.legacy = an engine without patch 2 (ignores the options, no new fields).
const { EventEmitter } = require('events');
const crypto = require('crypto');

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function id22(s) {
  const h = crypto.createHash('sha256').update(String(s)).digest();
  let out = '';
  for (let i = 0; i < 22; i++) out += B62[h[i] % 62];
  return out;
}
const hex = (s, n) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);

function trackObj(uri, o = {}) {
  const n = o.n != null ? o.n : uri.slice(-4);
  return { uri: o.gid || uri, name: o.name || `Song ${n}`, artist_names: [o.artist || 'Artist A', 'Artist B'],
    artist_uris: [`spotify:artist:${id22('ar' + (o.artist || 'A'))}`, `spotify:artist:${id22('arB')}`],
    album_name: o.album || 'Album X', album_uri: `spotify:album:${id22('al' + (o.album || 'X'))}`,
    album_cover_url: `https://i.scdn.co/image/ab67616d00001e02${hex('c' + (o.album || 'X'), 24)}`, position: 0,
    duration: o.duration || 200000, explicit: !!o.explicit, release_date: 'year:2001', track_number: 1, disc_number: 1,
    format: 'OGG_VORBIS_320', codec: 'vorbis', bitrate: 320, sample_rate: 44100, bit_depth: null };
}

class EngineModel extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.o = { enumMs: 200, batchMs: 30, batch: 100, legacy: false, metadata: true, username: 'testuser', ...opts };
    this.username = this.o.username;
    this.playlists = [];             // rootlist items (engine shape)
    this.ctxs = new Map();           // uri -> context
    this.liked = new Set();
    this.noSession = false;
    this.track = null;               // the loaded track (for /status)
    this.counts = { rootlist: 0, likedGet: 0, likedPost: 0, adds: 0, plays: [], queue: [], other: [] };
    this.log = [];                   // every request {method, path}
    this.hooks = {};                 // test hooks: evictOnPage (uri), status204Once, down (fakeEngine: not reachable)
  }

  // entries: [{ uri, meta: 'ok' | 'cached' | 'fail' | 'never', name, duration, explicit }]
  // failBatch: that batch of the context's sweeps fails as a whole (once): the sweep aborts and the context is held for
  // holdMs (patch 2: nothing moves, no sweep is scheduled until a poll after the hold). holdSweeping: the hold is
  // reported as sweeping (the engine after the review); false = as not sweeping (before it).
  // failEnum: that many enumerations of it fail (each when it would have landed): no listing, and /context/tracks answers
  // 500 for enumHoldMs (refresh=1 and the engine's own writes don't lift it); the poll after that enumerates again.
  addContext(uri, entries, { revision = '', truncated = false, enumMs, stuckSweeping = false, failBatch = 0, holdMs = 300, holdSweeping = true,
    failEnum = 0, enumHoldMs = 300 } = {}) {
    const c = { uri, entries, revision, truncated, enumMs: enumMs == null ? this.o.enumMs : enumMs, stuckSweeping,
      listing: null, cached: new Set(), failed: new Set(), sweep: null, failBatch, holdMs, holdSweeping, heldUntil: 0, batches: 0,
      failEnum, enumHoldMs, enumHeldUntil: 0,
      n: { summaries: 0, pages: 0, refresh: 0, sweep0: 0, sweepsScheduled: 0, enumerations: 0, full: 0, holds: 0, enumFails: 0, held500: 0 } };
    for (const e of entries) if (e.meta === 'cached') c.cached.add(e.uri);
    this.ctxs.set(uri, c);
    return c;
  }

  ctx(uri) { return this.ctxs.get(uri); }

  addPlaylist(item) { this.playlists.push({ description: '', folder: [], collaborative: false, image_url: null, revision: '', ...item }); }

  // the engine's own writes drop its listing; the rootlist revision moves
  invalidate(uri) { const c = this.ctxs.get(uri); if (c) { c.listing = null; if (c.sweep) { clearInterval(c.sweep); c.sweep = null; } } }

  state(c) {
    const now = Date.now();
    if (c.listing && !c.listing.ready && now >= c.listing.readyAt) {
      if (c.failEnum > 0) {                                     // the enumeration failed: no listing, the context is held
        c.failEnum--;
        c.n.enumFails++;
        c.enumHeldUntil = c.listing.readyAt + c.enumHoldMs;
        c.listing = null;
        return null;
      }
      c.listing.ready = true; c.listing.fetchedAt = c.listing.readyAt;
    }
    return c.listing;
  }

  missing(c) { return c.entries.filter((e) => !c.cached.has(e.uri) && !c.failed.has(e.uri) && e.meta !== 'never' && /^spotify:(track|episode):/.test(e.uri)); }

  startSweep(c) {
    if (c.sweep || c.stuckSweeping) return;
    if (Date.now() < c.heldUntil) return;
    if (!this.missing(c).length) return;
    c.n.sweepsScheduled++;
    c.sweep = setInterval(() => {
      if (++c.batches === c.failBatch) {
        clearInterval(c.sweep);
        c.sweep = null;
        c.heldUntil = Date.now() + c.holdMs;
        c.n.holds++;
        return;
      }
      const m = this.missing(c).slice(0, this.o.batch);
      for (const e of m) { if (e.meta === 'fail') c.failed.add(e.uri); else c.cached.add(e.uri); }
      if (!this.missing(c).length) { clearInterval(c.sweep); c.sweep = null; }
    }, this.o.batchMs);
    c.sweep.unref && c.sweep.unref();
  }

  contextTracks(q) {
    const uri = q.get('uri');
    const c = this.ctxs.get(uri);
    if (!this.o.metadata) return { status: 404, json: null };
    if (!c) return { status: 400, json: null };
    const legacy = this.o.legacy;
    const bool = (k, d) => (q.has(k) && !legacy ? !['0', 'false'].includes(q.get(k)) : d);
    const meta = bool('meta', true);
    const sweep = bool('sweep', true);
    const refresh = bool('refresh', false);
    const from = q.has('from') && !legacy ? Number(q.get('from')) : 0;
    const limit = q.has('limit') && !legacy ? Number(q.get('limit')) : Infinity;
    if (!meta) c.n.summaries++; else if (q.has('from')) c.n.pages++; else c.n.full++;
    if (refresh) { c.n.refresh++; this.invalidate(uri); }
    if (!sweep) c.n.sweep0++;
    const held = () => { c.n.held500++; return { status: 500, json: { error: 'context enumeration held after a failure' } }; };
    this.state(c);                                              // an enumeration that failed meanwhile
    if (!c.listing && Date.now() < c.enumHeldUntil) return held();
    if (!c.listing) { c.listing = { ready: false, readyAt: Date.now() + c.enumMs, revision: c.revision }; c.n.enumerations++; }
    const l = this.state(c);
    if (!l) return held();                                      // failed at once (enumMs 0)
    if (l.ready && sweep) this.startSweep(c);
    const ents = l.ready ? c.entries : [];
    const out = { uri, ready: l.ready, length: ents.length, cached: ents.filter((e) => c.cached.has(e.uri)).length };
    if (!legacy) {
      Object.assign(out, { failed: ents.filter((e) => c.failed.has(e.uri)).length,
        sweeping: !!c.sweep || c.stuckSweeping || (c.holdSweeping && Date.now() < c.heldUntil),
        revision: l.revision, fetched_at: l.ready ? l.fetchedAt : 0, truncated: c.truncated });
    }
    if (meta) {
      out.tracks = ents.slice(from, from + limit).map((e) => {
        const has = c.cached.has(e.uri) && this.hooks.evictOnPage !== e.uri;
        const it = { uri: e.uri, track: has ? trackObj(e.uri, e) : null };
        if (!legacy && c.failed.has(e.uri)) it.failed = true;
        return it;
      });
    }
    return { status: 200, json: out };
  }

  status() {
    if (this.noSession) return { status: 204, json: null };
    const t = this.track;
    return { status: 200, json: { username: this.username, device_id: 'dev1', device_type: 'SMARTPHONE', device_name: 'Encore', play_origin: null,
      play_origin_device_id: null, context_uri: t ? t.context_uri : null, context_name: null, stopped: !t, paused: !!(t && t.paused), buffering: false,
      volume: 100, volume_steps: 100, repeat_context: false, repeat_track: false, shuffle_context: !!this.shuffle,
      track: t ? { ...trackObj(t.gid || t.uri, t), position: 0, ...(this.o.legacy ? {} : { context_track_uri: t.uri }) } : null } };
  }

  // -> { status, json }
  handle(method, pathq, body) {
    const u = new URL(pathq, 'http://engine');
    const p = u.pathname;
    this.log.push({ method, path: pathq });
    if (this.noSession && p !== '/status') return { status: 204, json: null };
    if (method === 'GET' && p === '/status') return this.status();
    if (method === 'GET' && p === '/library/playlists') {
      this.counts.rootlist++;
      if (this.hooks.root204 > 0) { this.hooks.root204--; return { status: 204, json: null }; }
      const items = this.playlists.map((it) => {
        const x = { ...it };
        if (this.o.legacy) delete x.revision;
        return x;
      });
      return { status: 200, json: { total: items.length, offset: 0, limit: 500, items } };
    }
    if (method === 'GET' && p === '/context/tracks') return this.contextTracks(u.searchParams);
    if (method === 'GET' && p === '/library/liked') {
      this.counts.likedGet++;
      const uris = (u.searchParams.get('uris') || '').split(',').filter(Boolean);
      if (!uris.length || uris.length > 50 || uris.some((x) => !x.startsWith('spotify:track:'))) return { status: 400, json: null };
      return { status: 200, json: { items: uris.map((x) => ({ uri: x, liked: this.liked.has(x) })) } };
    }
    if (method === 'POST' && p === '/library/liked') {
      this.counts.likedPost++;
      for (const x of body.uris) { if (body.liked) this.liked.add(x); else this.liked.delete(x); }
      const lc = this.ctxs.get(`spotify:user:${this.username}:collection`);
      if (lc) {
        for (const x of body.uris) {
          lc.entries = lc.entries.filter((e) => e.uri !== x);
          if (body.liked) { lc.entries.unshift({ uri: x, meta: 'ok' }); }
        }
        this.invalidate(lc.uri);
      }
      return { status: 200, json: null };
    }
    if (method === 'POST' && p === '/library/playlists/add_tracks') {
      this.counts.adds++;
      const pl = this.playlists.find((x) => x.uri === body.playlist_uri);
      if (!pl) return { status: 404, json: null };
      if (!pl.can_edit) return { status: 403, json: null };
      const c = this.ctxs.get(body.playlist_uri);
      if (c) { for (const x of body.uris) c.entries.push({ uri: x, meta: 'ok' }); c.revision = hex(c.revision + 'add' + Date.now(), 16); this.invalidate(c.uri); }
      pl.length += body.uris.length;
      pl.revision = c ? c.revision : hex(pl.revision + 'add', 16);
      return { status: 200, json: null };
    }
    if (method === 'POST' && p === '/player/play') {
      this.counts.plays.push(body);
      this.shuffle = body.shuffle_context != null ? body.shuffle_context : this.shuffle;
      const first = body.skip_to_uri || 'spotify:track:' + id22('first:' + body.uri);
      this.track = { uri: first, context_uri: body.uri, gid: this.o.relink ? 'spotify:track:' + id22('gid:' + first) : null, paused: !!body.paused };
      setTimeout(() => {
        const st = this.status().json;
        if (st && st.track) this.emit('event', { type: 'metadata', data: st.track });
        if (body.shuffle_context != null) this.emit('event', { type: 'shuffle_context', data: { value: !!body.shuffle_context } });
      }, 30);
      return { status: 200, json: null };
    }
    if (method === 'POST' && p === '/player/add_to_queue') { this.counts.queue.push(body); return { status: 200, json: null }; }
    if (method === 'POST' && p === '/player/output_delay') return { status: 200, json: { delay_ms: body.delay_ms, republished: false, position_ms: 0 } };
    if (method === 'POST' && p.startsWith('/player/')) {
      this.counts.other.push(p);
      if (p === '/player/resume' && this.track) { this.track.paused = false; setTimeout(() => this.emit('event', { type: 'playing', data: {} }), 10); }
      if (p === '/player/pause' && this.track) { this.track.paused = true; setTimeout(() => this.emit('event', { type: 'paused', data: {} }), 10); }
      return { status: 200, json: null };
    }
    return { status: 404, json: null };
  }
}

// An in-process stand-in for engine.js over the model (unit tests).
function fakeEngine(model) {
  const e = new EventEmitter();
  e.connected = true;
  e.status = { username: model.username };
  const down = () => Object.assign(new Error('Encore\'s player isn\'t reachable.'), { status: 502, code: 'engine_error' });   // as engine.send
  e.get = async (p) => { await new Promise((r) => setImmediate(r)); if (model.hooks.down) throw down(); return model.handle('GET', p); };
  e.send = async (m, p, b) => { await new Promise((r) => setImmediate(r)); return model.handle(m, p, b); };
  e.call = async (p, b, m = 'POST') => { const r = model.handle(m, p, b || {}); if (r.status >= 400) throw Object.assign(new Error('x'), { code: 'engine_' + r.status }); return r.json; };
  e.refresh = async () => { const r = model.status(); e.status = r.json; if (r.json) e.emit('status', r.json); return r.json; };
  model.on('event', (ev) => e.emit('event', ev.type, ev.data));
  return e;
}

module.exports = { EngineModel, fakeEngine, trackObj, id22, hex };
