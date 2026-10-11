'use strict';
// Catalog: what the phone browses (DESIGN-3.md §3, §4.3). The app only ever sees the gateway's own short JSON; all
// Spotify knowledge stays here, in webapi.js and in image.js.
//  - Playlists: the engine's rootlist (sidebar order, folders, can_edit, revisions), fetched only for a request or a
//    write, merged with the Web API's /me/playlists (mosaic covers, owner names) at most every 10 min.
//  - Song lists (any playlist, Liked Songs): the engine's own context enumeration, the same one the player uses, so a
//    row's uri always matches what play/skip_to_uri expects. Polled as small summaries only while a phone request
//    waits (2 s at most per request, then a partial answer), rows read in pages of 500 once done, then stored and
//    reused while the playlist's revision (Liked: the Liked signal) says it is current.
//  - Albums, artists, search: the Web API (it is the only one that searches), cached.
//  - Liked state, like/unlike and adds go through the engine (no Web API budget); creating a playlist and removing songs
//    from one (0.9) need the Web API.
//  - membership.js (0.9, "Saved in") hooks in (onChange: library rebuilds, stored playlist lists, adds/removes) and
//    reads playlists' uris in the background through readUris, when bgRoom says the phone isn't using the engine.
//  - When a playlist's songs were added (0.9.x, sort by Date added; DESIGN-DATE-ADDED.md): the Web API's items, the
//    engine's listing has no dates. Stored per playlist while its library revision is current; our writes drop it.
//  - Profiles (0.10, DESIGN-PROFILES.md §2.7): PL rows carry ou (the owner's spotify:user: uri, for the "by <name>"
//    link), and a playlist header the Web API doesn't give takes the row a profile served (social.js, hintFor).
// Engine traffic is limited (one enumeration at a time, 12 per 5 min, refresh=1 once a minute per list, none for 30 s
// after one failed), and every answer is memoized (body, ETag, gzip) so a revalidation costs neither stringify nor
// compression.
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const log = require('./log');
const { JsonCache } = require('./jsoncache');
const { tokenFor } = require('./image');

const TRACK_URI = /^spotify:track:[0-9A-Za-z]{22}$/;
const ID = /^[0-9A-Za-z]{22}$/;
const PLAYLIST_URI = /^spotify:playlist:[0-9A-Za-z]{22}$/;
// a Spotify username (0.10 profiles, DESIGN-PROFILES.md §2.2): the decoded part after spotify:user:
const USER_ID = /^[^\s/\\:?#%]{1,64}$/;
const userIdOk = (id) => typeof id === 'string' && USER_ID.test(id);
const ownerUri = (id) => (userIdOk(id) ? 'spotify:user:' + encodeURIComponent(id) : undefined);
const MADE_FOR = /^(Discover Weekly|Release Radar|Daily Mix \d+|On Repeat|Repeat Rewind|Your Top Songs \d{4}|daylist.*|Your Time Capsule)$/i;
const SIM_CODES = ['rate_limited', 'engine_no_session', 'listing_off'];

// Timings and limits (tests shrink them).
const TIMING = {
  rootFresh: 30000,          // a rootlist build older than this is revalidated in the background
  rootBlock: 600000,         // ... older than this, the request waits for it
  rootGap: 10000,            // never two rootlist fetches closer than this
  rootTimeout: 15000,
  rootWait: 3000,            // a write waits this long for its forced rootlist refresh
  noSession: 1500,           // the engine answered 204 (session swap): wait, try once more
  mergeGap: 600000,          // Web API /me/playlists merge: never more often (a failed one counts too)
  mergeDebounce: 15000,
  mergeRetry: 60000,         // a merge turned away before anything went out (queue/429 gate): again after this
  sigGap: 300000,            // Liked signal (/me/tracks?limit=1): at most this often (a failed one counts too)
  sigRetry: 30000,           // ... turned away before it went out: again after this
  likedSettle: 5000,         // no Liked signal this soon after our own like/unlike (/me/tracks may not show it yet)
  pollMs: 500,               // summary polls while a phone request waits ...
  waitMs: 2000,              // ... for at most this long, then a partial answer
  summaryTimeout: 5000,
  pageTimeout: 15000,
  stallMs: 1000,             // done by the stall rule: no progress for this long while nothing sweeps
  stallHoldMs: 35000,        // ... unless songs are left without metadata: the engine holds a sweep 30 s after an error
  stallLegacyMs: 4000,       // the same for an engine without patch 2 (it doesn't say whether it sweeps)
  enumMax: 120000,           // an enumeration counts as in flight for at most this long
  enumHold: 30000,           // the engine answers 500 for 30 s after a failed enumeration: that list isn't polled meanwhile
  enumWindow: 300000,
  enumLimit: 12,             // enumerations started per window
  refreshGap: 60000,         // refresh=1 at most this often per list
  rereadMax: 300000,         // a re-read we started with refresh=1 is followed until stored, at most this long (the engine's 5-min listing cache)
  listTtl: 600000,           // lists with unavailable rows, lists not in the library, a created playlist's empty list
  headerRetry: 120000,       // a failed Web API header (playlist outside the library) is asked for again after this
  likedNoAccount: 1800000,   // the Liked listing without a Web API account (no signal to check it against)
  dupWait: 4000,             // the duplicate check waits this long for an enumeration, else it is skipped
  writeTimeout: 35000,       // the engine bounds its library calls at 30 s
  likedFresh: 60000,         // a liked state from the Map is good for this long
  likedMax: 2000,
  phoneRecent: 600000,       // the current song's liked state is checked while a phone was seen this recently
  likedDebounce: 300,
  albumTtl: 7 * 86400000,
  artistTtl: 86400000,
  searchTtl: 600000,
  searchMax: 50,
  retryMs: 2500,             // what a partial answer tells the phone
  rowsPage: 500,
  partialRows: 100,
  bgQuiet: 10000,            // no background read (membership.js) this soon after a phone's list request or write
  addedPages: 50,            // date added: Web API pages (100 items each) read per playlist at most
  warmRows: 20,              // a list's first rows whose covers the image cache makes before the phone asks (1.1.x speed)
  warmRowsTtl: 600000,       // ... once per list and rows in this long
};

const MSG = {
  rate_limited: 'Spotify is limiting requests right now. Try again in a minute.',
  engine_no_session: 'Encore\'s player is reconnecting to Spotify. Try again in a moment.',
  listing_off: 'Song lists are turned off on the Encore player (metadata.enabled).',
  engine_error: 'Encore\'s player didn\'t answer. Try again in a moment.',
  busy: 'Encore is loading other lists. Try again in a moment.',
};

const fail = (status, code, message, extra) => Object.assign(new Error(message), { status, code }, extra);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

// Drop absent values: the phone never gets a null.
function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === '' || Number.isNaN(o[k])) delete o[k];
  return o;
}

const ENTITIES = { amp: '&', quot: '"', lt: '<', gt: '>', apos: '\'', nbsp: ' ' };
function plainText(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] != null ? ENTITIES[e.toLowerCase()] : m;
    })
    .replace(/\s+/g, ' ').trim();
}

// Response memo: the serialized body, its ETag and (once asked for) its gzip, built once per object.
const memos = new WeakMap();
function memo(obj) {
  let m = memos.get(obj);
  if (!m) {
    const body = Buffer.from(JSON.stringify(obj));
    m = { body, etag: '"' + sha1(body).slice(0, 20) + '"', gz: null };
    m.gzip = () => m.gz || (m.gz = new Promise((resolve, reject) => zlib.gzip(body, (e, b) => (e ? reject(e) : resolve(b)))));
    memos.set(obj, m);
  }
  return m;
}

function pickImg(images, width) {
  if (!Array.isArray(images) || !images.length) return '';
  const m = images.find((x) => x && x.width === width);
  return ((m || images[0]) || {}).url || '';
}

// TR from an engine listing entry: u is the entry's own uri (what skip_to_uri matches), never the metadata uri.
function engineRow(u, t) {
  const r = { u, n: t.name, a: (t.artist_names || []).join(', '), ar: (t.artist_uris || [])[0], al: t.album_name, alu: t.album_uri,
    i: tokenFor(t.album_cover_url), d: t.duration };
  if (t.explicit) r.e = 1;
  return clean(r);
}

// TR from a Web API track (album: the album page's rows, which carry tn/dn and no cover)
function webRow(t, album) {
  const al = album || t.album || {};
  const r = { u: t.uri, n: t.name, a: (t.artists || []).filter(Boolean).map((a) => a.name).join(', '), ar: t.artists && t.artists[0] && t.artists[0].uri,
    al: al.name, alu: al.uri, i: album ? undefined : tokenFor(pickImg(al.images, 300)), d: t.duration_ms };
  if (t.explicit) r.e = 1;
  if (album) { r.tn = t.track_number; r.dn = t.disc_number; }
  return clean(r);
}

function alRow(a) {
  const ar = (a.artists || [])[0] || {};
  return clean({ u: a.uri, n: a.name, i: tokenFor(pickImg(a.images, 300)), ar: ar.name, aru: ar.uri,
    y: parseInt(String(a.release_date || '').slice(0, 4), 10) || undefined, t: a.album_type ? String(a.album_type).toLowerCase() : undefined });
}

const arRow = (a) => clean({ u: a.uri, n: a.name, i: tokenFor(pickImg(a.images, 320)) });

// A TR row the phone sent along with a like (§3.4): only known keys, sane types.
function safeRow(x) {
  const r = { u: x.u, n: String(x.n).slice(0, 300) };
  for (const k of ['a', 'al']) if (typeof x[k] === 'string') r[k] = x[k].slice(0, 500);
  for (const k of ['ar', 'alu']) if (typeof x[k] === 'string' && /^spotify:[a-z]+:[0-9A-Za-z]{22}$/.test(x[k])) r[k] = x[k];
  if (typeof x.i === 'string' && /^[A-Za-z0-9_-]{1,600}$/.test(x.i)) r.i = x.i;
  if (Number.isFinite(x.d) && x.d >= 0) r.d = Math.round(x.d);
  if (x.e === 1 || x.e === true) r.e = 1;
  return r;
}

class Catalog {
  constructor({ cfg, engine, webapi, bus, player, images, timing }) {
    Object.assign(this, { cfg, engine, webapi, bus, player, images });
    this.T = { ...TIMING, ...timing };
    this.store = new JsonCache(path.join(cfg.cacheDir, 'catalog'), {
      top: { mem: 4, keep: 0, sub: '' }, list: { mem: 20, keep: 300 }, album: { mem: 30, keep: 500 }, artist: { mem: 20, keep: 300 },
      added: { mem: 20, keep: 300 } });
    const root = this.store.getSync('top', 'root');
    this.root = root && Array.isArray(root.items) ? root : null;          // { at, username, items (engine rows), likedLen, likedOrder }
    this.webpl = this.store.getSync('top', 'webpl');                       // { at, map: id -> {img, owner}, missing: [ids] }
    this.likedLen = this.root ? this.root.likedLen : undefined;            // the stored Liked listing's length
    this.likedOrder = (this.root && this.root.likedOrder) || 'unknown';
    this.build = null;             // { obj, byId: id -> { pl, raw }, sig }
    this.rootFetchAt = 0;
    this.rootFlight = null;
    this.rootErr = null;
    this.forced = null;
    this.mergeFlight = null;
    this.mergeTimer = null;
    this.mergeNext = 0;            // no merge before this (the last attempt failed or was turned away)
    this.likedSig = null;          // { total, first, at }
    this.sigFlight = null;
    this.sigNext = 0;              // no Liked signal before this (the last one failed or was turned away)
    this.likedWriteAt = 0;         // when our last like/unlike landed in the engine
    this.likedStates = new Map();  // uri -> { s, at } (not "liked": that is the route method)
    this.prevSum = new Map();      // ctx -> { cf, at, fetched, held } (the stall rule, across phone requests)
    this.firstCached = new Map();  // ctx -> cached at the first summary since the last store (engine_est)
    this.lastPoll = new Map();     // ctx -> time of its last summary
    this.enums = new Map();        // ctx -> since: enumerations seen running (ready:false)
    this.holds = new Map();        // ctx -> until: the engine failed its enumeration (500), no poll of it before then
    this.enumStarts = [];
    this.lastRefresh = new Map();  // ctx -> time of its last refresh=1
    this.rereads = new Map();      // ctx -> time of the refresh=1 that started a re-read not stored yet
    this.removedAt = new Map();    // ctx -> time of our last Web API remove (the engine's listing doesn't see it)
    this.addedDrops = new Map();   // playlist id -> time of our last write to it: dates read before then are not used
    this.addedStale = new WeakMap(); // stored dates -> their stale answer
    this.flights = new Map();
    this.chains = new Map();
    this.headers = new Map();      // ctx -> { exp, h }: Web API headers of playlists outside the library
    this.replies = new WeakMap();  // stored listing -> { hs, obj, stale }
    this.searches = new Map();     // key -> { at, obj }
    this.warmed = new Set();
    this.rowWarm = new Map();      // sha1(list key + its first rows' covers) -> when they were handed to the image cache
    this.pollAt = 0;
    this.est = 0;
    this.listing = 'unknown';
    this.legacy = false;           // the engine ignores (or refuses) the patch-2 listing options
    this.offLogged = false;
    this.sim = null;
    this.albumsCap = 20;
    this.fgAt = 0;                 // a phone's last list request or playlist write (bgRoom)
    this.hooks = [];               // onChange
    this.hintFor = null;           // (0.10) id -> a PL row social.js served (main.js sets it)
    if (this.root) this.rebuild(false);
    engine.on('event', (type, d) => { if (type === 'metadata') this.onTrack(d); });
    engine.on('connected', () => this.probeListing(3));
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

  // (1.1.x speed) The covers of the first rows of a list the phone opened, at its row size (88/216), made by the image
  // cache before the phone scrolls to them: its list lane, at the front (the list opened last goes first), idle-only,
  // one ffmpeg run at a time. Once per list and rows in 10 min, so the phone's polls of a list in progress and its
  // revalidations don't queue it again. Returns body (for `return memo(this.warmRows(...))`).
  // tag (search): the rows the last call with it queued that still wait are dropped (Images.prewarm)
  warmRows(key, rows, body, tag) {
    if (!this.images || typeof this.images.prewarm !== 'function' || !Array.isArray(rows)) return body;
    const tokens = [];
    for (const r of rows.slice(0, this.T.warmRows)) if (r && typeof r.i === 'string' && r.i && !tokens.includes(r.i)) tokens.push(r.i);
    if (!tokens.length) return body;
    const k = sha1(key + '>' + tokens.join(','));
    const at = this.rowWarm.get(k);
    if (at && Date.now() - at < this.T.warmRowsTtl) return body;
    this.rowWarm.delete(k);
    this.rowWarm.set(k, Date.now());
    while (this.rowWarm.size > 300) this.rowWarm.delete(this.rowWarm.keys().next().value);
    this.images.prewarm(tokens, tag ? { first: true, tag } : { first: true });
    return body;
  }

  // writes to one playlist, one after another
  chain(id, fn) {
    const job = (this.chains.get(id) || Promise.resolve()).then(fn);
    const tail = job.catch(() => {});
    this.chains.set(id, tail);
    tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return job;
  }

  // fn(type, data): 'library' (the build was made again), 'list' {u, v, uris, trunc} (a playlist's song list was stored;
  // trunc: the engine cut it at metadata.max_tracks), 'write' {u, op, uris, before, after} (an add/remove landed;
  // before/after: the library's revision around it)
  onChange(fn) { this.hooks.push(fn); }

  notify(type, data) {
    for (const fn of this.hooks) { try { fn(type, data); } catch (e) { log.warn('catalog hook:', e.message); } }
  }

  username() {
    const s = this.engine.status;
    return (s && s.username) || (this.webapi.user && this.webapi.user.id) || (this.root && this.root.username) || '';
  }

  myName() { return (this.webapi.user && this.webapi.user.name) || this.username(); }
  likedCtx() { const me = this.username(); return me ? `spotify:user:${me}:collection` : ''; }

  likedCount() {
    const a = Number.isFinite(this.likedLen) ? this.likedLen : -1;
    const b = this.likedSig && Number.isFinite(this.likedSig.total) ? this.likedSig.total : -1;
    const n = Math.max(a, b);
    return n >= 0 ? n : undefined;
  }

  simulate(code, seconds) {
    if (!code) { this.sim = null; return null; }
    if (!SIM_CODES.includes(code)) throw fail(400, 'bad_request', 'code must be one of ' + SIM_CODES.join(', '));
    const s = Math.max(1, Math.min(3600, Number(seconds) || 60));
    this.sim = { code, until: Date.now() + s * 1000 };
    log.info(`catalog: simulating ${code} for ${s} s`);
    return { code, seconds: s };
  }

  simCheck() {
    const s = this.sim;
    if (!s) return;
    if (Date.now() >= s.until) { this.sim = null; return; }
    throw fail(503, s.code, MSG[s.code], { retry_after: Math.ceil((s.until - Date.now()) / 1000) });
  }

  checkUris(a, min) {
    if (!Array.isArray(a) || a.length < min || a.length > 50) throw fail(400, 'bad_request', `Send ${min} to 50 song uris.`);
    for (const u of a) if (typeof u !== 'string' || !TRACK_URI.test(u)) throw fail(400, 'bad_request', 'Only songs (spotify:track:…) can be added or liked.');
    return [...new Set(a)];
  }

  // ------------------------------------------------------------------ root list (§4.3.1)
  plRow(it, me, detail) {
    const id = it.uri.slice(17);
    const own = !!me && it.owner_username === me;
    const ed = !!it.can_edit;
    // Spotify's own playlists (Discover Weekly, radios, Top Songs) get a new revision every few minutes even when their
    // songs don't change (seen live 2026-10-05): judge them by the list lifetime instead, so the library's ETag and
    // their stored listings don't churn
    const v = it.owner_username === 'spotify' ? undefined : it.revision || undefined;
    const w = this.webpl && this.webpl.map && this.webpl.map[id];
    const o = own ? this.myName() : it.owner_username === 'spotify' ? 'Spotify' : (w && w.owner) || it.owner_username;
    const pl = { u: it.uri, n: it.name, i: tokenFor(it.image_url) || (w && tokenFor(w.img)) || undefined, o, ou: ownerUri(it.owner_username),
      own: own ? 1 : undefined, ed: ed ? 1 : undefined, c: it.collaborative || (ed && !own) ? 1 : undefined,
      mf: it.owner_username === 'spotify' && MADE_FOR.test(it.name) ? 1 : undefined,
      len: it.length || 0, f: Array.isArray(it.folder) && it.folder.length ? it.folder : undefined, v };
    if (detail) pl.d = plainText(it.description);
    return clean(pl);
  }

  // Rebuild the /v1/playlists body from the stored rootlist + merge. push: tell the phones when it changed.
  rebuild(push = true) {
    const r = this.root;
    if (!r) return;
    const me = this.username();
    const items = [];
    const byId = new Map();
    const tokens = [];
    for (const it of r.items) {
      if (!it || typeof it.uri !== 'string' || !PLAYLIST_URI.test(it.uri)) continue;
      if (!it.name || (it.owner_username === 'spotify' && !it.length)) continue;          // junk entries
      const pl = this.plRow(it, me, false);
      items.push(pl);
      byId.set(it.uri.slice(17), { pl, raw: it });
      if (pl.i && !this.warmed.has(pl.i)) { this.warmed.add(pl.i); tokens.push(pl.i); }
    }
    const obj = {};
    if (me) {
      obj.me = { id: me, n: this.myName() || me };
      obj.liked = clean({ ctx: `spotify:user:${me}:collection`, len: this.likedCount() });
    }
    obj.items = items;
    const old = this.build;
    this.build = { obj, byId, sig: this.buildSig() };
    if (push && old && memo(old.obj).etag !== memo(obj).etag) this.bus.push('playlists', {});
    if (push && old) {
      for (const [id, { pl }] of byId) {
        const o = old.byId.get(id);
        if (o && pl.v && o.pl.v !== pl.v) this.store.has('list', sha1(pl.u)).then((has) => { if (has) this.bus.push('playlist', { u: pl.u, len: pl.len }); });
      }
    }
    if (tokens.length && this.images) this.images.prewarm(tokens);
    this.notify('library', {});
  }

  buildSig() { return `${this.username()}|${this.myName()}|${this.likedCount()}`; }
  rebuildIfStale() { if (this.root && (!this.build || this.build.sig !== this.buildSig())) this.rebuild(true); }

  saveRoot() {
    if (!this.root) return;
    this.root.likedLen = this.likedLen;
    this.root.likedOrder = this.likedOrder;
    this.store.put('top', 'root', this.root);
  }

  fetchRoot() {
    if (this.rootFlight) return this.rootFlight;
    this.rootFetchAt = Date.now();
    this.rootFlight = (async () => {
      const get = async () => { this.est++; return this.engine.get('/library/playlists?offset=0&limit=500', { timeoutMs: this.T.rootTimeout }); };
      let r = await get();
      if (r.status === 204) { await sleep(this.T.noSession); r = await get(); }
      if (r.status === 204) throw fail(503, 'engine_no_session', MSG.engine_no_session, { retry_after: 5 });
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) throw fail(502, 'engine_error', 'Encore\'s player couldn\'t list your playlists.');
      const me = this.username();
      this.root = { at: Date.now(), username: me || (this.root && this.root.username) || '', items: r.json.items };
      this.rootErr = null;
      this.rebuild(true);
      this.saveRoot();
      this.mergeUnknown();
      return this.build;
    })().catch((e) => { this.rootErr = { at: Date.now(), code: e.code }; throw e; })
      .finally(() => { this.rootFlight = null; });
    return this.rootFlight;
  }

  // A refresh after our own write: now, or 10 s after the last fetch when that was less than 10 s ago (the cached build
  // already carries the write meanwhile).
  forceRoot() {
    const wait = this.rootFetchAt + this.T.rootGap - Date.now();
    if (wait <= 0 && !this.rootFlight) return this.fetchRoot();
    if (!this.forced) {
      this.forced = new Promise((resolve, reject) => {
        setTimeout(() => { this.forced = null; this.fetchRoot().then(resolve, reject); }, Math.max(0, wait));
      });
      this.forced.catch(() => {});
    }
    return this.forced;
  }

  // After our own write: the forced refresh, waited for (at most rootWait) so the answer carries the new revision. One
  // that rootGap defers past the wait can't land within it: the cached build (which carries the write) answers at once
  // (a "Saved in" Done sends its writes one after another, each would sit out the whole wait).
  async settleRoot() {
    const defer = this.rootFetchAt + this.T.rootGap - Date.now();
    const p = this.forceRoot().catch(() => {});
    if (defer >= this.T.rootWait) return;
    await Promise.race([p, sleep(this.T.rootWait)]);
  }

  bgRoot() { if (!this.rootFlight && Date.now() - this.rootFetchAt >= this.T.rootGap) this.fetchRoot().catch(() => {}); }

  // The root list as the phone should see it now: waits only when there is none or it is very old.
  async rootNow(fresh) {
    const age = this.root ? Date.now() - this.root.at : Infinity;
    const gapOk = Date.now() - this.rootFetchAt >= this.T.rootGap;
    if (!this.build || ((age > this.T.rootBlock || fresh) && gapOk)) {
      try { await this.fetchRoot(); } catch (e) { if (!this.build) throw e; }
    } else if (age > this.T.rootFresh) this.bgRoot();
    this.rebuildIfStale();
    return this.build;
  }

  async library(fresh) {
    this.simCheck();
    this.signal();
    await this.rootNow(fresh);
    this.mergeMaybe();
    const stale = this.rootErr && (!this.root || this.rootErr.at > this.root.at);
    return memo(stale ? { ...this.build.obj, stale: 1 } : this.build.obj);
  }

  // ------------------------------------------------------------------ Web API merge (covers + owner names)
  mergeMaybe() {
    if (!this.webapi.ready) return;
    if (!this.webpl || Date.now() - this.webpl.at >= this.T.mergeGap) this.merge();
  }

  // A rootlist shows a playlist of mine with no picture that the merge doesn't know (a new one): merge early, but still
  // never within 10 min of the last one. Ids the merge didn't return (Spotify's, junk) never trigger it.
  mergeUnknown() {
    if (!this.webapi.ready || !this.build || this.mergeTimer) return;
    const known = this.webpl ? new Set([...Object.keys(this.webpl.map || {}), ...(this.webpl.missing || [])]) : new Set();
    let unknown = false;
    for (const [id, { pl, raw }] of this.build.byId) if (pl.own && !raw.image_url && !known.has(id)) { unknown = true; break; }
    if (!unknown) return;
    const at = Math.max(Date.now() + this.T.mergeDebounce, this.webpl ? this.webpl.at + this.T.mergeGap : 0, this.mergeNext);
    this.mergeTimer = setTimeout(() => { this.mergeTimer = null; this.merge(); }, at - Date.now());
    this.mergeTimer.unref();
  }

  merge() {
    if (this.mergeFlight || !this.webapi.ready) return this.mergeFlight;
    if (this.webpl && Date.now() - this.webpl.at < this.T.mergeGap) return null;
    if (Date.now() < this.mergeNext) return null;                    // the last attempt failed or was turned away
    this.mergeFlight = (async () => {
      const map = {};
      for (let page = 0; page < 3; page++) {
        const j = await this.webapi.api('GET', `/me/playlists?limit=50&offset=${page * 50}`, undefined, { quiet: true });
        // turned away (busy/limited): soon again if nothing went out yet, else not within the 10 min either
        if (j === undefined) { this.mergeNext = Date.now() + (page ? this.T.mergeGap : this.T.mergeRetry); return; }
        for (const p of (j && j.items) || []) {
          if (p && p.id) map[p.id] = clean({ img: p.images && p.images[0] && p.images[0].url, owner: p.owner && p.owner.display_name, pub: p.public === false ? 0 : p.public ? 1 : undefined });
        }
        if (!j || !j.next) break;
      }
      const missing = this.root ? this.root.items.map((it) => String((it && it.uri) || '').slice(17)).filter((id) => ID.test(id) && !map[id]) : [];
      this.webpl = { at: Date.now(), map, missing };
      this.store.put('top', 'webpl', this.webpl);
      this.rebuild(true);
    })().catch((e) => { this.mergeNext = Date.now() + this.T.mergeGap; log.warn('playlist merge:', e.message); })   // a real failure counts as a merge
      .finally(() => { this.mergeFlight = null; });
    return this.mergeFlight;
  }

  // ------------------------------------------------------------------ the Liked signal (§4.3.4)
  signal() {
    if (this.sigFlight || !this.webapi.ready) return;
    if (this.likedSig && Date.now() - this.likedSig.at < this.T.sigGap) return;
    if (Date.now() < this.sigNext) return;
    if (Date.now() - this.likedWriteAt < this.T.likedSettle) return;   // right after our own like: the next request asks
    const t0 = Date.now();
    this.sigFlight = this.webapi.api('GET', '/me/tracks?limit=1', undefined, { quiet: true }).then(async (j) => {
      if (j === undefined) { this.sigNext = Date.now() + this.T.sigRetry; return; }      // turned away: nothing went out
      if (!j || !Number.isFinite(j.total)) { this.sigNext = Date.now() + this.T.sigGap; return; }
      // a like/unlike of ours landed meanwhile: this answer may predate it (likedSig.at stays 0: the next request asks)
      if (this.likedWriteAt >= t0) return;
      const it = j.items && j.items[0];
      const old = this.likedSig;
      this.likedSig = { total: j.total, first: (it && it.track && it.track.uri) || '', at: Date.now() };
      // a Liked listing patched by our own likes takes the next signal as its baseline
      const ctx = this.likedCtx();
      const st = ctx && await this.store.get('list', sha1(ctx));
      if (st && !st.sig) this.store.put('list', sha1(ctx), { ...st, sig: { total: this.likedSig.total, first: this.likedSig.first } });
      if (!old || old.total !== j.total) this.rebuildIfStale();
    }).catch(() => { this.sigNext = Date.now() + this.T.sigGap; })
      .finally(() => { this.sigFlight = null; });
  }

  // ------------------------------------------------------------------ song lists from the engine (§4.3.2)
  // Does the engine list songs (metadata.enabled)? Asked once its events connect: a context it can't list answers 400
  // when listings are on and 404 when they are off, without anything going to Spotify. 204 (no session yet): again.
  async probeListing(tries) {
    let r = null;
    try { r = await this.engine.get('/context/tracks?uri=' + encodeURIComponent('spotify:search:encore'), { timeoutMs: this.T.summaryTimeout }); }
    catch (e) { /* not reachable now: a list request tells later */ }
    if (r && r.status === 400) { this.listing = 'on'; this.offLogged = false; return; }
    if (r && r.status === 404) {
      this.listing = 'off';
      if (!this.offLogged) { this.offLogged = true; log.warn('the engine answers 404 to /context/tracks: metadata.enabled is off, song lists are unavailable'); }
      return;
    }
    if (tries > 1) setTimeout(() => this.probeListing(tries - 1), 5000).unref();
  }

  listValid(st, kind, pl) {
    if (!st || st.inv) return false;
    if (st.exp) return Date.now() < st.exp;
    // un rows the stall rule made (songs the engine never reported failed) are read again after 10 min, Liked too
    if (st.sun && Date.now() - st.at >= this.T.listTtl) return false;
    if (pl && pl.v && !st.un) return !!st.v && st.v === pl.v;
    if (kind === 'liked') {
      if (!this.webapi.ready) return Date.now() - st.at < this.T.likedNoAccount;
      const s = this.likedSig;
      return !st.sig || !s || (st.sig.total === s.total && st.sig.first === s.first);
    }
    return Date.now() - st.at < this.T.listTtl;
  }

  async playlist(id, fresh) {
    this.simCheck();
    const ctx = 'spotify:playlist:' + id;
    // the cached rootlist: only GET /v1/playlists and our writes revalidate it (a list's polls would cost one per 30 s)
    if (!this.build) { try { await this.rootNow(false); } catch (e) { /* not in the library as far as we know */ } }
    else this.rebuildIfStale();
    const ent = this.build && this.build.byId.get(id);
    let h = ent ? this.plRow(ent.raw, this.username(), true) : await this.webHeader(id);
    // (0.10) a playlist outside the library whose header the Web API doesn't give (another person's, under dev mode): the
    // row a profile served (social.js hints), so the page has a name, a cover and an owner line
    if (!h.n && this.hintFor) { const x = this.hintFor(id); if (x && x.n) h = { ...x, u: ctx }; }
    return this.list(ctx, { kind: 'playlist', pl: ent ? ent.pl : null, fresh, header: h });
  }

  async liked(fresh) {
    this.simCheck();
    this.signal();
    if (!this.username()) { try { await this.rootNow(false); } catch (e) { /* below */ } }
    const ctx = this.likedCtx();
    if (!ctx) throw fail(503, 'engine_no_session', MSG.engine_no_session, { retry_after: 5 });
    return this.list(ctx, { kind: 'liked', pl: null, fresh, header: { n: 'Liked Songs' } });
  }

  // The header of a playlist outside the library (opened from search). 403/404 -> {u} (the app keeps its search row).
  async webHeader(id) {
    const ctx = 'spotify:playlist:' + id;
    const c = this.headers.get(ctx);
    if (c && Date.now() < c.exp) return c.h;
    if (!this.webapi.ready) return { u: ctx };
    let h = { u: ctx };
    let ttl = this.T.listTtl;
    try {
      const j = await this.webapi.api('GET', `/playlists/${id}?fields=${encodeURIComponent('name,description,images,owner(id,display_name)')}`);
      if (j) {
        const me = this.username();
        const ow = j.owner || {};
        h = clean({ u: ctx, n: j.name, i: tokenFor(pickImg(j.images)), o: ow.id === me ? this.myName() : ow.id === 'spotify' ? 'Spotify' : ow.display_name || ow.id,
          ou: ownerUri(ow.id), own: ow.id && ow.id === me ? 1 : undefined, d: plainText(j.description) });
      }
    } catch (e) {
      // anything but 403/404: what we had, asked again in 2 min (not on every partial poll of the list)
      if (e.status !== 403 && e.status !== 404) { if (c) h = c.h; ttl = this.T.headerRetry; }
    }
    this.headers.set(ctx, { exp: Date.now() + ttl, h });
    if (this.headers.size > 100) this.headers.delete(this.headers.keys().next().value);
    return h;
  }

  // Limiter (step 2): one enumeration in flight, at most 12 started per 5 min.
  limited(ctx) {
    const now = Date.now();
    for (const [c, since] of this.enums) if (now - since > this.T.enumMax) this.enums.delete(c);
    for (const c of this.enums.keys()) if (c !== ctx) return { wait: true, other: c };
    if (this.enums.has(ctx)) return null;
    while (this.enumStarts.length && now - this.enumStarts[0] > this.T.enumWindow) this.enumStarts.shift();
    if (this.enumStarts.length >= this.T.enumLimit) return { busy: true, retry: Math.max(1, Math.ceil((this.enumStarts[0] + this.T.enumWindow - now) / 1000)) };
    return null;
  }

  // The engine answered 5xx for a list (patch 2: its enumeration failed, and it answers 500 for 30 s): nothing of it is
  // in flight any more, a re-read we followed has ended, and it isn't polled again before enumHold is over.
  hold(ctx) {
    this.holds.delete(ctx);
    this.holds.set(ctx, Date.now() + this.T.enumHold);
    if (this.holds.size > 200) this.holds.delete(this.holds.keys().next().value);
    this.enums.delete(ctx);
    this.prevSum.delete(ctx);
    this.firstCached.delete(ctx);
    this.rereads.delete(ctx);
  }

  // seconds left of a list's hold (0: none)
  heldFor(ctx) {
    const until = this.holds.get(ctx);
    if (!until) return 0;
    if (Date.now() >= until) { this.holds.delete(ctx); return 0; }
    return Math.ceil((until - Date.now()) / 1000);
  }

  async list(ctx, { kind, pl, fresh, header }) {
    this.fgAt = Date.now();
    const key = sha1(ctx);
    const stored = await this.store.get('list', key);
    // A re-read we started with refresh=1 is followed until it is stored: the old copy isn't answered meanwhile (the
    // app's next polls would get it back as done), and a fresh=1 during it doesn't start the engine over.
    const rereading = Date.now() - (this.rereads.get(ctx) || 0) < this.T.rereadMax;
    const forced = !!fresh && !rereading && Date.now() - (this.lastRefresh.get(ctx) || 0) >= this.T.refreshGap;
    if (stored && !forced && !rereading && this.listValid(stored, kind, pl)) return this.listReply(stored, kind, header);
    // its enumeration failed a moment ago: the engine would only answer 500 again
    const holdLeft = this.heldFor(ctx);
    if (holdLeft) {
      if (stored) return this.listReply(stored, kind, header, true);
      throw fail(502, 'engine_error', MSG.engine_error, { retry_after: holdLeft });
    }
    let block = this.limited(ctx);
    // The list in flight may have finished with nobody polling it (the phone went elsewhere): one summary tells (sweep=0:
    // it may be a playlist only the duplicate check enumerated).
    if (block && block.other && Date.now() - (this.lastPoll.get(block.other) || 0) >= 1000) {
      try { this.observe(block.other, await this.summary(block.other, false, false)); } catch (e) { /* engine_error freed its slot, else still in flight */ }
      block = this.limited(ctx);
    }
    if (block) {
      if (stored) return this.listReply(stored, kind, header, true);
      if (block.busy) throw fail(503, 'busy', MSG.busy, { retry_after: block.retry });
      return this.partial(ctx, null, { kind, pl, header });
    }
    try {
      return await this.single('list:' + ctx, () => this.poll(ctx, { kind, pl, stored, forced, rereading, header }));
    } catch (e) {
      if (stored && e.status >= 500) return this.listReply(stored, kind, header, true);
      throw e;
    }
  }

  // ≤ 2 listing polls per second, whoever asks
  async pollGate() {
    const now = Date.now();
    const at = Math.max(now, this.pollAt + this.T.pollMs);
    this.pollAt = at;
    if (at > now) await sleep(at - now);
  }

  // One GET /context/tracks with the patch-2 options (a stock engine ignores them, or refuses them with 400: then
  // whole listings from then on). 404 = metadata disabled, 400 = not a listable context, 204 = no session right now.
  async ctxGet(ctx, opts, timeoutMs) {
    const base = '/context/tracks?uri=' + encodeURIComponent(ctx);
    const get = () => this.engine.get(this.legacy || !opts ? base : base + opts, { timeoutMs });
    let r = await get();
    if (r.status === 400 && opts && !this.legacy) {
      const plain = await this.engine.get(base, { timeoutMs });
      if (plain.status !== 400) { this.legacy = true; log.info('the engine refuses the listing options (no Encore patch 2): reading whole listings'); r = plain; }
    }
    if (r.status === 204) { await sleep(this.T.noSession); r = await get(); }
    if (r.status === 204) throw fail(503, 'engine_no_session', MSG.engine_no_session, { retry_after: 5 });
    if (r.status === 404) {
      this.listing = 'off';
      if (!this.offLogged) { this.offLogged = true; log.warn('the engine answers 404 to /context/tracks: metadata.enabled is off, song lists are unavailable'); }
      throw fail(503, 'listing_off', MSG.listing_off, { retry_after: 60 });
    }
    if (r.status === 400) throw fail(404, 'not_found', 'This list isn\'t available.');
    if (r.status >= 500) { this.hold(ctx); throw fail(502, 'engine_error', MSG.engine_error, { retry_after: Math.ceil(this.T.enumHold / 1000) }); }
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') throw fail(502, 'engine_error', MSG.engine_error);
    this.listing = 'on';
    this.offLogged = false;
    const j = r.json;
    if (!('sweeping' in j) && !this.legacy) this.legacyFields = true;     // patch-2 fields missing: an older engine
    return { ready: !!j.ready, length: j.length | 0, cached: j.cached | 0, failed: j.failed | 0, sweeping: !!j.sweeping,
      reportsSweep: 'sweeping' in j, revision: typeof j.revision === 'string' ? j.revision : '', fetched_at: Number(j.fetched_at) || 0,
      truncated: !!j.truncated, tracks: Array.isArray(j.tracks) ? j.tracks : null };
  }

  async summary(ctx, refresh, sweep = true) {
    await this.pollGate();
    this.lastPoll.set(ctx, Date.now());
    try {
      return await this.ctxGet(ctx, `&meta=0${refresh ? '&refresh=1' : ''}${sweep ? '' : '&sweep=0'}`, this.T.summaryTimeout);
    } catch (e) {
      // the engine failed (5xx: ctxGet holds the list) or didn't answer: nothing shows an enumeration of it is still
      // running, so it doesn't keep the other lists waiting for up to enumMax
      if (e.code === 'engine_error') this.enums.delete(ctx);
      throw e;
    }
  }

  // Bookkeeping per summary: enumerations in flight (limiter + engine_est), the stall rule's memory.
  observe(ctx, s) {
    const now = Date.now();
    if (!s.ready) {
      if (!this.enums.has(ctx)) { this.enums.set(ctx, now); this.enumStarts.push(now); }
    } else if (this.enums.has(ctx)) {
      this.enums.delete(ctx);
      this.est += Math.ceil(s.length / 50) + (ctx.startsWith('spotify:playlist:') ? 0 : 1);   // pages (+ the resolve)
    }
    if (s.ready && !this.firstCached.has(ctx)) this.firstCached.set(ctx, s.cached);
    const cf = s.cached + s.failed;
    const p = this.prevSum.get(ctx);
    if (!p || p.cf !== cf || p.fetched !== s.fetched_at || !s.ready || s.sweeping) this.prevSum.set(ctx, { cf, at: now, fetched: s.fetched_at });
    if (this.prevSum.size > 200) this.prevSum.delete(this.prevSum.keys().next().value);
  }

  // p.held: the last stall left songs without metadata, so it waits out the engine's sweep hold before finishing
  stalled(ctx, s) {
    const p = this.prevSum.get(ctx);
    if (!p || !s.ready || s.sweeping) return false;
    return Date.now() - p.at >= (!s.reportsSweep ? this.T.stallLegacyMs : p.held ? this.T.stallHoldMs : this.T.stallMs);
  }

  async poll(ctx, { kind, pl, stored, forced, rereading, header }) {
    const t0 = Date.now();
    const canRefresh = () => Date.now() - (this.lastRefresh.get(ctx) || 0) >= this.T.refreshGap;
    // the engine keeps listings 5 min: a stored listing at another revision (Liked: one the signal made invalid) means
    // its copy may be old too. Only when a re-read starts: a refresh=1 during one would make the engine start over.
    let refresh = forced || (!!stored && !rereading && canRefresh() && (kind === 'liked' || (!!pl && !!pl.v && stored.v !== pl.v)));
    let revChecked = false;
    let s = null;
    for (;;) {
      s = await this.summary(ctx, refresh);
      if (refresh) {
        const t = Date.now();
        this.lastRefresh.set(ctx, t);
        this.rereads.set(ctx, t);
        if (this.rereads.size > 200) this.rereads.delete(this.rereads.keys().next().value);
        refresh = false;
      }
      this.observe(ctx, s);
      if (s.ready) {
        // a listing older than one of our removes (a Web API write the engine's copy doesn't show): read again
        if (kind === 'playlist' && this.beforeRemove(ctx, s) && !revChecked && canRefresh()) { revChecked = true; refresh = true; continue; }
        // revision check: an engine listing older than the rootlist is read again (once a minute at most)
        if (kind === 'playlist' && pl && pl.v && s.revision && s.revision !== pl.v) {
          if (this.root && s.fetched_at && this.root.at > s.fetched_at) {
            if (!revChecked && canRefresh()) { revChecked = true; refresh = true; continue; }
          } else this.bgRoot();                                         // the listing is the newer one
        }
        const done = s.cached + s.failed >= s.length;
        if (done || this.stalled(ctx, s)) {
          const r = await this.rows(ctx, s, { kind, stored, stall: !done });
          if (r.reply && r.held) {
            // Songs without metadata that the engine never reported failed: after a sweep error it holds the list for
            // 30 s (sweeping:false, nothing moves), and the poll after that sweeps again. Wait that out (partial) before
            // they become un rows.
            const p = this.prevSum.get(ctx);
            if (s.reportsSweep && p && !p.held) { p.held = true; return this.partial(ctx, r.s || s, { kind, pl, header, items: r.items }); }
            r.items = r.items.map((x) => (x.x ? { u: x.u, un: 1 } : x));
          }
          if (r.reply) return this.storeList(ctx, r, { kind, header });
          if (r.items) return this.partial(ctx, r.s || s, { kind, pl, header, items: r.items });
          s = r.s || s;
          if (!s.ready) return this.partial(ctx, s, { kind, pl, header });
        }
      }
      if (Date.now() - t0 + this.T.pollMs >= this.T.waitMs) break;      // the partial page takes the last slot
      await sleep(this.T.pollMs);
    }
    return this.partial(ctx, s, { kind, pl, header });
  }

  // Step 4: all rows, in pages of 500 (one page per event-loop turn), without asking the engine to sweep.
  // -> { reply: true, items, s, held } | { items } (partial: an entry's metadata was evicted) | { s } (the listing moved)
  // held: on a stall, songs with neither metadata nor failed (x rows here; poll makes them un rows when the stall is final)
  async rows(ctx, s, { kind, stored, stall }) {
    const old = stored ? new Map(stored.items.filter((r) => !r.un).map((r) => [r.u, r])) : null;
    let ref = s;
    for (let attempt = 0; attempt < 2; attempt++) {
      const items = [];
      let missing = false;
      let held = 0;
      let moved = null;
      let from = 0;
      while (from < ref.length) {
        const pg = await this.ctxGet(ctx, `&sweep=0&from=${from}&limit=${this.T.rowsPage}`, this.T.pageTimeout);
        if (!pg.ready || pg.length !== ref.length || (ref.fetched_at && pg.fetched_at !== ref.fetched_at)) { moved = pg; break; }
        const tr = pg.tracks || [];
        if (!tr.length) { moved = pg; break; }
        for (const e of tr) {
          if (!e || typeof e.uri !== 'string' || !e.uri.startsWith('spotify:track:')) continue;     // episodes, local files
          if (e.track) items.push(engineRow(e.uri, e.track));
          else if (e.failed) items.push({ u: e.uri, un: 1 });
          else if (stall) { held++; items.push({ u: e.uri, x: 1 }); }
          else if (old && old.has(e.uri)) items.push(old.get(e.uri));                              // evicted meanwhile
          else { missing = true; items.push({ u: e.uri, x: 1 }); }
        }
        from += tr.length;
        await tick();
      }
      if (moved) { ref = moved; if (!moved.ready) return { s: moved }; continue; }
      if (missing) return { items, s: ref };
      return { reply: true, items, s: ref, held };
    }
    return { s: ref };
  }

  storeList(ctx, { items, s, held }, { kind, header }) {
    if (kind === 'liked') {
      const sig = this.likedSig;
      if (sig && sig.first && items.length) {
        this.likedOrder = items[0].u === sig.first ? 'newest_first' : items[items.length - 1].u === sig.first ? 'oldest_first' : 'unknown';
      }
      if (this.likedOrder === 'oldest_first') items.reverse();
    }
    let ms = 0;
    let un = 0;
    for (const r of items) { ms += r.d || 0; if (r.un) un++; }
    // sun: how many of the un rows the stall rule made (listValid)
    const st = { ctx, kind, v: s.revision || '', sig: kind === 'liked' && this.likedSig ? { total: this.likedSig.total, first: this.likedSig.first } : null,
      at: Date.now(), len: items.length, ms, trunc: s.truncated ? 1 : 0, un, sun: held || 0, items };
    this.store.put('list', sha1(ctx), st);
    const first = this.firstCached.get(ctx);
    this.est += Math.ceil(Math.max(0, s.cached - (first == null ? s.cached : first)) / 100);       // metadata batches
    this.firstCached.delete(ctx);
    this.prevSum.delete(ctx);
    this.rereads.delete(ctx);
    if (kind === 'liked') { this.likedLen = st.len; this.saveRoot(); this.rebuildIfStale(); }
    if (kind === 'playlist' && this.hooks.length) this.notify('list', { u: ctx, v: st.v, uris: items.map((r) => r.u), trunc: !!st.trunc });
    return this.listReply(st, kind, header);
  }

  listReply(st, kind, h, stale) {
    const hs = JSON.stringify(h);
    let c = this.replies.get(st);
    if (!c || c.hs !== hs) {
      const obj = { k: kind, ctx: st.ctx };
      if (kind === 'playlist' && st.v) obj.v = st.v;
      Object.assign(obj, { h, len: st.len, have: st.len - st.un, done: 1, ms: st.ms });
      if (st.trunc) obj.trunc = 1;
      obj.items = st.items;
      c = { hs, obj, stale: null };
      this.replies.set(st, c);
    }
    this.warmRows(st.ctx, st.items);
    if (!stale) return memo(c.obj);
    return memo(c.stale || (c.stale = { ...c.obj, stale: 1 }));
  }

  // Step 5: not done within the wait. Never stored.
  async partial(ctx, s, { kind, pl, header, items }) {
    const obj = { k: kind, ctx, h: header };
    if (!s || !s.ready) {
      const len = kind === 'liked' ? this.likedCount() : pl ? pl.len : undefined;
      if (len != null) obj.len = len;
      Object.assign(obj, { wait: 1, retry_ms: this.T.retryMs, items: [] });
      return memo(obj);
    }
    Object.assign(obj, { len: s.length, have: s.cached, retry_ms: this.T.retryMs });
    let rows = items;
    if (!rows) {
      rows = [];
      try {
        const rev = kind === 'liked' && this.likedOrder === 'oldest_first';
        const from = rev ? Math.max(0, s.length - this.T.partialRows) : 0;
        await this.pollGate();
        const pg = await this.ctxGet(ctx, `&sweep=0&from=${from}&limit=${this.T.partialRows}`, this.T.pageTimeout);
        let tr = pg.tracks || [];
        if (tr.length > this.T.partialRows) tr = tr.slice(from, from + this.T.partialRows);     // an engine that ignored from/limit
        for (const e of tr) {
          if (!e || typeof e.uri !== 'string' || !e.uri.startsWith('spotify:track:')) continue;
          rows.push(e.track ? engineRow(e.uri, e.track) : e.failed ? { u: e.uri, un: 1 } : { u: e.uri, x: 1 });
        }
        if (rev) rows.reverse();
      } catch (e) { /* the phone asks again */ }
    } else if (kind === 'liked' && this.likedOrder === 'oldest_first') rows = rows.slice().reverse();
    obj.items = rows.slice(0, this.T.partialRows);
    this.warmRows(ctx, obj.items);
    return memo(obj);
  }

  // ------------------------------------------------------------------ date added (0.9.x, DESIGN-DATE-ADDED.md)
  // GET /v1/playlists/<id>/added -> { v: the library's revision of it ('' : none), items: [[track uri, added_at ms or
  // 0], …] } in the playlist's order, one entry per item (duplicates too; episodes and local files left out, like the
  // song list). Stored while the library's revision is the one it was read at (no revision: Spotify's own playlists,
  // those outside the library: listTtl); one of our writes to the playlist drops it, and a read that one landed
  // during is answered but not stored. Never logs a song.
  async added(id) {
    this.simCheck();
    // the cached rootlist, as for the song list (only GET /v1/playlists and our writes revalidate it)
    if (!this.build) { try { await this.rootNow(false); } catch (e) { /* not in the library as far as we know */ } }
    else this.rebuildIfStale();
    const ent = this.build && this.build.byId.get(id);
    const v = (ent && ent.pl.v) || '';
    const drop = this.addedDrops.get(id) || 0;
    const st = await this.store.get('added', id);
    const usable = !!st && st.at > drop && !!st.body && Array.isArray(st.body.items);
    if (usable && (v ? st.body.v === v : Date.now() - st.at < this.T.listTtl)) return memo(st.body);
    // one read per playlist (a request after one of our writes doesn't join a read that started before it)
    return this.single(`added:${id}:${drop}`, async () => {
      try {
        return memo(await this.readAdded(id, v));
      } catch (e) {
        if (!usable || !(e.status >= 500)) throw e;
        let s = this.addedStale.get(st);
        if (!s) { s = { ...st.body, stale: 1 }; this.addedStale.set(st, s); }
        return memo(s);
      }
    });
  }

  async readAdded(id, v) {
    const t0 = Date.now();
    const fields = encodeURIComponent('next,items(added_at,item(uri),track(uri))');
    const items = [];
    let offset = 0;
    try {
      for (let page = 0; page < this.T.addedPages; page++) {
        // (no market: Spotify answers the playlist's own uris, the ones the song list has, not relinked ones)
        const j = await this.webapi.api('GET', `/playlists/${id}/items?fields=${fields}&limit=100&offset=${offset}`);
        if (!j || !Array.isArray(j.items)) throw fail(502, 'spotify_error', 'Spotify sent an empty playlist.');
        for (const x of j.items) {
          const t = x && (x.item || x.track);                        // Feb 2026: item (track: the old name)
          const u = t && t.uri;
          if (typeof u !== 'string' || !u.startsWith('spotify:track:')) continue;   // episodes, local files, gone songs
          const ms = typeof x.added_at === 'string' ? Date.parse(x.added_at) : NaN;
          items.push([u, ms > 0 ? ms : 0]);                           // (very old playlists say 1970 or nothing)
        }
        offset += j.items.length;
        if (!j.next || !j.items.length) break;
      }
    } catch (e) {
      if (e.status === 403 || e.status === 404) throw fail(404, 'not_available', 'Spotify doesn\'t share when songs were added to this playlist.');
      throw e;                                                         // rate_limited, busy, spotify_not_connected, spotify_error
    }
    const body = { v, items };
    if (t0 > (this.addedDrops.get(id) || 0)) this.store.put('added', id, { at: t0, body });
    return body;
  }

  // one of our writes to the playlist (or one that may have landed): its dates are read again next time
  dropAdded(id) {
    this.addedDrops.delete(id);
    this.addedDrops.set(id, Date.now());
    if (this.addedDrops.size > 200) this.addedDrops.delete(this.addedDrops.keys().next().value);
    this.store.del('added', id).catch(() => {});
  }

  // ------------------------------------------------------------------ albums, artists, search (§4.3.3)
  async album(id) {
    this.simCheck();
    const c = await this.store.get('album', id);
    if (c && Date.now() - c.at < this.T.albumTtl) return memo(c.body);
    return this.single('album:' + id, async () => {
      try {
        const j = await this.webapi.api('GET', `/albums/${id}`);
        if (!j || !j.uri) throw fail(502, 'spotify_error', 'Spotify sent an empty album.');
        const tracks = ((j.tracks && j.tracks.items) || []).filter(Boolean);
        const total = (j.tracks && j.tracks.total) || tracks.length;
        for (let off = 50; tracks.length < total && off < 2000; off += 50) {
          const p = await this.webapi.api('GET', `/albums/${id}/tracks?offset=${off}&limit=50`);
          const more = ((p && p.items) || []).filter(Boolean);
          if (!more.length) break;
          tracks.push(...more);
        }
        const album = { name: j.name, uri: j.uri };
        const items = tracks.filter((t) => typeof t.uri === 'string' && t.uri.startsWith('spotify:track:')).map((t) => webRow(t, album));
        const cps = Array.isArray(j.copyrights) ? j.copyrights : [];
        const cp = cps.find((x) => x && x.type === 'P') || cps.find((x) => x && x.type === 'C');
        const h = clean({ ...alRow(j), cp: cp && cp.text, len: items.length });
        const body = { k: 'album', ctx: j.uri, h, len: items.length, have: items.length, done: 1, ms: items.reduce((n, r) => n + (r.d || 0), 0), items };
        this.store.put('album', id, { at: Date.now(), body });
        return memo(body);
      } catch (e) {
        if (c) return memo(c.stale || (c.stale = { ...c.body, stale: 1 }));
        throw e;
      }
    });
  }

  async artist(id) {
    this.simCheck();
    const c = await this.store.get('artist', id);
    const warm = (b) => this.warmRows('artist:' + id, [...(b.top || []), ...(b.albums || []), ...(b.singles || [])], b);
    if (c && Date.now() - c.at < this.T.artistTtl) return memo(warm(c.body));
    return this.single('artist:' + id, async () => {
      try {
        const a = await this.webapi.api('GET', `/artists/${id}`);
        if (!a || !a.uri) throw fail(502, 'spotify_error', 'Spotify sent an empty artist.');
        let alb;
        try { alb = await this.webapi.api('GET', `/artists/${id}/albums?include_groups=album,single&limit=${this.albumsCap}`); }
        catch (e) {
          if (e.spotifyStatus !== 400 || this.albumsCap <= 10) throw e;
          this.albumsCap = 10;                                           // dev mode refuses 20: remember it
          alb = await this.webapi.api('GET', `/artists/${id}/albums?include_groups=album,single&limit=10`);
        }
        let complete = true;
        let top = [];
        try {
          const q = encodeURIComponent(`artist:"${a.name}"`);
          const sr = await this.webapi.api('GET', `/search?q=${q}&type=track&limit=10`);
          top = ((sr && sr.tracks && sr.tracks.items) || []).filter((t) => t && (t.artists || []).some((x) => x && x.id === id)).slice(0, 5).map((t) => webRow(t));
        } catch (e) { complete = false; }
        const groups = { album: new Map(), single: new Map() };
        for (const x of ((alb && alb.items) || []).filter(Boolean)) {
          const g = String(x.album_group || x.album_type || '').toLowerCase();
          const m = g === 'single' ? groups.single : g === 'album' || g === 'compilation' ? groups.album : null;
          if (!m) continue;
          const k = String(x.name || '').toLowerCase();
          const prev = m.get(k);
          if (!prev || String(x.release_date || '') > String(prev.release_date || '')) m.set(k, x);   // editions: the newest
        }
        const sorted = (m) => [...m.values()].sort((p, q) => String(q.release_date || '').localeCompare(String(p.release_date || ''))).slice(0, 20).map(alRow);
        const body = { a: arRow(a), top, albums: sorted(groups.album), singles: sorted(groups.single) };
        if (complete) this.store.put('artist', id, { at: Date.now(), body });
        return memo(warm(body));
      } catch (e) {
        if (c) return memo(warm(c.stale || (c.stale = { ...c.body, stale: 1 })));
        throw e;
      }
    });
  }

  async search(qRaw, type, offset) {
    this.simCheck();
    const q = String(qRaw == null ? '' : qRaw).trim().replace(/\s+/g, ' ');
    if (!q || q.length > 100) throw fail(400, 'bad_request', 'Search needs 1 to 100 characters.');
    const songs = type != null || offset != null;                       // "See all songs": 10 more at offset N
    let off = 0;
    if (songs) {
      off = offset == null || offset === '' ? 0 : Number(offset);
      if (type !== 'track' || !Number.isInteger(off) || off < 0 || off > 990 || off % 10) throw fail(400, 'bad_request', 'See all songs needs type=track and an offset of 0 to 990 in steps of 10.');
    }
    const ql = q.toLowerCase();
    const key = songs ? `${ql}|track|${off}` : `${ql}|all`;
    const c = this.searches.get(key);
    if (c) { this.searches.delete(key); this.searches.set(key, c); }
    const warm = (o) => this.warmRows('search:' + key, [o.top && o.top.o, ...((o.tracks && o.tracks.items) || []), ...(o.artists || []), ...(o.albums || []), ...(o.playlists || [])], o, 'search');
    if (c && Date.now() - c.at < this.T.searchTtl) return memo(warm(c.obj));
    return this.single('search:' + key, async () => {
      try {
        const qq = encodeURIComponent(q);
        const j = await this.webapi.api('GET', songs ? `/search?q=${qq}&type=track&limit=10&offset=${off}` : `/search?q=${qq}&type=track,artist,album,playlist&limit=10`);
        const obj = songs ? { q: ql, tracks: this.trackPage(j && j.tracks, off) } : this.searchAll(ql, j || {});
        this.searches.set(key, { at: Date.now(), obj });
        while (this.searches.size > this.T.searchMax) this.searches.delete(this.searches.keys().next().value);
        return memo(warm(obj));
      } catch (e) {
        if (c) return memo(warm(c.stale || (c.stale = { ...c.obj, stale: 1 })));
        throw e;
      }
    });
  }

  trackPage(tr, off) {
    const items = ((tr && tr.items) || []).filter((t) => t && typeof t.uri === 'string' && t.uri.startsWith('spotify:track:')).slice(0, 10).map((t) => webRow(t));
    const total = (tr && Number(tr.total)) || 0;
    const page = { total, items };
    if (off + 10 < total && off + 10 <= 990) page.next = off + 10;
    return page;
  }

  searchAll(ql, j) {
    const me = this.username();
    const tracks = this.trackPage(j.tracks, 0);
    const artists = ((j.artists && j.artists.items) || []).filter((a) => a && a.uri).map(arRow);
    const albums = ((j.albums && j.albums.items) || []).filter((a) => a && a.uri).map(alRow);
    const playlists = ((j.playlists && j.playlists.items) || []).filter((p) => p && p.uri).map((p) => {
      const ow = p.owner || {};
      return clean({ u: p.uri, n: p.name, i: tokenFor(pickImg(p.images)), o: ow.id === me && me ? this.myName() : ow.id === 'spotify' ? 'Spotify' : ow.display_name || ow.id,
        ou: ownerUri(ow.id) });
    });
    let top;
    if (ql.length >= 3 && artists[0] && String(artists[0].n || '').toLowerCase().startsWith(ql)) top = { k: 'artist', o: artists[0] };
    else if (tracks.items[0]) top = { k: 'track', o: tracks.items[0] };
    else if (albums[0]) top = { k: 'album', o: albums[0] };
    else if (artists[0]) top = { k: 'artist', o: artists[0] };
    const obj = { q: ql };
    if (top) obj.top = top;
    Object.assign(obj, { tracks, artists: artists.slice(0, 3), albums: albums.slice(0, 3), playlists: playlists.slice(0, 3) });
    return obj;
  }

  // ------------------------------------------------------------------ liked state (§4.3.4)
  setLiked(uri, s) {
    this.likedStates.delete(uri);
    this.likedStates.set(uri, { s, at: Date.now() });
    while (this.likedStates.size > this.T.likedMax) this.likedStates.delete(this.likedStates.keys().next().value);
  }

  // engine GET /library/liked for up to 50 uris -> Map uri -> 0/1
  async engineLiked(uris) {
    const p = '/library/liked?uris=' + uris.map(encodeURIComponent).join(',');
    this.est++;
    let r = await this.engine.get(p, { timeoutMs: this.T.writeTimeout });
    if (r.status === 204) { await sleep(this.T.noSession); this.est++; r = await this.engine.get(p, { timeoutMs: this.T.writeTimeout }); }
    if (r.status === 204) throw fail(503, 'engine_no_session', MSG.engine_no_session, { retry_after: 5 });
    if (r.status === 400) throw fail(400, 'bad_request', 'Only songs (spotify:track:…) can be checked.');
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) throw fail(502, 'engine_error', MSG.engine_error);
    const m = new Map();
    for (const it of r.json.items) if (it && typeof it.uri === 'string') m.set(it.uri, it.liked ? 1 : 0);
    return m;
  }

  async contains(urisRaw) {
    this.simCheck();
    const uris = this.checkUris(String(urisRaw || '').split(',').filter(Boolean), 1);
    const out = {};
    const ask = [];
    for (const u of uris) {
      const e = this.likedStates.get(u);
      if (e && Date.now() - e.at < this.T.likedFresh) out[u] = e.s; else ask.push(u);
    }
    if (ask.length) {
      const m = await this.engineLiked(ask);
      for (const u of ask) {
        const s = m.get(u) ? 1 : 0;
        this.setLiked(u, s);
        if (this.player.noteLiked) this.player.noteLiked(u, s);
        out[u] = s;
      }
    }
    const items = {};
    for (const u of uris) items[u] = out[u];
    return memo({ items });
  }

  // The engine's 'metadata' event (a new song): check its liked state while a phone is around.
  onTrack(d) {
    const uri = d && (d.context_track_uri || d.uri);
    if (!uri || !TRACK_URI.test(uri) || uri === this.lastTrackUri) return;
    if (Date.now() - (this.player.lastPhone || 0) > this.T.phoneRecent) return;
    this.lastTrackUri = uri;
    clearTimeout(this.trackTimer);
    this.trackTimer = setTimeout(async () => {
      try {
        const known = this.likedStates.get(uri);
        const prior = known ? known.s : this.player.likedMap ? this.player.likedMap.get(uri) : undefined;
        const s = (await this.engineLiked([uri])).get(uri) ? 1 : 0;
        this.setLiked(uri, s);
        if (this.player.noteLiked) this.player.noteLiked(uri, s);
        if (prior != null && prior !== s) this.bus.push('liked', { items: [{ u: uri, s }] });
      } catch (e) { /* the phone asks itself (contains) */ }
    }, this.T.likedDebounce);
  }

  // ------------------------------------------------------------------ writes (§4.3.5)
  async save(b) {
    this.simCheck();
    if (!b || typeof b.saved !== 'boolean') throw fail(400, 'bad_request', 'saved must be true or false.');
    const uris = this.checkUris(b.uris, 1);
    // one like/unlike at a time: each one patches the stored Liked listing the one before it left
    return this.chain('liked', () => this.saveNow(uris, b));
  }

  async saveNow(uris, b) {
    const want = b.saved ? 1 : 0;
    const ctx = this.likedCtx();
    const stored = ctx ? await this.store.get('list', sha1(ctx)) : null;
    const present = stored ? new Set(stored.items.map((r) => r.u)) : null;
    let n = 0;                                                       // how many actually change
    for (const u of uris) {
      const e = this.likedStates.get(u);
      const was = e && Date.now() - e.at < this.T.likedFresh ? e.s : present ? (present.has(u) ? 1 : 0) : e ? e.s : null;
      if (was !== want) n++;
    }
    const r = await this.engine.send('POST', '/library/liked', { uris, liked: b.saved }, { timeoutMs: this.T.writeTimeout });
    this.est++;
    this.writeStatus(r.status);
    this.likedWriteAt = Date.now();
    for (const u of uris) { this.setLiked(u, want); if (this.player.noteLiked) this.player.noteLiked(u, want); }
    // patch the stored Liked listing so it isn't read again (the engine drops its own copy on every write)
    if (stored) {
      let items;
      let inv = !!stored.inv;
      if (want) {
        const rows = Array.isArray(b.rows) ? b.rows : [];
        const add = [];
        for (const u of uris) {
          if (present.has(u)) continue;
          const row = rows.find((x) => x && x.u === u && typeof x.n === 'string');
          if (!row) { inv = true; break; }                             // nothing to show for it: read the list again
          add.push(safeRow(row));
        }
        items = inv ? stored.items : [...add, ...stored.items];
      } else {
        const gone = new Set(uris);
        items = stored.items.filter((x) => !gone.has(x.u));
      }
      let ms = 0;
      let un = 0;
      for (const x of items) { ms += x.d || 0; if (x.un) un++; }
      const ns = { ...stored, items, len: inv ? Math.max(0, stored.len + (want ? n : -n)) : items.length, ms, un, sun: Math.min(stored.sun || 0, un),
        sig: null, inv: inv ? 1 : undefined };
      this.store.put('list', sha1(ctx), ns);
      this.likedLen = ns.len;
    } else if (Number.isFinite(this.likedLen)) this.likedLen = Math.max(0, this.likedLen + (want ? n : -n));
    if (this.likedSig) { this.likedSig.total = Math.max(0, this.likedSig.total + (want ? n : -n)); this.likedSig.at = 0; }
    this.saveRoot();
    this.rebuildIfStale();
    const len = this.likedCount();
    this.bus.push('liked', clean({ items: uris.map((u) => ({ u, s: want })), len }));
    const items = {};
    for (const u of uris) items[u] = want;
    return memo(clean({ items, liked_len: len }));
  }

  writeStatus(st) {
    if (st >= 200 && st < 300 && st !== 204) return;
    if (st === 204) throw fail(503, 'engine_no_session', MSG.engine_no_session, { retry_after: 5 });
    if (st === 400) throw fail(400, 'bad_request', 'Encore\'s player refused that request.');
    if (st === 403) throw fail(403, 'not_editable', 'You can\'t change this playlist.');
    if (st === 404) throw fail(404, 'not_found', 'This playlist doesn\'t exist anymore.');
    if (st === 409) throw fail(409, 'changed', 'The playlist kept changing. Try again.');
    if (st === 429) throw fail(503, 'rate_limited', MSG.rate_limited, { retry_after: 30 });
    throw fail(502, 'engine_error', MSG.engine_error);
  }

  async engineAdd(ctx, uris) {
    const r = await this.engine.send('POST', '/library/playlists/add_tracks', { playlist_uri: ctx, uris }, { timeoutMs: this.T.writeTimeout });
    this.est += 2;                                                     // revision + append
    this.writeStatus(r.status);
  }

  async items(id, b) {
    this.simCheck();
    if (!b || (b.op !== 'add' && b.op !== 'remove')) throw fail(400, 'bad_request', 'op must be "add" or "remove".');
    const uris = this.checkUris(b.uris, 1);
    this.fgAt = Date.now();
    if (b.op === 'remove') return this.chain(id, () => this.remove(id, uris));
    return this.chain(id, () => this.add(id, uris, b.allow_duplicates === true));
  }

  // the playlist's library entry, for a write (403 when it can't be edited)
  async writable(id) {
    let ent = this.build && this.build.byId.get(id);
    if (!ent) { await this.fetchRoot().catch(() => {}); ent = this.build && this.build.byId.get(id); }
    if (!ent) throw fail(404, 'not_found', 'This playlist isn\'t in your library.');
    if (!ent.pl.ed) throw fail(403, 'not_editable', 'You can\'t change this playlist.');
    return ent;
  }

  async add(id, uris, dupOk) {
    const ent = await this.writable(id);
    const ctx = ent.pl.u;
    if (!dupOk) {
      const dups = await this.duplicates(ctx, ent.pl, uris);
      if (dups.length) {
        throw fail(409, 'duplicate', dups.length === 1 && uris.length === 1 ? `This song is already in ${ent.pl.n}.` : `${dups.length === 1 ? 'A song is' : 'Some songs are'} already in ${ent.pl.n}.`, { uris: dups });
      }
    }
    const before = ((this.build && this.build.byId.get(id)) || ent).pl.v || '';     // (a rootlist may have landed during the check)
    try { await this.engineAdd(ctx, uris); } finally { this.dropAdded(id); }   // (a failed add may have landed too)
    // The engine dropped its listing of it, and with it any enumeration the duplicate check started and gave up on:
    // it no longer holds the limiter's slot, and no limiter summary may start it again for nobody.
    this.enums.delete(ctx);
    this.prevSum.delete(ctx);
    this.firstCached.delete(ctx);
    const key = sha1(ctx);
    const st = await this.store.get('list', key);
    if (st) this.store.put('list', key, { ...st, v: '', inv: 1 });     // read again next time (its rows stay for reuse)
    ent.raw.length = (ent.raw.length || 0) + uris.length;              // the cached build shows it at once
    this.rebuild(true);
    this.saveRoot();
    await this.settleRoot();
    const now = (this.build && this.build.byId.get(id)) || ent;
    this.notify('write', { u: ctx, op: 'add', uris, before, after: now.pl.v || '' });
    this.bus.push('playlist', { u: ctx, len: now.pl.len });
    return memo({ playlist: now.pl, added: uris.length });
  }

  // Remove songs (0.9, op remove): the engine has no remove, so the Web API's DELETE /playlists/{id}/items (every copy
  // of a song goes). The stored list is read again next time, the engine's listing too (it doesn't see the write).
  async remove(id, uris) {
    const ent = await this.writable(id);
    const ctx = ent.pl.u;
    const before = ent.pl.v || '';
    try {
      await this.webapi.api('DELETE', `/playlists/${id}/items`, { items: uris.map((uri) => ({ uri })) });
    } catch (e) {
      if (e.status === 403) throw fail(403, 'not_editable', 'You can\'t change this playlist.');
      if (e.status === 404) throw fail(404, 'not_found', 'This playlist doesn\'t exist anymore.');
      throw e;                                                         // rate_limited, spotify_not_connected, spotify_error
    } finally { this.dropAdded(id); }                                  // its dates are read again (a failed remove may have landed too)
    this.fgAt = Date.now();
    this.removedAt.delete(ctx);
    this.removedAt.set(ctx, Date.now());
    if (this.removedAt.size > 200) this.removedAt.delete(this.removedAt.keys().next().value);
    this.lastRefresh.delete(ctx);                                      // the next read may refresh=1 at once
    this.rereads.delete(ctx);
    this.prevSum.delete(ctx);
    this.firstCached.delete(ctx);
    const key = sha1(ctx);
    const st = await this.store.get('list', key);
    if (st) {
      const gone = new Set(uris);
      if (!st.inv && before && st.v === before) ent.raw.length = Math.max(0, (ent.raw.length || 0) - st.items.filter((r) => gone.has(r.u)).length);
      this.store.put('list', key, { ...st, v: '', inv: 1 });
    }
    this.rebuild(true);
    this.saveRoot();
    await this.settleRoot();
    const now = (this.build && this.build.byId.get(id)) || ent;
    this.notify('write', { u: ctx, op: 'remove', uris, before, after: now.pl.v || '' });
    this.bus.push('playlist', { u: ctx, len: now.pl.len });
    return memo({ playlist: now.pl, removed: uris.length });
  }

  beforeRemove(ctx, s) { return !!s.fetched_at && s.fetched_at < (this.removedAt.get(ctx) || 0); }

  // uris of `uris` already in the playlist (by uri; by name + seconds only when both rows are at hand)
  async duplicates(ctx, pl, uris) {
    const st = await this.store.get('list', sha1(ctx));
    let have = null;
    if (st && this.listValid(st, 'playlist', pl)) have = new Set(st.items.map((r) => r.u));
    else have = await this.engineUris(ctx).catch(() => null);         // (lists off, no session: the add needs neither)
    if (!have) return [];                                              // not ready within 4 s: no check
    const dups = uris.filter((u) => have.has(u));
    if (st) {
      const keys = new Set(st.items.filter((r) => r.n && r.d).map((r) => `${r.n}|${Math.round(r.d / 1000)}`));
      for (const u of uris) {
        if (dups.includes(u)) continue;
        const row = this.rowAtHand(u);
        if (row && keys.has(`${row.n}|${Math.round(row.d / 1000)}`)) dups.push(u);
      }
    }
    return dups;
  }

  rowAtHand(u) {
    for (const st of this.store.values('list')) {
      const r = st.items && st.items.find((x) => x.u === u && x.n && x.d);
      if (r) return r;
    }
    const t = this.player.st && this.player.st.track;
    if (t && (t.context_track_uri === u || t.uri === u) && t.name && t.duration_ms) return { n: t.name, d: t.duration_ms };
    return null;
  }

  // The playlist's uris straight from the engine: summaries (no sweep) until enumerated, then pages.
  async engineUris(ctx) {
    if (this.heldFor(ctx)) return null;                                // its enumeration just failed: no check
    const t0 = Date.now();
    let s;
    for (;;) {
      s = await this.summary(ctx, false, false);
      this.observe(ctx, s);
      if (s.ready) break;
      if (Date.now() - t0 + this.T.pollMs > this.T.dupWait) return null;
      await sleep(this.T.pollMs);
    }
    const set = new Set();
    if (s.tracks && s.tracks.length >= s.length) { for (const e of s.tracks) if (e && e.uri) set.add(e.uri); return set; }   // a stock engine
    for (let from = 0; from < s.length;) {
      const pg = await this.ctxGet(ctx, `&sweep=0&from=${from}&limit=${this.T.rowsPage}`, this.T.pageTimeout);
      if (!pg.ready || !pg.tracks || !pg.tracks.length) return null;
      for (const e of pg.tracks) if (e && e.uri) set.add(e.uri);
      from += pg.tracks.length;
      await tick();
    }
    return set;
  }

  // ------------------------------------------------------------------ background reads (membership.js)
  // Room for one: no phone list request or write for bgQuiet, no enumeration in flight or held, the engine lists songs,
  // and at most half of the window's enumerations used (the rest stay the phone's).
  // why bgRoom() says no (membership.js logs it, at most once a minute)
  bgWhy() {
    const now = Date.now();
    if (now - this.fgAt < this.T.bgQuiet) return 'a phone is loading lists';
    if (this.listing === 'off') return 'the engine lists no songs (metadata off)';
    const l = this.limited('');
    if (l) return l.busy ? `the enumeration budget is used up (${l.retry} s)` : 'another enumeration is running';
    for (const until of this.holds.values()) if (now < until) return 'a failed list is on hold';
    if (this.enumStarts.length >= Math.floor(this.T.enumLimit / 2)) return `half the enumeration budget is used (${this.enumStarts.length} in 5 min)`;
    return 'room';
  }

  bgRoom() {
    const now = Date.now();
    if (now - this.fgAt < this.T.bgQuiet || this.listing === 'off' || this.limited('')) return false;
    for (const until of this.holds.values()) if (now < until) return false;
    return this.enumStarts.length < Math.floor(this.T.enumLimit / 2);
  }

  // A playlist's stored song list: { v, at, uris, trunc } (null: none, or one marked to be read again; trunc: the engine
  // cut it at metadata.max_tracks). Read from memory or straight from disk, so the phone's lists keep their places in the
  // memory LRU.
  async storedUris(ctx) {
    const key = sha1(ctx);
    let st = this.store.peek('list', key);
    if (!st) { try { st = JSON.parse(await fsp.readFile(this.store.file('list', key), 'utf8')); } catch (e) { st = null; } }
    if (!st || st.inv || st.exp || st.kind !== 'playlist' || !Array.isArray(st.items)) return null;
    return { v: st.v || '', at: st.at || 0, uris: st.items.map((r) => r.u), trunc: !!st.trunc };
  }

  // A playlist's song uris and the revision they are at, without metadata: summaries with sweep=0 until enumerated
  // (they count in the limiter like any enumeration), then pages. A listing older than the rootlist at another revision,
  // or older than one of our removes, is read again with refresh=1 (once a minute per list, like the phone's).
  // -> { v, uris, trunc } | null (not enumerated within waitMs, or it may not be refreshed yet: later; trunc: the engine
  // cut the listing at metadata.max_tracks). Engine errors throw (ctxGet holds the list after a 5xx).
  async readUris(ctx, pl, waitMs) {
    if (this.heldFor(ctx)) return null;
    const t0 = Date.now();
    let refresh = false;
    let s;
    try {
      for (;;) {
        s = await this.summary(ctx, refresh, false);
        if (refresh) { this.lastRefresh.set(ctx, Date.now()); refresh = false; }
        this.observe(ctx, s);
        if (s.ready) {
          const old = this.beforeRemove(ctx, s) ||
            (!!pl && !!pl.v && !!s.revision && s.revision !== pl.v && !!this.root && !!s.fetched_at && this.root.at > s.fetched_at);
          if (!old) break;
          if (Date.now() - (this.lastRefresh.get(ctx) || 0) < this.T.refreshGap) return null;
          refresh = true;
          continue;
        }
        if (Date.now() - t0 + this.T.pollMs > waitMs) return null;
        await sleep(this.T.pollMs);
      }
      if (pl && pl.v && s.revision && s.revision !== pl.v) this.bgRoot();      // the listing is the newer one
      const uris = [];
      if (s.tracks && s.tracks.length >= s.length) {                            // a stock engine
        for (const e of s.tracks) if (e && typeof e.uri === 'string') uris.push(e.uri);
        return { v: s.revision, uris, trunc: s.truncated };
      }
      for (let from = 0; from < s.length;) {
        const pg = await this.ctxGet(ctx, `&sweep=0&from=${from}&limit=${this.T.rowsPage}`, this.T.pageTimeout);
        if (!pg.ready || pg.length !== s.length || !pg.tracks || !pg.tracks.length || (s.fetched_at && pg.fetched_at !== s.fetched_at)) return null;
        for (const e of pg.tracks) if (e && typeof e.uri === 'string') uris.push(e.uri);
        from += pg.tracks.length;
        await tick();
      }
      return { v: s.revision, uris, trunc: s.truncated };
    } finally {
      this.prevSum.delete(ctx);                                        // not a phone's progress (the stall rule)
      this.firstCached.delete(ctx);
    }
  }

  async create(b) {
    this.simCheck();
    const name = b && typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) throw fail(400, 'bad_request', 'A playlist name needs 1 to 100 characters.');
    const uris = this.checkUris(b.uris == null ? [] : b.uris, 0);
    const j = await this.webapi.api('POST', '/me/playlists', { name, public: false, collaborative: false, description: '' });
    if (!j || !j.id || !ID.test(j.id)) throw fail(502, 'spotify_error', 'Spotify didn\'t create the playlist.');
    const ctx = 'spotify:playlist:' + j.id;
    const raw = { uri: ctx, name: j.name || name, description: '', owner_username: (j.owner && j.owner.id) || this.username(), length: 0,
      image_url: null, collaborative: false, can_edit: true, folder: [], revision: '' };
    let added = 0;
    let addError;
    if (uris.length) {
      try { await this.engineAdd(ctx, uris); added = uris.length; } catch (e) { addError = e.message; }
    } else {
      // nothing in it yet: opening it costs no enumeration for the next 10 min
      this.store.put('list', sha1(ctx), { ctx, kind: 'playlist', v: '', sig: null, at: Date.now(), exp: Date.now() + this.T.listTtl, len: 0, ms: 0, trunc: 0, un: 0, items: [] });
    }
    raw.length = added;
    if (this.root) {
      this.root.items = [raw, ...this.root.items.filter((it) => !it || it.uri !== ctx)];    // Spotify puts new ones on top
      this.rebuild(true);
      this.saveRoot();
    }
    await this.settleRoot();
    const ent = this.build && this.build.byId.get(j.id);
    const out = { playlist: ent ? ent.pl : this.plRow(raw, this.username(), false), added };
    if (addError) out.add_error = addError;
    return memo(out);
  }

  // ------------------------------------------------------------------ admin
  async flush(what) {
    if (!['lists', 'images', 'all'].includes(what)) throw fail(400, 'bad_request', 'what must be lists, images or all');
    if (what !== 'images') {
      for (const k of ['list', 'album', 'artist', 'added']) await this.store.clear(k);
      this.searches.clear();
      this.headers.clear();
      this.prevSum.clear();
      this.firstCached.clear();
      this.rereads.clear();
      if (this.likedLen != null) { this.likedLen = undefined; this.saveRoot(); this.rebuildIfStale(); }
    }
    if (what === 'all') {
      await this.store.del('top', 'root');
      await this.store.del('top', 'webpl');
      this.root = null;
      this.build = null;
      this.webpl = null;
      this.likedStates.clear();
      this.likedSig = null;
      this.warmed.clear();
    }
    if (what !== 'lists') this.rowWarm.clear();
    if (what !== 'lists' && this.images) await this.images.flush();
    log.info(`catalog: flushed ${what}`);
    return { ok: true, what };
  }

  counters() {
    return { listing: this.listing, calls: this.webapi.calls || 0, engine_est: this.est, liked_order: this.likedOrder };
  }

  async info() {
    const now = Date.now();
    const age = (t) => (t ? Math.round((now - t) / 1000) : null);
    while (this.enumStarts.length && now - this.enumStarts[0] > this.T.enumWindow) this.enumStarts.shift();
    return {
      rootlist_age_s: age(this.root && this.root.at), rootlist_error: this.rootErr && this.rootErr.code, playlists: this.build ? this.build.obj.items.length : 0,
      webpl_age_s: age(this.webpl && this.webpl.at), webpl_known: this.webpl ? Object.keys(this.webpl.map || {}).length : 0,
      webpl_missing: this.webpl ? (this.webpl.missing || []).length : 0,
      lists_stored: await this.store.count('list'), lists_mem: this.store.values('list').length,
      enumerating: [...this.enums].map(([c, t]) => ({ ctx: c, age_s: age(t) })), enumerations_5min: this.enumStarts.length,
      listing: this.listing, legacy_engine: this.legacy || !!this.legacyFields,
      liked_states: this.likedStates.size, liked_sig_age_s: this.likedSig ? age(this.likedSig.at) : null, liked_len: this.likedCount(),
      liked_order: this.likedOrder, engine_est: this.est, web_calls: this.webapi.calls || 0, searches: this.searches.size,
      simulate: this.sim && Date.now() < this.sim.until ? { code: this.sim.code, left_s: Math.ceil((this.sim.until - now) / 1000) } : null,
    };
  }
}

module.exports = { Catalog, memo, plainText, TIMING, clean, pickImg, webRow, alRow, arRow, userIdOk, ownerUri };
