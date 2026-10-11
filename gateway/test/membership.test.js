'use strict';
// Offline test of membership.js ("Saved in", gateway 0.9, DESIGN-0.9.md §3a) with the real catalog.js, a fake engine
// (rootlist, /context/tracks with the patch-2 options, add_tracks) and a fake Web API (DELETE /playlists/{id}/items).
//   node gateway/test/membership.test.js   (or with the whole suite: node --test, see README.md)
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { EventEmitter } = require('events');
const { Catalog } = require('../src/catalog');
const { Membership } = require('../src/membership');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const id = (c) => c.repeat(22).slice(0, 22);
const PL = (c) => 'spotify:playlist:' + id(c);
const T = (c) => 'spotify:track:' + id(c);
const parse = (m) => JSON.parse(m.body.toString());
let revN = 0;
const nextRev = (c) => `${c.toLowerCase()}r${++revN}`;              // (a playlist's revisions never repeat)

// ------------------------------------------------------------------ the fake engine
class FakeEngine extends EventEmitter {
  constructor() {
    super();
    this.status = { username: 'alex' };
    this.connected = true;
    this.pls = new Map();          // id -> { id, name, owner, edit, rev, uris, max }
    this.listings = new Map();     // id -> { rev, uris, trunc, readyAt, fetched } (the engine's 5-min listing cache)
    this.log = [];                 // every request: { t, m, p, ctx, q }
    this.enumMs = 30;
    this.fail = null;              // { id, status }: the next /context/tracks of that playlist answers this
    this.rootDelay = 0;
  }

  // max: the engine's metadata.max_tracks for it (its listing is cut there, truncated: true)
  add(c, { rev, uris, edit = true, owner = 'alex', name, max }) {
    this.pls.set(id(c), { id: id(c), name: name || 'Secret name ' + c, owner, edit, rev: rev || nextRev(c), uris: uris.slice(), max });
  }

  // Spotify changed it (another device): the engine's listing cache keeps the old one
  change(c, uris) { const p = this.pls.get(id(c)); p.uris = uris.slice(); p.rev = nextRev(c); }

  root() {
    return { items: [...this.pls.values()].map((p) => ({ uri: 'spotify:playlist:' + p.id, name: p.name, owner_username: p.owner, length: p.uris.length,
      can_edit: p.edit, collaborative: p.owner !== 'alex' && p.edit, revision: p.rev, folder: [], image_url: 'https://i.scdn.co/image/' + p.id.toLowerCase(), description: '' })) };
  }

  ctxReads(c) { return this.log.filter((x) => x.p.startsWith('/context/tracks') && (!c || x.ctx === PL(c))); }

  async get(p) {
    const q = new URLSearchParams(p.split('?')[1] || '');
    const entry = { t: Date.now(), m: 'GET', p, ctx: q.get('uri'), q };
    this.log.push(entry);
    await null;
    if (p.startsWith('/library/playlists')) {
      if (this.rootDelay) await sleep(this.rootDelay);
      return { status: 200, json: this.root() };
    }
    if (p.startsWith('/context/tracks')) {
      const uri = q.get('uri') || '';
      const pid = uri.slice(17);
      if (this.fail && this.fail.id === pid) { const st = this.fail.status; this.fail = null; return { status: st, json: null }; }
      const pl = uri.startsWith('spotify:playlist:') && this.pls.get(pid);
      if (!pl) return { status: 400, json: null };
      let L = this.listings.get(pid);
      if (q.get('refresh') === '1') L = null;
      if (!L) {
        const cut = !!pl.max && pl.uris.length > pl.max;
        L = { rev: pl.rev, uris: cut ? pl.uris.slice(0, pl.max) : pl.uris.slice(), trunc: cut, readyAt: Date.now() + this.enumMs, fetched: 0 };
        this.listings.set(pid, L);
      }
      const ready = Date.now() >= L.readyAt;
      if (ready && !L.fetched) L.fetched = Date.now();
      const j = { ready, length: ready ? L.uris.length : 0, cached: ready ? L.uris.length : 0, failed: 0, sweeping: false,
        revision: ready ? L.rev : '', fetched_at: ready ? L.fetched : 0, truncated: ready && L.trunc };
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
      pl.rev = nextRev(pl.id[0]);
      this.listings.delete(pl.id);              // the engine drops its listing on its own writes
      return { status: 200, json: {} };
    }
    return { status: 404, json: null };
  }
}

// ------------------------------------------------------------------ the fake Web API
const engine = new FakeEngine();
const webapi = {
  ready: true,
  user: { id: 'alex', name: 'Alex' },
  reqs: [],
  fail: null,
  async api(method, p, body) {
    this.reqs.push({ method, p, body });
    await null;
    if (method === 'GET' && p.startsWith('/me/playlists')) return { items: [], next: null };
    if (method === 'GET' && p.startsWith('/me/tracks')) return { total: 0, items: [] };
    const m = p.match(/^\/playlists\/([0-9A-Za-z]{22})\/items$/);
    if (method === 'DELETE' && m) {
      if (this.fail) { const f = this.fail; this.fail = null; throw f; }
      const pl = engine.pls.get(m[1]);
      if (!pl) throw Object.assign(new Error('Spotify doesn\'t have this (DELETE /playlists/x/items).'), { status: 404, code: 'not_found' });
      const gone = new Set(body.items.map((x) => x.uri));
      pl.uris = pl.uris.filter((u) => !gone.has(u));          // every copy goes
      pl.rev = nextRev(pl.id[0]);                              // (the engine's listing cache doesn't see a Web API write)
      return { snapshot_id: 'AAAAB' + revN };
    }
    throw Object.assign(new Error('unrouted ' + method + ' ' + p), { status: 404, code: 'not_found' });
  },
};
const bus = { events: [], push(type, data) { this.events.push({ type, data }); } };
const player = { st: {}, lastPhone: 0, noteLiked() {} };

const CT = { rootGap: 0, rootWait: 300, pollMs: 10, waitMs: 400, noSession: 10, enumHold: 200, enumLimit: 100, bgQuiet: 0, stallMs: 300 };
const MT = { gapMs: 80, pauseMs: 400, roomMs: 20, laterMs: 200, waitMs: 1000 };

async function until(what, fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(15);
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p09-'));
  // A: stored list at the library's revision (free); B: stored at an older one; C: someone's collaborative playlist
  // (editable); D: not editable; E: empty; F, G: plain
  engine.add('A', { uris: [T('1'), T('2')] });
  engine.add('B', { uris: [T('2'), T('3')] });
  engine.add('C', { uris: [T('4')], owner: 'friend' });
  engine.add('D', { uris: [T('1')], owner: 'friend', edit: false });
  engine.add('E', { uris: [] });
  engine.add('F', { uris: [T('1'), T('5'), T('1')] });
  engine.add('G', { uris: [T('6'), 'spotify:episode:' + id('7'), 'spotify:local:a:b:c:1'] });

  const catalog = new Catalog({ cfg: { cacheDir: dir }, engine, webapi, bus, player, images: null, timing: CT });
  // a playlist the phone opened earlier: its stored list (at A's revision), and B's at an older revision
  const stored = (c, v, uris) => catalog.store.put('list', sha1(PL(c)), { ctx: PL(c), kind: 'playlist', v, sig: null, at: Date.now(), len: uris.length,
    ms: 0, trunc: 0, un: 0, sun: 0, items: uris.map((u) => ({ u, n: 'Song', d: 180000 })) });
  stored('A', engine.pls.get(id('A')).rev, [T('1'), T('2')]);
  stored('B', 'b-old', [T('2')]);
  await sleep(50);                                                       // (disk writes)
  // background reads are held back at first: only the free lane (stored lists) may fill the index
  catalog.T.bgQuiet = 1e9;
  catalog.fgAt = Date.now();
  // one engine read at a time: instrument readUris (afterRead: runs once the listing is read, before the worker has it)
  const reads = [];
  let active = 0;
  let maxActive = 0;
  let afterRead = null;
  const readUris = catalog.readUris.bind(catalog);
  catalog.readUris = async (ctx, pl, w) => {
    const r = { ctx, start: Date.now(), end: 0 };
    reads.push(r);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const x = await readUris(ctx, pl, w);
      if (afterRead) await afterRead(ctx, x);
      return x;
    } finally { active--; r.end = Date.now(); }
  };
  const M = new Membership({ cfg: { cacheDir: dir }, catalog, timing: MT });
  await catalog.library(false);

  // ---- 400 for anything but one song uri
  for (const bad of [undefined, '', 'spotify:album:' + id('1'), T('1') + ',' + T('2'), 'spotify:track:short']) {
    await assert.rejects(M.containing(bad), (e) => e.status === 400 && e.code === 'bad_request', String(bad));
  }

  // ---- 1. from the catalog's stored lists, no engine traffic
  const c0 = parse(await until('A from its stored list', async () => { const m = await M.containing(T('1')); return parse(m).items[PL('A')] != null ? m : null; }));
  console.log('first containing:', JSON.stringify(c0).replace(/spotify:playlist:/g, ''));
  assert.deepStrictEqual(c0.items, { [PL('A')]: 1 });
  assert.strictEqual(c0.pending, 5, 'B (stored at an older revision), C, E, F, G pending; D is not editable');
  assert.strictEqual(engine.ctxReads().length, 0, 'no engine listing read');
  assert.strictEqual(reads.length, 0);
  assert.ok(!(PL('D') in c0.items));

  // ---- 2. a list the phone's browsing stores is taken in at once (the 'list' hook)
  const pb = parse(await until('B listed', async () => { const m = await catalog.playlist(id('B'), false); return parse(m).done ? m : null; }));
  assert.deepStrictEqual(pb.items.map((r) => r.u), [T('2'), T('3')]);
  let c = parse(await M.containing(T('3')));
  assert.deepStrictEqual(c.items, { [PL('A')]: 0, [PL('B')]: 1 });
  assert.strictEqual(c.pending, 4);
  assert.strictEqual(reads.length, 0, 'still no background read (the phone was busy)');

  // ---- 3. the gate: nothing while an enumeration runs or is held, or the window's budget is half used
  catalog.T.bgQuiet = 0;
  catalog.enums.set(PL('Z'), Date.now());
  M.kick(0);
  await sleep(150);
  assert.strictEqual(reads.length, 0, 'no read while an enumeration is in flight');
  catalog.enums.delete(PL('Z'));
  catalog.holds.set(PL('Z'), Date.now() + 150);
  await sleep(100);
  assert.strictEqual(reads.length, 0, 'no read while a list is held');
  catalog.holds.delete(PL('Z'));
  const window = catalog.enumStarts.length;
  for (let i = 0; i < 50 - window; i++) catalog.enumStarts.push(Date.now());       // 50 of 100: half used
  await sleep(100);
  assert.strictEqual(reads.length, 0, 'no read with half of the window used');
  catalog.enumStarts.splice(0, catalog.enumStarts.length - window);

  // ---- 4. the worker: one playlist at a time, at most one every gapMs, uris only (meta=0 / sweep=0)
  const t4 = engine.log.length;
  c = parse(await until('all indexed', async () => { const x = parse(await M.containing(T('1'))); return x.pending === 0 ? (await M.containing(T('1'))) : null; }));
  console.log('reads:', reads.map((r) => `${r.ctx.slice(17, 18)} ${r.end - r.start} ms`).join(', '));
  assert.deepStrictEqual(c.items, { [PL('A')]: 1, [PL('B')]: 0, [PL('C')]: 0, [PL('E')]: 0, [PL('F')]: 1, [PL('G')]: 0 });
  assert.strictEqual(maxActive, 1, 'one read at a time');
  assert.deepStrictEqual(reads.map((r) => r.ctx).sort(), [PL('C'), PL('E'), PL('F'), PL('G')]);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i].start - reads[i - 1].end >= MT.gapMs - 2, `read ${i} came ${reads[i].start - reads[i - 1].end} ms after the last`);
  for (const x of engine.log.slice(t4)) {
    if (!x.p.startsWith('/context/tracks')) continue;
    assert.strictEqual(x.q.get('sweep'), '0', 'never a sweep: ' + x.p);
    assert.ok(x.q.get('meta') === '0' || x.q.has('from'), 'summaries without metadata, then pages: ' + x.p);
  }
  assert.deepStrictEqual(parse(await M.containing(T('4'))).items[PL('C')], 1, 'the collaborative playlist');
  assert.deepStrictEqual(parse(await M.containing(T('6'))).items[PL('G')], 1, 'episodes and local files are left out, songs counted');
  assert.strictEqual(catalog.enums.size, 0, 'no enumeration left in flight');
  assert.ok(!catalog.prevSum.has(PL('C')), 'the stall rule\'s memory is left alone');
  // same answer, same ETag (the app revalidates)
  assert.strictEqual((await M.containing(T('1'))).etag, (await M.containing(T('1'))).etag);

  // ---- 5. stale revision: Spotify changed C, the engine still has its old listing; the library is newer
  engine.change('C', [T('4'), T('5')]);
  await sleep(5);
  const n5 = reads.length;
  const t5 = engine.log.length;
  await catalog.fetchRoot();                                             // library shows C's new revision
  c = parse(await M.containing(T('5')));
  assert.ok(!(PL('C') in c.items) && c.pending === 1, 'C is pending until read again');
  c = parse(await until('C read again', async () => { const x = parse(await M.containing(T('5'))); return x.pending === 0 ? await M.containing(T('5')) : null; }));
  assert.strictEqual(c.items[PL('C')], 1);
  assert.strictEqual(reads.length, n5 + 1);
  const refreshes = engine.log.slice(t5).filter((x) => x.ctx === PL('C') && x.q.get('refresh') === '1');
  assert.strictEqual(refreshes.length, 1, 'the old listing was read again once with refresh=1');
  assert.strictEqual(M.idx.get(PL('C')).v, engine.pls.get(id('C')).rev);
  // the refresh gap: an old listing within a minute of the last refresh=1 is left for later (null), no second refresh
  engine.change('C', [T('4')]);
  await sleep(5);
  await catalog.fetchRoot();
  engine.listings.get(id('C')).fetched = Date.now() - 1000;             // (older than the rootlist)
  const plC = catalog.build.byId.get(id('C')).pl;
  const refreshCount = () => engine.log.filter((x) => x.ctx === PL('C') && x.q && x.q.get('refresh') === '1').length;
  const r0 = refreshCount();
  assert.strictEqual(await readUris(PL('C'), plC, 500), null, 'refreshed less than a minute ago: later');
  assert.strictEqual(refreshCount(), r0, 'no second refresh=1 within the minute');
  catalog.lastRefresh.delete(PL('C'));
  const rc = await readUris(PL('C'), plC, 500);
  assert.deepStrictEqual(rc, { v: plC.v, uris: [T('4')], trunc: false }, 'read again once the gap allows');
  await until('C current again', async () => parse(await M.containing(T('5'))).pending === 0);

  // ---- 6. a 429 from the engine: no reads for pauseMs, then the playlist is read
  engine.change('E', [T('6')]);
  engine.listings.delete(id('E'));
  engine.fail = { id: id('E'), status: 429 };
  const n6 = reads.length;
  await sleep(MT.gapMs);
  await catalog.fetchRoot();
  await until('the 429', async () => reads.length > n6 && reads[n6].end);
  const failedAt = reads[n6].end;
  assert.ok(M.pauseUntil >= failedAt + MT.pauseMs - 5, 'paused');
  assert.ok(M.info().paused_s > 0);
  assert.ok(M.queue.includes(PL('E')), 'E stays queued');
  c = parse(await M.containing(T('6')));
  assert.ok(!(PL('E') in c.items) && c.pending === 1);
  await sleep(MT.pauseMs / 2);
  assert.strictEqual(reads.length, n6 + 1, 'nothing during the pause');
  c = parse(await until('E after the pause', async () => { const x = parse(await M.containing(T('6'))); return x.pending === 0 ? await M.containing(T('6')) : null; }));
  assert.strictEqual(c.items[PL('E')], 1);
  assert.ok(reads[n6 + 1].start >= failedAt + MT.pauseMs - 2, 'the next read waited for the pause');
  // a 500 holds the list in the catalog (enumHold) and pauses the worker too
  engine.change('G', [T('6'), T('8')]);
  engine.listings.delete(id('G'));
  engine.fail = { id: id('G'), status: 500 };
  const n6b = reads.length;
  await sleep(MT.gapMs);
  await catalog.fetchRoot();
  await until('the 500', async () => reads.length > n6b && reads[n6b].end);
  assert.ok(catalog.heldFor(PL('G')) > 0 && M.pauseUntil > Date.now());
  await until('G after the pause', async () => parse(await M.containing(T('8'))).items[PL('G')] === 1);

  // ---- 7. op add keeps the index exact (the new revision is known: no re-read)
  catalog.T.bgQuiet = 300;                                              // (a write keeps background reads away a while)
  const n7 = reads.length;
  const t7 = engine.log.length;
  const add = parse(await catalog.items(id('A'), { op: 'add', uris: [T('3')], allow_duplicates: true }));
  assert.strictEqual(add.added, 1);
  assert.strictEqual(add.playlist.u, PL('A'));
  assert.strictEqual(add.playlist.v, engine.pls.get(id('A')).rev, 'the rootlist after the add came back in time');
  await sleep(20);
  assert.strictEqual(M.idx.get(PL('A')).v, add.playlist.v, 'the index took the new revision');
  c = parse(await M.containing(T('3')));
  assert.strictEqual(c.pending, 0);
  assert.deepStrictEqual(c.items, { [PL('A')]: 1, [PL('B')]: 1, [PL('C')]: 0, [PL('E')]: 0, [PL('F')]: 0, [PL('G')]: 0 });
  await sleep(400);
  assert.strictEqual(reads.length, n7, 'no re-read after our own add');
  assert.strictEqual(engine.log.slice(t7).filter((x) => x.ctx === PL('A')).length, 0, 'no listing read of A');
  assert.ok(bus.events.some((e) => e.type === 'playlist' && e.data.u === PL('A')));

  // ---- 8. op add whose new revision isn't known yet: exact at once, read again once the library moves on
  engine.rootDelay = 250;
  catalog.T.rootWait = 50;
  const n8 = reads.length;
  const add2 = parse(await catalog.items(id('F'), { op: 'add', uris: [T('9')], allow_duplicates: true }));
  assert.strictEqual(add2.added, 1);
  await sleep(10);
  const eF = M.idx.get(PL('F'));
  assert.ok(eF.v === catalog.build.byId.get(id('F')).pl.v && eF.ids.has(id('9')), 'in place, still at the library\'s (old) revision');
  c = parse(await M.containing(T('9')));
  assert.strictEqual(c.items[PL('F')], 1, 'answered at once');
  await until('the rootlist lands', async () => catalog.build.byId.get(id('F')).pl.v === engine.pls.get(id('F')).rev);
  engine.rootDelay = 0;
  catalog.T.rootWait = 300;
  await until('F read again', async () => reads.length > n8 && M.current(M.idx.get(PL('F')), catalog.build.byId.get(id('F')).pl));
  assert.strictEqual(reads[n8].ctx, PL('F'));
  assert.strictEqual(parse(await M.containing(T('9'))).items[PL('F')], 1);
  assert.strictEqual(parse(await M.containing(T('5'))).items[PL('F')], 1, 'the rest of F is still there');

  // ---- 9. op remove: Web API DELETE /playlists/{id}/items, {items: [{uri}]}; index exact; stored list invalidated
  const n9 = reads.length;
  const w9 = webapi.reqs.length;
  const ev9 = bus.events.length;
  const rm = parse(await catalog.items(id('B'), { op: 'remove', uris: [T('2')] }));
  const del = webapi.reqs.slice(w9).filter((x) => x.method === 'DELETE');
  assert.strictEqual(del.length, 1);
  assert.strictEqual(del[0].p, `/playlists/${id('B')}/items`);
  assert.deepStrictEqual(del[0].body, { items: [{ uri: T('2') }] });
  assert.strictEqual(rm.removed, 1);
  assert.strictEqual(rm.playlist.u, PL('B'));
  assert.strictEqual(rm.playlist.len, 1);
  assert.strictEqual(rm.playlist.v, engine.pls.get(id('B')).rev);
  assert.ok(!('added' in rm));
  const pev = bus.events.slice(ev9).filter((e) => e.type === 'playlist');
  assert.ok(pev.length >= 1 && pev.every((e) => e.data.u === PL('B') && e.data.len === 1), 'the same event an add pushes');
  await sleep(20);
  c = parse(await M.containing(T('2')));
  assert.strictEqual(c.items[PL('B')], 0, 'removed');
  assert.strictEqual(c.items[PL('A')], 1);
  assert.strictEqual(parse(await M.containing(T('3'))).items[PL('B')], 1, 'the other song stays');
  const stB = await catalog.store.get('list', sha1(PL('B')));
  assert.ok(stB.inv && stB.v === '', 'the stored list is read again next time');
  await sleep(400);
  assert.strictEqual(reads.length, n9, 'no re-read after our own remove');
  // the phone opens B: the engine still holds its pre-remove listing, so it is read again with refresh=1
  const t9 = engine.log.length;
  const pb2 = parse(await until('B listed again', async () => { const m = await catalog.playlist(id('B'), false); return parse(m).done ? m : null; }));
  assert.deepStrictEqual(pb2.items.map((r) => r.u), [T('3')]);
  assert.ok(engine.log.slice(t9).some((x) => x.ctx === PL('B') && x.q.get('refresh') === '1'), 'refresh=1');
  // remove a song that is in the playlist twice: every copy goes
  catalog.T.bgQuiet = 0;
  const rm2 = parse(await catalog.items(id('F'), { op: 'remove', uris: [T('1')] }));
  assert.strictEqual(rm2.playlist.len, engine.pls.get(id('F')).uris.length);
  await sleep(20);
  assert.strictEqual(parse(await M.containing(T('1'))).items[PL('F')], 0);

  // ---- 10. the remove's errors
  const w10 = webapi.reqs.length;
  await assert.rejects(catalog.items(id('D'), { op: 'remove', uris: [T('1')] }), (e) => e.status === 403 && e.code === 'not_editable');
  await assert.rejects(catalog.items(id('Q'), { op: 'remove', uris: [T('1')] }), (e) => e.status === 404 && e.code === 'not_found');
  for (const b of [null, {}, { op: 'move', uris: [T('1')] }, { op: 'remove' }, { op: 'remove', uris: [] }, { op: 'remove', uris: ['spotify:album:' + id('1')] },
    { op: 'remove', uris: Array.from({ length: 51 }, (_, i) => T(String.fromCharCode(65 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)))) }]) {
    await assert.rejects(catalog.items(id('A'), b), (e) => e.status === 400 && e.code === 'bad_request', JSON.stringify(b).slice(0, 60));
  }
  assert.strictEqual(webapi.reqs.slice(w10).filter((x) => x.method === 'DELETE').length, 0, 'nothing reached Spotify');
  const before10 = M.idx.get(PL('A'));
  webapi.fail = Object.assign(new Error('Spotify refused this (DELETE /playlists/x/items: Forbidden).'), { status: 403, code: 'spotify_forbidden', spotifyStatus: 403 });
  await assert.rejects(catalog.items(id('A'), { op: 'remove', uris: [T('1')] }), (e) => e.status === 403 && e.code === 'not_editable');
  webapi.fail = Object.assign(new Error('Spotify doesn\'t have this (DELETE /playlists/x/items).'), { status: 404, code: 'not_found', spotifyStatus: 404 });
  await assert.rejects(catalog.items(id('A'), { op: 'remove', uris: [T('1')] }), (e) => e.status === 404 && e.code === 'not_found');
  webapi.fail = Object.assign(new Error('Spotify is limiting requests. Try again in 7 s.'), { status: 503, code: 'rate_limited', retry_after: 7 });
  await assert.rejects(catalog.items(id('A'), { op: 'remove', uris: [T('1')] }), (e) => e.status === 503 && e.code === 'rate_limited' && e.retry_after === 7);
  webapi.fail = Object.assign(new Error('Connect your Spotify account on the gateway admin page first'), { status: 503, code: 'spotify_not_connected' });
  await assert.rejects(catalog.items(id('A'), { op: 'remove', uris: [T('1')] }), (e) => e.code === 'spotify_not_connected');
  webapi.fail = Object.assign(new Error('Spotify DELETE /playlists/x/items: boom'), { status: 502, code: 'spotify_error' });
  await assert.rejects(catalog.items(id('A'), { op: 'remove', uris: [T('1')] }), (e) => e.status === 502 && e.code === 'spotify_error');
  assert.strictEqual(M.idx.get(PL('A')), before10, 'a failed remove leaves the index alone');
  assert.strictEqual(parse(await M.containing(T('1'))).items[PL('A')], 1);
  // op add is unchanged: its duplicate check still answers 409 with the uris
  await assert.rejects(catalog.items(id('A'), { op: 'add', uris: [T('1')] }), (e) => e.status === 409 && e.code === 'duplicate' && e.uris[0] === T('1'));

  // ---- 11. the index survives a restart (from disk; nothing read)
  await sleep(200);
  const n11 = reads.length;
  const t11 = engine.log.length;
  const catalog2 = new Catalog({ cfg: { cacheDir: dir }, engine, webapi, bus, player, images: null, timing: CT });
  const M2 = new Membership({ cfg: { cacheDir: dir }, catalog: catalog2, timing: MT });
  await catalog2.library(false);
  c = parse(await M2.containing(T('1')));
  assert.strictEqual(c.pending, 0, 'all known from disk');
  assert.deepStrictEqual(c.items, parse(await M.containing(T('1'))).items);
  await sleep(200);
  assert.strictEqual(engine.log.slice(t11).filter((x) => x.p.startsWith('/context/tracks')).length, 0, 'no listing read after the restart');
  assert.strictEqual(reads.length, n11);
  console.log('membership info:', JSON.stringify(M2.info()));

  // ---- 12. a listing the engine cut at metadata.max_tracks (truncated): a song in it is 1; a song not in it gets no
  // answer (not 0: it may be past the cut; not pending: it never becomes known)
  engine.add('H', { uris: [T('1'), T('2'), T('3')], max: 2 });
  await sleep(MT.gapMs);
  await catalog.fetchRoot();
  const rowOf = (c1) => catalog.build.byId.get(id(c1)).pl;
  await until('H read', async () => M.current(M.idx.get(PL('H')), rowOf('H')));
  assert.ok(M.idx.get(PL('H')).trunc, 'the entry knows its listing was cut');
  c = parse(await M.containing(T('3')));
  assert.ok(!(PL('H') in c.items), 'a song past the cut: no answer');
  assert.strictEqual(c.pending, 0, 'and not pending');
  assert.strictEqual(c.items[PL('B')], 1, 'the others answer as before');
  assert.strictEqual(parse(await M.containing(T('2'))).items[PL('H')], 1, 'a song within the cut');
  // the phone's own (cut) list of it keeps it cut: the 'list' hook and the stored list carry trunc
  const ph = parse(await until('H listed', async () => { const m = await catalog.playlist(id('H'), false); return parse(m).done ? m : null; }));
  assert.strictEqual(ph.trunc, 1);
  assert.deepStrictEqual(ph.items.map((r) => r.u), [T('1'), T('2')]);
  assert.strictEqual((await catalog.storedUris(PL('H'))).trunc, true);
  assert.ok(M.idx.get(PL('H')).trunc);
  assert.ok(!(PL('H') in parse(await M.containing(T('3'))).items));
  // and on disk (M2 has never seen H: it reads the file)
  await sleep(100);
  assert.ok(!M2.idx.has(PL('H')));
  assert.ok((await M2.entry(PL('H'))).trunc, 'trunc is kept on disk');
  // our own add to it is answered (taken in place; the engine would list it past the cut)
  await catalog.items(id('H'), { op: 'add', uris: [T('5')], allow_duplicates: true });
  await sleep(20);
  assert.ok(M.current(M.idx.get(PL('H')), rowOf('H')) && M.idx.get(PL('H')).trunc);
  assert.strictEqual(parse(await M.containing(T('5'))).items[PL('H')], 1, 'the added song');

  // ---- 13. a write whose forced rootlist refresh rootGap defers past rootWait answers at once (a "Saved in" Done sends
  // its writes one after another); the index stays exact, and the playlist is read again once the library moves on
  catalog.T.rootGap = 1500;
  catalog.T.rootWait = 1000;
  await catalog.fetchRoot();                                             // (the last rootlist fetch: just now)
  const vA = rowOf('A').v;
  let t13 = Date.now();
  const rm3 = parse(await catalog.items(id('A'), { op: 'remove', uris: [T('3')] }));
  assert.ok(Date.now() - t13 < 500, `the remove answered after ${Date.now() - t13} ms`);
  assert.strictEqual(rm3.removed, 1);
  assert.strictEqual(rm3.playlist.v, vA, 'the cached build answers');
  t13 = Date.now();
  await catalog.items(id('A'), { op: 'add', uris: [T('8')], allow_duplicates: true });
  assert.ok(Date.now() - t13 < 500, `the add answered after ${Date.now() - t13} ms`);
  await sleep(20);
  assert.strictEqual(M.idx.get(PL('A')).v, vA, 'both in place, at the library\'s (old) revision');
  assert.strictEqual(parse(await M.containing(T('3'))).items[PL('A')], 0, 'removed');
  assert.strictEqual(parse(await M.containing(T('8'))).items[PL('A')], 1, 'added');
  await until('the deferred rootlist lands', async () => rowOf('A').v === engine.pls.get(id('A')).rev);
  await until('A read again', async () => M.current(M.idx.get(PL('A')), rowOf('A')));
  assert.strictEqual(parse(await M.containing(T('3'))).items[PL('A')], 0);
  assert.strictEqual(parse(await M.containing(T('8'))).items[PL('A')], 1);
  catalog.T.rootGap = 0;
  catalog.T.rootWait = 300;

  // ---- 14. a background read that a write lands during is thrown away (its listing may predate the write) and done
  // again: a remove from J while J is read, its rootlist slow (the library stays at the old revision a while)
  let hooked = false;
  afterRead = async (ctx) => {
    if (ctx !== PL('J') || hooked) return;
    hooked = true;
    engine.rootDelay = 400;
    catalog.T.rootWait = 50;
    await catalog.items(id('J'), { op: 'remove', uris: [T('4')] });
  };
  const n14 = reads.length;
  engine.add('J', { uris: [T('4'), T('b')] });
  await sleep(MT.gapMs);
  await catalog.fetchRoot();
  await until('the read of J, and the remove during it', async () => hooked && reads.slice(n14).some((r) => r.ctx === PL('J') && r.end));
  await sleep(5);
  assert.notStrictEqual(rowOf('J').v, engine.pls.get(id('J')).rev, '(the library is still at the old revision)');
  c = parse(await M.containing(T('4')));
  assert.notStrictEqual(c.items[PL('J')], 1, 'the pre-remove listing was not taken');
  await until('J indexed after the remove', async () => rowOf('J').v === engine.pls.get(id('J')).rev && M.current(M.idx.get(PL('J')), rowOf('J')));
  assert.strictEqual(parse(await M.containing(T('4'))).items[PL('J')], 0, 'removed');
  assert.strictEqual(parse(await M.containing(T('b'))).items[PL('J')], 1);
  assert.ok(reads.slice(n14).filter((r) => r.ctx === PL('J')).length >= 2, 'J was read again');
  afterRead = null;
  engine.rootDelay = 0;
  catalog.T.rootWait = 300;
  console.log('ALL OK', reads.length, 'background reads,', engine.ctxReads().length, 'listing requests');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
