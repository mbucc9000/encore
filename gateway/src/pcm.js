'use strict';
// PcmClock: reads go-librespot's PCM pipe and turns it into one continuous, clocked stream of samples.
//  - real audio may run up to `leadMs` ahead of the listener (so a fresh play fills the phone's buffer in a burst),
//    after that the pipe is read at the listener's speed, which paces the player
//  - "the listener" is real time from the last anchor, corrected by the phone's playhead reports (follow()); while the
//    phone is stalled the clock is frozen, so the player never runs more than `leadMs` ahead of what it hears
//  - when the player is silent (paused, loading) the gap is filled with silence at real time
//  - 'resume' fires with the sample index where real audio starts again after silence (used for generation boundaries)
//  - beginDiscard()/endDiscard() drop in-flight audio around a user command so old audio never leaks into a new generation
//
// Where the PCM comes from (a "source"; D19):
//  - FifoSource (Linux, Docker; the default there): the engine writes into a FIFO the bridge holds open. This is the
//    code the bridge has always run, unchanged.
//  - PipeServerSource (Windows; PCM_SOURCE=pipe-server): the bridge serves a named pipe with a random name and the
//    engine connects to it as a client every time it opens its output (Encore patch 6). The newest connection that
//    writes is the one that plays (one that only reads is never adopted); whatever an older connection still holds
//    belongs to a finished output session and is dropped.
//    On Linux the same source works over a Unix socket (the tests use that).
// Both stop reading while the queue is full, so the engine's write blocks and its decoder waits: that backpressure is
// what paces the player.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const log = require('./log');

const RATE = 44100;
const BPS = 4; // bytes per sample frame (s16le, 2 channels)
// Prints the pipe's size (F_GETPIPE_SZ) after shrinking it to 16 KB (F_SETPIPE_SZ) if it is bigger, plus the error if
// that failed. Only ever shrink: Docker gives a container's new pipe just 8 KB once its uid is over
// fs.pipe-user-pages-soft (no CAP_SYS_RESOURCE), and "shrinking" that to 16 KB would grow it (EPERM).
const PIPE_SZ = 'open(my $f,"+<",$ARGV[0]) or die "$!\\n"; my $n = fcntl($f,1032,0) or die "F_GETPIPE_SZ: $!\\n"; ' +
  'if ($n > 16384) { my $r = fcntl($f,1031,16384); if ($r) { $n = $r } else { print "$n $!\\n"; exit } } print "$n\\n"';

// The engine's FIFO (Linux). sink = { data(buf), drop(buf), swap() }; a FIFO only ever calls data().
class FifoSource {
  constructor(fifo) {
    this.kind = 'fifo';
    this.fifo = fifo;
    this.rs = null;
    this.pipeBytes = 65536;   // the kernel pipe's size (the Linux default until sizePipe() knows better)
  }

  ensureFifo() {
    fs.mkdirSync(path.dirname(this.fifo), { recursive: true });
    if (!fs.existsSync(this.fifo)) execFileSync('mkfifo', ['-m', '666', this.fifo]);
    else if (!fs.statSync(this.fifo).isFIFO()) throw new Error(this.fifo + ' exists but is not a FIFO');
    fs.chmodSync(this.fifo, 0o666);
  }

  start(sink) {
    this.ensureFifo();
    // 'r+' = O_RDWR: never blocks on open and never sees EOF when the player restarts
    this.rs = fs.createReadStream(this.fifo, { flags: 'r+', highWaterMark: 8192 });
    this.rs.on('open', () => this.sizePipe());
    this.rs.on('data', (b) => sink.data(b));
    this.rs.on('error', (e) => log.error('pcm read:', e.message));
    log.info('reading PCM from', this.fifo);
  }

  // A small kernel pipe buffer (default 64 KB = 0.37 s) means little old audio is in flight at a command. Its real
  // size also tells the player where audio the engine produces right now will land (boundary()).
  sizePipe(tries = 0) {
    let out;
    try {
      out = execFileSync('perl', ['-e', PIPE_SZ, this.fifo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(' ');
    } catch (e) { log.warn('could not check the pipe buffer:', String(e.stderr || e.message).trim().split('\n')[0]); return; }
    if (Number(out[0]) > 0) this.pipeBytes = Number(out[0]);
    if (out.length === 1) { log.info(`pipe buffer is ${this.pipeBytes / 1024} KB`); return; }
    const err = out.slice(1).join(' ');
    // EBUSY: more than 16 KB is in the pipe right now; it drains whenever the reader catches up
    if (/busy/i.test(err) && tries < 20) { setTimeout(() => this.sizePipe(tries + 1), 3000).unref(); return; }
    log.warn(`could not shrink the ${this.pipeBytes / 1024} KB pipe buffer: ${err}`);
  }

  pause() { if (this.rs) this.rs.pause(); }
  resume() { if (this.rs) this.rs.resume(); }
  isPaused() { return !!(this.rs && this.rs.isPaused()); }
  get readableLength() { return this.rs ? this.rs.readableLength : 0; }   // read from the pipe, not yet delivered
  info() { return { source: 'fifo' }; }
  stop() { if (this.rs) { this.rs.destroy(); this.rs = null; } }
}

// A named pipe the bridge serves (Windows: \\.\pipe\encore-pcm-<random>; a Unix socket path elsewhere).
//  - One output session of the engine = one connection. A new connection takes over when it writes its first bytes;
//    the old one is then drained into drop() (its audio is from before the engine closed that output) and closed.
//  - Only a connection that writes is ever adopted. The engine opens the pipe write-only and writes at once. Any other
//    account on the PC can open it too (a pipe's default security lets Everyone read it, and its name can be listed),
//    but only to read: such a reader waits unadopted, so it can neither take over nor stop the engine's stream.
//    MAX_PENDING of them are kept at once; the oldest goes when more arrive.
//  - pause()/resume() apply to the current connection, and a connection adopted while paused stays paused.
//    A paused socket stops reading once `highWaterMark` bytes wait in it, then the pipe fills (pipeBytes, about
//    64 KB on Windows) and the engine's write blocks.
const MAX_PENDING = 4;
class PipeServerSource {
  constructor(pipePath, { pipeBytes = 65536, highWaterMark = 8192 } = {}) {
    this.kind = 'pipe-server';
    this.path = pipePath;
    this.pipeBytes = pipeBytes;   // what the pipe holds on its own while nobody reads (config / T3 measurement)
    this.highWaterMark = highWaterMark;
    this.server = null;
    this.sock = null;
    this.pending = new Set();     // connections that haven't written yet
    this.paused = false;
    this.listening = false;
    this.counts = { connections: 0, swaps: 0, droppedBytes: 0, readersClosed: 0 };
  }

  start(sink) {
    this.sink = sink;
    // highWaterMark: how much a paused connection buffers before it stops reading (accepted sockets get it, Node >= 20.1)
    const server = net.createServer({ highWaterMark: this.highWaterMark }, (sock) => this.candidate(sock));
    server.on('error', (e) => log.error('pcm pipe:', e.code || e.message));
    server.listen(this.path, () => { this.listening = true; log.info('reading PCM from a named pipe the engine connects to'); });
    this.server = server;
  }

  // A new connection waits until it writes (see above); its first bytes go back into it and it is adopted.
  candidate(sock) {
    this.counts.connections++;
    this.pending.add(sock);
    if (this.pending.size > MAX_PENDING) {         // readers piling up: the oldest one waiting goes
      const first = this.pending.values().next().value;
      this.pending.delete(first);
      this.counts.readersClosed++;
      first.destroy();
    }
    const onFirst = (b) => {
      sock.off('data', onFirst);
      this.pending.delete(sock);
      sock.pause();
      sock.unshift(b);                             // delivered (or dropped) by adopt()'s listener like the rest
      this.adopt(sock);
    };
    sock.on('data', onFirst);
    sock.on('error', (e) => { if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET' && e.code !== 'EOF') log.warn('pcm pipe connection:', e.code || e.message); });
    sock.on('close', () => { this.pending.delete(sock); if (this.sock === sock) this.sock = null; });
  }

  adopt(sock) {
    const old = this.sock;
    this.sock = sock;
    if (old) { this.counts.swaps++; this.retire(old); }
    if (this.sink.swap) this.sink.swap();          // a new output session starts on a sample frame boundary
    sock.on('data', (b) => { if (this.sock === sock) this.sink.data(b); else this.dropBytes(b); });
    if (!this.paused) sock.resume();               // (paused: it stays paused, its first bytes waiting in it)
  }

  // An older connection: read what it still holds (dropped), and close it soon in any case.
  retire(old) {
    old.resume();
    setTimeout(() => old.destroy(), 2000).unref();
  }

  dropBytes(b) {
    this.counts.droppedBytes += b.length;
    if (this.sink.drop) this.sink.drop(b);
  }

  pause() { this.paused = true; if (this.sock) this.sock.pause(); }
  resume() { this.paused = false; if (this.sock) this.sock.resume(); }
  isPaused() { return this.paused && !!this.sock; }
  get readableLength() { return this.sock ? this.sock.readableLength : 0; }
  get connected() { return !!this.sock; }
  info() { return { source: 'pipe-server', connected: !!this.sock, waiting: this.pending.size, ...this.counts }; }

  stop() {
    if (this.server) { this.server.close(); this.server = null; }
    if (this.sock) { this.sock.destroy(); this.sock = null; }
    for (const s of this.pending) s.destroy();
    this.pending.clear();
    this.listening = false;
  }
}

class PcmClock extends EventEmitter {
  // `source`: a FIFO path (as always) or a source object (PipeServerSource). Nothing is opened before start().
  constructor(source, { leadMs = 1500, gapMs = 120, queueMs = 400 } = {}) {
    super();
    this.src = typeof source === 'string' ? new FifoSource(source) : source;
    this.fifo = typeof source === 'string' ? source : null;
    this.leadMax = Math.round(leadMs * RATE / 1000);
    this.gapMs = gapMs;
    this.maxQueue = Math.round(queueMs * RATE / 1000) * BPS;
    this.queue = [];
    this.queued = 0;
    this.sample = 0;          // samples emitted so far = the stream timeline
    this.t0 = 0;              // wall clock (ms) at which sample 0 was "due"
    this.frozen = null;       // the sample a stalled phone is stuck at (due() stays there), null = real time
    this.lastDataAt = 0;
    this.lastAnyDataAt = 0;      // includes audio dropped while discarding (to know when the pipe is drained)
    this.inSilence = true;
    this.discarding = false;
    this.stats = { real: 0, silence: 0, dropped: 0 };
  }

  start() {
    this.src.start({ data: (b) => this.onData(b), drop: (b) => this.onDropped(b), swap: () => this.trimPartialFrame() });
    this.t0 = performance.now();
    this.timer = setInterval(() => this.tick(), 20);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.src.stop();
  }

  // the pipe's own buffer size (FIFO: measured by sizePipe(); named pipe: configured)
  get pipeBytes() { return this.src ? this.src.pipeBytes : 65536; }
  set pipeBytes(n) { if (this.src) this.src.pipeBytes = n; }

  onData(b) {
    this.lastAnyDataAt = performance.now();
    if (this.discarding) { this.stats.dropped += b.length / BPS; return; }
    this.queue.push(b);
    this.queued += b.length;
    this.lastDataAt = performance.now();
    if (this.queued > this.maxQueue) this.src.pause();
  }

  // audio from an older output session (named pipe): never played, but it is audio arriving (quiet() waits for it)
  onDropped(b) {
    this.lastAnyDataAt = performance.now();
    this.stats.dropped += b.length / BPS;
  }

  // A new output session starts on a frame boundary: an incomplete frame left from the old one would shift every
  // sample after it (loud static), so it goes.
  trimPartialFrame() {
    let n = this.queued % BPS;
    this.queued -= n;
    while (n > 0 && this.queue.length) {
      const last = this.queue[this.queue.length - 1];
      if (last.length > n) { this.queue[this.queue.length - 1] = last.subarray(0, last.length - n); n = 0; }
      else { n -= last.length; this.queue.pop(); }
    }
  }

  take(bytes) {                    // exactly `bytes` from the queue (bytes is a multiple of BPS)
    const parts = [];
    let need = bytes;
    while (need > 0 && this.queue.length) {
      const b = this.queue[0];
      if (b.length <= need) { parts.push(b); this.queue.shift(); need -= b.length; }
      else { parts.push(b.subarray(0, need)); this.queue[0] = b.subarray(need); need = 0; }
    }
    this.queued -= bytes - need;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  get queuedSamples() { return Math.floor(this.queued / BPS); }
  get readerPaused() { return !!(this.src && this.src.isPaused()); }
  get pipeSamples() { return Math.floor(this.pipeBytes / BPS); }
  get leadMs() { return Math.round(this.leadMax * 1000 / RATE); }       // the lead target
  // Audio the engine has produced that the stream hasn't emitted yet: the queue, what the reader holds but hasn't
  // delivered (readableLength: up to one read on a paused named pipe, which can be 64 KB), and the pipe itself while
  // the reader is paused. The player's boundary() = sample + inFlightSamples (R3c).
  get inFlightSamples() {
    const held = this.src ? Math.floor(this.src.readableLength / BPS) : 0;
    return this.queuedSamples + held + (this.readerPaused ? this.pipeSamples : 0);
  }

  // the sample the listener is hearing now
  due(now = performance.now()) { return this.frozen != null ? this.frozen : (now - this.t0) * RATE / 1000; }
  lead(now = performance.now()) { return this.sample - this.due(now); }
  reanchor() { this.anchorAt(this.sample); }
  anchorAt(sample) { this.frozen = null; this.t0 = performance.now() - sample * 1000 / RATE; }   // `sample` is due now; the lead builds from there

  // The phone is playing `sample` right now (or is stalled there); it can't be past what we've emitted. Stalled: due()
  // stays put, so reading stops `leadMs` ahead of it, the pipe fills and go-librespot's decoder waits for the phone.
  follow(sample, stalled) {
    const s = Math.min(sample, this.sample);
    if (stalled) this.frozen = s;
    else this.anchorAt(s);
  }

  unfreeze() { if (this.frozen != null) this.anchorAt(this.frozen); }   // real time again, from where it stood
  setLead(ms) { this.leadMax = Math.round(Math.min(30000, Math.max(5000, ms)) * RATE / 1000); }

  // Resolves once no audio has arrived for `ms` (the engine is paused and the pipe is drained), or after `max` ms.
  quiet(ms, max) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        const now = performance.now();
        if (now - this.lastAnyDataAt >= ms) return resolve(true);
        if (now - t0 >= max) return resolve(false);
        setTimeout(check, 5);
      };
      check();
    });
  }

  emitPcm(buf, real) {
    const start = this.sample;
    this.sample += buf.length / BPS;
    if (real) this.stats.real += buf.length / BPS; else this.stats.silence += buf.length / BPS;
    this.emit('pcm', buf, start, real);
  }

  tick() {
    const now = performance.now();
    let lead = this.lead(now);
    if (lead < -5 * RATE) { this.reanchor(); lead = 0; }       // long stall (e.g. container paused): don't flood silence
    // 1. real audio, up to leadMax ahead of the listener
    while (lead < this.leadMax) {
      const avail = this.queued - (this.queued % BPS);
      if (avail <= 0) break;
      const room = Math.ceil(this.leadMax - lead) * BPS;
      const buf = this.take(Math.min(avail, room));
      if (this.inSilence) { this.inSilence = false; this.emit('resume', this.sample); }
      this.emitPcm(buf, true);
      lead = this.lead(now);
    }
    if (this.readerPaused && this.queued < this.maxQueue / 2) this.src.resume();
    // 2. nothing to play for a while: silence up to real time (never while frozen: due <= sample, so lead >= 0)
    if (lead < 0 && now - this.lastDataAt > this.gapMs) {
      const n = Math.floor(-lead);
      if (n > 0) { this.inSilence = true; this.emitPcm(Buffer.alloc(n * BPS), false); }
    }
  }

  beginDiscard() {
    this.discarding = true;
    this.stats.dropped += this.queued / BPS;
    this.queue = [];
    this.queued = 0;
    this.reanchor();
    if (this.readerPaused) this.src.resume();   // keep draining the pipe while discarding
  }

  endDiscard() {
    this.discarding = false;
    this.inSilence = true;      // the next real audio marks the new generation's start
    this.reanchor();            // lead = 0, so the new audio can burst into the phone's buffer
  }
}

// The source the settings ask for: the FIFO path (Linux, as always) or the named-pipe server (Windows).
function sourceFor(cfg) {
  if (cfg.pcmSource === 'pipe-server') return new PipeServerSource(cfg.pcmPipe, { pipeBytes: cfg.pcmPipeBytes });
  return cfg.fifo;
}

module.exports = { PcmClock, FifoSource, PipeServerSource, sourceFor, RATE, BPS };
