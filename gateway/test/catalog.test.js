'use strict';
// catalog.js against an in-process model of the patch-2 engine and a fake Web API.
// fixtures/rootlist.json is a synthetic rootlist (made-up ids, names, owners and covers) with the engine's shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeCatalog, body, sleep, entries, ME, id22, FakeWebApi } = require('./support/helpers');
const { EngineModel } = require('./support/engine-model');
const { plainText } = require('../src/catalog');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rootlist.json'), 'utf8'));
const key = (ctx) => require('crypto').createHash('sha1').update(ctx).digest('hex');
const FIX_ME = 'alex';                       // the owner of the fixture's own lists

function fixtureModel(extra = {}) {
  const model = new EngineModel({ username: FIX_ME, ...extra });
  for (const it of FIX.items) model.addPlaylist({ ...it, revision: it.uri.endsWith('D') ? '' : 'ab' + it.length.toString(16) });
  return model;
}

function pl(model, name, o = {}) {
  const id = id22('pl' + name);
  const uri = 'spotify:playlist:' + id;
  model.addPlaylist({ uri, name, owner_username: ME, length: o.length || 0, can_edit: o.can_edit !== false, revision: o.revision || 'r1', image_url: o.image_url || null, ...o.extra });
  return { id, uri };
}

// Poll like the app (every retry_ms) until done; returns every answer.
async function pollList(fn, max = 80) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const b = body(await fn());
    out.push(b);
    if (b.done) break;
    await sleep(b.retry_ms || 100);
  }
  return out;
}

// ---------------------------------------------------------------- the library root
test('build: a 99-entry rootlist (synthetic fixture) -> PL rows', async () => {
  const model = fixtureModel();
  const webapi = new FakeWebApi();
  webapi.user = { id: FIX_ME, name: 'Alex Example' };
  const ownImageless = FIX.items.find((it) => it.owner_username === FIX_ME && !it.image_url);
  const citrus = FIX.items.find((it) => it.name.startsWith('Citrus'));
  webapi.on(/^\/me\/playlists/, () => ({ items: [
    { id: ownImageless.uri.slice(17), images: [{ url: 'https://mosaic.scdn.co/640/ab67616d0000b273aaaa' }], owner: { display_name: 'Alex Example' } },
    { id: citrus.uri.slice(17), images: [], owner: { display_name: 'Citrus Friend' } }], next: null }));
  webapi.on(/^\/me\/tracks/, () => ({ total: 1234, items: [{ track: { uri: 'spotify:track:' + id22('newest') } }] }));
  const { cat, events } = makeCatalog({ model, webapi });
  const b = body(await cat.library(false));
  assert.deepEqual(Object.keys(b), ['me', 'liked', 'items'], 'only me, liked, items: no sync time in the body');
  assert.equal(b.items.length, 97, 'the two junk entries are hidden');
  assert.ok(!b.items.some((x) => x.n === 'DJ' || x.n === ''), 'junk: name "" and spotify with length 0');
  const by = (n) => b.items.find((x) => x.n === n);
  const fam = by('Band Practice');
  assert.equal(fam.ed, 1); assert.equal(fam.c, 1); assert.equal(fam.own, undefined);
  assert.equal(by('slow sunday').ed, undefined, 'slow sunday is not editable');
  assert.equal(by('Discover Weekly').mf, 1, 'Discover Weekly is made for me');
  assert.equal(by('Discover Weekly').o, 'Spotify');
  assert.equal(by('Kitchen Disco').o, 'Alex Example');
  assert.equal(by('Kitchen Disco').own, 1);
  assert.equal(by('Kitchen Disco').i, 'ab67706c0000da8418b272c3148d7abf4cdba470', 'i.scdn.co -> 40 hex token');
  assert.match(by('Discover Weekly').i, /^u[A-Za-z0-9_-]+$/, 'pickasso -> u token');
  assert.equal(by('Your Top Songs 2023').mf, 1);
  assert.equal(by('This Is Nova Lark').mf, undefined);
  assert.equal(by('slow sunday').o, FIX.items.find((x) => x.name === 'slow sunday').owner_username, 'else the username');
  assert.ok(!b.items.some((x) => 'd' in x), 'no descriptions in the root');
  assert.ok(b.items.every((x) => !Object.values(x).some((v) => v === null)), 'no nulls');
  assert.equal(b.me.id, FIX_ME);
  assert.equal(b.liked.ctx, `spotify:user:${FIX_ME}:collection`);
  // the merge ran in the background: the imageless own playlist gets its mosaic
  await sleep(50);
  const b2 = body(await cat.library(false));
  assert.match(b2.items.find((x) => x.u === ownImageless.uri).i, /^u/, 'webpl mosaic fills a missing cover');
  assert.equal(b2.items.find((x) => x.n === citrus.name).o, 'Citrus Friend', 'other owners: the merged display name');
  assert.equal(b2.liked.len, 1234, 'liked.len from the Liked signal');
  assert.equal(events.filter((e) => e.type === 'playlists').length >= 1, true, 'playlists event when the body changed');
  // same ETag for two identical builds
  const e1 = cat.build && (await cat.library(false)).etag;
  cat.rebuild(true);
  const n = events.length;
  const e2 = (await cat.library(false)).etag;
  assert.equal(e1, e2, 'identical builds have the same ETag');
  assert.equal(events.length, n, 'and push nothing');
});

test('build: folders, descriptions', async () => {
  const model = new EngineModel();
  const a = pl(model, 'In folder', { extra: { folder: ['Outer', 'Inner'], description: '<a href="x">Jazz</a> r&amp;b &quot;mix&quot; &#x27;99 &#8212;  ok' } });
  const { cat } = makeCatalog({ model });
  const b = body(await cat.library(false));
  assert.deepEqual(b.items.find((x) => x.u === a.uri).f, ['Outer', 'Inner']);
  assert.equal(plainText('<b>Hi</b>&amp;<i>there</i> &#39;x&#39;   &lt;3 &#x2014; &nbsp;y'), 'Hi & there \'x\' <3 — y');
  model.ctxs.clear();
  model.addContext(a.uri, entries('fd', 3, 'cached'), { revision: 'r1', enumMs: 0 });
  const r = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(r.h.d, 'Jazz r&b "mix" \'99 — ok', 'description stripped and decoded in the detail header');
});

test('webpl merge: 10-min minimum, early merge for an unknown own imageless id, never for ids the merge did not return', async () => {
  const model = new EngineModel();
  const known = pl(model, 'known');
  const spot = { uri: 'spotify:playlist:' + id22('spot'), name: 'Daily Mix 1', owner_username: 'spotify', length: 50, can_edit: false };
  model.addPlaylist(spot);
  const webapi = new FakeWebApi();
  webapi.on(/^\/me\/playlists/, () => ({ items: model.playlists.filter((x) => x.owner_username === ME).map((x) => ({ id: x.uri.slice(17), images: [{ url: 'https://mosaic.scdn.co/640/' + x.uri.slice(17) }], owner: { display_name: 'Me' } })), next: null }));
  webapi.on(/^\/me\/tracks/, () => ({ total: 5, items: [] }));
  const { cat } = makeCatalog({ model, webapi, timing: { mergeGap: 1500, mergeDebounce: 100, rootFresh: 0, rootGap: 0 } });
  await cat.library(false);
  await sleep(30);
  assert.equal(webapi.count(/^\/me\/playlists/), 1, 'the first request merges');
  assert.ok(cat.webpl.missing.includes(spot.uri.slice(17)), 'the spotify playlist is remembered as not returned');
  await cat.library(true);
  await sleep(150);
  assert.equal(webapi.count(/^\/me\/playlists/), 1, 'no second merge inside the minimum, spotify id triggers nothing');
  pl(model, 'new one');                                         // own, no image, unknown
  await cat.library(true);
  await sleep(300);
  assert.equal(webapi.count(/^\/me\/playlists/), 1, 'the early merge still waits for the minimum');
  await sleep(1400);
  assert.equal(webapi.count(/^\/me\/playlists/), 2, 'one early merge once the minimum is over');
  assert.equal(known.uri.length > 0, true);
  await cat.library(true);
  await sleep(300);
  assert.equal(webapi.count(/^\/me\/playlists/), 2, 'nothing unknown left: no more merges');
});

// ---------------------------------------------------------------- song lists
test('listing: wait -> partial -> done, pages of 500, episodes and local files dropped, engine_est', async () => {
  const model = new EngineModel({ enumMs: 300, batchMs: 25 });
  const a = pl(model, 'big', { length: 1234, revision: 'r1' });
  const ents = entries('big', 1229);
  ents.splice(10, 0, { uri: 'spotify:episode:' + id22('ep1'), meta: 'ok' });
  ents.splice(600, 0, { uri: 'spotify:episode:' + id22('ep2'), meta: 'ok' });
  ents.splice(1100, 0, { uri: 'spotify:episode:' + id22('ep3'), meta: 'ok' });
  ents.splice(50, 0, { uri: 'spotify:local:Artist:Album:Song:200', meta: 'never' });
  ents.splice(700, 0, { uri: 'spotify:local:Artist:Album:Song2:201', meta: 'never' });
  model.addContext(a.uri, ents, { revision: 'r1' });
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  const est0 = cat.counters().engine_est;
  const answers = await pollList(() => cat.playlist(a.id, false));
  const first = answers[0];
  assert.equal(first.wait, 1); assert.equal(first.len, 1234, 'wait: the rootlist len'); assert.deepEqual(first.items, []);
  assert.equal(first.retry_ms, 100);
  const partials = answers.filter((x) => !x.done && !x.wait);
  assert.ok(partials.length >= 1, `partial answers seen (${partials.length})`);
  for (const p of partials) {
    assert.ok(p.items.length <= 100, 'partial: at most 100 rows');
    assert.equal(p.len, 1234); assert.ok(p.have <= 1234);
    assert.ok(p.items.every((r) => r.u.startsWith('spotify:track:')), 'partial: tracks only');
  }
  const done = answers[answers.length - 1];
  assert.equal(done.done, 1);
  assert.equal(done.len, 1229, 'len counts tracks only'); assert.equal(done.have, 1229); assert.equal(done.items.length, 1229);
  assert.ok(done.items.every((r) => r.u.startsWith('spotify:track:') && !r.x && r.n), 'done: every row has metadata');
  assert.equal(done.items[0].u, ents[0].uri, 'engine order kept');
  assert.equal(done.v, 'r1'); assert.equal(done.k, 'playlist'); assert.equal(done.ctx, a.uri);
  assert.equal(done.ms, done.items.reduce((n, r) => n + r.d, 0));
  assert.equal(done.h.n, 'big'); assert.equal(done.h.len, 1234);
  assert.ok(done.items.some((r) => r.e === 1) && done.items.some((r) => !('e' in r)), 'explicit flags');
  const pages = model.log.filter((x) => x.path.startsWith('/context/tracks') && x.path.includes('limit=500'));
  assert.equal(pages.length, 3, 'rows read in pages of 500');
  assert.ok(pages.every((x) => x.path.includes('sweep=0')), 'row pages never ask for a sweep');
  const est = cat.counters().engine_est - est0;
  assert.ok(est >= 25 + 1 && est <= 25 + 13, `engine_est: 25 pages + metadata batches (${est})`);
  // stored: the next request costs no engine call
  const n = model.log.length;
  const again = body(await cat.playlist(a.id, false));
  assert.equal(again.done, 1); assert.equal(model.log.length, n, 'a valid stored listing: no engine call');
});

test('listing: un rows from failed entries, reuse of an evicted row, x rows', async () => {
  const model = new EngineModel({ enumMs: 0, batchMs: 10 });
  const a = pl(model, 'fails', { length: 20, revision: 'r1' });
  const ents = entries('fl', 20);
  ents[3].meta = 'fail'; ents[7].meta = 'fail';
  const c = model.addContext(a.uri, ents, { revision: 'r1' });
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  const done = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(done.len, 20); assert.equal(done.have, 18);
  assert.deepEqual(done.items[3], { u: ents[3].uri, un: 1 }); assert.deepEqual(done.items[7], { u: ents[7].uri, un: 1 });
  // a list with un rows lives 10 min (not by revision): make it old, then an entry's metadata is evicted between the
  // summary and the page -> the old row is reused
  const st = await cat.store.get('list', require('crypto').createHash('sha1').update(a.uri).digest('hex'));
  st.at = Date.now() - 11 * 60000;
  model.hooks.evictOnPage = ents[5].uri;
  const again = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(again.done, 1);
  assert.equal(again.items[5].n, done.items[5].n, 'the evicted entry: the old stored row');
  // evicted with no old row: the list stays partial (x row)
  await cat.flush('lists');
  const r = body(await cat.playlist(a.id, false));
  assert.ok(!r.done && r.items.some((x) => x.x === 1 && x.u === ents[5].uri), 'no old row: partial with an x row');
  model.hooks.evictOnPage = null;
  assert.equal(c.n.sweepsScheduled >= 1, true);
});

test('listing B1: an entry that never arrives (not failed, not sweeping) ends by the stall rule, after the hold wait', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const a = pl(model, 'b1', { length: 50, revision: 'r1' });
  const ents = entries('b1', 50, 'cached');
  ents[20].meta = 'never';
  const c = model.addContext(a.uri, ents, { revision: 'r1' });
  c.cached.delete(ents[20].uri);
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  const per = [];
  const answers = await pollList(async () => { const n = c.n.summaries; const m = await cat.playlist(a.id, false); per.push(c.n.summaries - n); return m; });
  const r1 = answers[answers.length - 1];
  assert.ok(Math.max(...per) <= 5, `at most 5 summary polls per phone request (${per.join(',')})`);
  assert.ok(answers.length >= 2, `not finished at the first stall: it may be the engine's sweep hold (${answers.length} answers)`);
  assert.ok(answers.slice(0, -1).every((x) => !x.done && !x.items.some((r) => r.un)), 'no un rows before the stall is final');
  assert.ok(answers.slice(0, -1).some((x) => x.items[20] && x.items[20].x === 1), 'meanwhile it is an x row');
  assert.equal(r1.done, 1, 'finished by the stall rule once the hold wait was over');
  assert.deepEqual(r1.items[20], { u: ents[20].uri, un: 1 });
  assert.equal(r1.have, 49);
  const st = await cat.store.get('list', key(a.uri));
  assert.equal(st.un, 1, 'stored with its un row');
  assert.equal(st.sun, 1, 'counted as made by the stall rule');
  const polls1 = c.n.summaries;
  for (let i = 0; i < 5; i++) await cat.playlist(a.id, false);
  assert.equal(c.n.summaries, polls1, 'stored for 10 min: no more summary polls');
  assert.equal(c.n.sweepsScheduled, 0, 'nothing was ever missing that a sweep could fetch');
});

test('listing: a sweep hold reported as not sweeping (before the review: an error, then sweeping:false and nothing moves) is waited out, never stored as un rows', async () => {
  const model = new EngineModel({ enumMs: 0, batchMs: 30 });
  const a = pl(model, 'held', { length: 300, revision: 'r1' });
  const c = model.addContext(a.uri, entries('hd', 300), { revision: 'r1', failBatch: 2, holdMs: 200, holdSweeping: false });
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  const answers = await pollList(() => cat.playlist(a.id, false));
  const done = answers.pop();
  assert.equal(c.n.holds, 1, 'the engine held the list once');
  assert.ok(answers.some((x) => !x.done && x.have === 100), 'partial while it was held (one batch in)');
  assert.equal(done.done, 1); assert.equal(done.len, 300); assert.equal(done.have, 300);
  assert.ok(!done.items.some((r) => r.un || r.x), 'every row has its metadata: no un rows');
  const st = await cat.store.get('list', key(a.uri));
  assert.equal(st.un, 0); assert.equal(st.sun, 0);
});

test('listing: a sweep hold reported as sweeping (after the review) is no stall, even when it outlasts stallHoldMs', async () => {
  const model = new EngineModel({ enumMs: 0, batchMs: 30 });
  const a = pl(model, 'held sweeping', { length: 300, revision: 'r1' });
  const c = model.addContext(a.uri, entries('hs', 300), { revision: 'r1', failBatch: 2, holdMs: 700 });   // FAST stallHoldMs: 400
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  const answers = await pollList(() => cat.playlist(a.id, false));
  const done = answers.pop();
  assert.equal(c.n.holds, 1, 'the engine held the list once');
  assert.ok(answers.filter((x) => !x.done && x.have === 100).length >= 2, 'partials all through the hold (one batch in)');
  assert.ok(answers.every((x) => !x.items.some((r) => r.un)), 'no un rows meanwhile');
  assert.equal(done.done, 1); assert.equal(done.len, 300); assert.equal(done.have, 300);
  assert.ok(!done.items.some((r) => r.un || r.x), 'every row has its metadata');
  assert.equal(c.n.sweepsScheduled, 2, 'swept again once, by the first poll after the hold');
  const st = await cat.store.get('list', key(a.uri));
  assert.equal(st.un, 0); assert.equal(st.sun, 0);
});

test('listValid: stall-made un rows live 10 min (Liked too, whatever the signal); un rows from failed entries follow the signal', () => {
  const { cat } = makeCatalog();
  cat.likedSig = { total: 5, first: 'x', at: Date.now() };
  const sig = { total: 5, first: 'x' };
  const old = Date.now() - 11 * 60000;
  assert.equal(cat.listValid({ sig, at: old, un: 2, sun: 2, items: [] }, 'liked', null), false, 'Liked, stall-made un rows, 11 min old');
  assert.equal(cat.listValid({ sig, at: Date.now(), un: 2, sun: 2, items: [] }, 'liked', null), true, '... younger than 10 min');
  assert.equal(cat.listValid({ sig: { total: 6, first: 'x' }, at: Date.now(), un: 2, sun: 2, items: [] }, 'liked', null), false, '... and the signal still counts');
  assert.equal(cat.listValid({ sig, at: old, un: 2, sun: 0, items: [] }, 'liked', null), true, 'Liked, un rows from failed entries: the signal decides');
  assert.equal(cat.listValid({ v: 'r1', at: old, un: 1, sun: 1, items: [] }, 'playlist', { v: 'r1' }), false, 'a playlist with un rows: 10 min');
  assert.equal(cat.listValid({ v: 'r1', at: old, un: 0, sun: 0, items: [] }, 'playlist', { v: 'r1' }), true, 'no un rows: the revision decides');
});

test('listing: no stall while the engine sweeps', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const a = pl(model, 'sweeping', { length: 30, revision: 'r1' });
  const ents = entries('sw', 30, 'cached');
  const c = model.addContext(a.uri, ents, { revision: 'r1', stuckSweeping: true });
  c.cached.delete(ents[0].uri);
  ents[0].meta = 'ok';
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  for (let i = 0; i < 4; i++) {
    const r = body(await cat.playlist(a.id, false));
    assert.ok(!r.done, 'still partial while sweeping');
    assert.equal(r.have, 29);
    assert.equal(r.items[0].x, 1);
  }
  assert.equal(await cat.store.has('list', require('crypto').createHash('sha1').update(a.uri).digest('hex')), false, 'partials are never stored');
});

test('listing: revision validity, refresh=1 on the first poll only and once a minute, rootlist-newer / listing-newer', async () => {
  const model = new EngineModel({ enumMs: 50, batchMs: 10 });
  const a = pl(model, 'rev', { length: 10, revision: 'r1' });
  const c = model.addContext(a.uri, entries('rv', 10), { revision: 'r1' });
  const { cat } = makeCatalog({ model, timing: { rootGap: 0 } });
  const key = require('crypto').createHash('sha1').update(a.uri).digest('hex');
  const setRoot = (rev) => { model.playlists.find((x) => x.uri === a.uri).revision = rev; };
  await cat.library(false);
  let done = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(done.v, 'r1');
  assert.equal(c.n.refresh, 0, 'no refresh for a first read');
  const n0 = model.log.length;
  await cat.playlist(a.id, false);
  assert.equal(model.log.length, n0, 'same revision: no engine call');
  // a change made elsewhere: the rootlist says r2, the engine still holds its r1 listing (its 5-min cache)
  setRoot('r2');
  c.revision = 'r2';
  await cat.library(true);
  let before = c.n.refresh;
  let polls = c.n.summaries;
  const answers = await pollList(() => cat.playlist(a.id, false));
  done = answers.pop();
  assert.equal(c.n.refresh - before, 1, 'a stored listing at another revision: refresh=1, once');
  assert.ok(c.n.summaries - polls >= 2, 'later polls of the same read go without refresh');
  assert.equal(done.v, 'r2');
  assert.ok(model.log.filter((x) => x.path.includes('refresh=1')).every((x) => x.path.includes('meta=0')), 'refresh rides on a summary');
  // fresh=1 within a minute of the last refresh: ignored (served from the store)
  const n1 = model.log.length;
  await cat.playlist(a.id, true);
  assert.equal(model.log.length, n1, 'fresh=1 inside the minute is ignored');
  // rootlist newer than the engine's listing (and nothing stored): the engine's copy is read again with refresh=1
  cat.lastRefresh.clear();
  await cat.store.del('list', key);
  c.listing = { ready: true, readyAt: Date.now() - 5000, fetchedAt: Date.now() - 5000, revision: 'r2' };
  c.revision = 'r3';
  setRoot('r3');
  await cat.library(true);
  before = c.n.refresh;
  done = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(c.n.refresh - before, 1, 'the listing predates the rootlist: refresh=1');
  assert.equal(done.v, 'r3');
  // ... but only once a minute: within it the older listing is accepted (stored at its own revision, so invalid)
  await cat.store.del('list', key);
  c.listing = { ready: true, readyAt: Date.now() - 5000, fetchedAt: Date.now() - 5000, revision: 'r2' };
  await cat.library(true);
  before = c.n.refresh;
  done = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(c.n.refresh, before, 'refresh=1 at most once a minute per list');
  assert.equal(done.v, 'r2', 'stored with its own revision');
  // the listing newer than the rootlist: accepted, the rootlist refreshed in the background
  cat.lastRefresh.clear();
  await cat.store.del('list', key);
  await sleep(5);
  c.revision = 'r4';
  c.listing = { ready: true, readyAt: Date.now(), fetchedAt: Date.now() + 1000, revision: 'r4' };
  const roots = model.counts.rootlist;
  before = c.n.refresh;
  done = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(c.n.refresh, before, 'a newer listing is accepted without refresh');
  assert.equal(done.v, 'r4');
  await sleep(30);
  assert.ok(model.counts.rootlist >= roots + 1, 'and the rootlist is refreshed in the background');
});

test('limiter: a second list waits while one enumerates; the 13th enumeration in 5 min is busy', async () => {
  const model = new EngineModel({ enumMs: 2000 });
  const a = pl(model, 'slow', { length: 5 });
  const b = pl(model, 'other', { length: 7 });
  const ca = model.addContext(a.uri, entries('sa', 5), { revision: 'r1' });
  const cb = model.addContext(b.uri, entries('sb', 7), { revision: 'r1' });
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  const ra = body(await cat.playlist(a.id, false));
  assert.equal(ra.wait, 1);
  const rb = body(await cat.playlist(b.id, false));
  assert.equal(rb.wait, 1); assert.equal(rb.len, 7);
  assert.equal(cb.n.summaries + cb.n.pages + cb.n.full, 0, 'the second list asked the engine nothing');
  assert.ok(ca.n.summaries >= 1);
  // 12 enumerations already started in the window
  cat.enums.clear();
  const c2 = pl(model, 'third', { length: 3 });
  model.addContext(c2.uri, entries('sc', 3), { revision: 'r1' });
  await cat.library(true).catch(() => {});
  await sleep(350);
  await cat.library(true);
  cat.enumStarts = Array.from({ length: 12 }, () => Date.now() - 1000);
  await assert.rejects(cat.playlist(c2.id, false), (e) => e.status === 503 && e.code === 'busy' && e.retry_after > 250, '13th: busy with retry_after');
  // with a stored (invalid) listing: served stale
  const key = require('crypto').createHash('sha1').update(c2.uri).digest('hex');
  cat.store.put('list', key, { ctx: c2.uri, kind: 'playlist', v: 'old', sig: null, at: Date.now(), len: 1, ms: 1, trunc: 0, un: 0, items: [{ u: 'spotify:track:' + id22('z'), n: 'z', d: 1 }] });
  const st = body(await cat.playlist(c2.id, false));
  assert.equal(st.stale, 1); assert.equal(st.done, 1);
});

test('a failed enumeration (engine 500 for 30 s): the slot is freed, engine_error with retry_after or the stale copy, no poll during the hold', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const a = pl(model, 'broken', { length: 6, revision: 'r1' });
  const ca = model.addContext(a.uri, entries('br', 6, 'cached'), { revision: 'r1', enumMs: 300, failEnum: 1, enumHoldMs: 1500 });
  const b = pl(model, 'fine', { length: 4, revision: 'r1' });
  const cb = model.addContext(b.uri, entries('fn', 4, 'cached'), { revision: 'r1' });
  const { cat } = makeCatalog({ model, timing: { enumHold: 1500 } });
  await cat.library(false);
  assert.equal(body(await cat.playlist(a.id, false)).wait, 1, 'enumerating');
  assert.ok(cat.enums.has(a.uri), 'it holds the one-enumeration slot');
  await sleep(350);                                                 // its enumeration failed meanwhile
  await assert.rejects(cat.playlist(a.id, false), (e) => e.status === 502 && e.code === 'engine_error' && e.retry_after === 2, 'the poll that met the 500');
  assert.equal(ca.n.held500, 1);
  assert.ok(!cat.enums.has(a.uri), 'the slot is free');
  assert.equal((await pollList(() => cat.playlist(b.id, false))).pop().done, 1, 'another list isn\'t held back');
  assert.ok(cb.n.summaries >= 1);
  // during the hold nothing goes to the engine for it, whatever asks
  const calls = () => ca.n.summaries + ca.n.pages + ca.n.full;
  const n = calls();
  for (let i = 0; i < 3; i++) await assert.rejects(cat.playlist(a.id, false), (e) => e.status === 502 && e.code === 'engine_error' && e.retry_after >= 1);
  await assert.rejects(cat.playlist(a.id, true), (e) => e.code === 'engine_error', 'fresh=1 doesn\'t get around it');
  assert.equal(body(await cat.items(a.id, { op: 'add', uris: ['spotify:track:' + id22('to broken')] })).added, 1, 'an add skips the duplicate check meanwhile');
  cat.store.put('list', key(a.uri), { ctx: a.uri, kind: 'playlist', v: 'old', sig: null, at: Date.now(), len: 1, ms: 1, trunc: 0, un: 0, items: [{ u: 'spotify:track:' + id22('old row'), n: 'Old', d: 1 }] });
  const st = body(await cat.playlist(a.id, false));
  assert.equal(st.stale, 1, 'a stored copy (invalid): served stale'); assert.equal(st.done, 1); assert.equal(st.items[0].n, 'Old');
  assert.equal(calls(), n, 'no listing call for it during the hold');
  assert.equal(ca.n.held500, 1, 'the engine answered 500 once');
  // after the hold: enumerated again, stored
  await sleep(1500);
  const done = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(done.done, 1); assert.equal(done.len, 7); assert.equal(done.stale, undefined);
  assert.equal(ca.n.enumerations, 2); assert.equal(ca.n.held500, 1);
});

test('a failed enumeration nobody polls: the next list\'s summary of it frees the slot, and the hold starts', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const a = pl(model, 'failed alone', { length: 5, revision: 'r1' });
  const ca = model.addContext(a.uri, entries('fa', 5, 'cached'), { revision: 'r1', enumMs: 300, failEnum: 1, enumHoldMs: 3000 });
  const b = pl(model, 'next one', { length: 3, revision: 'r1' });
  const cb = model.addContext(b.uri, entries('no', 3, 'cached'), { revision: 'r1' });
  const { cat } = makeCatalog({ model, timing: { enumHold: 3000 } });
  await cat.library(false);
  assert.equal(body(await cat.playlist(a.id, false)).wait, 1);
  await sleep(1100);                                                // failed meanwhile, and not polled for a second
  const r = body(await cat.playlist(b.id, false));
  assert.equal(r.done, 1, 'not held back by the failed one');
  assert.ok(cb.n.summaries >= 1);
  assert.equal(ca.n.held500, 1, 'one summary of it told');
  assert.ok(!cat.enums.has(a.uri) && cat.heldFor(a.uri) > 0, 'out of the slot, held');
  const n = ca.n.summaries;
  await assert.rejects(cat.playlist(a.id, false), (e) => e.code === 'engine_error' && e.retry_after >= 1);
  assert.equal(ca.n.summaries, n, 'not polled during the hold');
});

test('an engine that doesn\'t answer a summary frees the slot too, without a hold', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const a = pl(model, 'unanswered', { length: 5, revision: 'r1' });
  const ca = model.addContext(a.uri, entries('ua', 5, 'cached'), { revision: 'r1', enumMs: 300 });
  const b = pl(model, 'after it', { length: 3, revision: 'r1' });
  model.addContext(b.uri, entries('ai', 3, 'cached'), { revision: 'r1' });
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  assert.equal(body(await cat.playlist(a.id, false)).wait, 1);
  assert.ok(cat.enums.has(a.uri));
  model.hooks.down = true;
  await assert.rejects(cat.playlist(a.id, false), (e) => e.status === 502 && e.code === 'engine_error' && e.retry_after == null);
  model.hooks.down = false;
  assert.ok(!cat.enums.has(a.uri), 'the slot is free');
  assert.equal(cat.heldFor(a.uri), 0, 'no hold: it was no 500');
  assert.equal((await pollList(() => cat.playlist(b.id, false))).pop().done, 1, 'the next list isn\'t held back');
  assert.equal((await pollList(() => cat.playlist(a.id, false))).pop().done, 1, 'and it is asked again at once');
  assert.equal(ca.n.enumerations, 1, 'the engine\'s own enumeration went on meanwhile');
});

test('listing: trunc, and Liked order detection + reversal', async () => {
  const model = new EngineModel({ enumMs: 0, batchMs: 10 });
  const a = pl(model, 'long', { length: 5000 });
  model.addContext(a.uri, entries('tr', 30, 'cached'), { revision: 'r1', truncated: true });
  const likedCtx = `spotify:user:${ME}:collection`;
  const le = entries('lk', 6, 'cached');                       // engine order: oldest first
  model.addContext(likedCtx, le, { revision: '' });
  const webapi = new FakeWebApi();
  let first = le[5].uri;
  webapi.on(/^\/me\/tracks/, () => ({ total: 6, items: [{ track: { uri: first } }] }));
  webapi.on(/^\/me\/playlists/, () => ({ items: [], next: null }));
  const { cat } = makeCatalog({ model, webapi });
  await cat.library(false);
  const t = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(t.trunc, 1, 'trunc from truncated');
  await sleep(20);
  const l = (await pollList(() => cat.liked(false))).pop();
  assert.equal(l.k, 'liked'); assert.equal(l.ctx, likedCtx); assert.deepEqual(l.h, { n: 'Liked Songs' });
  assert.equal(cat.counters().liked_order, 'oldest_first');
  assert.equal(l.items[0].u, le[5].uri, 'reversed: the newest first');
  assert.equal(l.items[5].u, le[0].uri);
  // newest-first engine order
  await cat.flush('lists');
  first = le[0].uri;
  cat.likedSig = { total: 6, first, at: Date.now() };
  const l2 = (await pollList(() => cat.liked(false))).pop();
  assert.equal(cat.counters().liked_order, 'newest_first');
  assert.equal(l2.items[0].u, le[0].uri);
  const root = body(await cat.library(false));
  assert.equal(root.liked.len, 6, 'liked.len');
});

// ---------------------------------------------------------------- writes
test('add: duplicate by uri from the engine (sweep=0, never a sweep), then allow_duplicates', async () => {
  const model = new EngineModel({ enumMs: 50 });
  const a = pl(model, 'drive drive drive', { length: 9 });
  const ents = entries('car', 9);
  const c = model.addContext(a.uri, ents, { revision: 'r1' });
  const { cat, events } = makeCatalog({ model });
  await cat.library(false);
  await assert.rejects(cat.items(a.id, { op: 'add', uris: [ents[2].uri], allow_duplicates: false }),
    (e) => e.status === 409 && e.code === 'duplicate' && e.uris[0] === ents[2].uri && /already in drive drive drive/.test(e.message));
  assert.equal(c.n.sweepsScheduled, 0, 'the duplicate check never caused a sweep');
  assert.ok(c.n.sweep0 >= 2 && model.log.filter((x) => x.path.startsWith('/context/tracks')).every((x) => x.path.includes('sweep=0')), 'every listing call had sweep=0');
  assert.equal(model.counts.adds, 0);
  const r = body(await cat.items(a.id, { op: 'add', uris: [ents[2].uri], allow_duplicates: true }));
  assert.equal(r.added, 1); assert.equal(r.playlist.len, 10);
  assert.equal(model.counts.adds, 1);
  assert.ok(events.some((e) => e.type === 'playlist' && e.data.u === a.uri && e.data.len === 10), 'playlist event');
  const fresh = 'spotify:track:' + id22('brand new');
  const r2 = body(await cat.items(a.id, { op: 'add', uris: [fresh] }));
  assert.equal(r2.added, 1);
  // (0.9: op 'remove' exists now — the Web API DELETE path is tested in p09/test_membership.js)
  await assert.rejects(cat.items(a.id, { op: 'add', uris: ['spotify:episode:' + id22('ep')] }), (e) => e.status === 400);
  const ro = pl(model, 'not mine', { length: 1, can_edit: false });
  await cat.library(true).catch(() => {});
  await sleep(320);
  await cat.library(true);
  await assert.rejects(cat.items(ro.id, { op: 'add', uris: [fresh] }), (e) => e.status === 403 && e.code === 'not_editable');
  await assert.rejects(cat.items(id22('nope'), { op: 'add', uris: [fresh] }), (e) => e.status === 404);
});

test('add: name + seconds only when both rows are at hand', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const a = pl(model, 'target', { length: 2 });
  const other = pl(model, 'other', { length: 1 });
  const ta = [{ uri: 'spotify:track:' + id22('orig'), meta: 'cached', name: 'Same Song', duration: 200400 },
    { uri: 'spotify:track:' + id22('x2'), meta: 'cached', name: 'Else', duration: 100000 }];
  model.addContext(a.uri, ta, { revision: 'r1' });
  const relinked = 'spotify:track:' + id22('relinked copy');
  model.addContext(other.uri, [{ uri: relinked, meta: 'cached', name: 'Same Song', duration: 199600 }], { revision: 'r1' });
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  const unseen = 'spotify:track:' + id22('unseen');
  // no stored rows yet: by uri only
  const r0 = body(await cat.items(a.id, { op: 'add', uris: [unseen] }));
  assert.equal(r0.added, 1);
  // store both lists
  model.ctx(a.uri).entries.pop();
  model.playlists.find((x) => x.uri === a.uri).length = 2;
  await sleep(320);
  await cat.library(true);
  (await pollList(() => cat.playlist(a.id, false))).pop();
  (await pollList(() => cat.playlist(other.id, false))).pop();
  await assert.rejects(cat.items(a.id, { op: 'add', uris: [relinked] }), (e) => e.code === 'duplicate', 'same name + rounded seconds, both rows stored');
  const stranger = 'spotify:track:' + id22('stranger');
  const r = body(await cat.items(a.id, { op: 'add', uris: [stranger] }));
  assert.equal(r.added, 1, 'no row at hand for it: no name check');
});

test('like: patches the stored Liked listing from rows and keeps it valid; a row-less save invalidates it', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const likedCtx = `spotify:user:${ME}:collection`;
  const le = entries('lv', 4, 'cached');
  model.addContext(likedCtx, le, {});
  for (const e of le) model.liked.add(e.uri);
  const webapi = new FakeWebApi();
  webapi.on(/^\/me\/tracks/, () => ({ total: model.ctx(likedCtx).entries.length, items: [{ track: { uri: model.ctx(likedCtx).entries[0].uri } }] }));
  webapi.on(/^\/me\/playlists/, () => ({ items: [], next: null }));
  const { cat, events, player } = makeCatalog({ model, webapi });
  await cat.library(false);
  await sleep(20);
  const l = (await pollList(() => cat.liked(false))).pop();
  assert.equal(l.len, 4);
  const nu = 'spotify:track:' + id22('newly liked');
  const n0 = model.log.length;
  const r = body(await cat.save({ uris: [nu], saved: true, rows: [{ u: nu, n: 'Newly', a: 'Someone', d: 123000, i: 'ab67616d00001e02' + 'a'.repeat(24), junk: 'x' }] }));
  assert.deepEqual(r.items, { [nu]: 1 }); assert.equal(r.liked_len, 5);
  assert.equal(model.counts.likedPost, 1);
  assert.ok(events.some((e) => e.type === 'liked' && e.data.items[0].u === nu && e.data.items[0].s === 1 && e.data.len === 5));
  assert.deepEqual(player.noted.pop(), [nu, 1]);
  const l2 = body(await cat.liked(false));
  assert.equal(l2.items[0].u, nu, 'prepended from the request rows'); assert.equal(l2.items[0].junk, undefined, 'only known keys');
  assert.equal(l2.len, 5); assert.equal(l2.done, 1);
  assert.equal(model.log.filter((x, i) => i >= n0 && x.path.startsWith('/context/tracks')).length, 0, 'still valid: no re-read');
  // the next signal is adopted as the baseline, the listing stays valid
  cat.likedSig.at = 0;
  await cat.liked(false);
  await sleep(30);
  body(await cat.liked(false));
  assert.equal(model.log.filter((x, i) => i >= n0 && x.path.startsWith('/context/tracks')).length, 0, 'signal adopted: still no re-read');
  // unlike: removed
  const r2 = body(await cat.save({ uris: [le[1].uri], saved: false }));
  assert.equal(r2.items[le[1].uri], 0);
  const l3 = body(await cat.liked(false));
  assert.ok(!l3.items.some((x) => x.u === le[1].uri)); assert.equal(l3.len, 4);
  // a saved uri without a usable row: the stored listing is invalid
  const nu2 = 'spotify:track:' + id22('no row');
  await cat.save({ uris: [nu2], saved: true });
  const n1 = model.log.length;
  await cat.liked(false);
  assert.ok(model.log.slice(n1).some((x) => x.path.startsWith('/context/tracks')), 'invalid: read from the engine again');
  // contains: from the Map, then the engine
  const c = body(await cat.contains([nu, le[1].uri, le[2].uri].join(',')));
  assert.deepEqual(c.items, { [nu]: 1, [le[1].uri]: 0, [le[2].uri]: 1 });
  await assert.rejects(cat.contains('spotify:episode:' + id22('e')), (e) => e.status === 400);
});

test('add: the forced rootlist refresh inside the 10 s guard is deferred, len patched at once', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const a = pl(model, 'guarded', { length: 3 });
  model.addContext(a.uri, entries('gd', 3, 'cached'), { revision: 'r1' });
  const { cat } = makeCatalog({ model, timing: { rootGap: 600, rootWait: 100 } });
  await cat.library(false);
  const roots = model.counts.rootlist;
  const r = body(await cat.items(a.id, { op: 'add', uris: ['spotify:track:' + id22('g new')], allow_duplicates: true }));
  assert.equal(r.playlist.len, 4, 'the reply already shows len + 1');
  assert.equal(model.counts.rootlist, roots, 'no rootlist fetch inside the guard');
  const lib = body(await cat.library(false));
  assert.equal(lib.items.find((x) => x.u === a.uri).len, 4, 'the cached build carries it');
  await sleep(700);
  assert.equal(model.counts.rootlist, roots + 1, 'the refresh ran once the guard was over');
});

test('create: private playlist via the Web API, first song via the engine, at the top of the root', async () => {
  const model = new EngineModel({ enumMs: 0 });
  pl(model, 'existing', { length: 1 });
  const webapi = new FakeWebApi();
  let created = null;
  webapi.on(/^\/me\/playlists$/, (m, p, b) => {
    created = b;
    const id = id22('created' + b.name);
    model.addPlaylist({ uri: 'spotify:playlist:' + id, name: b.name, owner_username: ME, length: 0, can_edit: true, revision: 'c1' });
    model.playlists.unshift(model.playlists.pop());             // Spotify puts new playlists on top
    return { id, uri: 'spotify:playlist:' + id, name: b.name, owner: { id: ME } };
  });
  webapi.on(/^\/me\/playlists\?/, () => ({ items: [], next: null }));
  webapi.on(/^\/me\/tracks/, () => ({ total: 0, items: [] }));
  const { cat } = makeCatalog({ model, webapi });
  await cat.library(false);
  const r = body(await cat.create({ name: '  Road Trip ', uris: ['spotify:track:' + id22('rt1')] }));
  assert.deepEqual(created, { name: 'Road Trip', public: false, collaborative: false, description: '' });
  assert.equal(r.added, 1); assert.equal(r.playlist.n, 'Road Trip'); assert.equal(r.playlist.own, 1); assert.equal(r.playlist.ed, 1);
  assert.equal(model.counts.adds, 1);
  const lib = body(await cat.library(false));
  assert.equal(lib.items[0].n, 'Road Trip', 'at index 0');
  await assert.rejects(cat.create({ name: '   ' }), (e) => e.status === 400);
  await assert.rejects(cat.create({ name: 'x'.repeat(101) }), (e) => e.status === 400);
  // empty: an empty done listing for 10 min, no enumeration
  const e = body(await cat.create({ name: 'Empty' }));
  assert.equal(e.added, 0);
  const n = model.log.length;
  const l = body(await cat.playlist(id22('createdEmpty'), false));
  assert.equal(l.done, 1); assert.equal(l.len, 0);
  assert.equal(model.log.slice(n).filter((x) => x.path.startsWith('/context/tracks')).length, 0, 'no enumeration');
});

// ---------------------------------------------------------------- engine without patch 2, errors
test('degrades with an engine without patch 2 (no revision/failed/sweeping, options ignored)', async () => {
  const model = new EngineModel({ enumMs: 0, batchMs: 10, legacy: true });
  const a = pl(model, 'old engine', { length: 600 });
  model.addContext(a.uri, entries('le', 600), {});
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  const all = await pollList(() => cat.playlist(a.id, false));
  const done = all.pop();
  assert.equal(done.done, 1); assert.equal(done.items.length, 600); assert.equal(done.v, undefined);
  assert.ok(all.every((x) => !x.items || x.items.length <= 100), 'partials still at most 100 rows');
  const n = model.log.length;
  await cat.playlist(a.id, false);
  assert.equal(model.log.length, n, 'no revisions: the stored list is good for 10 min');
});

test('errors: listing_off (404), engine 400 -> not_found, 204 -> engine_no_session, stale fallbacks, simulate', async () => {
  const model = new EngineModel({ enumMs: 0, metadata: false });
  const a = pl(model, 'off', { length: 2 });
  model.addContext(a.uri, entries('of', 2, 'cached'), { revision: 'r1' });
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  await assert.rejects(cat.playlist(a.id, false), (e) => e.status === 503 && e.code === 'listing_off');
  assert.equal(cat.counters().listing, 'off');
  const added = body(await cat.items(a.id, { op: 'add', uris: ['spotify:track:' + id22('while off')] }));
  assert.equal(added.added, 1, 'lists off: the duplicate check is skipped, the add still works');
  model.o.metadata = true;
  await assert.rejects(cat.playlist(id22('not in the model'), false), (e) => e.status === 404 && e.code === 'not_found');
  const done = (await pollList(() => cat.playlist(a.id, false))).pop();
  assert.equal(done.done, 1); assert.equal(cat.counters().listing, 'on');
  // no session: stored listing (made invalid) served stale
  model.playlists[0].revision = 'r9';
  await sleep(320);
  await cat.library(true);
  model.noSession = true;
  const t0 = Date.now();
  const st = body(await cat.playlist(a.id, false));
  assert.equal(st.stale, 1, 'engine 204 twice: the stored copy, stale');
  assert.ok(Date.now() - t0 >= 50, 'it waited and tried once more');
  await sleep(320);
  const lib = body(await cat.library(true));
  assert.equal(lib.stale, 1, 'rootlist 204: the cached build, stale');
  model.noSession = false;
  cat.simulate('rate_limited', 1);
  await assert.rejects(cat.library(false), (e) => e.status === 503 && e.code === 'rate_limited' && e.retry_after === 1);
  await assert.rejects(cat.search('x'), (e) => e.code === 'rate_limited');
  cat.simulate(null);
  await cat.library(false);
});

// ---------------------------------------------------------------- Web API pages
test('album, artist, search shapes and caches', async () => {
  const webapi = new FakeWebApi();
  const img = (w) => ({ url: `https://i.scdn.co/image/ab67616d0000${w === 640 ? 'b273' : w === 300 ? '1e02' : '4851'}${'c'.repeat(24)}`, width: w, height: w });
  const art = (n) => ({ id: id22('artist' + n), uri: 'spotify:artist:' + id22('artist' + n), name: n });
  const tr = (n, i, a = 'Barry White', al = null) => ({ uri: 'spotify:track:' + id22(n + i), name: n + ' ' + i, artists: [art(a)], duration_ms: 1000 * (100 + i), explicit: i === 1,
    track_number: i + 1, disc_number: 1, album: al || { name: 'Alb', uri: 'spotify:album:' + id22('alb'), images: [img(640), img(300), img(64)] } });
  const albumId = id22('album');
  webapi.on(new RegExp(`^/albums/${albumId}$`), () => ({ uri: 'spotify:album:' + albumId, name: 'Can\'t Get Enough', album_type: 'album', release_date: '1974-08-01',
    artists: [art('Barry White')], images: [img(640), img(300), img(64)], copyrights: [{ type: 'C', text: '© x' }, { type: 'P', text: '℗ 1974 20th Century Records' }],
    tracks: { total: 60, items: Array.from({ length: 50 }, (_, i) => { const t = tr('t', i); delete t.album; return t; }) } }));
  webapi.on(new RegExp(`^/albums/${albumId}/tracks`), () => ({ items: Array.from({ length: 10 }, (_, i) => { const t = tr('t', 50 + i); delete t.album; return t; }) }));
  const artistId = id22('artistBarry White');
  webapi.on(new RegExp(`^/artists/${artistId}$`), () => ({ ...art('Barry White'), images: [{ url: 'https://i.scdn.co/image/ab6761610000e5eb' + 'd'.repeat(24), width: 640 }, { url: 'https://i.scdn.co/image/ab67616100005174' + 'd'.repeat(24), width: 320 }] }));
  let albumsCalls = 0;
  webapi.on(new RegExp(`^/artists/${artistId}/albums`), (m, p) => {
    albumsCalls++;
    if (/limit=20/.test(p)) throw Object.assign(new Error('bad limit'), { status: 502, code: 'spotify_error', spotifyStatus: 400 });
    const a = (n, d, g) => ({ uri: 'spotify:album:' + id22(n + d), name: n, release_date: d, album_group: g, album_type: g, artists: [art('Barry White')], images: [img(300)] });
    return { items: [a('Greatest', '1975-01-01', 'album'), a('greatest', '2001-01-01', 'album'), a('Stone Gon\'', '1973', 'album'), a('Single A', '1999-05-05', 'single'), a('Comp', '1980', 'compilation'), null] };
  });
  webapi.on(/^\/search\?q=artist/, () => ({ tracks: { total: 10, items: [tr('pop', 1), tr('pop', 2, 'Someone Else'), null, tr('pop', 3)] } }));
  let searches = 0;
  webapi.on(/^\/search\?/, (m, p) => {
    searches++;
    if (/type=track&limit=10&offset=/.test(p)) return { tracks: { total: 25, items: Array.from({ length: 10 }, (_, i) => tr('more', i)) } };
    return { tracks: { total: 812, items: [tr('song', 0)] }, artists: { items: [art('Barry White'), art('Barry Manilow')] },
      albums: { items: [{ uri: 'spotify:album:' + albumId, name: 'Alb', release_date: '1974', album_type: 'album', artists: [art('Barry White')], images: [img(300)] }] },
      playlists: { items: [null, { uri: 'spotify:playlist:' + id22('sp'), name: 'Barry mix', images: [{ url: 'https://mosaic.scdn.co/640/abc' }], owner: { id: 'someone', display_name: 'Someone' } }] } };
  });
  const { cat } = makeCatalog({ webapi });
  const al = body(await cat.album(albumId));
  assert.equal(al.k, 'album'); assert.equal(al.len, 60); assert.equal(al.items.length, 60); assert.equal(al.done, 1);
  assert.equal(al.h.cp, '℗ 1974 20th Century Records', 'copyright P first'); assert.equal(al.h.y, 1974); assert.equal(al.h.t, 'album'); assert.equal(al.h.len, 60);
  assert.equal(al.h.i, 'ab67616d00001e02' + 'c'.repeat(24), 'album header: the 300 px token');
  assert.equal(al.items[0].tn, 1); assert.equal(al.items[0].dn, 1); assert.equal(al.items[0].i, undefined, 'album rows carry no cover');
  assert.equal(al.items[1].e, 1); assert.equal(al.ms, al.items.reduce((n, r) => n + r.d, 0));
  const c0 = webapi.calls;
  await cat.album(albumId);
  assert.equal(webapi.calls, c0, 'album cached');
  const ar = body(await cat.artist(artistId));
  assert.equal(ar.a.i, 'ab67616100005174' + 'd'.repeat(24), 'artist: the 320 px token');
  assert.equal(ar.top.length, 2, 'Popular: only this artist\'s songs'); assert.ok(ar.top[0].i);
  assert.deepEqual(ar.albums.map((x) => [x.n, x.y]), [['greatest', 2001], ['Comp', 1980], ['Stone Gon\'', 1973]], 'editions de-duplicated, newest first');
  assert.deepEqual(ar.singles.map((x) => x.n), ['Single A']);
  assert.equal(albumsCalls, 2, 'a 400 at limit=20: retried once at 10');
  assert.equal(cat.albumsCap, 10);
  const s = body(await cat.search('  Barry  '));
  assert.equal(s.q, 'barry'); assert.deepEqual(s.top, { k: 'artist', o: s.artists[0] });
  assert.equal(s.tracks.total, 812); assert.equal(s.tracks.next, 10); assert.equal(s.playlists.length, 1, 'null items dropped');
  assert.deepEqual(Object.keys(s.playlists[0]).sort(), ['i', 'n', 'o', 'ou', 'u']);   // 0.10: + ou (the only allowed edit, DESIGN-PROFILES §5.1)
  const s2 = body(await cat.search('ba'));
  assert.deepEqual(s2.top.k, 'track', 'under 3 characters: the first track');
  const n = searches;
  await cat.search('barry');
  assert.equal(searches, n, 'search cached (normalised key)');
  const more = body(await cat.search('barry', 'track', '10'));
  assert.deepEqual(Object.keys(more), ['q', 'tracks']); assert.equal(more.tracks.next, 20);
  const last = body(await cat.search('barry', 'track', '20'));
  assert.equal(last.tracks.next, undefined, 'next absent at the end');
  await assert.rejects(cat.search('barry', 'track', '15'), (e) => e.status === 400);
  await assert.rejects(cat.search('barry', 'episode', '10'), (e) => e.status === 400);
  await assert.rejects(cat.search('x'.repeat(101)), (e) => e.status === 400);
  await assert.rejects(cat.search(''), (e) => e.status === 400);
  // stale on failure
  cat.searches.get('barry|all').at = 0;
  webapi.routes.find(([re]) => String(re) === String(/^\/search\?/))[1] = () => { throw Object.assign(new Error('down'), { status: 502, code: 'spotify_error' }); };
  const st = body(await cat.search('barry'));
  assert.equal(st.stale, 1);
});

test('current song: liked check on a new song while a phone is around; player.noteLiked; event on a change', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const { cat, engine, events, player } = makeCatalog({ model });
  const u = 'spotify:track:' + id22('playing');
  const gid = 'spotify:track:' + id22('relinked gid');
  cat.setLiked(u, 0);
  model.liked.add(u);
  engine.emit('event', 'metadata', { uri: gid, context_track_uri: u, name: 'x' });
  await sleep(80);
  assert.equal(model.counts.likedGet, 1, 'one engine call');
  assert.ok(model.log.some((x) => x.path.includes(encodeURIComponent(u))), 'by context_track_uri');
  assert.deepEqual(player.noted.pop(), [u, 1]);
  assert.ok(events.some((e) => e.type === 'liked' && e.data.items[0].u === u && e.data.items[0].s === 1), 'state changed: liked event');
  engine.emit('event', 'metadata', { uri: gid, context_track_uri: u, name: 'x' });
  await sleep(60);
  assert.equal(model.counts.likedGet, 1, 'same song: no new check');
  player.lastPhone = Date.now() - 11 * 60000;
  engine.emit('event', 'metadata', { uri: 'spotify:track:' + id22('next') });
  await sleep(60);
  assert.equal(model.counts.likedGet, 1, 'no phone in 10 min: no check');
});

// ---------------------------------------------------------------- review fixes (3a)
const failErr = () => Object.assign(new Error('down'), { status: 502, code: 'spotify_error' });

test('like: two likes/unlikes in flight together are applied one after the other (neither patch is lost)', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const likedCtx = `spotify:user:${ME}:collection`;
  const le = entries('cc', 6, 'cached');
  model.addContext(likedCtx, le, {});
  for (const e of le) model.liked.add(e.uri);
  const webapi = new FakeWebApi();
  webapi.on(/^\/me\/tracks/, () => ({ total: 6, items: [{ track: { uri: le[0].uri } }] }));
  webapi.on(/^\/me\/playlists/, () => ({ items: [], next: null }));
  const { cat, engine } = makeCatalog({ model, webapi });
  await cat.library(false);
  await sleep(20);
  assert.equal((await pollList(() => cat.liked(false))).pop().len, 6);
  const send = engine.send;
  let inflight = 0;
  let most = 0;
  engine.send = async (m, p, b) => {                          // slow engine writes, so the two requests overlap
    if (p !== '/library/liked') return send(m, p, b);
    inflight++; most = Math.max(most, inflight);
    await sleep(60);
    inflight--;
    return send(m, p, b);
  };
  const [r1, r2] = await Promise.all([cat.save({ uris: [le[1].uri], saved: false }), cat.save({ uris: [le[3].uri], saved: false })]);
  assert.equal(most, 1, 'one engine write at a time');
  assert.equal(body(r1).liked_len, 5); assert.equal(body(r2).liked_len, 4);
  const l = body(await cat.liked(false));
  assert.equal(l.len, 4);
  assert.ok(!l.items.some((x) => x.u === le[1].uri || x.u === le[3].uri), 'both songs are gone from the stored listing');
  // a bad request isn't queued behind them
  await assert.rejects(cat.save({ uris: ['x'], saved: true }), (e) => e.status === 400);
});

test('fresh=1: the next polls follow the re-read it started (never the old copy as done), one refresh=1', async () => {
  const model = new EngineModel({ enumMs: 0, batchMs: 10 });
  const a = pl(model, 'pull', { length: 10, revision: 'r1' });
  const c = model.addContext(a.uri, entries('pu', 10, 'cached'), { revision: 'r1' });
  const { cat } = makeCatalog({ model });
  await cat.library(false);
  assert.equal((await pollList(() => cat.playlist(a.id, false))).pop().len, 10);
  // changed where the rootlist doesn't show it (same revision): only a pull finds out
  c.entries.push(...entries('pu2', 3, 'cached'));
  c.enumMs = 500;
  const r1 = body(await cat.playlist(a.id, true));
  assert.equal(c.n.refresh, 1, 'fresh=1 sent refresh=1');
  assert.ok(!r1.done, 'the re-read takes longer than one phone request');
  const rest = await pollList(() => cat.playlist(a.id, false));
  assert.ok(rest.length >= 2 && rest.slice(0, -1).every((x) => !x.done), 'no follow-up poll got the old copy back as done');
  assert.equal(rest.pop().len, 13, 'the re-read was stored');
  assert.equal(c.n.refresh, 1, 'and it was the only refresh=1');
  assert.equal(cat.rereads.has(a.uri), false, 'stored: nothing followed any more');
  // a fresh=1 while a re-read runs doesn't start the engine over
  cat.lastRefresh.clear();
  body(await cat.playlist(a.id, true));
  assert.equal(c.n.refresh, 2);
  cat.lastRefresh.clear();                                    // as if a minute had passed
  body(await cat.playlist(a.id, true));
  assert.equal(c.n.refresh, 2, 'a second pull during the re-read: no second refresh=1');
  assert.equal((await pollList(() => cat.playlist(a.id, false))).pop().done, 1);
  const n = model.log.length;
  assert.equal(body(await cat.playlist(a.id, false)).done, 1);
  assert.equal(model.log.length, n, 'stored again: answered without the engine');
});

test('a re-read that takes longer than the refresh gap gets one refresh=1, not one per phone request', async () => {
  const model = new EngineModel({ enumMs: 0, batchMs: 10 });
  const a = pl(model, 'long reread', { length: 20, revision: 'r1' });
  const c = model.addContext(a.uri, entries('lr', 20), { revision: 'r1' });
  const { cat } = makeCatalog({ model, timing: { refreshGap: 150, rootGap: 0 } });
  await cat.library(false);
  (await pollList(() => cat.playlist(a.id, false))).pop();
  model.playlists.find((x) => x.uri === a.uri).revision = 'r2';     // edited on the PC
  c.revision = 'r2';
  c.enumMs = 700;                                                   // the engine's re-read outlasts the refresh gap
  await cat.library(true);
  const answers = await pollList(() => cat.playlist(a.id, false), 40);
  const done = answers.pop();
  assert.equal(done.done, 1, `finished (${answers.length + 1} answers)`);
  assert.equal(done.v, 'r2');
  assert.equal(c.n.refresh, 1, `one refresh=1 for the whole re-read (${c.n.refresh})`);
  assert.equal(c.n.enumerations, 2, 'the engine enumerated once more, not over and over');
});

test('header of a playlist outside the library: a failure is kept for headerRetry, not asked on every poll', async () => {
  const model = new EngineModel({ enumMs: 500 });
  const id = id22('outside');
  model.addContext('spotify:playlist:' + id, entries('os', 5, 'cached'), { revision: 'z' });
  const webapi = new FakeWebApi();
  let failing = true;
  webapi.on(/^\/playlists\//, () => { if (failing) throw failErr(); return { name: 'Outside', owner: { id: 'someone', display_name: 'Someone' } }; });
  webapi.on(/^\/me\//, () => ({ items: [], next: null, total: 0 }));
  const { cat } = makeCatalog({ model, webapi, timing: { headerRetry: 600 } });
  await cat.library(false);
  const answers = await pollList(() => cat.playlist(id, false));
  assert.ok(answers.length >= 3, `several polls (${answers.length})`);
  assert.equal(webapi.count(/^\/playlists\//), 1, 'one header call for all of them');
  assert.deepEqual(answers.pop().h, { u: 'spotify:playlist:' + id });
  failing = false;
  await sleep(650);
  const r = body(await cat.playlist(id, false));
  assert.equal(webapi.count(/^\/playlists\//), 2, 'asked again after headerRetry');
  assert.equal(r.h.n, 'Outside'); assert.equal(r.h.o, 'Someone');
  failing = true;
  cat.headers.get('spotify:playlist:' + id).exp = 0;
  assert.equal(body(await cat.playlist(id, false)).h.n, 'Outside', 'a later failure keeps the header it had');
  assert.equal(body(await cat.playlist(id, false)).h.n, 'Outside');
  assert.equal(webapi.count(/^\/playlists\//), 3, '... for headerRetry too');
});

test('merge and Liked signal: a failure waits the full gap, a turn-away (nothing sent) only the short retry', async () => {
  const model = new EngineModel({ enumMs: 0 });
  pl(model, 'm1');
  const webapi = new FakeWebApi();
  let mode = 'fail';
  const answer = (ok) => () => { if (mode === 'fail') throw failErr(); return mode === 'away' ? undefined : ok; };
  webapi.on(/^\/me\/playlists/, answer({ items: [], next: null }));
  webapi.on(/^\/me\/tracks/, answer({ total: 3, items: [] }));
  const { cat } = makeCatalog({ model, webapi, timing: { mergeGap: 600, mergeRetry: 100, sigGap: 600, sigRetry: 100, rootFresh: 100000 } });
  const merges = () => webapi.count(/^\/me\/playlists/);
  const sigs = () => webapi.count(/^\/me\/tracks/);
  await cat.library(false);
  await sleep(30);
  assert.equal(merges(), 1); assert.equal(sigs(), 1);
  for (let i = 0; i < 3; i++) { await sleep(130); await cat.library(false); }
  await sleep(30);
  assert.equal(merges(), 1, 'a failed merge: not again within its gap (the short retry is long over)');
  assert.equal(sigs(), 1, 'a failed signal: not again within its gap');
  await sleep(300);
  mode = 'away';
  await cat.library(false);
  await sleep(30);
  assert.equal(merges(), 2, 'after the gap: again'); assert.equal(sigs(), 2);
  await sleep(130);
  mode = 'ok';
  await cat.library(false);
  await sleep(30);
  assert.equal(merges(), 3, 'turned away: again after the short retry'); assert.equal(sigs(), 3);
  assert.ok(cat.webpl && cat.likedSig && cat.likedSig.total === 3);
});

test('listing probe: on/off from a context the engine can\'t list, asked when its events connect', async () => {
  const model = new EngineModel();
  const { cat, engine } = makeCatalog({ model });
  assert.equal(cat.counters().listing, 'unknown');
  engine.emit('connected');
  await sleep(20);
  assert.equal(cat.counters().listing, 'on', 'a 400 for a context it can\'t list: listings on');
  assert.ok(model.log.some((x) => x.path === '/context/tracks?uri=' + encodeURIComponent('spotify:search:encore')), 'one probe');
  model.o.metadata = false;
  engine.emit('connected');
  await sleep(20);
  assert.equal(cat.counters().listing, 'off', '404: listings off');
  const m2 = new EngineModel();
  m2.noSession = true;
  const { cat: c2, engine: e2 } = makeCatalog({ model: m2 });
  e2.emit('connected');
  await sleep(20);
  assert.equal(c2.counters().listing, 'unknown', '204 (no session yet): still unknown');
});

test('add: a duplicate check that gave up frees the limiter slot, and nothing enumerates that playlist again', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const big = pl(model, 'big unstored', { length: 3000 });
  const cb = model.addContext(big.uri, entries('bg', 30), { revision: 'r1', enumMs: 1200 });
  const quiet = pl(model, 'Quiet', { length: 5 });
  model.addContext(quiet.uri, entries('qt', 5, 'cached'), { revision: 'r1' });
  const other = pl(model, 'Other', { length: 4 });
  model.addContext(other.uri, entries('ot', 4, 'cached'), { revision: 'r1' });
  const { cat } = makeCatalog({ model, timing: { dupWait: 200 } });
  await cat.library(false);
  const r = body(await cat.items(big.id, { op: 'add', uris: ['spotify:track:' + id22('to big')] }));
  assert.equal(r.added, 1, 'the check gave up: added without it');
  assert.equal(cb.n.enumerations, 1);
  const polls = cb.n.summaries + cb.n.pages + cb.n.full;
  assert.equal(body(await cat.playlist(quiet.id, false)).done, 1, 'the next list isn\'t held back by the abandoned enumeration');
  await sleep(1300);                                                // the dropped enumeration has ended by now
  assert.equal((await pollList(() => cat.playlist(other.id, false))).pop().done, 1);
  assert.equal(cb.n.summaries + cb.n.pages + cb.n.full, polls, 'no limiter summary for the big playlist');
  assert.equal(cb.n.enumerations, 1, 'nothing started its enumeration again');
});

test('Liked signal: an answer that may predate our like is dropped, and none is asked right after a like', async () => {
  const model = new EngineModel({ enumMs: 0 });
  const likedCtx = `spotify:user:${ME}:collection`;
  model.addContext(likedCtx, entries('sg', 4, 'cached'), {});
  const lc = model.ctx(likedCtx);
  const webapi = new FakeWebApi();
  let delay = 0;
  webapi.on(/^\/me\/tracks/, async () => {
    const out = { total: lc.entries.length, items: [{ track: { uri: lc.entries[0].uri } }] };   // read now ...
    await sleep(delay);                                                                       // ... answered later
    return out;
  });
  webapi.on(/^\/me\/playlists/, () => ({ items: [], next: null }));
  const { cat } = makeCatalog({ model, webapi, timing: { likedSettle: 400 } });
  await cat.library(false);
  await sleep(20);
  (await pollList(() => cat.liked(false))).pop();
  assert.deepEqual((await cat.store.get('list', key(likedCtx))).sig, { total: 4, first: lc.entries[0].uri });
  cat.likedSig.at = 0;
  delay = 150;
  await cat.liked(false);                                     // a signal goes out (it reads 4) ...
  const nu = 'spotify:track:' + id22('liked meanwhile');
  await cat.save({ uris: [nu], saved: true, rows: [{ u: nu, n: 'Meanwhile', d: 1000 }] });   // ... our like lands meanwhile
  await sleep(200);
  assert.equal(cat.likedSig.total, 5, 'the answer from before the like did not undo it');
  assert.equal(cat.likedSig.at, 0, 'the next request asks again');
  assert.equal((await cat.store.get('list', key(likedCtx))).sig, null, 'and it was not adopted as the baseline');
  delay = 0;
  const n = webapi.count(/^\/me\/tracks/);
  await cat.liked(false);
  assert.equal(webapi.count(/^\/me\/tracks/), n, 'right after a like: no signal');
  await sleep(250);
  await cat.liked(false);
  await sleep(20);
  assert.equal(webapi.count(/^\/me\/tracks/), n + 1, 'after likedSettle: one');
  assert.deepEqual((await cat.store.get('list', key(likedCtx))).sig, { total: 5, first: nu }, 'the baseline shows the like');
  const m = model.log.length;
  assert.equal(body(await cat.liked(false)).len, 5);
  assert.equal(model.log.slice(m).filter((x) => x.path.startsWith('/context/tracks')).length, 0, 'still valid: no re-read');
});

test('list routes use the cached rootlist: only GET /v1/playlists revalidates it', async () => {
  const model = new EngineModel({ enumMs: 400 });
  const a = pl(model, 'cached root', { length: 5 });
  model.addContext(a.uri, entries('cr', 5, 'cached'), { revision: 'r1' });
  const { cat } = makeCatalog({ model, timing: { rootFresh: 50, rootGap: 0 } });
  await cat.library(false);
  const roots = model.counts.rootlist;
  await sleep(80);
  const answers = await pollList(() => cat.playlist(a.id, false));
  assert.ok(answers.length >= 2 && answers[answers.length - 1].done === 1);
  await sleep(20);
  assert.equal(model.counts.rootlist, roots, 'no rootlist fetch from a list\'s polls');
  await cat.library(false);
  await sleep(20);
  assert.equal(model.counts.rootlist, roots + 1, 'GET /v1/playlists revalidates it');
});

// ------------------------------------------------------------------ 1.1.x speed: the covers of a list's first rows
test('row covers: a list\'s first 20 rows go to the image cache\'s list lane (first), once per list and rows; again after a flush', async () => {
  const model = new EngineModel({ enumMs: 50, batchMs: 10 });
  const a = pl(model, 'covers', { length: 30, revision: 'r1' });
  model.addContext(a.uri, Array.from({ length: 30 }, (_, i) => ({ uri: 'spotify:track:' + id22('cv' + i), meta: 'ok', n: i, album: 'al' + (i % 25) })), { revision: 'r1' });
  const { cat, images } = makeCatalog({ model });
  const calls = [];
  images.prewarm = (t, o) => calls.push({ t, o });
  await cat.library(false);
  const lib = calls.length;
  assert.ok(calls.every((c) => !(c.o && c.o.first)), 'the library\'s playlist covers: the backlog, not first');
  const answers = await pollList(() => cat.playlist(a.id, false));
  const done = answers[answers.length - 1];
  assert.equal(done.done, 1);
  const rows = calls.slice(lib);
  assert.ok(rows.length >= 1 && rows.every((c) => c.o && c.o.first === true), 'a list\'s rows: first');
  const want = done.items.slice(0, 20).map((r) => r.i);
  assert.equal(new Set(want).size, 20);
  assert.deepEqual(rows[rows.length - 1].t, want, 'the first 20 rows\' covers, in their order');
  for (const c of rows) assert.ok(c.t.length <= 20);
  const n = calls.length;
  for (let i = 0; i < 3; i++) await cat.playlist(a.id, false);
  assert.equal(calls.length, n, 'the phone asking again (a stored list): not queued again');
  await cat.flush('images');
  await cat.playlist(a.id, false);
  assert.equal(calls.length, n + 1, 'after the covers were flushed: queued again');
  assert.deepEqual(calls[n].t, want);
});

test('row covers: search and artist pages warm their rows\' covers once; album rows carry none; no image cache, no harm', async () => {
  const webapi = new FakeWebApi();
  const tok = (k) => 'ab67616d00001e02' + key(k).slice(0, 24);
  const img = (k) => [{ url: 'https://i.scdn.co/image/' + tok(k), width: 300 }];
  const art = (n) => ({ id: id22('artist' + n), uri: 'spotify:artist:' + id22('artist' + n), name: n, images: img('ar' + n) });
  const tr = (i, a = 'Zed') => ({ uri: 'spotify:track:' + id22('st' + i), name: 'Song ' + i, artists: [art(a)], duration_ms: 1000,
    album: { name: 'Alb ' + i, uri: 'spotify:album:' + id22('sa' + i), images: img('al' + i) } });
  const artistId = id22('artistZed');
  webapi.on(new RegExp(`^/artists/${artistId}$`), () => art('Zed'));
  webapi.on(new RegExp(`^/artists/${artistId}/albums`), () => ({ items: [1, 2, 3].map((i) => ({ uri: 'spotify:album:' + id22('za' + i), name: 'ZA ' + i,
    release_date: '200' + i, album_group: i === 3 ? 'single' : 'album', album_type: 'album', artists: [art('Zed')], images: img('za' + i) })) }));
  webapi.on(/^\/search\?q=artist/, () => ({ tracks: { total: 2, items: [tr(100), tr(101)] } }));
  const albumId = id22('zalbum');
  webapi.on(new RegExp(`^/albums/${albumId}$`), () => ({ uri: 'spotify:album:' + albumId, name: 'Z', album_type: 'album', artists: [art('Zed')], images: img('zalb'),
    tracks: { total: 3, items: [0, 1, 2].map((i) => { const t = tr(200 + i); delete t.album; return t; }) } }));
  webapi.on(/^\/search\?/, () => ({ tracks: { total: 10, items: Array.from({ length: 10 }, (_, i) => tr(i)) }, artists: { items: [art('Zed'), art('Zoe')] },
    albums: { items: [{ uri: 'spotify:album:' + id22('x1'), name: 'X1', album_type: 'album', artists: [art('Zed')], images: img('x1') }] },
    playlists: { items: [{ uri: 'spotify:playlist:' + id22('zp'), name: 'Zmix', images: img('zp'), owner: { id: 'someone', display_name: 'Someone' } }] } }));
  const { cat, images } = makeCatalog({ webapi });
  const calls = [];
  images.prewarm = (t, o) => calls.push({ t, o });
  const s = body(await cat.search('zz'));
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].o, { first: true, tag: 'search' }, 'tagged: the next search replaces what of it still waits');
  const want = [s.top.o.i, ...s.tracks.items.map((r) => r.i), ...s.artists.map((r) => r.i), ...s.albums.map((r) => r.i), ...s.playlists.map((r) => r.i)]
    .filter((x, i, arr) => x && arr.indexOf(x) === i);
  assert.deepEqual(calls[0].t, want, 'top, songs, artists, albums, playlists: in page order, once each');
  assert.equal(want.length, 14);
  await cat.search('zz');
  assert.equal(calls.length, 1, 'the cached search again: not queued again');
  const more = body(await cat.search('zz', 'track', '10'));
  assert.equal(calls.length, 2, 'See all songs: its own page');
  assert.deepEqual(calls[1].o, { first: true, tag: 'search' });
  assert.deepEqual(calls[1].t, more.tracks.items.map((r) => r.i).filter((x, i, arr) => arr.indexOf(x) === i));
  const ar = body(await cat.artist(artistId));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].t, [...ar.top, ...ar.albums, ...ar.singles].map((r) => r.i), 'artist: Popular, albums, singles');
  assert.deepEqual(calls[2].o, { first: true }, 'not a search: nothing replaces it');
  await cat.artist(artistId);
  assert.equal(calls.length, 3, 'the cached artist again: not queued again');
  const al = body(await cat.album(albumId));
  assert.ok(al.items.every((r) => !r.i));
  assert.equal(calls.length, 3, 'album rows have no covers: nothing queued');
  cat.images = null;
  cat.searches.clear();
  assert.equal(body(await cat.search('zz')).q, 'zz', 'without an image cache the page is the same');
});
