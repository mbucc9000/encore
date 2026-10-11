'use strict';
// pcm.js sources (R3g, D19): the FIFO stays the Linux default, and the named-pipe server the Windows bridge uses.
//  - PcmClock over a scripted source: backpressure (pause above the queue limit, resume below half), the in-flight
//    count the player's boundary uses, the partial frame dropped at a new output session, dropped audio counted.
//  - PipeServerSource over a real pipe (a Unix socket here, a named pipe on Windows): data, backpressure, a new
//    connection replacing the old one once it writes (the old one's bytes dropped, never played), and a connection
//    that only reads (any account may open the pipe to read) never taking over.
//  - Windows only: the pipe's quota measured with a writer that blocks like the engine's (T3); reported, not judged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PcmClock, FifoSource, PipeServerSource, sourceFor, BPS } = require('../src/pcm');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(10); }
}
const win = process.platform === 'win32';
const pipeName = () => (win ? `\\\\.\\pipe\\encore-test-${crypto.randomBytes(6).toString('hex')}`
  : path.join(os.tmpdir(), `encore-test-${crypto.randomBytes(6).toString('hex')}.sock`));

// the sources' own log lines ("reading PCM from …") stay out of the test output
function quietLog(t) {
  const orig = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  t.after(() => Object.assign(console, orig));
}

// a source the test drives by hand
class ScriptedSource {
  constructor() { this.kind = 'scripted'; this.pipeBytes = 65536; this.paused = false; this.held = 0; this.stopped = false; }
  start(sink) { this.sink = sink; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  isPaused() { return this.paused; }
  get readableLength() { return this.held; }
  stop() { this.stopped = true; }
}

function scriptedClock(opts = {}) {
  const src = new ScriptedSource();
  const clock = new PcmClock(src, { leadMs: 5000, gapMs: 120, queueMs: 400, ...opts });
  clock.start();
  clearInterval(clock.timer);          // the test calls tick() itself
  clock.timer = null;
  const out = [];
  clock.on('pcm', (buf, start, real) => { if (real) out.push(Buffer.from(buf)); });
  return { src, clock, out };
}

test('a FIFO path still means the FIFO source (Linux, Docker); sourceFor() follows PCM_SOURCE', () => {
  const c = new PcmClock(path.join(os.tmpdir(), 'unused-pcm-source.pcm'), { leadMs: 10000 });
  assert.ok(c.src instanceof FifoSource);
  assert.equal(c.fifo, path.join(os.tmpdir(), 'unused-pcm-source.pcm'));
  assert.equal(c.pipeBytes, 65536, 'until sizePipe() measures it');
  assert.equal(c.readerPaused, false, 'nothing is open before start()');
  assert.equal(c.inFlightSamples, 0);
  assert.equal(sourceFor({ pcmSource: 'fifo', fifo: '/pipe/encore.pcm' }), '/pipe/encore.pcm');
  const s = sourceFor({ pcmSource: 'pipe-server', pcmPipe: '\\\\.\\pipe\\x', pcmPipeBytes: 12345 });
  assert.ok(s instanceof PipeServerSource);
  assert.equal(s.path, '\\\\.\\pipe\\x');
  assert.equal(s.pipeBytes, 12345);
  assert.equal(new PcmClock(s).pipeSamples, Math.floor(12345 / BPS));
});

test('backpressure: the reader pauses above the queue limit and resumes below half of it; in-flight samples', () => {
  const { src, clock } = scriptedClock();
  const max = clock.maxQueue;
  assert.equal(max, Math.round(0.4 * 44100) * BPS);
  src.sink.data(Buffer.alloc(max - 4));
  assert.equal(src.paused, false);
  src.sink.data(Buffer.alloc(8));
  assert.equal(src.paused, true, 'paused once more than the limit is queued');
  assert.equal(clock.readerPaused, true);
  src.held = 4000;                       // the reader holds bytes it hasn't delivered
  assert.equal(clock.inFlightSamples, Math.floor((max + 4) / BPS) + 1000 + 65536 / BPS, 'queue + held + the pipe while paused');
  src.held = 0;
  clock.tick();                          // lead 0 < 5 s: the whole queue is emitted
  assert.equal(clock.queued, 0);
  assert.equal(src.paused, false, 'resumed below half the limit');
  assert.equal(clock.inFlightSamples, 0);
  // beginDiscard resumes a paused reader so the pipe drains
  src.sink.data(Buffer.alloc(max + 4));
  assert.equal(src.paused, true);
  clock.beginDiscard();
  assert.equal(src.paused, false);
  src.sink.data(Buffer.alloc(400));
  assert.equal(clock.queued, 0, 'dropped while discarding');
  clock.endDiscard();
});

test('a new output session drops the partial frame left by the old one; older-connection audio is counted as dropped', () => {
  const { src, clock, out } = scriptedClock();
  const old = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);          // two frames and half of one
  src.sink.data(old);
  src.sink.swap();
  assert.equal(clock.queued, 8);
  const fresh = Buffer.from([11, 12, 13, 14, 15, 16, 17, 18]);
  src.sink.data(fresh);
  clock.tick();
  assert.deepEqual([...Buffer.concat(out)], [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18], 'frame-aligned: no shifted samples');
  // a partial frame spread over several queued buffers
  src.sink.data(Buffer.from([1, 2, 3, 4, 5]));
  src.sink.data(Buffer.from([6]));
  src.sink.swap();
  assert.equal(clock.queued, 4);
  assert.equal(clock.queue.length, 1);
  const before = clock.stats.dropped;
  const t0 = clock.lastAnyDataAt;
  src.sink.drop(Buffer.alloc(4096));
  assert.equal(clock.stats.dropped - before, 1024);
  assert.ok(clock.lastAnyDataAt >= t0, 'quiet() waits for dropped audio too');
  clock.stop();
  assert.ok(src.stopped);
});

test('named pipe server: data, backpressure, and a new connection replacing the old one', async (t) => {
  quietLog(t);
  const p = pipeName();
  const got = [];
  let dropped = 0;
  let swaps = 0;
  const src = new PipeServerSource(p, { pipeBytes: 65536 });
  src.start({ data: (b) => got.push(b), drop: (b) => { dropped += b.length; }, swap: () => { swaps++; } });
  t.after(() => src.stop());
  await until(() => src.listening, 5000, 'listen');
  const total = () => got.reduce((n, b) => n + b.length, 0);

  // 1. data flows
  const a = net.connect(p);
  t.after(() => a.destroy());
  await new Promise((r) => a.once('connect', r));
  a.write(Buffer.alloc(1000, 0xaa));
  await until(() => total() === 1000, 5000, 'the first bytes');
  assert.equal(src.connected, true);
  assert.equal(swaps, 1);

  // 2. backpressure: paused, the writer gets stuck; resumed, everything arrives
  src.pause();
  assert.equal(src.isPaused(), true);
  const BIG = 8 << 20;
  let flushed = 0;
  let lastProgress = Date.now();
  (async () => {
    const chunk = Buffer.alloc(16384, 0xaa);
    for (let sent = 0; sent < BIG; sent += chunk.length) {
      const more = a.write(chunk, () => { flushed += chunk.length; lastProgress = Date.now(); });
      if (!more) await new Promise((r) => a.once('drain', r));
    }
  })().catch(() => {});
  await until(() => Date.now() - lastProgress > 400, 15000, 'the writer to block');
  const inFlight = flushed;
  t.diagnostic(`paused: ${inFlight} bytes left the writer (${src.readableLength} held by the reader)`);
  assert.ok(inFlight < BIG, 'the writer is held back while the reader is paused');
  assert.ok(src.readableLength <= 256 * 1024, `the reader holds little (${src.readableLength})`);
  src.resume();
  await until(() => total() === 1000 + BIG, 20000, 'all bytes after resume');

  // 3. a new connection while paused: the old one's leftovers are dropped, the new one plays
  src.pause();
  a.write(Buffer.alloc(40000, 0xaa));
  await sleep(200);
  const b = net.connect(p);
  t.after(() => b.destroy());
  await new Promise((r) => b.once('connect', r));
  await until(() => src.counts.connections === 2, 5000, 'the second connection');
  await sleep(100);
  assert.equal(swaps, 1, 'a connection that hasn\'t written yet doesn\'t take over');
  assert.equal(src.counts.swaps, 0);
  const n0 = got.length;
  b.write(Buffer.alloc(3000, 0xbb));
  await until(() => swaps === 2, 5000, 'the swap at the new connection\'s first bytes');
  assert.equal(src.counts.swaps, 1);
  await until(() => dropped === 40000, 5000, 'the old connection drained into drop()');
  src.resume();
  await until(() => got.slice(n0).reduce((n, x) => n + x.length, 0) === 3000, 5000, 'the new connection\'s bytes');
  assert.ok(got.slice(n0).every((x) => x.every((v) => v === 0xbb)), 'only the new connection plays');
  assert.equal(src.counts.droppedBytes, 40000);
  // the old connection is closed by the server soon after
  await until(() => a.destroyed || a.readyState === 'closed' || a.writableEnded || !a.writable, 4000, 'the old connection to close');
});

test('a connection that arrives while paused starts paused', async (t) => {
  quietLog(t);
  const p = pipeName();
  const got = [];
  const src = new PipeServerSource(p);
  src.start({ data: (x) => got.push(x), drop: () => {}, swap: () => {} });
  t.after(() => src.stop());
  await until(() => src.listening, 5000, 'listen');
  src.pause();
  const c = net.connect(p);
  t.after(() => c.destroy());
  await new Promise((r) => c.once('connect', r));
  c.write(Buffer.alloc(5000, 1));
  await until(() => src.connected, 5000, 'adopted');
  await sleep(200);
  assert.equal(got.length, 0, 'nothing delivered while paused');
  assert.equal(src.isPaused(), true);
  src.resume();
  await until(() => got.reduce((n, x) => n + x.length, 0) === 5000, 5000, 'delivered after resume');
});

// Any account on the PC may open the named pipe to read (its default security), and its name can be listed: such a
// reader must never take over from the engine or stop its audio. Only a connection that writes is adopted.
test('a connection that only reads never takes over: the engine keeps playing, and piled-up readers are closed', async (t) => {
  quietLog(t);
  const p = pipeName();
  let played = 0;
  let dropped = 0;
  let swaps = 0;
  const src = new PipeServerSource(p);
  src.start({ data: (b) => { played += b.length; }, drop: (b) => { dropped += b.length; }, swap: () => { swaps++; } });
  t.after(() => src.stop());
  await until(() => src.listening, 5000, 'listen');
  const engine = net.connect(p);
  t.after(() => engine.destroy());
  await new Promise((r) => engine.once('connect', r));
  engine.write(Buffer.alloc(4000, 0x11));
  await until(() => played === 4000, 5000, 'the engine plays');
  // readers arrive, more than are kept waiting
  const readers = [];
  for (let i = 0; i < 7; i++) {
    const r = net.connect(p);
    r.on('error', () => {});
    readers.push(r);
    t.after(() => r.destroy());
    await new Promise((res) => r.once('connect', res));
  }
  await until(() => src.counts.connections === 8, 5000, 'the readers connected');
  await until(() => src.counts.readersClosed === 3, 5000, 'the oldest waiting readers closed');
  assert.equal(src.info().waiting, 4);
  engine.write(Buffer.alloc(4000, 0x22));
  await until(() => played === 8000, 5000, 'the engine still plays');
  assert.equal(swaps, 1, 'no reader took over');
  assert.equal(src.counts.swaps, 0);
  assert.equal(dropped, 0, 'nothing of the engine\'s was dropped');
  assert.equal(src.connected, true);
  // the engine's next output session (a new connection that writes) still takes over at once
  const next = net.connect(p);
  t.after(() => next.destroy());
  await new Promise((r) => next.once('connect', r));
  next.write(Buffer.alloc(2000, 0x33));
  await until(() => swaps === 2 && played === 10000, 5000, 'the new session plays');
  assert.equal(src.counts.swaps, 1);
});

// T3 (Windows): how much a writer that blocks like the engine (a synchronous handle, WriteFile) gets into the pipe
// while the bridge isn't reading. The answer belongs in PCM_PIPE_BYTES' default (65536) if it differs a lot.
test('Windows named pipe quota, measured (T3)', { skip: !win && 'needs Windows named pipes' }, async (t) => {
  quietLog(t);
  const p = pipeName();
  const src = new PipeServerSource(p);
  let delivered = 0;
  src.start({ data: (x) => { delivered += x.length; }, drop: () => {}, swap: () => {} });
  t.after(() => src.stop());
  await until(() => src.listening, 5000, 'listen');
  src.pause();
  // O_WRONLY alone = an existing pipe opened for writing, as the engine's os.OpenFile(path, O_WRONLY) does
  const writer = `const fs=require('fs');const fd=fs.openSync(process.argv[1],fs.constants.O_WRONLY);const b=Buffer.alloc(4096,3);let n=0;
    for(;;){fs.writeSync(fd,b);n+=b.length;fs.writeSync(1,n+'\\n');}`;
  const child = spawn(process.execPath, ['-e', writer, p], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { try { child.kill(); } catch (e) { /* gone */ } });
  let written = 0;
  let lastProgress = Date.now();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { const m = d.trim().split('\n').pop(); written = Number(m) || written; lastProgress = Date.now(); });
  await until(() => written > 0 && Date.now() - lastProgress > 500, 15000, 'the writer to block');
  const held = src.readableLength;
  t.diagnostic(`blocked after ${written} bytes: ${held} held by the bridge's socket, about ${written - held} in the pipe (PCM_PIPE_BYTES default 65536)`);
  assert.ok(written < 4 << 20, 'the writer blocks');
  assert.equal(delivered, 0, 'nothing delivered while paused');
  src.resume();
  await until(() => delivered >= written, 10000, 'the backlog after resume');
});
