'use strict';
// One ffmpeg AAC-LC encoder per quality tier. PCM in, ADTS frames out, kept in a ring for (re)connecting phones.
// Frames are numbered globally: frame G carries stream samples [G*1024, (G+1)*1024) in every tier. Each encoder starts
// on that grid (startSample is a multiple of 1024 and it is fed from there on); its own AAC frame n carries samples
// [(n-1)*1024, n*1024) of its input (the native encoder adds 1024 samples of priming), so n is global frame
// startSample/1024 + n - 1, and frame 0 (the priming) is never kept. Frame G of any tier holds the same audio, so a
// phone can switch tiers between two frames.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { BPS } = require('./pcm');
const log = require('./log');

const SPF = 1024;

class TierEncoder extends EventEmitter {
  constructor(name, kbps, startSample, ringFrames, ffmpeg) {
    super();
    Object.assign(this, { name, kbps, startSample, ringFrames, ffmpeg });
    this.frames = [];
    this.first = startSample / SPF;   // global index of frames[0]
    this.next = this.first;           // global index the next frame will get
    this.primed = false;              // ffmpeg's first frame (the priming) has gone by
    this.pending = Buffer.alloc(0);
    this.listeners = 0;
    this.lastUsed = Date.now();
    this.dead = false;
    this.setMaxListeners(100);
  }

  start() {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
      '-c:a', 'aac', '-b:a', this.kbps + 'k', '-f', 'adts', '-flush_packets', '1', 'pipe:1'];
    this.proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });   // no console window on Windows
    this.proc.stdout.on('data', (d) => this.onOut(d));
    this.proc.stderr.on('data', (d) => log.warn(`ffmpeg[${this.name}]`, String(d).trim()));
    this.proc.stdin.on('error', () => {});
    this.proc.on('exit', (code) => { this.dead = true; log.warn(`encoder ${this.name} exited (${code})`); this.emit('dead'); });
    log.info(`encoder ${this.name} (${this.kbps} kbps AAC) started at sample ${this.startSample} (frame ${this.first})`);
  }

  // `start` = stream sample index of pcm[0]; only samples from startSample on are encoded
  write(pcm, start) {
    if (this.dead) return;
    const skip = this.startSample - start;
    if (skip > 0) {
      if (skip * BPS >= pcm.length) return;
      pcm = pcm.subarray(skip * BPS);
    }
    this.proc.stdin.write(pcm);
  }

  onOut(d) {
    let buf = this.pending.length ? Buffer.concat([this.pending, d]) : d;
    let off = 0;
    while (buf.length - off >= 7) {
      if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) { off++; continue; }   // resync on the ADTS syncword
      const len = ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | (buf[off + 5] >> 5);
      if (len < 7) { off++; continue; }
      if (buf.length - off < len) break;
      this.push(Buffer.from(buf.subarray(off, off + len)));
      off += len;
    }
    this.pending = Buffer.from(buf.subarray(off));
  }

  push(frame) {
    if (!this.primed) { this.primed = true; return; }
    this.frames.push(frame);
    this.next++;
    if (this.frames.length > this.ringFrames) { this.frames.shift(); this.first++; }
    this.emit('frame', this.next - 1);
  }

  get last() { return this.next - 1; }      // newest global frame (first - 1 while there is none)
  frame(g) { return g >= this.first && g < this.next ? this.frames[g - this.first] : null; }
  frameForSample(s) { return Math.floor(s / SPF); }
  sampleForFrame(g) { return g * SPF; }     // first stream sample frame g carries
  stop() { try { this.proc.kill(); } catch (e) { /* already gone */ } }
}

class Encoders {
  constructor(clock, cfg) {
    this.clock = clock;
    this.cfg = cfg;
    this.map = new Map();
    this.ringFrames = Math.ceil(cfg.ringSeconds * 44100 / SPF);
    clock.on('pcm', (buf, start) => { for (const e of this.map.values()) e.write(buf, start); });
    setInterval(() => this.reap(), 30000).unref();
  }

  get(name) {
    let e = this.map.get(name);
    if (!e || e.dead) {
      e = new TierEncoder(name, this.cfg.tiers[name], Math.ceil(this.clock.sample / SPF) * SPF, this.ringFrames, this.cfg.ffmpeg);
      e.start();
      this.map.set(name, e);
    }
    e.lastUsed = Date.now();
    return e;
  }

  // A phone is around or streaming: every tier runs, so a quality switch is just a reconnect at another tier from the
  // next frame.
  warmAll() { for (const name of Object.keys(this.cfg.tiers)) this.get(name); }

  reap() {   // stop tiers nobody has used for 10 minutes (the default tier always stays warm, all of them while anyone listens)
    const busy = this.listening() > 0;
    for (const [k, e] of this.map) {
      if (e.dead) { this.map.delete(k); continue; }
      if (busy) e.lastUsed = Date.now();
      else if (k !== this.cfg.defaultTier && Date.now() - e.lastUsed > 600000) {
        log.info(`encoder ${k} idle, stopping`);
        e.stop();
        this.map.delete(k);
      }
    }
  }

  listening() { let n = 0; for (const e of this.map.values()) n += e.listeners; return n; }

  info() {
    return [...this.map.values()].map((e) => ({ tier: e.name, kbps: e.kbps, frames: e.next, ring_from: e.first, listeners: e.listeners }));
  }
}

module.exports = { Encoders, SPF };
