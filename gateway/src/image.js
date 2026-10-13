'use strict';
// Covers for the phone: GET /v1/img/<token>?s=88|216|640 -> a JPEG.
// The phone can't rely on iOS 6's TLS against modern CDNs, so covers come through the gateway over the same signed
// link, already at the size a cell draws (no decoding of 640 px originals on an A6 just to show 44 pt).
//  - Tokens: 40 hex = https://i.scdn.co/image/<hex>; 'u' + base64url(URL) = any other Spotify image host. The phone
//    never sees a CDN URL; every URL is re-checked against the host allowlist (and so is where a redirect lands).
//  - 88/216: square centre crops, made together by one ffmpeg run from the 300 px variant. 640: the 640 px variant,
//    passed through untouched when it is a JPEG of at most 400 KB, else converted (never upscaled).
//  - Disk cache under cache/img (512 MB, oldest out first) with a 40 MB memory LRU in front. i.scdn.co files never
//    change (the URL names the file); other hosts can swap the picture behind a URL, so their files live 7 days.
//  - ffmpeg runs niced (below-normal priority on Windows), one thread, never while a generation starts.
//  - Warming (made before the phone asks; nothing logged per picture): two low-priority lanes that run only while no
//    phone request is being made and no generation starts, at most 2 jobs at once and one ffmpeg run at a time (its
//    own semaphore, whichever size group the run is for).
//    The queue lane (warmQueue; CoverWarm below) holds the covers around the playing song (640 + 88/216 each), replaced
//    on every song change; it goes first, 0.5 s after a generation started. The list lane (prewarm) holds the first
//    rows of a list the phone opened (88/216, at the front; a search's rows replace the previous search's still
//    waiting) and the playlist covers, 5 s after a generation.
//  - Every answer carries an ETag (a hash of its bytes; If-None-Match -> 304) and a long Cache-Control. Only a client
//    that sends If-None-Match gets a 304: the app (1.0.0) never does (its own cover cache answers instead), so this
//    saves it nothing.
// GET /v1/image?u=<URL> (app 0.4) still works: the original bytes, or a size when s= is given.
// Jams (DESIGN-4b.md §4.7, §4.8): members' Facebook-hosted pictures are allowed (their URLs expire: a dead one is
// image_gone and the app draws initials), and a Spotify Code (scannables.scdn.co) is passed through as the same PNG
// bytes for any s (a JPEG would blur the bars), at most 64 KB, cached 7 days.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const log = require('./log');
const { t } = require('./i18n');
const { renameRetry } = require('./fsutil');

const HOST_OK = /(^|\.)(scdn\.co|spotifycdn\.com|fbcdn\.net)$|^platform-lookaside\.fbsbx\.com$/i;
const CODE_HOST = 'scannables.scdn.co';
const CODE_BYTES = 64 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;        // a source bigger than this is not a cover
const MEM_BYTES = 40 * 1024 * 1024;
const PASS_BYTES = 400 * 1024;            // a 640 JPEG up to this size goes to the phone as it is
const U_TTL_MS = 7 * 86400000;
const NEG_MS = 10 * 60000;
const TOUCH_MS = 3600000;                 // a hit refreshes an i.scdn.co file's mtime at most this often
const SIZES = [88, 216, 640];
const WARM_MAX = 2;                       // warming jobs at once (both lanes), of them at most one 'small' (ffmpeg)
const WARM_HOLD_MS = 500;                 // the queue lane: this long after a generation started (its audio burst first)
const LIST_HOLD_MS = 5000;                // the list lane: this long after a generation began
const PQ_MAX = 500;
const WQ_MAX = 16;
// i.scdn.co ids are a 16-hex size prefix + a 24-hex file id; these families come in several sizes
const FAMILIES = [
  { big: 'ab67616d0000b273', small: 'ab67616d00001e02', tiny: 'ab67616d00004851' },   // album: 640 / 300 / 64
  { big: 'ab6761610000e5eb', small: 'ab67616100005174', tiny: 'ab6761610000f178' },   // artist: 640 / 320 / 160
];
const SMALL_FILTER = '[0:v]scale=216:216:force_original_aspect_ratio=increase:flags=lanczos,crop=216:216,split=2[a][b];[b]scale=88:88:flags=lanczos[c]';
const BIG_FILTER = 'scale=\'min(640,iw)\':\'min(640,ih)\':force_original_aspect_ratio=decrease:flags=lanczos';

const fail = (status, code, message, extra) => Object.assign(new Error(message), { status, code }, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the request's If-None-Match names this ETag (or *): the phone's copy is current
function notModified(req, etag) {
  const inm = req && req.headers && req.headers['if-none-match'];
  if (typeof inm !== 'string' || !inm) return false;
  return inm.split(',').some((x) => { const v = x.trim(); return v === '*' || v.replace(/^W\//, '') === etag; });
}

function hostOk(url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  return u.protocol === 'https:' && HOST_OK.test(u.hostname);
}

// URL -> token ('' when it isn't a Spotify image URL we may fetch)
function tokenFor(url) {
  if (typeof url !== 'string' || !url) return '';
  const m = url.match(/^https:\/\/i\.scdn\.co\/image\/([0-9a-f]{40})$/);
  if (m) return m[1];
  if (!hostOk(url)) return '';
  const t = 'u' + Buffer.from(url).toString('base64url');
  return t.length <= 600 ? t : '';
}

// token -> URL, re-checked (null = not a token of ours)
function urlFor(token) {
  if (/^[0-9a-f]{40}$/.test(token)) return 'https://i.scdn.co/image/' + token;
  if (!/^u[A-Za-z0-9_-]{8,599}$/.test(token)) return null;
  const url = Buffer.from(token.slice(1), 'base64url').toString();
  return hostOk(url) ? url : null;
}

// The source for a size group: 'small' (88/216) wants the 300/320 variant, 'big' the 640 one.
function variantUrl(url, big) {
  let m = url.match(/^https:\/\/i\.scdn\.co\/image\/([0-9a-f]{16})([0-9a-f]{24})$/);
  if (m) {
    const f = FAMILIES.find((x) => m[1] === x.big || m[1] === x.small || m[1] === x.tiny);
    return f ? 'https://i.scdn.co/image/' + (big ? f.big : f.small) + m[2] : url;
  }
  m = url.match(/^https:\/\/mosaic\.scdn\.co\/(\d+)\/(.+)$/);
  if (m) return `https://mosaic.scdn.co/${big ? 640 : 300}/${m[2]}`;
  return url;
}

// s -> 88 | 216 | 640 (nearest); missing, empty or not a number: 640, the uncropped one
function snap(s) {
  if (s == null || s === '') return 640;
  const n = Number(s);
  if (!Number.isFinite(n)) return 640;
  return SIZES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const isPng = (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;
const isCode = (url) => { try { return new URL(url).hostname.toLowerCase() === CODE_HOST; } catch (e) { return false; } };

// A JPEG's pixel size from its first SOF marker, or null.
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
// The 640 a phone gets as it is: a JPEG no bigger than 640 px each way (some artist pictures are 1000x675 originals)
const passable = (b) => { if (!isJpeg(b) || b.length > PASS_BYTES) return false; const d = jpegSize(b); return !!d && d.w <= 640 && d.h <= 640; };

// A tiny semaphore. Phone jobs are served newest first (the cell on screen now), background jobs after them in order.
class Sem {
  constructor(n) { this.n = n; this.busy = 0; this.q = []; }
  take(phone) {
    if (this.busy < this.n) { this.busy++; return Promise.resolve(); }
    return new Promise((resolve) => this.q.push({ resolve, phone }));
  }
  give() {
    let i = -1;
    for (let k = this.q.length - 1; k >= 0; k--) if (this.q[k].phone) { i = k; break; }
    if (i < 0 && this.q.length) i = 0;
    if (i < 0) { this.busy--; return; }
    this.q.splice(i, 1)[0].resolve();
  }
}

class Images {
  constructor(cfg, player) {
    this.dir = path.join(cfg.cacheDir, 'img');
    this.tmp = path.join(this.dir, 'tmp');
    this.ffmpeg = cfg.ffmpeg || 'ffmpeg';
    this.capBytes = (cfg.imageDiskMB || 512) * 1024 * 1024;
    this.player = player;
    this.fetch = (...a) => fetch(...a);
    this.mem = new Map();          // `${token}@${s}` -> { buf, type }
    this.memBytes = 0;
    this.neg = new Map();          // token -> until (an upstream 403/404)
    this.flight = new Map();       // `${token}:${group}` -> Promise (download + resize, once per source)
    this.fetchSem = new Sem(4);
    this.ffSem = new Sem(2);
    this.warmFfSem = new Sem(1);   // warming's ffmpeg runs (phone: false), one at a time, 'big' and 'small' alike
    this.phoneJobs = 0;
    this.pq = [];                  // list lane: { token, group: 'small', tag } (a list's first rows at the front, playlist covers)
    this.pset = new Set();         // `${token}:${group}` waiting in the list lane
    this.wq = [];                  // queue lane: { token, group } around the playing song (warmQueue replaces it)
    this.warmBusy = 0;             // warming jobs running (both lanes)
    this.warmSmall = 0;            // ... of them 'small' (an ffmpeg run)
    this.warmTimer = null;
    this.coverWarm = null;         // the CoverWarm (main.js sets it): its counters go into info()
    this.etags = new WeakMap();    // Buffer -> its ETag
    this.genAt = 0;                // a generation began (player 'gen')
    this.genStartAt = 0;           // ... its audio started (player 'genStart')
    this.stats = { hits: 0, misses: 0, cdn: 0, ffmpeg: 0, lastFfmpegMs: null, prewarmed: 0, warmedQueue: 0, notModified: 0 };
    this.disk = null;              // { bytes, files } once the background index ran
    fs.mkdirSync(this.tmp, { recursive: true });
    fsp.readdir(this.tmp).then((l) => Promise.all(l.map((f) => fsp.unlink(path.join(this.tmp, f)).catch(() => {})))).catch(() => {});
    if (player && player.on) {
      player.on('gen', () => { this.genAt = Date.now(); });
      player.on('genStart', () => { this.genStartAt = Date.now(); });
    }
    setTimeout(() => this.scan(), 30000).unref();
    setInterval(() => this.scan(), 3600000).unref();
  }

  file(token, s, ext = 'jpg') {
    const h = crypto.createHash('sha1').update(token).digest('hex');
    return path.join(this.dir, h.slice(0, 2), `${h}.${s}.${ext}`);
  }

  remember(key, entry) {
    const old = this.mem.get(key);
    if (old) { this.mem.delete(key); this.memBytes -= old.buf.length; }
    this.mem.set(key, entry);
    this.memBytes += entry.buf.length;
    for (const [k, v] of this.mem) {
      if (this.memBytes <= MEM_BYTES) break;
      this.mem.delete(k);
      this.memBytes -= v.buf.length;
    }
  }

  recall(key) {
    const e = this.mem.get(key);
    if (e) { this.mem.delete(key); this.mem.set(key, e); }
    return e;
  }

  // ------------------------------------------------------------------ the phone's routes
  etagOf(buf) {
    let e = this.etags.get(buf);
    if (!e) { e = '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"'; this.etags.set(buf, e); }
    return e;
  }

  // 200 with the bytes, or 304 when the phone's If-None-Match names them (same ETag and Cache-Control either way)
  reply(req, res, buf, type, cacheControl) {
    const h = { 'Content-Type': type, 'Cache-Control': cacheControl, ETag: this.etagOf(buf) };
    if (notModified(req, h.ETag)) { this.stats.notModified++; res.writeHead(304, h); return res.end(); }
    res.writeHead(200, { ...h, 'Content-Length': buf.length });
    res.end(buf);
  }

  async serve(req, res, token, s) {
    const url = urlFor(token);
    if (!url) throw fail(400, 'bad_request', t('en', 'That isn\'t an image token.'));
    if (isCode(url)) return this.reply(req, res, await this.code(token, url), 'image/png', 'private, max-age=604800');
    const size = snap(s);
    const buf = await this.get(token, size, url, true);
    this.reply(req, res, buf, 'image/jpeg', token[0] === 'u' ? 'private, max-age=604800' : 'private, max-age=31536000, immutable');
  }

  // GET /v1/image?u=<URL>: app 0.4's cover route. No s: the original bytes, as before.
  async serveLegacy(req, res, url) {
    const u = url.searchParams.get('u') || '';
    const token = tokenFor(u);
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'bad_image_url' } }));
    }
    if (url.searchParams.has('s')) return this.serve(req, res, token, url.searchParams.get('s'));
    const key = token + '@orig';
    let e = this.recall(key);
    if (!e) {
      if ((this.neg.get(token) || 0) > Date.now()) throw fail(404, 'image_gone', t('en', 'This picture is gone.'));
      let p = this.flight.get(token + ':orig');
      if (!p) {
        p = this.download(u, true).finally(() => this.flight.delete(token + ':orig'));
        this.flight.set(token + ':orig', p);
      }
      try { e = await p; } catch (err) { if (err.gone) this.neg.set(token, Date.now() + NEG_MS); throw err; }
      this.remember(key, { ...e, at: Date.now() });
    }
    this.reply(req, res, e.buf, e.type, 'private, max-age=86400');
  }

  // ------------------------------------------------------------------ a Spotify Code: the CDN's PNG, unchanged
  async code(token, url) {
    const key = token + '@png';
    const e = this.recall(key);
    if (e && Date.now() - e.at <= U_TTL_MS) { this.stats.hits++; return e.buf; }
    if ((this.neg.get(token) || 0) > Date.now()) throw fail(404, 'image_gone', t('en', 'This picture is gone.'));
    const f = this.file(token, 'code', 'png');
    try {
      const st = await fsp.stat(f);
      if (Date.now() - st.mtimeMs <= U_TTL_MS) {
        const buf = await fsp.readFile(f);
        if (isPng(buf)) { this.remember(key, { buf, type: 'image/png', at: st.mtimeMs }); this.stats.hits++; return buf; }
      }
    } catch (err) { /* not on disk */ }
    this.stats.misses++;
    let p = this.flight.get(token + ':code');
    if (!p) {
      p = (async () => {
        let dl;
        // a refused width (any 4xx) is gone: the app hides the code row
        try { dl = await this.download(url, true, { gone4xx: true }); }
        catch (err) { if (err.gone) this.neg.set(token, Date.now() + NEG_MS); throw err; }
        if (!isPng(dl.buf) || dl.buf.length > CODE_BYTES) throw fail(502, 'image_upstream', t('en', 'The Spotify Code isn\'t a small PNG.'));
        await fsp.mkdir(path.dirname(f), { recursive: true });
        const tmp = path.join(this.tmp, crypto.randomBytes(6).toString('hex') + '.png');
        await fsp.writeFile(tmp, dl.buf);
        await renameRetry(tmp, f);
        this.remember(key, { buf: dl.buf, type: 'image/png', at: Date.now() });
        return dl.buf;
      })().finally(() => this.flight.delete(token + ':code'));
      this.flight.set(token + ':code', p);
    }
    return p;
  }

  // ------------------------------------------------------------------ lookup: memory, disk, then make it
  async get(token, s, url, phone) {
    const key = `${token}@${s}`;
    let e = this.recall(key);
    if (e && token[0] === 'u' && Date.now() - e.at > U_TTL_MS) e = null;   // other hosts: 7 days, in memory too
    if (e) { this.stats.hits++; return e.buf; }
    if ((this.neg.get(token) || 0) > Date.now()) throw fail(404, 'image_gone', t('en', 'This picture is gone.'));
    const buf = await this.fromDisk(token, s);
    if (buf) { this.stats.hits++; return buf; }
    this.stats.misses++;
    await this.make(token, url, s === 640 ? 'big' : 'small', phone);
    e = this.recall(key);
    if (e) return e.buf;
    const again = await this.fromDisk(token, s);
    if (again) return again;
    throw fail(502, 'image_upstream', t('en', 'The picture couldn\'t be made.'));
  }

  async fromDisk(token, s) {
    const f = this.file(token, s);
    let st;
    try { st = await fsp.stat(f); } catch (e) { return null; }
    const age = Date.now() - st.mtimeMs;
    if (token[0] === 'u' && age > U_TTL_MS) return null;                 // other hosts: fetched again after 7 days
    let buf;
    try { buf = await fsp.readFile(f); } catch (e) { return null; }
    this.remember(`${token}@${s}`, { buf, type: 'image/jpeg', at: st.mtimeMs });
    if (token[0] !== 'u' && age > TOUCH_MS) fsp.utimes(f, new Date(), new Date()).catch(() => {});   // LRU by mtime
    return buf;
  }

  async exists(token, s) {
    try {
      const st = await fsp.stat(this.file(token, s));
      return !(token[0] === 'u' && Date.now() - st.mtimeMs > U_TTL_MS);
    } catch (e) { return false; }
  }

  // Download + resize, once per (token, size group) at a time.
  make(token, url, group, phone) {
    const k = `${token}:${group}`;
    let p = this.flight.get(k);
    if (!p) {
      p = this.produce(token, url, group, phone).finally(() => this.flight.delete(k));
      this.flight.set(k, p);
    }
    return p;
  }

  async produce(token, url, group, phone) {
    if (phone) this.phoneJobs++;
    try {
      const src = variantUrl(url, group === 'big');
      let dl;
      try { dl = await this.download(src, phone); }
      catch (e) {
        if (!(e.gone && src !== url)) throw e;
        dl = await this.download(url, phone);                         // the variant isn't there: the token's own URL
      }
      if (group === 'big' && passable(dl.buf)) {
        await this.store(token, 640, dl.buf);
        return;
      }
      await this.resize(token, dl.buf, group, phone);
    } catch (e) {
      if (e.gone) { this.neg.set(token, Date.now() + NEG_MS); throw fail(404, 'image_gone', t('en', 'This picture is gone.')); }
      throw e;
    } finally {
      if (phone) this.phoneJobs--;
    }
  }

  async download(url, phone, { gone4xx = false } = {}) {
    await this.fetchSem.take(phone);
    try {
      this.stats.cdn++;
      let r;
      let buf;
      try {
        r = await this.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
        if (r.url && !hostOk(r.url)) throw fail(502, 'image_upstream', t('en', 'The image host redirected somewhere else.'));
        if (r.status === 403 || r.status === 404 || (gone4xx && r.status >= 400 && r.status < 500)) throw fail(404, 'image_gone', t('en', 'This picture is gone.'), { gone: true });
        if (!r.ok) throw fail(502, 'image_upstream', t('en', 'The image host said {status}.', { status: r.status }));
        buf = Buffer.from(await r.arrayBuffer());
      } catch (e) {
        if (e.status) throw e;
        throw fail(502, 'image_upstream', t('en', 'The image host didn\'t answer.'));
      }
      const type = (r.headers && r.headers.get && r.headers.get('content-type')) || 'image/jpeg';
      if (!/^image\//.test(type)) throw fail(502, 'image_upstream', 'not an image');
      if (buf.length > MAX_BYTES) throw fail(502, 'image_upstream', 'image too large');
      return { buf, type };
    } finally {
      this.fetchSem.give();
    }
  }

  // One ffmpeg run: 'small' makes 216 and 88 together, 'big' a JPEG fitted within 640 px (never upscaled).
  async resize(token, src, group, phone) {
    const id = crypto.randomBytes(6).toString('hex');
    const inFile = path.join(this.tmp, id + '.src');
    const outs = group === 'big' ? { 640: path.join(this.tmp, id + '.640.jpg') }
      : { 216: path.join(this.tmp, id + '.216.jpg'), 88: path.join(this.tmp, id + '.88.jpg') };
    const args = ['-v', 'error', '-nostdin', '-y', '-threads', '1', '-i', inFile];
    if (group === 'big') args.push('-vf', BIG_FILTER, '-frames:v', '1', '-q:v', '3', '-pix_fmt', 'yuvj420p', outs[640]);
    else {
      args.push('-filter_complex', SMALL_FILTER, '-map', '[a]', '-frames:v', '1', '-q:v', '3', '-pix_fmt', 'yuvj420p', outs[216],
        '-map', '[c]', '-frames:v', '1', '-q:v', '3', '-pix_fmt', 'yuvj420p', outs[88]);
    }
    // the phone's runs: 2 at a time, newest first; warming's: one at a time, whichever size group (a 'big' source that
    // isn't passable is converted too)
    const sem = phone ? this.ffSem : this.warmFfSem;
    await sem.take(phone);
    try {
      // never while a generation is starting (the audio path gets the CPU first)
      for (let i = 0; i < 300 && this.player && this.player.pending; i++) await sleep(50);
      await fsp.writeFile(inFile, src);
      const t0 = Date.now();
      await this.run(args);
      this.stats.ffmpeg++;
      this.stats.lastFfmpegMs = Date.now() - t0;
      for (const [s, f] of Object.entries(outs)) {
        const buf = await fsp.readFile(f);
        if (!isJpeg(buf)) throw fail(502, 'image_upstream', t('en', 'The picture couldn\'t be converted.'));
        await this.store(token, Number(s), buf, f);
      }
    } finally {
      sem.give();
      for (const f of [inFile, ...Object.values(outs)]) fsp.unlink(f).catch(() => {});
    }
  }

  run(args) {
    const go = (cmd, a, lower) => new Promise((resolve, reject) => {
      const child = execFile(cmd, a, { timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { err.stderr = String(stderr || '').trim().split('\n')[0]; reject(err); } else resolve();
      });
      // Windows has no nice: the same idea through the process priority (the audio path gets the CPU first)
      if (lower && child.pid) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* it already ended */ } }
    });
    if (process.platform === 'win32') {
      return go(this.ffmpeg, args, true).catch((e) => {
        log.warn('ffmpeg (cover):', e.killed ? 'timed out' : (e.stderr || e.code || e.message));
        throw fail(502, 'image_upstream', t('en', 'The picture couldn\'t be converted.'));
      });
    }
    return go('nice', ['-n', '10', this.ffmpeg, ...args]).catch((e) => {
      if (e.code === 'ENOENT' && e.path === 'nice') return go(this.ffmpeg, args);       // no nice here: run it plain
      log.warn('ffmpeg (cover):', e.killed ? 'timed out' : (e.stderr || e.message));
      throw fail(502, 'image_upstream', t('en', 'The picture couldn\'t be converted.'));
    });
  }

  // Into the disk cache (tmp file + rename) and memory.
  async store(token, s, buf, tmpFile) {
    const f = this.file(token, s);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    let from = tmpFile;
    if (!from) { from = path.join(this.tmp, crypto.randomBytes(6).toString('hex') + `.${s}.jpg`); await fsp.writeFile(from, buf); }
    await renameRetry(from, f);      // Windows: retried while a scanner holds the old file for a moment
    this.remember(`${token}@${s}`, { buf, type: 'image/jpeg', at: Date.now() });
    if (this.disk) {
      this.disk.bytes += buf.length;
      this.disk.files++;
      if (this.disk.bytes > this.capBytes && !this.scanning) this.scan();
    }
  }

  // ------------------------------------------------------------------ warming (made before the phone asks)
  // A token the lanes may warm: one of ours, not a Spotify Code (those are the PNG route's)
  warmable(t) { const u = typeof t === 'string' && t ? urlFor(t) : null; return !!u && !isCode(u); }

  // The list lane, 88/216: the playlist covers (at the back), or with first a list's first rows (at the front, in
  // their order: the list the phone opened last goes first). With tag, the rows still waiting from the last call with
  // that tag are dropped first: a search typed further (the app searches after each 380 ms pause) makes the results
  // of the one before stale.
  prewarm(tokens, { first = false, tag = null } = {}) {
    if (tag) {
      this.pq = this.pq.filter((j) => {
        if (j.tag !== tag) return true;
        this.pset.delete(`${j.token}:${j.group}`);
        return false;
      });
    }
    const add = [];
    const seen = new Set();
    for (const t of tokens || []) {
      if (!this.warmable(t) || seen.has(t)) continue;
      seen.add(t);
      const k = `${t}:small`;
      if (this.pset.has(k)) {                                  // waiting already (or running: not in pq)
        const i = first ? this.pq.findIndex((j) => j.token === t) : -1;
        if (i >= 0) add.push(this.pq.splice(i, 1)[0]);         // further back: moved up with this list
        continue;
      }
      if (!first && this.pq.length + add.length >= PQ_MAX) continue;
      this.pset.add(k);
      add.push({ token: t, group: 'small', tag });
    }
    if (first) {
      this.pq.unshift(...add);
      while (this.pq.length > PQ_MAX) this.pset.delete(`${this.pq.pop().token}:small`);
    } else this.pq.push(...add);
    this.pumpWarm();
  }

  // The queue lane: the covers around the playing song, in order (CoverWarm), each at 640 (Now Playing, the lock
  // screen) and 88/216 (the mini player, Up Next, list rows). Replaces what was waiting: that window is stale.
  warmQueue(tokens) {
    const q = [];
    for (const t of tokens || []) {
      if (!this.warmable(t) || q.some((j) => j.token === t)) continue;
      q.push({ token: t, group: 'big' }, { token: t, group: 'small' });
    }
    this.wq = q.slice(0, WQ_MAX);
    this.pumpWarm();
    return this.wq.length;
  }

  // The next job, or null: the queue lane first (0.5 s after a generation started), then the list lane (5 s after a
  // generation began). Never while a phone request is being made or a generation starts; one ffmpeg run at a time.
  nextWarm() {
    if (this.phoneJobs > 0 || (this.player && this.player.pending)) return null;
    const now = Date.now();
    const pick = (q) => {
      const i = q.findIndex((j) => j.group === 'big' || this.warmSmall === 0);
      return i < 0 ? null : q.splice(i, 1)[0];
    };
    if (this.wq.length && now - Math.max(this.genAt, this.genStartAt) >= WARM_HOLD_MS) {
      const j = pick(this.wq);
      if (j) return { ...j, lane: 'queue' };
    }
    if (this.pq.length && now - this.genAt >= LIST_HOLD_MS) {
      const j = pick(this.pq);
      if (j) return { ...j, lane: 'list' };
    }
    return null;
  }

  pumpWarm() {
    while (this.warmBusy < WARM_MAX) {
      const job = this.nextWarm();
      if (!job) break;
      this.runWarm(job);
    }
    // held back (a phone request, a generation, the hold): look again shortly; a job that ends looks again too
    if ((this.wq.length || this.pq.length) && this.warmBusy < WARM_MAX && !this.warmTimer) {
      this.warmTimer = setTimeout(() => { this.warmTimer = null; this.pumpWarm(); }, this.wq.length ? 250 : 1000);
      if (this.warmTimer.unref) this.warmTimer.unref();
    }
  }

  async runWarm({ token, group, lane }) {
    this.warmBusy++;
    if (group === 'small') this.warmSmall++;
    try {
      const s = group === 'big' ? 640 : 88;
      // gone, being made (a phone request: it gets there itself), or there already: nothing to do
      if ((this.neg.get(token) || 0) <= Date.now() && !this.flight.has(`${token}:${group}`) && !(await this.exists(token, s))) {
        await this.make(token, urlFor(token), group, false);
        if (lane === 'queue') this.stats.warmedQueue++; else this.stats.prewarmed++;
      }
    } catch (e) { /* the phone asks again if it needs it */ }
    finally {
      if (lane === 'list') this.pset.delete(`${token}:${group}`);
      this.warmBusy--;
      if (group === 'small') this.warmSmall--;
      if (this.wq.length || this.pq.length) setImmediate(() => this.pumpWarm());
    }
  }

  // ------------------------------------------------------------------ disk index + eviction
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const files = [];
      for (const d of await fsp.readdir(this.dir).catch(() => [])) {
        if (d === 'tmp' || d.length !== 2) continue;
        for (const f of await fsp.readdir(path.join(this.dir, d)).catch(() => [])) {
          const p = path.join(this.dir, d, f);
          try { const st = await fsp.stat(p); files.push({ p, size: st.size, mtime: st.mtimeMs }); } catch (e) { /* gone */ }
        }
      }
      let bytes = files.reduce((n, f) => n + f.size, 0);
      let count = files.length;
      if (bytes > this.capBytes) {
        const goal = this.capBytes * 460 / 512;
        files.sort((a, b) => a.mtime - b.mtime);
        let removed = 0;
        for (const f of files) {
          if (bytes <= goal) break;
          try { await fsp.unlink(f.p); bytes -= f.size; count--; removed++; } catch (e) { /* gone */ }
        }
        log.info(`image cache over ${Math.round(this.capBytes / 1048576)} MB: removed ${removed} old files`);
      }
      this.disk = { bytes, files: count };
    } finally {
      this.scanning = false;
    }
  }

  async flush() {
    this.mem.clear();
    this.memBytes = 0;
    this.neg.clear();
    this.pq = [];
    this.pset.clear();
    this.wq = [];
    for (const d of await fsp.readdir(this.dir).catch(() => [])) {
      if (d !== 'tmp') await fsp.rm(path.join(this.dir, d), { recursive: true, force: true }).catch(() => {});
    }
    this.disk = { bytes: 0, files: 0 };
  }

  info() {
    const now = Date.now();
    let neg = 0;
    for (const [k, t] of this.neg) { if (t > now) neg++; else this.neg.delete(k); }
    const out = { mem_bytes: this.memBytes, mem_items: this.mem.size, disk_bytes: this.disk ? this.disk.bytes : null, disk_files: this.disk ? this.disk.files : null,
      queued: this.pq.length + this.wq.length + this.fetchSem.q.length + this.ffSem.q.length, running: this.flight.size, phone_jobs: this.phoneJobs,
      negatives: neg, hits: this.stats.hits, misses: this.stats.misses, cdn_fetches: this.stats.cdn, ffmpeg_runs: this.stats.ffmpeg,
      last_ffmpeg_ms: this.stats.lastFfmpegMs, prewarmed: this.stats.prewarmed,
      // warming: waiting per lane, running, made by the queue lane (prewarmed: by the list lane), 304s sent
      warm_queue: this.wq.length, warm_list: this.pq.length, warm_running: this.warmBusy, warmed_queue: this.stats.warmedQueue,
      not_modified: this.stats.notModified };
    if (this.coverWarm) out.cover_warm = this.coverWarm.info();      // main.js sets it
    return out;
  }
}

// ------------------------------------------------------------------ the covers around the playing song (1.1.x speed)
// On every song change the bridge warms the covers of the next 2 songs, the one before and the current one, at the
// sizes the phone asks for them (640: Now Playing and the lock screen; 88/216: the mini player, Up Next, list rows). A
// skip then finds its cover in the bridge's cache instead of waiting on the CDN (65-320 ms) and ffmpeg (~120 ms).
//  - The songs come from what the bridge already knows: the engine's /player/queue (local; asking fetches nothing,
//    and an entry whose metadata the engine hasn't fetched yet has no cover: one more look 1.5 s later), its
//    /status next_track for an engine without the queue route, and the player's previous song.
//  - Images.warmQueue does the work on its queue lane (above). Nothing is sent to the phone and nothing is logged.
//  - Only while a phone was seen in the last 10 minutes (nobody to show a cover to otherwise).
const WARM_TIMING = {
  debounceMs: 300,           // after a song change / a generation start (a burst of skips: once where it landed)
  retryMs: 1500,             // a next entry without metadata yet: one more look (the engine fetches the window's after 1 s)
  queueTimeout: 2000,
  phoneRecent: 600000,
};
const songOf = (t) => (t ? `${t.uri || ''}|${t.img || ''}` : '');

class CoverWarm {
  constructor({ player, engine, images, timing }) {
    Object.assign(this, { player, engine, images });
    this.T = { ...WARM_TIMING, ...timing };
    this.timer = null;
    this.running = false;
    this.again = false;
    this.last = '';               // the window last handed to images (song + tokens)
    this.retried = '';            // the song whose one extra look was used
    this.noQueue = false;         // the engine has no /player/queue (stock): next_track only
    this.stats = { windows: 0, looks: 0, errors: 0 };
    if (player && player.on) {
      player.on('track', () => this.kick());
      player.on('genStart', () => this.kick());
    }
    if (engine && engine.on) engine.on('connected', () => { this.noQueue = false; });   // maybe another engine now
  }

  kick(ms = this.T.debounceMs) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.run(); }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  async run() {
    if (this.running) { this.again = true; return; }
    const p = this.player;
    if (p.pending) return;                                             // its genStart kicks again
    const cur = p.st && p.st.track;
    if (!cur || !(Date.now() - (p.lastPhone || 0) < this.T.phoneRecent)) return;
    this.running = true;
    try {
      const song = songOf(cur);
      this.stats.looks++;
      const { next, missing } = await this.upcoming();
      if (p.pending || songOf(p.st.track) !== song) return;           // moved on meanwhile: that change kicks again
      const tokens = [];
      for (const t of [next[0], next[1], p.prevTrack && p.prevTrack.img, cur.img]) if (t && !tokens.includes(t)) tokens.push(t);
      const sig = song + '>' + tokens.join(',');
      if (tokens.length && sig !== this.last) {
        this.last = sig;
        this.stats.windows++;
        this.images.warmQueue(tokens);
      }
      if (missing && this.retried !== song) { this.retried = song; this.kick(this.T.retryMs); }
    } catch (e) {
      this.stats.errors++;                                             // best effort: the phone asks for what it needs
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.kick(); }
    }
  }

  // -> { next: [token of the song after this one, of the one after that] ('' = no cover known), missing: an entry
  // without metadata yet }. engine.get never emits anything (engine.refresh would publish a snapshot to the phone).
  async upcoming() {
    if (!this.noQueue) {
      try {
        const r = await this.engine.get('/player/queue', { timeoutMs: this.T.queueTimeout });
        if (r.status === 200 && r.json && Array.isArray(r.json.next)) {
          const two = r.json.next.slice(0, 2);
          return { next: two.map((e) => (e && e.track ? tokenFor(e.track.album_cover_url) : '')),
            missing: two.some((e) => e && typeof e.uri === 'string' && !e.track) };
        }
        if (r.status === 404) this.noQueue = true;
        else return { next: [], missing: false };                      // 204: no session
      } catch (e) {
        this.stats.errors++;
      }
    }
    try {
      const r = await this.engine.get('/status', { timeoutMs: this.T.queueTimeout });
      const nt = r.status === 200 && r.json && r.json.next_track;
      return { next: [nt ? tokenFor(nt.album_cover_url) : ''], missing: false };
    } catch (e) {
      return { next: [], missing: false };
    }
  }

  info() {
    return { windows: this.stats.windows, looks: this.stats.looks, errors: this.stats.errors, queue_route: !this.noQueue };
  }
}

module.exports = { Images, CoverWarm, tokenFor, urlFor, variantUrl, snap, hostOk };
