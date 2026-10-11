'use strict';
// image.js with real ffmpeg on synthetic JPEG/PNG sources (generated here), a fake CDN fetch. The tests that need
// ffmpeg are skipped when it isn't on PATH (or FFMPEG=<path>).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Images, tokenFor, urlFor, variantUrl, snap } = require('../src/image');
const { tmp, sof, sleep } = require('./support/helpers');
const { needs, ffmpeg: FFMPEG } = require('./support/platform');

const NEED = { skip: needs({ ffmpeg: true }) };

const SRC = tmp('imgsrc');
function gen(name, args) {
  if (NEED.skip) return Buffer.alloc(0);
  const f = path.join(SRC, name);
  execFileSync(FFMPEG, ['-v', 'error', '-y', ...args, f]);
  return fs.readFileSync(f);
}
const FX = {
  sq300: gen('sq300.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=300x300:rate=1', '-frames:v', '1', '-q:v', '3']),
  r300x229: gen('r300x229.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=300x229:rate=1', '-frames:v', '1', '-q:v', '3']),
  sq640: gen('sq640.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=640x640:rate=1', '-frames:v', '1', '-q:v', '4']),
  png300: gen('png300.png', ['-f', 'lavfi', '-i', 'testsrc=size=300x300:rate=1', '-frames:v', '1']),
  big: gen('big.jpg', ['-f', 'lavfi', '-i', 'nullsrc=s=1280x1280,geq=random(1)*255:random(2)*255:random(3)*255', '-frames:v', '1', '-q:v', '1', '-pix_fmt', 'yuvj444p']),
};

const hex24 = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 24);
const custom = (name) => 'ab67706c0000da84' + hex24(name);            // a custom upload: no size variants

function mk(map, opts = {}) {
  const dir = tmp('img');
  const player = opts.player || { pending: null, on() {} };
  const im = new Images({ cacheDir: dir, ffmpeg: FFMPEG, imageDiskMB: opts.mb || 512 }, player);
  const log = [];
  im.fetch = async (url) => {
    log.push(url);
    const hit = map(url);
    if (!hit) return { url, status: 404, ok: false, headers: { get: () => 'text/plain' }, arrayBuffer: async () => new ArrayBuffer(0) };
    if (hit.redirect) return { url: hit.redirect, status: 200, ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => FX.sq300 };
    return { url, status: 200, ok: true, headers: { get: () => hit.type || 'image/jpeg' }, arrayBuffer: async () => hit.buf };
  };
  return { im, log, dir };
}

test('tokens: round trip, allowlist, variants, size snapping', () => {
  const t = 'ab67616d00001e02' + hex24('a');
  assert.equal(tokenFor('https://i.scdn.co/image/' + t), t);
  assert.equal(urlFor(t), 'https://i.scdn.co/image/' + t);
  const mosaic = 'https://mosaic.scdn.co/640/ab67616d0000b273' + hex24('m');
  const u = tokenFor(mosaic);
  assert.match(u, /^u[A-Za-z0-9_-]+$/);
  assert.equal(urlFor(u), mosaic);
  const pick = 'https://pickasso.spotifycdn.com/image/ab67c0de0000deef/dt/v1/img/dw/cover/en';
  assert.equal(urlFor(tokenFor(pick)), pick);
  assert.equal(tokenFor('http://i.scdn.co/image/' + t), '', 'http refused');
  assert.equal(tokenFor('https://evil.example/x.jpg'), '', 'other hosts refused');
  assert.equal(tokenFor('https://scdn.co.evil.example/x.jpg'), '');
  assert.equal(urlFor('u' + Buffer.from('https://evil.example/x.jpg').toString('base64url')), null, 'a forged token is re-checked');
  assert.equal(urlFor('u' + Buffer.from('http://i.scdn.co/image/x').toString('base64url')), null);
  assert.equal(urlFor('nothex'), null);
  const id = hex24('v');
  assert.equal(variantUrl('https://i.scdn.co/image/ab67616d00001e02' + id, true), 'https://i.scdn.co/image/ab67616d0000b273' + id, 'album 300 -> 640');
  assert.equal(variantUrl('https://i.scdn.co/image/ab67616d0000b273' + id, false), 'https://i.scdn.co/image/ab67616d00001e02' + id, 'album 640 -> 300');
  assert.equal(variantUrl('https://i.scdn.co/image/ab67616d00004851' + id, false), 'https://i.scdn.co/image/ab67616d00001e02' + id, 'album 64 -> 300');
  assert.equal(variantUrl('https://i.scdn.co/image/ab67616100005174' + id, true), 'https://i.scdn.co/image/ab6761610000e5eb' + id, 'artist 320 -> 640');
  assert.equal(variantUrl('https://i.scdn.co/image/ab6761610000e5eb' + id, false), 'https://i.scdn.co/image/ab67616100005174' + id, 'artist 640 -> 320');
  assert.equal(variantUrl('https://mosaic.scdn.co/640/abc', false), 'https://mosaic.scdn.co/300/abc');
  assert.equal(variantUrl('https://mosaic.scdn.co/60/abc', true), 'https://mosaic.scdn.co/640/abc');
  assert.equal(variantUrl('https://i.scdn.co/image/' + custom('c'), true), 'https://i.scdn.co/image/' + custom('c'), 'custom uploads: their own URL');
  assert.equal(variantUrl(pick, false), pick);
  assert.deepEqual([60, 88, 120, 200, 216, 400, 500, 640, 5000].map(snap), [88, 88, 88, 216, 216, 216, 640, 640, 640]);
  assert.equal(snap('x'), 640); assert.equal(snap(null), 640, 'no s: 640'); assert.equal(snap(''), 640); assert.equal(snap(undefined), 640); assert.equal(snap('0'), 88);
});

test('ffmpeg: 88 and 216 are exact squares from JPEG/PNG sources of any shape, one run per source', NEED, async () => {
  const files = { sq300: FX.sq300, r300x229: FX.r300x229, sq640: FX.sq640, png300: FX.png300 };
  const { im, log } = mk((url) => {
    for (const [k, buf] of Object.entries(files)) if (url.endsWith(custom(k))) return { buf, type: k.startsWith('png') ? 'image/png' : 'image/jpeg' };
    return null;
  });
  for (const k of Object.keys(files)) {
    const token = custom(k);
    const runs = im.stats.ffmpeg;
    const a = await im.get(token, 88, urlFor(token), true);
    const b = await im.get(token, 216, urlFor(token), true);
    assert.deepEqual(sof(a), { w: 88, h: 88 }, `${k} -> 88x88`);
    assert.deepEqual(sof(b), { w: 216, h: 216 }, `${k} -> 216x216`);
    assert.equal(im.stats.ffmpeg - runs, 1, `${k}: one ffmpeg run makes both`);
  }
  assert.equal(log.length, 4, 'one download per source');
  assert.ok(im.stats.lastFfmpegMs > 0 && im.stats.lastFfmpegMs < 5000, `last ffmpeg ${im.stats.lastFfmpegMs} ms`);
  // memory, then disk
  const n = log.length;
  const again = await im.get(custom('sq300'), 88, urlFor(custom('sq300')), true);
  assert.deepEqual(sof(again), { w: 88, h: 88 }); assert.equal(log.length, n);
  im.mem.clear(); im.memBytes = 0;
  const t0 = Date.now();
  await im.get(custom('sq300'), 216, urlFor(custom('sq300')), true);
  assert.equal(log.length, n, 'from disk'); assert.ok(Date.now() - t0 < 50);
});

test('640: a JPEG <= 400 KB passes through untouched; PNG and big JPEG are converted, never upscaled; album variants', NEED, async () => {
  assert.ok(FX.big.length > 400 * 1024, `the big fixture is ${FX.big.length} bytes`);
  const alb = hex24('album');
  const { im, log } = mk((url) => {
    if (url.endsWith(custom('sq640'))) return { buf: FX.sq640 };
    if (url.endsWith(custom('png300'))) return { buf: FX.png300, type: 'image/png' };
    if (url.endsWith(custom('big'))) return { buf: FX.big };
    if (url.endsWith('ab67616d0000b273' + alb)) return { buf: FX.sq640 };
    if (url.endsWith('ab67616d00001e02' + alb)) return { buf: FX.sq300 };
    if (url.endsWith('ab67616100005174' + alb)) return null;            // a missing variant
    if (url.endsWith('ab6761610000e5eb' + alb)) return { buf: FX.sq640 };
    return null;
  });
  const pass = await im.get(custom('sq640'), 640, urlFor(custom('sq640')), true);
  assert.ok(pass.equals(FX.sq640), 'identical bytes');
  const png = await im.get(custom('png300'), 640, urlFor(custom('png300')), true);
  assert.equal(png[0], 0xff); assert.equal(png[1], 0xd8);
  assert.deepEqual(sof(png), { w: 300, h: 300 }, 'not upscaled');
  const big = await im.get(custom('big'), 640, urlFor(custom('big')), true);
  assert.deepEqual(sof(big), { w: 640, h: 640 }); assert.ok(big.length < FX.big.length);
  // album token (300 px) -> s=640 fetches the 640 variant
  const t300 = 'ab67616d00001e02' + alb;
  await im.get(t300, 640, urlFor(t300), true);
  assert.ok(log.includes('https://i.scdn.co/image/ab67616d0000b273' + alb), 'the 640 variant');
  // artist 640 token, small sizes: the 320 variant 404s -> the token's own URL once
  const t640 = 'ab6761610000e5eb' + alb;
  const s88 = await im.get(t640, 88, urlFor(t640), true);
  assert.deepEqual(sof(s88), { w: 88, h: 88 });
  assert.deepEqual(log.slice(-2), ['https://i.scdn.co/image/ab67616100005174' + alb, 'https://i.scdn.co/image/' + t640]);
});

test('u files expire after 7 days, i.scdn.co files never; negative cache; redirect off the allowlist; headers', NEED, async () => {
  const mosaic = 'https://mosaic.scdn.co/300/' + hex24('mos');
  const ut = tokenFor('https://mosaic.scdn.co/640/' + hex24('mos'));
  const ht = custom('sq300');
  const ctx = mk((url) => (url === mosaic || url.endsWith(ht) ? { buf: FX.sq300 } : url.includes('redir') ? { redirect: 'https://evil.example/x' } : null));
  const { im, log, dir } = ctx;
  await im.get(ut, 88, urlFor(ut), true);
  await im.get(ht, 88, urlFor(ht), true);
  const old = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(im.file(ut, 88), old, old);
  fs.utimesSync(im.file(ht, 88), old, old);
  const im2 = new Images({ cacheDir: dir, ffmpeg: FFMPEG }, { pending: null, on() {} });
  im2.fetch = im.fetch;
  const n = log.length;
  await im2.get(ht, 88, urlFor(ht), true);
  assert.equal(log.length, n, 'i.scdn.co: still served from disk');
  await im2.get(ut, 88, urlFor(ut), true);
  assert.equal(log.length, n + 1, 'u token older than 7 days: fetched again');
  // negative cache
  const gone = custom('gone');
  await assert.rejects(im2.get(gone, 216, urlFor(gone), true), (e) => e.status === 404 && e.code === 'image_gone');
  const m = log.length;
  await assert.rejects(im2.get(gone, 88, urlFor(gone), true), (e) => e.code === 'image_gone');
  assert.equal(log.length, m, 'remembered: no second fetch');
  assert.equal(im2.info().negatives, 1);
  // redirect to another host
  const rt = tokenFor('https://mosaic.scdn.co/300/redir');
  await assert.rejects(im2.get(rt, 88, urlFor(rt), true), (e) => e.status === 502);
  // serve(): headers
  const out = {};
  const res = { writeHead(s, h) { out.s = s; out.h = h; }, end(b) { out.b = b; } };
  await im2.serve({}, res, ht, '200');
  assert.equal(out.s, 200); assert.equal(out.h['Content-Type'], 'image/jpeg'); assert.equal(out.h['Cache-Control'], 'private, max-age=31536000, immutable');
  assert.deepEqual(sof(out.b), { w: 216, h: 216 }, 's=200 snaps to 216');
  await im2.serve({}, res, ht, null);
  assert.deepEqual(sof(out.b), { w: 300, h: 300 }, 'no s: the 640 variant (a 300 px source passes through uncropped), not 88');
  await im2.serve({}, res, ut, '88');
  assert.equal(out.h['Cache-Control'], 'private, max-age=604800');
  await assert.rejects(im2.serve({}, res, 'u' + Buffer.from('https://evil.example/a').toString('base64url'), '88'), (e) => e.status === 400);
  // the old route: original bytes without s
  const lres = { writeHead(s, h) { out.s = s; out.h = h; }, end(b) { out.b = b; } };
  await im2.serveLegacy({}, lres, new URL('http://x/v1/image?u=' + encodeURIComponent(mosaic)));
  assert.ok(out.b.equals(FX.sq300)); assert.equal(out.h['Cache-Control'], 'private, max-age=86400');
  await im2.serveLegacy({}, lres, new URL('http://x/v1/image?u=' + encodeURIComponent('https://evil.example/a')));
  assert.equal(out.s, 400);
});

test('disk cap: the oldest files go first, down to 460/512 of the cap; prewarm runs only when idle', NEED, async () => {
  const names = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
  const { im } = mk((url) => (names.some((k) => url.endsWith(custom(k))) ? { buf: FX.sq640 } : null), { mb: 0.03 });
  let t = Date.now() - 100000;
  for (const k of names) {
    await im.get(custom(k), 216, urlFor(custom(k)), true);
    t += 1000;
    for (const s of [88, 216]) fs.utimesSync(im.file(custom(k), s), new Date(t), new Date(t));
  }
  await im.scan();
  const cap = 0.03 * 1024 * 1024;
  assert.ok(im.disk.bytes <= cap * 460 / 512, `${im.disk.bytes} bytes kept of a ${Math.round(cap)} cap`);
  assert.equal(fs.existsSync(im.file(custom('d1'), 216)), false, 'the oldest is gone');
  assert.equal(fs.existsSync(im.file(custom('d6'), 216)), true, 'the newest stays');
  // prewarm: held back while a generation starts, then one at a time
  const player = { pending: { gen: 2 }, on() {} };
  const { im: pw, log } = mk((url) => (url.endsWith(custom('p1')) || url.endsWith(custom('p2')) ? { buf: FX.sq300 } : null));
  pw.player = player;
  pw.prewarm([custom('p1'), custom('p2'), custom('p1')]);
  await sleep(300);
  assert.equal(log.length, 0, 'not while player.pending');
  player.pending = null;
  await sleep(2500);
  assert.equal(log.length, 2, 'both prewarmed once');
  assert.ok(fs.existsSync(pw.file(custom('p1'), 88)) && fs.existsSync(pw.file(custom('p2'), 88)));
});

// ------------------------------------------------------------------ 1.1.x speed: warming lanes, ETag / 304
const { EventEmitter } = require('events');
const alb = (n) => 'ab67616d00001e02' + hex24('alb' + n);              // an album cover token (the 300 px one)
const v640 = (n) => 'https://i.scdn.co/image/ab67616d0000b273' + hex24('alb' + n);
const v300 = (n) => 'https://i.scdn.co/image/ab67616d00001e02' + hex24('alb' + n);

// fetches take 60 ms; counts how many run at once, and how many ffmpeg runs at once
function instrument(im) {
  const m = { fetchNow: 0, fetchMax: 0, ffNow: 0, ffMax: 0 };
  const f0 = im.fetch;
  im.fetch = async (url, o) => { m.fetchNow++; m.fetchMax = Math.max(m.fetchMax, m.fetchNow); try { await sleep(60); return await f0(url, o); } finally { m.fetchNow--; } };
  const run0 = im.run.bind(im);
  im.run = async (args) => { m.ffNow++; m.ffMax = Math.max(m.ffMax, m.ffNow); try { return await run0(args); } finally { m.ffNow--; } };
  return m;
}
async function until(fn, ms = 6000) { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(20); return fn(); }

test('queue lane: 640 then 88/216 per song in order, 0.5 s after a generation started, 2 at a time with one ffmpeg run, cached ones skipped, replaced on a new window', NEED, async () => {
  const player = new EventEmitter();
  player.pending = null;
  const albums = 'ABCDEFGH'.split('');
  const { im, log } = mk((url) => {
    for (const n of albums) { if (url === v640(n)) return { buf: FX.sq640 }; if (url === v300(n)) return { buf: FX.sq300 }; }
    return null;
  }, { player });
  const m = instrument(im);
  player.emit('genStart', 2);
  assert.equal(im.warmQueue([alb('A'), alb('B'), alb('C'), alb('A'), '', 'nothex']), 6, 'three songs x two size groups, duplicates and junk dropped');
  await sleep(300);
  assert.equal(log.length, 0, 'held for 0.5 s after the generation started');
  assert.ok(await until(() => im.info().warmed_queue === 6), `all six made (${im.info().warmed_queue})`);
  assert.deepEqual(log.slice(0, 2).sort(), [v300('A'), v640('A')].sort(), 'the next song first: its 640 and its 88/216 together');
  assert.ok(log.indexOf(v640('C')) > log.indexOf(v640('A')), 'in order');
  assert.ok(m.fetchMax <= 2, `at most 2 jobs at once (${m.fetchMax})`);
  assert.equal(m.ffMax, 1, 'one ffmpeg run at a time');
  for (const n of ['A', 'B', 'C']) for (const s of [88, 216, 640]) assert.ok(fs.existsSync(im.file(alb(n), s)), `${n} at ${s} on disk`);
  assert.ok((await im.get(alb('B'), 640, urlFor(alb('B')), true)).equals(FX.sq640), 'a skip finds the 640 there (passthrough bytes)');
  assert.equal(log.length, 6, 'served from the cache');
  // the next window: what is cached is skipped
  im.warmQueue([alb('A'), alb('D')]);
  assert.ok(await until(() => im.info().warmed_queue === 8));
  await sleep(100);
  assert.deepEqual(log.slice(6).sort(), [v300('D'), v640('D')].sort(), 'only the new song fetched');
  // replaced while held: the stale window never runs
  player.emit('genStart', 3);
  im.warmQueue([alb('E'), alb('F')]);
  im.warmQueue([alb('G')]);
  assert.equal(im.info().warm_queue, 2);
  assert.ok(await until(() => im.info().warmed_queue === 10));
  await sleep(200);
  assert.ok(!log.some((u) => u === v640('E') || u === v640('F') || u === v300('E') || u === v300('F')), 'the replaced window was dropped');
  // never while a phone request is being made, or a generation starts
  im.phoneJobs = 1;
  im.warmQueue([alb('H')]);
  await sleep(700);
  assert.equal(log.includes(v640('H')), false, 'held while a phone request is made');
  im.phoneJobs = 0;
  player.pending = { gen: 4 };
  await sleep(400);
  assert.equal(log.includes(v640('H')), false, 'held while a generation starts');
  player.pending = null;
  assert.ok(await until(() => log.includes(v640('H'))), 'then made');
  // a Spotify Code is never warmed
  assert.equal(im.warmQueue([tokenFor('https://scannables.scdn.co/uri/plain/png/000000/white/640/spotify:track:' + 'x'.repeat(22))]), 0);
  const info = im.info();
  assert.equal(typeof info.warm_list, 'number'); assert.equal(typeof info.warm_running, 'number');
});

test('list lane: a list\'s first rows go ahead of the playlist-cover backlog, in order, one ffmpeg run at a time; the queue lane goes first', NEED, async () => {
  const player = new EventEmitter();
  player.pending = null;
  const names = ['P1', 'P2', 'P3', 'P4', 'P5', 'R1', 'R2', 'Q1'];
  const { im, log } = mk((url) => (names.some((n) => url.endsWith(custom(n))) ? { buf: FX.sq300 } : null), { player });
  const m = instrument(im);
  player.emit('gen', 2);                                   // the list lane waits 5 s after a generation began
  im.prewarm(['P1', 'P2', 'P3', 'P4', 'P5'].map(custom));
  im.prewarm([custom('R1'), custom('R2'), custom('P4'), custom('R1')], { first: true });
  assert.deepEqual(im.pq.map((j) => j.token), ['R1', 'R2', 'P4', 'P1', 'P2', 'P3', 'P5'].map(custom), 'the list\'s rows first, P4 moved up');
  im.prewarm([custom('P2')]);
  assert.equal(im.pq.length, 7, 'a token waiting already is not queued twice');
  assert.equal(im.info().warm_list, 7);
  await sleep(300);
  assert.equal(log.length, 0, 'held 5 s after a generation');
  im.genAt = 0;
  im.warmQueue([custom('Q1')]);                            // the song window arrives: it goes first
  assert.ok(await until(() => im.info().prewarmed === 7 && im.info().warmed_queue >= 1), `all made (${im.info().prewarmed} list, ${im.info().warmed_queue} queue)`);
  assert.ok(log[0].endsWith(custom('Q1')), 'the queue lane first');
  const rows = log.filter((u) => !u.endsWith(custom('Q1')));
  assert.deepEqual(rows.map((u) => u.slice(-40)), ['R1', 'R2', 'P4', 'P1', 'P2', 'P3', 'P5'].map(custom), 'list order kept');
  assert.equal(m.ffMax, 1, 'one ffmpeg run at a time');
  assert.equal(im.info().warm_list, 0);
  for (const n of names) assert.ok(fs.existsSync(im.file(custom(n), 88)), `${n} at 88`);
});

test('ETag on every picture (a hash of its bytes); If-None-Match -> 304 without a body, same headers', NEED, async () => {
  const mosaic = 'https://mosaic.scdn.co/300/' + hex24('etag');
  const ut = tokenFor('https://mosaic.scdn.co/640/' + hex24('etag'));
  const ht = custom('sq300');
  const { im } = mk((url) => (url === mosaic || url.endsWith(ht) ? { buf: FX.sq300 } : null));
  let out = {};
  const res = { writeHead(s, h) { out.s = s; out.h = h; }, end(b) { out.b = b; } };
  await im.serve({ headers: {} }, res, ht, '88');
  const etag = out.h.ETag;
  assert.match(etag, /^"[0-9a-f]{20}"$/);
  assert.equal(out.s, 200); assert.equal(out.h['Content-Length'], out.b.length); assert.equal(out.h['Cache-Control'], 'private, max-age=31536000, immutable');
  for (const inm of [etag, 'W/' + etag, `"nope", ${etag}`, '*']) {
    out = {};
    await im.serve({ headers: { 'if-none-match': inm } }, res, ht, '88');
    assert.equal(out.s, 304, `If-None-Match ${inm}`); assert.equal(out.b, undefined, 'no body');
    assert.equal(out.h.ETag, etag); assert.equal(out.h['Cache-Control'], 'private, max-age=31536000, immutable'); assert.equal(out.h['Content-Length'], undefined);
  }
  out = {};
  await im.serve({ headers: { 'if-none-match': '"0000"' } }, res, ht, '88');
  assert.equal(out.s, 200, 'another ETag: the bytes');
  await im.serve({ headers: {} }, res, ht, '216');
  assert.notEqual(out.h.ETag, etag, 'each size its own ETag');
  im.mem.clear(); im.memBytes = 0;
  await im.serve({}, res, ht, '88');
  assert.equal(out.h.ETag, etag, 'the same after a read from disk');
  await im.serve({}, res, ut, '88');
  assert.equal(out.h['Cache-Control'], 'private, max-age=604800'); assert.match(out.h.ETag, /^"[0-9a-f]{20}"$/);
  out = {};
  await im.serveLegacy({ headers: {} }, res, new URL('http://x/v1/image?u=' + encodeURIComponent(mosaic)));
  const le = out.h.ETag;
  assert.ok(out.b.equals(FX.sq300)); assert.match(le, /^"[0-9a-f]{20}"$/);
  out = {};
  await im.serveLegacy({ headers: { 'if-none-match': le } }, res, new URL('http://x/v1/image?u=' + encodeURIComponent(mosaic)));
  assert.equal(out.s, 304); assert.equal(out.h['Cache-Control'], 'private, max-age=86400');
  assert.equal(im.info().not_modified, 5);
});

test('warming: one ffmpeg run at a time for both size groups (a 640 source too big to pass through is converted too)', NEED, async () => {
  const player = new EventEmitter();
  player.pending = null;
  const { im } = mk((url) => (['W1', 'W2'].some((n) => url.endsWith(custom(n))) ? { buf: FX.big } : null), { player });
  const m = instrument(im);
  player.emit('genStart', 2);                              // held 0.5 s, so that all four are queued first
  assert.equal(im.warmQueue([custom('W1'), custom('W2')]), 4, 'two songs x two size groups');
  assert.ok(await until(() => im.info().warmed_queue === 4), `all four made (${im.info().warmed_queue})`);
  assert.equal(im.stats.ffmpeg, 4, 'every one converted: the 640 source is 1280 px');
  assert.equal(m.fetchMax, 2, 'two jobs at once');
  assert.equal(m.ffMax, 1, 'one ffmpeg run at a time, a \'big\' one included');
  for (const n of ['W1', 'W2']) for (const s of [88, 216, 640]) assert.ok(fs.existsSync(im.file(custom(n), s)), `${n} at ${s}`);
});

test('list lane: a search\'s rows replace those the previous search left waiting; other lists\' rows stay', async () => {
  const player = new EventEmitter();
  player.pending = null;
  const { im, log } = mk(() => null, { player });
  player.emit('gen', 2);                                   // held: the list lane waits 5 s after a generation began
  const names = (q) => q.map((j) => j.token);
  im.prewarm([custom('P1')]);                              // the playlist covers
  im.prewarm([custom('L1'), custom('X')], { first: true }); // a playlist's rows
  im.prewarm([custom('S1'), custom('S2'), custom('X')], { first: true, tag: 'search' });   // a search ('the b')
  assert.deepEqual(names(im.pq), ['S1', 'S2', 'X', 'L1', 'P1'].map(custom), 'the search first; X moved up with it');
  im.prewarm([custom('S3'), custom('S2')], { first: true, tag: 'search' });                 // typed further ('the be')
  assert.deepEqual(names(im.pq), ['S3', 'S2', 'X', 'L1', 'P1'].map(custom), 'S1 dropped; X, a playlist row too, stays');
  assert.equal(im.pset.has(`${custom('S1')}:small`), false);
  assert.equal(im.pset.size, 5);
  im.prewarm([custom('S1')], { first: true, tag: 'search' });                                // back to the shorter one
  assert.deepEqual(names(im.pq), ['S1', 'X', 'L1', 'P1'].map(custom));
  im.prewarm([custom('L2')], { first: true });             // another list: no tag, drops nothing
  assert.deepEqual(names(im.pq), ['L2', 'S1', 'X', 'L1', 'P1'].map(custom));
  assert.equal(im.info().warm_list, 5);
  assert.equal(log.length, 0, 'nothing fetched while held');
  await im.flush();
});
