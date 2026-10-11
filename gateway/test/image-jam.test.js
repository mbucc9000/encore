'use strict';
// image.js for Jams (DESIGN-4b.md §4.7, §4.8): the two Facebook hosts and nothing else new; a Spotify Code from
// scannables.scdn.co passes through as the same PNG bytes (any s, ≤ 64 KB, a refused width = image_gone).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Images, tokenFor, urlFor } = require('../src/image');
const { tmp } = require('./support/helpers');
const { needs, ffmpeg: FFMPEG } = require('./support/platform');

const NEED = { skip: needs({ ffmpeg: true }) };   // the picture conversion runs ffmpeg

const CODE = 'https://scannables.scdn.co/uri/plain/png/2F9A2B/white/640/spotify%3Asocialsession%3AAbC123_tok';
const SRC = tmp('imgjam');
const PNG = (() => {
  if (NEED.skip) return Buffer.alloc(0);
  const f = path.join(SRC, 'pic.png');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=200x200:rate=1', '-frames:v', '1', f]);
  return fs.readFileSync(f);
})();
const CODE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake code bars '.repeat(200))]);

function mk(map) {
  const im = new Images({ cacheDir: tmp('imgj'), ffmpeg: FFMPEG }, { pending: null, on() {} });
  const log = [];
  im.fetch = async (url) => {
    log.push(url);
    const hit = map(url);
    if (!hit || hit.status) return { url, status: (hit && hit.status) || 404, ok: false, headers: { get: () => 'text/plain' }, arrayBuffer: async () => new ArrayBuffer(0) };
    return { url, status: 200, ok: true, headers: { get: () => hit.type || 'image/png' }, arrayBuffer: async () => hit.buf };
  };
  return { im, log };
}

function res() {
  const r = { head: null, body: null };
  r.writeHead = (st, h) => { r.head = { st, h }; };
  r.end = (b) => { r.body = b; };
  return r;
}

test('allowlist: platform-lookaside.fbsbx.com and *.fbcdn.net join the Spotify hosts; nothing else new', () => {
  for (const ok of ['https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1&height=300', 'https://scontent-xxx1-1.xx.fbcdn.net/v/t1.0-1/p320x320/1.jpg',
    'https://fbcdn.net/x.jpg', CODE, 'https://i.scdn.co/image/ab6775700000ee85' + 'a'.repeat(24)]) {
    const t = tokenFor(ok);
    assert.ok(t, ok);
    assert.equal(urlFor(t), ok);
  }
  for (const bad of ['https://platform-lookaside-fbsbx.com/x.jpg', 'https://evil.platform-lookaside.fbsbx.com/x.jpg', 'https://platform-lookaside.fbsbx.com.evil.example/x.jpg', 'https://fbcdn.net.evil.example/x.jpg',
    'https://facebook.com/x.jpg', 'https://graph.facebook.com/1/picture', 'http://scontent.xx.fbcdn.net/x.jpg', 'https://example.com/socialsession.png']) {
    assert.equal(tokenFor(bad), '', bad);
    assert.equal(urlFor('u' + Buffer.from(bad).toString('base64url')), null, 'a forged token: ' + bad);
  }
});

test('Spotify Code: the same PNG bytes for any s, cached (memory, then disk) for 7 days; a 4xx is image_gone; too big or not a PNG -> 502', NEED, async () => {
  const { im, log } = mk((u) => (u === CODE ? { buf: CODE_PNG } : null));
  const ci = tokenFor(CODE);
  for (const s of ['88', '640', null]) {
    const r = res();
    await im.serve({}, r, ci, s);
    assert.equal(r.head.st, 200);
    assert.equal(r.head.h['Content-Type'], 'image/png');
    assert.equal(r.head.h['Cache-Control'], 'private, max-age=604800');
    assert.ok(Buffer.compare(r.body, CODE_PNG) === 0, 'unchanged bytes');
  }
  assert.equal(log.length, 1, 'one CDN download');
  im.mem.clear();
  im.memBytes = 0;
  const r2 = res();
  await im.serve({}, r2, ci, '216');
  assert.ok(Buffer.compare(r2.body, CODE_PNG) === 0);
  assert.equal(log.length, 1, 'from disk');
  const gone = mk((u) => (u === CODE ? { status: 400 } : null));
  await assert.rejects(gone.im.serve({}, res(), ci, '640'), (e) => e.status === 404 && e.code === 'image_gone', 'a refused width');
  const big = mk(() => ({ buf: Buffer.concat([CODE_PNG, Buffer.alloc(70 * 1024)]) }));
  await assert.rejects(big.im.serve({}, res(), ci, '640'), (e) => e.status === 502);
  const jpg = mk(() => ({ buf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]), type: 'image/jpeg' }));
  await assert.rejects(jpg.im.serve({}, res(), ci, '640'), (e) => e.status === 502, 'only a PNG passes');
});

test('a member picture (PNG on fbcdn) still becomes a JPEG; only scannables.scdn.co passes PNGs through', NEED, async () => {
  const pic = 'https://scontent-xxx1-1.xx.fbcdn.net/v/t1.0-1/p320x320/abc.png';
  const { im } = mk((u) => (u === pic ? { buf: PNG } : null));
  const r = res();
  await im.serve({}, r, tokenFor(pic), '88');
  assert.equal(r.head.h['Content-Type'], 'image/jpeg');
  assert.ok(r.body[0] === 0xff && r.body[1] === 0xd8);
});
