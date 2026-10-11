'use strict';
// Who may use the admin page and pairing, and the admin password (1.1.0).
//  - ADMIN_ALLOW: the addresses that may reach /admin and POST /v1/pair, as a comma- or space-separated list of IPv4 /
//    IPv6 addresses and CIDR ranges. The word "private" stands for the default set: loopback, 10/8, 172.16/12,
//    192.168/16, 100.64/10 (carrier-grade NAT, used by VPN overlays such as Tailscale), IPv6 unique-local fc00::/7 and
//    link-local fe80::/10. Example: ADMIN_ALLOW=private,203.0.113.7. This computer (loopback) is always allowed.
//  - A request that carries a proxy header (Forwarded, X-Forwarded-For, X-Real-IP) is refused, because behind a proxy
//    the peer address says nothing about the real client. With ADMIN_TRUST_PROXY=1 it is let through when both the
//    proxy and the client it names (the last hop of the header) are allowed. Reverse proxies are not supported in 1.x.
//  - Wrong passwords are limited per address: MAX_FAILURES within FAIL_WINDOW_MS lock that address out for LOCK_MS.
//  - The password: ADMIN_PASSWORD from the environment wins, as before. Without it, a password chosen on the admin
//    page is kept as a salted scrypt hash in data/admin.json. Until one is chosen the admin page opens in setup mode,
//    which asks for the one-time setup code the bridge prints in its log at startup (a new code at every start). Where
//    `loopbackSetup` is on (the Windows tray opens the page on this computer), the page on this computer itself needs no
//    code: a loopback peer whose Host (and Origin, if any) is a loopback name, never a DNS-rebinding site's page.
//  - Parallel password checks are capped (MAX_VERIFY_PER_ADDR, MAX_VERIFY): a burst of guesses can't run hundreds of
//    scrypt hashes before the failure limit trips.
//  - POST /v1/pair only answers allowed addresses: its reply is the one message that carries a device's secret.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const log = require('./log');

const MAX_FAILURES = 10;
const FAIL_WINDOW_MS = 15 * 60000;
const LOCK_MS = 15 * 60000;
const MAX_TRACKED = 1000;                 // addresses with recent failures kept in memory (the oldest go first)
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const OK_CACHE_MS = 10 * 60000;           // a verified Authorization header skips scrypt for this long
const MAX_VERIFY_PER_ADDR = 2;            // password hashes running at once for one address (more get a 429, unhashed)
const MAX_VERIFY = 4;                     // ... and for every address together (each scrypt holds about 16 MB)
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
// the Host (and Origin) of a page opened on this computer itself, as the tray opens it (webapi.js's CALLBACK_HOST)
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';     // no 0/O, 1/I/L
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip'];
const PRIVATE = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const fail = (status, code, message, extra) => ({ ok: false, status, code, message, ...extra });

// '::ffff:192.168.1.20' -> '192.168.1.20'; '[::1]' -> '::1'; '' for anything that isn't an address
function normIp(ip) {
  let s = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const m = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (m) s = m[1];
  const z = s.indexOf('%');                                     // fe80::1%eth0: the zone isn't part of the address
  if (z > 0) s = s.slice(0, z);
  return net.isIP(s) ? s : '';
}

// Parses an allow list. Returns { list: net.BlockList, entries: [...], bad: [...] }.
function parseAllow(spec) {
  const list = new net.BlockList();
  const entries = [];
  const bad = [];
  const words = String(spec || '').split(/[\s,;]+/).filter(Boolean);
  const add = (w) => {
    const [addr, bits, extra] = w.split('/');
    const a = normIp(addr);
    if (!a || extra !== undefined) return false;
    const type = net.isIPv6(a) ? 'ipv6' : 'ipv4';
    const max = type === 'ipv6' ? 128 : 32;
    if (bits === undefined) { list.addAddress(a, type); entries.push(a); return true; }
    if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return false;
    list.addSubnet(a, Number(bits), type);
    entries.push(`${a}/${Number(bits)}`);
    return true;
  };
  for (const w of words.length ? words : ['private']) {
    if (w.toLowerCase() === 'private') { PRIVATE.forEach(add); continue; }
    if (!add(w)) bad.push(w);
  }
  return { list, entries, bad };
}

const DEFAULT = parseAllow('private');
const isPrivate = (ip) => { const a = normIp(ip); return !!a && DEFAULT.list.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4'); };
const isLoopback = (ip) => { const a = normIp(ip); return a === '::1' || a.startsWith('127.'); };

// The client a trusted proxy names: the last hop of Forwarded (for=), X-Forwarded-For or X-Real-IP; '' if unreadable.
function forwardedClient(h) {
  if (h.forwarded) {
    const last = String(h.forwarded).split(',').pop();
    const m = last.match(/(?:^|;)\s*for\s*=\s*("?)([^";]+)\1/i);
    if (!m) return '';
    let v = m[2].trim();
    if (v.startsWith('[')) v = v.slice(1, v.indexOf(']'));                 // "[2001:db8::1]:4711"
    else if (/^[\d.]+:\d+$/.test(v)) v = v.split(':')[0];                  // "192.0.2.1:4711"
    return normIp(v);
  }
  if (h['x-forwarded-for']) return normIp(String(h['x-forwarded-for']).split(',').pop());
  if (h['x-real-ip']) return normIp(h['x-real-ip']);
  return '';
}

function newSetupCode() {
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return s.replace(/(.{4})(?=.)/g, '$1-');                              // XXXX-XXXX-XXXX
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

class AdminAuth {
  // opts: cfg (dataDir, adminPassword, adminAllow, adminTrustProxy, adminSetupLoopback), now (tests), scrypt (tests)
  constructor({ cfg = {}, now = Date.now, scrypt } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.scryptOpts = { ...SCRYPT, ...scrypt };
    this.envPassword = cfg.adminPassword || '';
    this.trustProxy = !!cfg.adminTrustProxy;
    this.loopbackSetup = !!cfg.adminSetupLoopback;
    const a = parseAllow(cfg.adminAllow);
    this.allow = a.list;
    this.allowEntries = a.entries;
    this.allowBad = a.bad;
    this.allowFallback = !a.entries.length;
    if (this.allowFallback) {                                  // nothing usable: this computer only, never "everyone"
      this.allow = parseAllow('127.0.0.0/8,::1').list;
      this.allowEntries = ['127.0.0.0/8', '::1'];
    } else {                                                   // this computer itself is always allowed
      this.allow.addSubnet('127.0.0.0', 8, 'ipv4');
      this.allow.addAddress('::1', 'ipv6');
    }
    this.file = cfg.dataDir ? path.join(cfg.dataDir, 'admin.json') : null;
    this.stored = null;                                        // { kdf, N, r, p, salt, hash, set }
    this.storedError = null;
    this.load();
    this.setupCode = this.mode() === 'setup' ? newSetupCode() : null;
    this.failures = new Map();                                 // ip -> { at: [times], lockedUntil }
    this.okCache = new Map();                                  // sha256(Authorization) hex -> expiry
    this.verifying = new Map();                                // sha256(Authorization) hex -> its hash in progress
    this.inflight = new Map();                                 // address -> hashes running for it
    this.inflightAll = 0;
    this.counts = { refused: 0, proxied: 0, failures: 0, locked: 0, busy: 0 };
  }

  load() {
    if (this.envPassword || !this.file) return;
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { return; }      // no file: setup mode
    try {
      const j = JSON.parse(text);
      if (j && j.kdf === 'scrypt' && j.salt && j.hash && j.N && j.r && j.p) this.stored = j;
      else this.storedError = 'unknown format';
    } catch (e) { this.storedError = 'not JSON'; }
  }

  // 'env' (ADMIN_PASSWORD), 'stored' (data/admin.json) or 'setup' (no password yet)
  mode() { return this.envPassword ? 'env' : this.stored ? 'stored' : 'setup'; }

  // Logged once at startup by main.js.
  announce(port) {
    const nBad = this.allowBad.length;
    if (nBad) log.warn(`ADMIN_ALLOW: ignored ${nBad} ${nBad === 1 ? 'entry that isn\'t an address or range' : 'entries that aren\'t addresses or ranges'}`);
    if (this.allowFallback) log.warn('ADMIN_ALLOW has no usable entry: the admin page and pairing only answer this computer');
    else if (this.cfg.adminAllow) log.info(`ADMIN_ALLOW: the admin page and pairing answer ${this.allowEntries.length} address${this.allowEntries.length === 1 ? '' : 'es or ranges'}`);
    if (this.trustProxy) log.warn('ADMIN_TRUST_PROXY is on: proxy headers are believed (reverse proxies are not supported in this version)');
    const m = this.mode();
    if (m === 'env' && this.file && fs.existsSync(this.file)) log.info('ADMIN_PASSWORD is set: it is used, not the password saved on the admin page');
    if (m !== 'setup') return;
    if (this.storedError) log.warn(`data/admin.json can't be used (${this.storedError}): the admin page is in setup mode again`);
    log.warn(`no admin password yet: open http://<this computer's address>:${port}/admin and choose one with the setup code ${this.setupCode}` +
      ' (a new code at every start; or set ADMIN_PASSWORD)');
  }

  allowed(ip) {
    const a = normIp(ip);
    return !!a && this.allow.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4');
  }

  // The network gate for /admin and /v1/pair: null when the request may go on, else a refusal.
  gate(req) {
    const peer = normIp(req.socket && req.socket.remoteAddress);
    const h = req.headers || {};
    const proxied = PROXY_HEADERS.some((k) => h[k] != null);
    if (proxied) {
      if (!this.trustProxy) {
        this.counts.proxied++;
        return fail(403, 'proxied', 'The admin page and pairing don\'t work through a proxy. Open the bridge\'s own address on your home network.');
      }
      const client = forwardedClient(h);
      if (!this.allowed(peer) || !client || !this.allowed(client)) { this.counts.refused++; return fail(403, 'forbidden', 'Not from this address.'); }
      return null;
    }
    if (!this.allowed(peer)) { this.counts.refused++; return fail(403, 'forbidden', 'Not from this address.'); }
    return null;
  }

  // the address failures are counted against (the client a trusted proxy names, else the peer)
  key(req) {
    const h = req.headers || {};
    const peer = normIp(req.socket && req.socket.remoteAddress) || '?';
    return this.trustProxy && PROXY_HEADERS.some((k) => h[k] != null) ? (forwardedClient(h) || peer) : peer;
  }

  locked(req) {
    const f = this.failures.get(this.key(req));
    const now = this.now();
    if (f && f.lockedUntil > now) return fail(429, 'too_many_attempts', 'Too many wrong passwords. Try again later.', { retry_after: Math.ceil((f.lockedUntil - now) / 1000) });
    return null;
  }

  noteFailure(req) {
    const k = this.key(req);
    const now = this.now();
    let f = this.failures.get(k);
    if (!f) {
      if (this.failures.size >= MAX_TRACKED) this.failures.delete(this.failures.keys().next().value);
      f = { at: [], lockedUntil: 0 };
    } else this.failures.delete(k);                            // re-inserted below: the Map stays oldest-first
    f.at = f.at.filter((t) => now - t < FAIL_WINDOW_MS);
    f.at.push(now);
    this.counts.failures++;
    if (f.at.length >= MAX_FAILURES) {
      f.lockedUntil = now + LOCK_MS;
      f.at = [];
      this.counts.locked++;
      log.warn(`admin: ${MAX_FAILURES} wrong passwords from one address: it is locked out for ${LOCK_MS / 60000} min`);
    }
    this.failures.set(k, f);
  }

  // The password check for an admin request that passed gate(). {ok: true} or a refusal (401 asks for the password).
  // A stored password costs one scrypt (about 16 MB) per check, and a failure is only counted once its hash is done, so
  // a burst of parallel guesses would all hash before the lockout could trip: requests with the same header share one
  // hash (the admin page sends several at once), and only MAX_VERIFY_PER_ADDR (per address) / MAX_VERIFY (in all)
  // different ones hash at a time; the rest get a 429 at once, without hashing.
  async check(req) {
    const lock = this.locked(req);
    if (lock) return lock;
    if (this.mode() === 'setup') return fail(503, 'admin_setup', 'Choose an admin password on the admin page first.');
    const h = String((req.headers || {}).authorization || '');
    if (!h.startsWith('Basic ')) return fail(401, 'password_required', 'password required');
    const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
    let ok;
    let mine = true;                                           // this request ran the check (a shared one counts once)
    if (this.mode() === 'env') ok = same(pass, this.envPassword);
    else {
      const key = sha(h).toString('hex');
      const exp = this.okCache.get(key);
      if (exp && exp > this.now()) return { ok: true };
      let p = this.verifying.get(key);
      if (p) mine = false;
      else {
        const k = this.key(req);
        const n = this.inflight.get(k) || 0;
        if (n >= MAX_VERIFY_PER_ADDR || this.inflightAll >= MAX_VERIFY) {
          this.counts.busy++;
          return fail(429, 'too_many_attempts', 'Too many password checks at once. Try again in a moment.', { retry_after: 1 });
        }
        this.inflight.set(k, n + 1);
        this.inflightAll++;
        p = this.verifyStored(pass).finally(() => {
          this.verifying.delete(key);
          const left = (this.inflight.get(k) || 1) - 1;
          if (left > 0) this.inflight.set(k, left);
          else this.inflight.delete(k);
          this.inflightAll--;
        });
        this.verifying.set(key, p);
      }
      ok = await p;
      if (ok) {
        if (this.okCache.size >= 16) this.okCache.delete(this.okCache.keys().next().value);
        this.okCache.set(key, this.now() + OK_CACHE_MS);
      }
    }
    if (ok) return { ok: true };
    if (mine) this.noteFailure(req);
    return fail(401, 'password_required', 'wrong password');
  }

  async verifyStored(pass) {
    const s = this.stored;
    if (!s) return false;
    try {
      const want = Buffer.from(s.hash, 'base64');
      const got = await scrypt(pass, Buffer.from(s.salt, 'base64'), want.length, { N: s.N, r: s.r, p: s.p, maxmem: 128 * s.N * s.r * 2 });
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    } catch (e) { return false; }
  }

  // GET /admin/api/setup: what the page shows. Never the code itself.
  setupInfo(req) {
    const setup = this.mode() === 'setup';
    return { setup, code_needed: setup && !(this.loopbackSetup && this.loopbackPeer(req)), min_length: MIN_PASSWORD };
  }

  // The page the tray opened on this computer: a loopback peer with no proxy header, AND a loopback name in Host (and in
  // Origin when the browser sends one). A website that reaches 127.0.0.1 by DNS rebinding comes from loopback too, but
  // its Host and Origin carry its own name, so it still needs the setup code.
  loopbackPeer(req) {
    const h = req.headers || {};
    if (!isLoopback(req.socket && req.socket.remoteAddress) || PROXY_HEADERS.some((k) => h[k] != null)) return false;
    if (!LOOPBACK_HOST.test(String(h.host || ''))) return false;
    if (h.origin != null) {
      let host = '';
      try { host = new URL(String(h.origin)).host; } catch (e) { return false; }      // "null" and the like
      if (!LOOPBACK_HOST.test(host)) return false;
    }
    return true;
  }

  // POST /admin/api/setup {code, password}: chooses the password once. Throws {status, code, message}.
  async setup(req, b = {}) {
    const err = (status, code, message, extra) => Object.assign(new Error(message), { status, code }, extra);
    if (this.mode() !== 'setup') throw err(409, 'already_set', 'An admin password is already set.');
    const lock = this.locked(req);
    if (lock) throw err(429, lock.code, lock.message, { retry_after: lock.retry_after });
    if (!(this.loopbackSetup && this.loopbackPeer(req))) {
      const given = normCode(b.code);
      if (!given || !same(given, normCode(this.setupCode))) {
        this.noteFailure(req);
        throw err(403, 'bad_setup_code', 'That isn\'t the setup code from the bridge\'s log.');
      }
    }
    const pw = typeof b.password === 'string' ? b.password : '';
    if (pw.length < MIN_PASSWORD) throw err(400, 'weak_password', `Use at least ${MIN_PASSWORD} characters.`);
    if (pw.length > MAX_PASSWORD) throw err(400, 'weak_password', `Use at most ${MAX_PASSWORD} characters.`);
    if (!this.file) throw err(500, 'no_data_dir', 'The bridge has no data folder to keep the password in.');
    const salt = crypto.randomBytes(16);
    const o = this.scryptOpts;
    const hash = await scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 128 * o.N * o.r * 2 });
    const rec = { v: 1, kdf: 'scrypt', N: o.N, r: o.r, p: o.p, salt: salt.toString('base64'), hash: hash.toString('base64'), set: new Date(this.now()).toISOString() };
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.stored = rec;
    this.storedError = null;
    this.setupCode = null;                                     // one use
    this.okCache.clear();
    log.info('admin: the admin password was set on the admin page');
    return { ok: true };
  }

  // for /admin/api/status (counters only: never an address)
  info() {
    return { mode: this.mode(), allow: this.cfg.adminAllow ? 'custom' : 'private', trust_proxy: this.trustProxy, ...this.counts,
      locked_now: [...this.failures.values()].filter((f) => f.lockedUntil > this.now()).length };
  }
}

function scrypt(pw, salt, len, opts) {
  return new Promise((resolve, reject) => crypto.scrypt(pw, salt, len, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

module.exports = { AdminAuth, parseAllow, normIp, isPrivate, isLoopback, forwardedClient, MAX_FAILURES, LOCK_MS };
