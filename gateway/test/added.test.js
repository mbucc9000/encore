'use strict';
// Offline test of GET /v1/playlists/<id>/added (sort by Date added, DESIGN-DATE-ADDED.md) with the real catalog.js and
// http.js, a fake engine (rootlist with revisions, /context/tracks with the patch-2 options, add_tracks) and a fake Web
// API (GET /playlists/{id}/items with fields/limit/offset paging, DELETE /playlists/{id}/items).
//   node gateway/test/added.test.js   (or with the whole suite: node --test, see README.md)
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { EventEmitter } = require('events');
const { Catalog } = require('../src/catalog');
const { createServer } = require('../src/http');

// every log line the gateway writes (none may carry a song)
const logged = [];
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h22 = (s) => crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 22);
const id = (c) => c.repeat(22).slice(0, 22);
const PL = (c) => 'spotify:playlist:' + id(c);
const T = (s) => 'spotify:track:' + h22(s);
const EP = (s) => 'spotify:episode:' + h22('ep' + s);
const LOCAL = (s) => `spotify:local:Artist:Album:${s}:180`;
const parse = (m) => JSON.parse(m.body.toString());
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');     // Spotify's shape: no milliseconds
const DAY0 = Date.UTC(2020, 0, 1);
const dayIso = (i) => iso(DAY0 + i * 86400000);
let revN = 0;
const nextRev = (c) => `${c.toLowerCase()}r${++revN}`;
const NOT_AVAILABLE = 'Spotify doesn\'t share when songs were added to this playlist.';

// ------------------------------------------------------------------ the fake engine (+ Spotify's side of each playlist)
class FakeEngine extends EventEmitter {
  constructor() {
    super();
    this.status = { username: 'alex' };
    this.connected = true;
    this.pls = new Map();          // id -> { id, name, owner, edit, rev, uris, added (ISO | null | junk), field, nulls }
    this.listings = new Map();
    this.log = [];
    this.enumMs = 30;
    this.rootDelay = 0;
  }

  // field: what the Web API calls a playlist item's track ('item' since Feb 2026, 'track' before, 'mixed': both kinds)
  add(c, { uris, added, edit = true, owner = 'alex', name, field = 'item', nulls }) {
    this.pls.set(id(c), { id: id(c), name: name || 'Secret name ' + c, owner, edit, rev: nextRev(c), uris: uris.slice(),
      added: added ? added.slice() : uris.map((u, i) => dayIso(i)), field, nulls: nulls || new Set() });
  }

  // Spotify changed it (another device)
  change(c, uris, added) {
    const p = this.pls.get(id(c));
    p.uris = uris.slice();
    p.added = added ? added.slice() : uris.map((u, i) => dayIso(1000 + i));
    p.rev = nextRev(c);
  }

  root() {
    return { items: [...this.pls.values()].map((p) => ({ uri: 'spotify:playlist:' + p.id, name: p.name, owner_username: p.owner, length: p.uris.length,
      can_edit: p.edit, collaborative: p.owner !== 'alex' && p.edit, revision: p.rev, folder: [], image_url: 'https://i.scdn.co/image/' + p.id.toLowerCase(), description: '' })) };
  }

  async get(p) {
    const q = new URLSearchParams(p.split('?')[1] || '');
    this.log.push({ t: Date.now(), m: 'GET', p, ctx: q.get('uri'), q });
    await null;
    if (p.startsWith('/library/playlists')) {
      if (this.rootDelay) await sleep(this.rootDelay);
      return { status: 200, json: this.root() };
    }
    if (p.startsWith('/context/tracks')) {
      const uri = q.get('uri') || '';
      const pid = uri.slice(17);
      const pl = uri.startsWith('spotify:playlist:') && this.pls.get(pid);
      if (!pl) return { status: 400, json: null };
      let L = this.listings.get(pid);
      if (q.get('refresh') === '1') L = null;
      if (!L) { L = { rev: pl.rev, uris: pl.uris.slice(), readyAt: Date.now() + this.enumMs, fetched: 0 }; this.listings.set(pid, L); }
      const ready = Date.now() >= L.readyAt;
      if (ready && !L.fetched) L.fetched = Date.now();
      const j = { ready, length: ready ? L.uris.length : 0, cached: ready ? L.uris.length : 0, failed: 0, sweeping: false,
        revision: ready ? L.rev : '', fetched_at: ready ? L.fetched : 0, truncated: false };
      if (ready && q.get('meta') !== '0') {
        const from = Number(q.get('from') || 0);
        const lim = q.has('limit') ? Number(q.get('limit')) : L.uris.length;
        j.tracks = L.uris.slice(from, from + lim).map((u) => ({ uri: u, track: { name: 'Song', artist_names: ['Someone'], duration: 180000 } }));
      }
      return { status: 200, json: j };
    }
    return { status: 404, json: null };
  }

  async send(m, p, body) {
    this.log.push({ t: Date.now(), m, p, body });
    await null;
    if (m === 'POST' && p === '/library/playlists/add_tracks') {
      const pl = this.pls.get(String(body.playlist_uri).slice(17));
      if (!pl) return { status: 404, json: null };
      if (!pl.edit) return { status: 403, json: null };
      pl.uris.push(...body.uris);
      pl.added.push(...body.uris.map(() => iso(Date.now())));
      pl.rev = nextRev(pl.id[0]);
      this.listings.delete(pl.id);
      return { status: 200, json: {} };
    }
    return { status: 404, json: null };
  }
}

// ------------------------------------------------------------------ the fake Web API (as webapi.js throws)
const engine = new FakeEngine();
const forbidden = (p) => Object.assign(new Error(`Spotify refused this (GET ${p.split('?')[0]}: Forbidden).`), { status: 403, code: 'spotify_forbidden', spotifyStatus: 403 });
const missing = (p) => Object.assign(new Error(`Spotify doesn't have this (GET ${p.split('?')[0]}).`), { status: 404, code: 'not_found', spotifyStatus: 404 });
const limited = (s) => Object.assign(new Error(`Spotify is limiting requests. Try again in ${s} s.`), { status: 503, code: 'rate_limited', retry_after: s });
const boom = () => Object.assign(new Error('Spotify GET /playlists/x/items: boom'), { status: 502, code: 'spotify_error', spotifyStatus: 500 });
const webapi = {
  ready: true,
  user: { id: 'alex', name: 'Alex' },
  reqs: [],
  extra: new Map(),      // playlists outside the library (Spotify knows them, the rootlist doesn't)
  forbid: new Set(),     // ids Spotify answers 403 for (dev mode: someone else's playlist)
  failAt: null,          // { id, offset, err }: once
  delay: 0,              // ms per items page
  async api(method, p, body) {
    this.reqs.push({ method, p, body });
    await null;
    if (method === 'GET' && p.startsWith('/me/playlists')) return { items: [], next: null };
    if (method === 'GET' && p.startsWith('/me/tracks')) return { total: 0, items: [] };
    let m = p.match(/^\/playlists\/([0-9A-Za-z]{22})\/items\?(.*)$/);
    if (method === 'GET' && m) {
      if (this.delay) await sleep(this.delay);
      const q = new URLSearchParams(m[2]);
      const offset = Number(q.get('offset') || 0);
      const limit = Number(q.get('limit') || 100);
      if (this.failAt && this.failAt.id === m[1] && this.failAt.offset === offset) { const e = this.failAt.err; this.failAt = null; throw e; }
      if (this.forbid.has(m[1])) throw forbidden(p);
      const pl = engine.pls.get(m[1]) || this.extra.get(m[1]);
      if (!pl) throw missing(p);
      const items = pl.uris.slice(offset, offset + limit).map((u, k) => {
        const i = offset + k;
        if (pl.nulls.has(i)) return { added_at: pl.added[i], item: null, track: null };           // a song Spotify lost
        const key = pl.field === 'mixed' ? (i % 2 ? 'track' : 'item') : pl.field;
        return { added_at: pl.added[i], [key]: { uri: u } };
      });
      const next = offset + limit < pl.uris.length ? `https://api.spotify.com/v1/playlists/${m[1]}/items?offset=${offset + limit}&limit=${limit}` : null;
      return { next, items };
    }
    m = p.match(/^\/playlists\/([0-9A-Za-z]{22})\/items$/);
    if (method === 'DELETE' && m) {
      const pl = engine.pls.get(m[1]);
      if (!pl) throw missing(p);
      const gone = new Set(body.items.map((x) => x.uri));
      const keep = pl.uris.map((u, i) => i).filter((i) => !gone.has(pl.uris[i]));
      pl.uris = keep.map((i) => pl.uris[i]);
      pl.added = keep.map((i) => pl.added[i]);
      pl.rev = nextRev(pl.id[0]);
      return { snapshot_id: 'AAAAB' + revN };
    }
    throw Object.assign(new Error('unrouted ' + method + ' ' + p.split('?')[0]), { status: 404, code: 'not_found' });
  },
};
const itemReqs = (c) => webapi.reqs.filter((r) => r.method === 'GET' && r.p.startsWith(`/playlists/${id(c)}/items`));
const bus = { events: [], push(type, data) { this.events.push({ type, data }); } };
const player = { st: {}, lastPhone: Date.now(), noteLiked() {}, pollRemote: () => Promise.resolve() };

// what the answer must be: Spotify's items in order, songs only (as the song list), added_at ISO -> ms (else 0)
function truth(c, from) {
  const pl = from || engine.pls.get(id(c));
  const out = [];
  pl.uris.forEach((u, i) => {
    if (pl.nulls.has(i) || !u.startsWith('spotify:track:')) return;
    const ms = typeof pl.added[i] === 'string' ? Date.parse(pl.added[i]) : NaN;
    out.push([u, ms > 0 ? ms : 0]);
  });
  return out;
}

async function until(what, fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(15);
  }
}

const CT = { rootGap: 0, rootWait: 300, pollMs: 10, waitMs: 400, noSession: 10, enumHold: 200, enumLimit: 100, bgQuiet: 0, stallMs: 300, listTtl: 300 };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-'));
  // A: 250 items, songs in it twice, an episode and a local file, 'item' and 'track' mixed, odd added_at values
  const aUris = Array.from({ length: 250 }, (_, i) => (i === 10 ? EP(1) : i === 20 ? LOCAL(1) : T('a' + (i % 120))));
  const aAdded = aUris.map((u, i) => dayIso(i));
  aAdded[5] = null;                                   // no added_at at all
  aAdded[6] = '1970-01-01T00:00:00Z';                 // what very old playlists say
  aAdded[7] = 'not a date';
  engine.add('A', { uris: aUris, added: aAdded, field: 'mixed' });
  // S: one of Spotify's own (no revision in the library), legacy 'track' only
  engine.add('S', { uris: [T('s1'), T('s2'), T('s3')], owner: 'spotify', name: 'Discover Weekly', edit: false, field: 'track' });
  // N: an item Spotify lost (item and track null), 'item' only
  engine.add('N', { uris: [T('n1'), T('n2'), T('n3')], nulls: new Set([1]) });
  // D: someone else's playlist the dev app may not read (403); F: 450 items (the page cap)
  engine.add('D', { uris: [T('d1')], owner: 'friend', edit: false });
  engine.add('F', { uris: Array.from({ length: 450 }, (_, i) => T('f' + i)) });
  // X: outside the library (opened from search)
  webapi.extra.set(id('X'), { uris: [T('x1'), T('x2')], added: [dayIso(1), dayIso(2)], field: 'item', nulls: new Set() });
  webapi.forbid.add(id('D'));

  const catalog = new Catalog({ cfg: { cacheDir: dir }, engine, webapi, bus, player, images: null, timing: CT });

  // ---- 1. order, duplicates, paging, item vs track, the dates
  const a1m = await catalog.added(id('A'));
  const a1 = parse(a1m);
  assert.deepStrictEqual(Object.keys(a1), ['v', 'items'], 'the shape: {v, items}');
  assert.strictEqual(a1.v, engine.pls.get(id('A')).rev, 'v: the library\'s revision');
  assert.deepStrictEqual(a1.items, truth('A'));
  assert.strictEqual(a1.items.length, 248, 'one entry per song item (the episode and the local file left out)');
  assert.deepStrictEqual(a1.items[0], [T('a0'), DAY0]);
  assert.deepStrictEqual(a1.items[1], [T('a1'), DAY0 + 86400000], 'a \'track\' item (legacy name)');
  assert.deepStrictEqual(a1.items.slice(5, 8).map((e) => e[1]), [0, 0, 0], 'null, 1970 and junk added_at: 0');
  assert.strictEqual(a1.items.filter((e) => e[0] === T('a0')).length, 3, 'a song in it 3 times: 3 entries');
  assert.deepStrictEqual(a1.items.filter((e) => e[0] === T('a0')).map((e) => e[1]), [DAY0, DAY0 + 120 * 86400000, DAY0 + 240 * 86400000]);
  const r1 = itemReqs('A');
  assert.strictEqual(r1.length, 3, 'pages of 100 until next is null');
  r1.forEach((r, i) => {
    const q = new URLSearchParams(r.p.split('?')[1]);
    assert.strictEqual(q.get('fields'), 'next,items(added_at,item(uri),track(uri))');
    assert.strictEqual(q.get('limit'), '100');
    assert.strictEqual(q.get('offset'), String(i * 100));
    assert.ok(!q.has('market'), 'no market (no relinked uris)');
  });
  // the same order as the playlist's song list (the app aligns them by index)
  const listA = parse(await until('A listed', async () => { const m = await catalog.playlist(id('A'), false); return parse(m).done ? m : null; }));
  assert.deepStrictEqual(a1.items.map((e) => e[0]), listA.items.map((r) => r.u), 'aligned with the song list');
  assert.strictEqual(listA.v, a1.v);

  // ---- 2. stored while the library's revision is unchanged: same memo (ETag), no request
  const a2m = await catalog.added(id('A'));
  assert.strictEqual(a2m.etag, a1m.etag);
  assert.strictEqual(itemReqs('A').length, 3, 'no second read');

  // ---- 3. one read per playlist
  webapi.delay = 40;
  const ns = await Promise.all([catalog.added(id('N')), catalog.added(id('N')), catalog.added(id('N'))]);
  webapi.delay = 0;
  assert.strictEqual(itemReqs('N').length, 1, 'three requests, one read');
  assert.ok(ns.every((m) => m.etag === ns[0].etag));
  assert.deepStrictEqual(parse(ns[0]).items, [[T('n1'), DAY0], [T('n3'), DAY0 + 2 * 86400000]], 'the lost item left out, \'item\' read');

  // ---- 4. Spotify changed A (another device): read again once the library shows the new revision
  const vOld = a1.v;
  engine.change('A', [T('a0'), T('z1'), T('a0')]);
  assert.strictEqual(parse(await catalog.added(id('A'))).v, vOld, 'the library still says the old revision: the stored dates');
  assert.strictEqual(itemReqs('A').length, 3);
  await catalog.fetchRoot();
  const a4 = parse(await catalog.added(id('A')));
  assert.strictEqual(a4.v, engine.pls.get(id('A')).rev);
  assert.notStrictEqual(a4.v, vOld);
  assert.deepStrictEqual(a4.items, truth('A'));
  assert.strictEqual(itemReqs('A').length, 4);

  // ---- 5. no revision (Spotify's own playlist, one outside the library): listTtl
  const s5 = parse(await catalog.added(id('S')));
  assert.strictEqual(s5.v, '', 'Spotify\'s own: no revision');
  assert.deepStrictEqual(s5.items, truth('S'), '\'track\' only (legacy)');
  await catalog.added(id('S'));
  assert.strictEqual(itemReqs('S').length, 1, 'within listTtl: stored');
  const x5 = parse(await catalog.added(id('X')));
  assert.deepStrictEqual(x5, { v: '', items: [[T('x1'), DAY0 + 86400000], [T('x2'), DAY0 + 2 * 86400000]] }, 'outside the library');
  await sleep(CT.listTtl + 30);
  await catalog.added(id('S'));
  await catalog.added(id('X'));
  assert.strictEqual(itemReqs('S').length, 2, 'read again after listTtl');
  assert.strictEqual(itemReqs('X').length, 2);

  // ---- 6. our add drops them, even before the library shows the new revision
  catalog.T.rootGap = 600;
  catalog.T.rootWait = 300;
  await catalog.fetchRoot();                                             // (the forced refresh after the add: deferred past rootWait)
  const vA = catalog.build.byId.get(id('A')).pl.v;
  const n6 = itemReqs('A').length;
  const add = parse(await catalog.items(id('A'), { op: 'add', uris: [T('new1')], allow_duplicates: true }));
  assert.strictEqual(add.added, 1);
  assert.strictEqual(catalog.build.byId.get(id('A')).pl.v, vA, '(the library is still at the old revision)');
  await sleep(5);
  const a6 = parse(await catalog.added(id('A')));
  assert.strictEqual(itemReqs('A').length, n6 + 1, 'read again after our add');
  assert.strictEqual(a6.v, vA);
  assert.deepStrictEqual(a6.items, truth('A'));
  assert.strictEqual(a6.items[a6.items.length - 1][0], T('new1'), 'the added song, last');
  assert.ok(Date.now() - a6.items[a6.items.length - 1][1] < 5000, 'added just now');
  await catalog.added(id('A'));
  assert.strictEqual(itemReqs('A').length, n6 + 1, 'then stored again');
  await until('the deferred rootlist', async () => catalog.build.byId.get(id('A')).pl.v === engine.pls.get(id('A')).rev);
  await catalog.added(id('A'));
  assert.strictEqual(itemReqs('A').length, n6 + 2, 'and read again at the new revision');

  // ---- 7. our remove drops them too (every copy of the song goes)
  await catalog.fetchRoot();
  const n7 = itemReqs('A').length;
  const rm = parse(await catalog.items(id('A'), { op: 'remove', uris: [T('a0')] }));
  assert.strictEqual(rm.removed, 1);
  await sleep(5);
  const a7 = parse(await catalog.added(id('A')));
  assert.strictEqual(itemReqs('A').length, n7 + 1, 'read again after our remove');
  assert.ok(!a7.items.some((e) => e[0] === T('a0')), 'both copies gone');
  assert.deepStrictEqual(a7.items, truth('A'));
  catalog.T.rootGap = 0;

  // ---- 8. a write that lands during a read: that read is answered but not stored, and a request after the write
  // doesn't join it
  engine.change('A', aUris.slice(), aAdded.slice());
  await catalog.fetchRoot();
  await sleep(5);
  webapi.delay = 80;
  const n8 = itemReqs('A').length;
  const p1 = catalog.added(id('A'));
  await sleep(40);                                                       // (its first page is on the way)
  await catalog.items(id('A'), { op: 'remove', uris: [T('a1')] });
  await sleep(2);
  const p2 = catalog.added(id('A'));
  await p1;
  assert.strictEqual(catalog.store.peek('added', id('A')), null, 'the read the remove landed during is not stored');
  const a8 = parse(await p2);
  webapi.delay = 0;
  assert.strictEqual(itemReqs('A').length, n8 + 6, 'two reads of 3 pages: the second didn\'t join the first');
  assert.ok(!a8.items.some((e) => e[0] === T('a1')));
  assert.deepStrictEqual(a8.items, truth('A'));
  assert.strictEqual((await catalog.added(id('A'))).etag, (await p2).etag, 'the read after the write is the stored one');
  assert.strictEqual(itemReqs('A').length, n8 + 6);

  // ---- 9. errors
  // 403 / 404 from Spotify -> 404 not_available
  await assert.rejects(catalog.added(id('D')), (e) => e.status === 404 && e.code === 'not_available' && e.message === NOT_AVAILABLE);
  await assert.rejects(catalog.added(id('Z')), (e) => e.status === 404 && e.code === 'not_available' && e.message === NOT_AVAILABLE);
  // the others as the other Web API routes, nothing stored
  webapi.failAt = { id: id('F'), offset: 0, err: limited(7) };
  await assert.rejects(catalog.added(id('F')), (e) => e.status === 503 && e.code === 'rate_limited' && e.retry_after === 7);
  webapi.failAt = { id: id('F'), offset: 200, err: boom() };
  await assert.rejects(catalog.added(id('F')), (e) => e.status === 502 && e.code === 'spotify_error', 'a failure on a later page');
  assert.strictEqual(await catalog.store.get('added', id('F')), null, 'nothing stored');
  const nNC = itemReqs('F').length;
  webapi.ready = false;
  webapi.failAt = { id: id('F'), offset: 0, err: Object.assign(new Error('Connect your Spotify account on the gateway admin page first'), { status: 503, code: 'spotify_not_connected' }) };
  await assert.rejects(catalog.added(id('F')), (e) => e.code === 'spotify_not_connected');
  webapi.ready = true;
  assert.strictEqual(itemReqs('F').length, nNC + 1);
  // a stored copy at an older revision answers (stale: 1) when Spotify fails with a 5xx ...
  const a9old = parse(await catalog.added(id('A')));
  engine.change('A', [T('c1'), T('c2')]);
  await catalog.fetchRoot();
  webapi.failAt = { id: id('A'), offset: 0, err: limited(9) };
  const st9 = await catalog.added(id('A'));
  assert.deepStrictEqual(parse(st9), { ...a9old, stale: 1 }, 'the stored dates, marked stale');
  webapi.failAt = { id: id('A'), offset: 0, err: boom() };
  assert.strictEqual((await catalog.added(id('A'))).etag, st9.etag, 'the same stale answer');
  const a9 = parse(await catalog.added(id('A')));
  assert.deepStrictEqual(a9, { v: engine.pls.get(id('A')).rev, items: truth('A') }, 'then the new dates');
  // ... but not after one of our writes (they may predate it), and never for a 403/404
  await catalog.items(id('A'), { op: 'add', uris: [T('c3')], allow_duplicates: true });
  await sleep(5);
  webapi.failAt = { id: id('A'), offset: 0, err: limited(4) };
  await assert.rejects(catalog.added(id('A')), (e) => e.code === 'rate_limited', 'no stale copy after our write');
  await sleep(CT.listTtl + 30);
  webapi.forbid.add(id('S'));
  await assert.rejects(catalog.added(id('S')), (e) => e.code === 'not_available', 'a 403 with a stored copy');
  webapi.forbid.delete(id('S'));
  // the admin's simulated errors
  catalog.simulate('rate_limited', 5);
  const n9 = webapi.reqs.length;
  await assert.rejects(catalog.added(id('N')), (e) => e.status === 503 && e.code === 'rate_limited');
  assert.strictEqual(webapi.reqs.length, n9, 'nothing reached Spotify');
  catalog.simulate(null);

  // ---- 10. at most addedPages pages (5000 items)
  assert.strictEqual(catalog.T.addedPages, 50);
  catalog.T.addedPages = 3;
  const nF = itemReqs('F').length;
  const f10 = parse(await catalog.added(id('F')));
  assert.strictEqual(itemReqs('F').length, nF + 3);
  assert.strictEqual(f10.items.length, 300);
  assert.deepStrictEqual(f10.items, truth('F').slice(0, 300));
  catalog.T.addedPages = 50;

  // ---- 11. the admin's list flush drops them
  const nN = itemReqs('N').length;
  await catalog.flush('lists');
  await catalog.added(id('N'));
  assert.strictEqual(itemReqs('N').length, nN + 1);

  // ---- 12. after a restart: from disk, nothing read
  await catalog.added(id('A'));
  await sleep(100);                                                      // (disk writes)
  const r12 = webapi.reqs.length;
  const catalog2 = new Catalog({ cfg: { cacheDir: dir }, engine, webapi, bus, player, images: null, timing: CT });
  const a12 = parse(await catalog2.added(id('A')));
  assert.deepStrictEqual(a12, { v: engine.pls.get(id('A')).rev, items: truth('A') });
  assert.strictEqual(webapi.reqs.length, r12, 'nothing read');

  // ---- 13. the route (http.js): signed GET, ETag / 304, errors, not shadowed by /v1/playlists/<id>
  const calls = { added: 0, playlist: 0 };
  const realAdded = catalog.added.bind(catalog);
  const realPlaylist = catalog.playlist.bind(catalog);
  catalog.added = (...a) => { calls.added++; return realAdded(...a); };
  catalog.playlist = (...a) => { calls.playlist++; return realPlaylist(...a); };
  const server = createServer({ cfg: { dataDir: dir, version: 'test' }, player, auth: { verify: () => ({ id: 'dev', name: 'test' }) }, bus,
    encoders: { warmAll() {} }, engine, clock: {}, started: Date.now(), webapi, catalog, images: {}, jam: {}, personal: {}, lyrics: {}, membership: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
  const h1 = await get(`/v1/playlists/${id('A')}/added`);
  assert.strictEqual(h1.status, 200);
  assert.deepStrictEqual(JSON.parse(h1.body), { v: engine.pls.get(id('A')).rev, items: truth('A') });
  assert.ok(h1.headers.etag);
  assert.strictEqual(calls.added, 1);
  assert.strictEqual(calls.playlist, 0, 'not the song list route');
  const h2 = await get(`/v1/playlists/${id('A')}/added`, { 'If-None-Match': h1.headers.etag });
  assert.strictEqual(h2.status, 304);
  const h3 = await get(`/v1/playlists/${id('A')}`);
  assert.strictEqual(h3.status, 200);
  assert.strictEqual(calls.playlist, 1, 'the song list route still answers');
  assert.strictEqual(calls.added, 2);
  const h4 = await get(`/v1/playlists/${id('D')}/added`);
  assert.strictEqual(h4.status, 404);
  assert.deepStrictEqual(JSON.parse(h4.body), { error: { code: 'not_available', message: NOT_AVAILABLE } });
  webapi.failAt = { id: id('S'), offset: 0, err: limited(11) };
  catalog2.store.del('added', id('S'));
  await catalog.store.del('added', id('S'));
  const h5 = await get(`/v1/playlists/${id('S')}/added`);
  assert.strictEqual(h5.status, 503);
  assert.deepStrictEqual(JSON.parse(h5.body), { error: { code: 'rate_limited', message: limited(11).message, retry_after: 11 } });
  const h6 = await get(`/v1/playlists/${id('A')}/added`, {}, 'POST');
  assert.strictEqual(h6.status, 404, 'GET only');
  const h7 = await get('/v1/playlists/short/added');
  assert.strictEqual(h7.status, 404);
  assert.strictEqual(calls.added, 4, '(D and S)');
  server.close();

  // ---- never a song in the log
  for (const l of logged) assert.ok(!/spotify:track:|Secret name/.test(l), 'a song or a name in the log: ' + l);
  console.log('ALL OK', webapi.reqs.filter((r) => r.p.includes('/items')).length, 'Web API item requests');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
