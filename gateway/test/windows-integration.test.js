'use strict';
// Small Windows integration points of R3c that run anywhere:
//  - the Jam QR code (http.js jamQr): the bridge's own encoder (qr.js) on Windows (D22), and wherever qrencode is
//    missing; Docker keeps qrencode;
//  - the player's stream boundary (player.js boundary() / realNow()) counts what the PCM reader holds but hasn't
//    delivered yet (pcm.js inFlightSamples): on Windows one read of the named pipe can hold 64 KB;
//  - the state files written with tmp + rename (auth.js, webapi.js, jam.js) go through fsutil's renameRetry.
// Synthetic links and data only.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { jamQr } = require('../src/http');
const { qrPng } = require('../src/qr');
const { PcmClock, BPS } = require('../src/pcm');
const { Player } = require('../src/player');
const { hasCommand } = require('./support/platform');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-win-integration-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// jamQr(res, link, opts) -> the answer it wrote
function qr(link, opts) {
  let r;
  const done = new Promise((resolve) => {
    r = { writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = Buffer.isBuffer(b) ? b : Buffer.from(String(b || '')); resolve(this); } };
  });
  jamQr(r, link, opts);
  return done;
}
const link = (n) => `https://open.spotify.com/socialsession/${'a'.repeat(20)}${n}?si=0123456789abcdef`;

test('Jam QR on Windows: the bridge\'s own encoder, the same PNG qr.js draws; only Spotify links', async () => {
  const l = link(1);
  const r = await qr(l, { js: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'image/png');
  assert.ok(r.body.subarray(0, 8).equals(PNG_SIG));
  assert.ok(r.body.equals(qrPng(l)), 'the qr.js PNG');
  assert.equal(r.headers['Content-Length'], r.body.length);
  const again = await qr(l, { js: true });
  assert.ok(again.body.equals(r.body), 'cached by link');
  for (const bad of [null, '', 'https://example.com/socialsession/x', 'javascript:alert(1)']) {
    const n = await qr(bad, { js: true });
    assert.equal(n.status, 404);
    assert.equal(JSON.parse(n.body).error.code, 'no_jam');
  }
});

test('Jam QR without qrencode on this computer: the bridge\'s own encoder instead of a 502', async () => {
  const saved = process.env.PATH;
  process.env.PATH = tmp();                                  // an empty folder: no qrencode to find
  try {
    const l = link(2);
    const r = await qr(l, { js: false });
    assert.equal(r.status, 200, String(r.body));
    assert.ok(r.body.equals(qrPng(l)));
  } finally { process.env.PATH = saved; }
});

test('Jam QR on Docker: still qrencode', { skip: !hasCommand('qrencode', ['--version']) && 'qrencode is not on PATH' }, async () => {
  const r = await qr(link(3), { js: false });
  assert.equal(r.status, 200);
  assert.ok(r.body.subarray(0, 8).equals(PNG_SIG));
});

// A PCM source as the clock sees it: paused or not, and what its reader holds but hasn't delivered
function heldSource() {
  return { paused: false, readableLength: 0, pipeBytes: 65536, start(sink) { this.sink = sink; }, stop() {}, pause() { this.paused = true; }, resume() { this.paused = false; },
    isPaused() { return this.paused; }, info() { return { source: 'test' }; } };
}

test('the player\'s boundary and engine position count what the PCM reader holds (pcm.js inFlightSamples)', () => {
  const src = heldSource();
  const clock = new PcmClock(src, { leadMs: 10000 });
  clock.start();
  clearInterval(clock.timer);
  clock.timer = null;
  const player = new Player({ engine: { status: null, on() {}, call: async () => null }, clock, bus: { push() {} }, webapi: null, dataDir: tmp() });
  assert.equal(player.boundary(), 0);
  src.sink.data(Buffer.alloc(4000 * BPS));                  // queued
  assert.equal(player.boundary(), 4000);
  src.paused = true;                                         // the reader is paused: the pipe is full behind it
  src.readableLength = 16384;                                // and its last read is still undelivered
  assert.equal(player.boundary(), 4000 + 16384 / BPS + 65536 / BPS);
  assert.equal(player.boundary(), clock.sample + clock.inFlightSamples);
  assert.equal(player.realNow(), clock.stats.real + clock.inFlightSamples);
  // a clock without the getter (an old stub) gets the old sum
  const old = { sample: 10, queuedSamples: 5, readerPaused: true, pipeSamples: 7, stats: { real: 3 } };
  const p2 = Object.create(Player.prototype);
  p2.clock = old;
  assert.equal(p2.boundary(), 22);
  assert.equal(p2.realNow(), 15);
});

test('the state files are written with tmp + renameRetry (Windows: a scanner may hold the old file a moment)', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  assert.match(src('auth.js'), /renameRetrySync\(tmp, this\.file\)/);
  assert.match(src('webapi.js'), /renameRetrySync\(tmp, this\.file\)/);
  assert.match(src('jam.js'), /await renameRetry\(tmp, file\)/);
  for (const f of ['auth.js', 'webapi.js', 'jam.js']) assert.doesNotMatch(src(f), /fs\.renameSync|fsp\.rename\(/, f);
  // and they still work: a devices.json written twice
  const { Auth } = require('../src/auth');
  const dir = tmp();
  const a = new Auth(dir);
  a.pair(a.newCode().code, 'Test Phone');
  a.pair(a.newCode().code, 'Test Phone 2');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'devices.json'), 'utf8'))).length, 2);
  assert.equal(fs.existsSync(path.join(dir, 'devices.json.tmp')), false);
});
