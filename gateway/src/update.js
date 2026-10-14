'use strict';
// Updates for Encore Bridge (DESIGN-UPDATES.md). Two parts, picked by makeUpdate():
//
//  - Updater: the bridge's own update check (Docker, plain Linux, Windows without the tray launcher; §7). At most one
//    automatic check a day (first look 10 min after start, then every 30 min: "is a check due?"), plus the admin page's
//    Check now (throttled: a GitHub contact less than 60 s ago, or a rate limit still in force, answers the stored
//    result). One request to GitHub's latest-release endpoint of UPDATE_REPO with only the User-Agent
//    "EncoreBridge/<version>" and two fixed headers (and an ETag GitHub sent earlier, only when it looks like a content
//    hash); no cookies, no query, no identifier. A newer final release (vX.Y.Z; release candidates, prereleases and
//    drafts never) is announced only after its SHA256SUMS.txt verified against an embedded Ed25519 key (updatekeys.js)
//    and lists this kind's archive: then the admin page shows the update commands with that archive's SHA-256. The
//    bridge never downloads or runs an update itself. State: <DATA_DIR>/update.json (times, versions, asset ids and
//    sizes, a hash, a content-hash ETag, error codes; nothing personal), written with temp + rename, never logged.
//    UPDATE_CHECK=0 turns the automatic check off; a development build (a version that isn't X.Y.Z[-pre]) never looks.
//    Its kinds: 'docker' (a source build) and 'other' need Encore-<v>-source.tar.gz; 'docker-image' (the prebuilt
//    images, cfg.prebuiltImage; DESIGN-DOCKER-IMAGES.md §5) needs COMPOSE_ASSET (encore-docker-compose.yaml) uploaded
//    and in the signed list, though the bridge never downloads it, and is shown only IMAGE_WAIT_MS (an hour) after the
//    release was published: the images are built after the release, in about 15 minutes. A stored answer holding
//    another kind's file list (a data folder moved from a source build to the images) is asked for again in full.
//
//  - UpdateRelay: Windows with the tray launcher (§5.10). The launcher does the checking, downloading and installing;
//    it pushes its view to POST /local/v1/update and the bridge keeps it in memory only (nothing is written to
//    DATA_DIR). The admin page's Check now / Update now / Cancel become requests the launcher picks up from
//    GET /local/v1/status (update_request) and acknowledges with handled_request; a request nobody picked up is dropped
//    after 2 minutes (the page then says the tray didn't answer).
//
// Log lines carry codes and versions only (§11): never a URL, a redirect target, an ETag, an address, a response body,
// an exception's text or anything from a release's name or notes. Downloads follow at most 5 redirects, each https to
// github.com or *.githubusercontent.com; API answers at most 3, each to api.github.com. Test-only bases and keys
// (config.js: loopback addresses only) replace the hosts and the trust list in tests; the real GitHub is never contacted
// by a test.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const log = require('./log');
const EMBEDDED_KEYS = require('./updatekeys');
const { t } = require('./i18n');

// ---------------------------------------------------------------- constants (the release selftest reads these lines)
const UPDATE_REPO = 'mbucc9000/encore';
const API_BASE = 'https://api.github.com';
const DOWNLOAD_BASE = 'https://github.com';
const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;     // display only: the release notes link
const COMPOSE_ASSET = 'encore-docker-compose.yaml';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FIRST_LOOK_MS = 10 * MIN;          // the first "is a check due?" after start
const LOOK_EVERY_MS = 30 * MIN;          // then every 30 minutes
const OFFLINE_RETRY_MS = HOUR;           // no connection at all: GitHub wasn't contacted, look again in an hour
const JITTER_MS = 60 * MIN;              // 0-60 min added to the daily interval
const MIN_AUTO_GAP_MS = 23 * HOUR;       // two automatic contacts in one process: never closer than this (monotonic)
const MAX_PLAUSIBLE_MS = 25 * HOUR + MIN;  // a next check further away than this means the clock went back
const MANUAL_REUSE_MS = 60 * 1000;       // Check now within 60 s of the last contact: the stored result
const TIMEOUT_MS = 15000;                // one exchange (with its redirects)
const API_MAX_BYTES = 1 << 20;           // 1 MiB
const SUMS_MAX_BYTES = 64 << 10;         // 64 KiB
const SIG_MAX_BYTES = 1024;              // read up to 1 KiB; must be exactly 64 bytes
const ASSET_MAX_BYTES = 512 * 1024 * 1024;
const API_HOPS = 3;
const DOWNLOAD_HOPS = 5;
const REQUEST_TTL_MS = 2 * MIN;          // an admin-page request nobody picked up
const IMAGE_WAIT_MS = 60 * MIN;          // kind 'docker-image': the card an hour after the release (the images need ~15 min)
const STATE_FILE = 'update.json';
const SUMS = 'SHA256SUMS.txt';
const SIG = 'SHA256SUMS.txt.sig';

const KINDS = Object.freeze(['windows-installer', 'windows-zip', 'docker', 'docker-image', 'other']);
const STATES = Object.freeze(['never', 'checking', 'up_to_date', 'available', 'error']);
const PHASES = Object.freeze(['downloading', 'verifying', 'waiting', 'cancelled', 'failed']);
const CODES = Object.freeze(['offline', 'timeout', 'rate_limited', 'http_error', 'bad_answer', 'no_release', 'incomplete_release', 'bad_signature',
  'sums_entry_missing', 'download_failed', 'no_space', 'hash_mismatch', 'setup_cancelled', 'setup_failed', 'setup_start_failed']);
const ACTIONS = Object.freeze(['check', 'install', 'cancel']);

// RFC 8032 §7.1 TEST 1 and TEST 2: public test data, never trusted by a release build
const RFC_TEST_KEYS = Object.freeze(['11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=', 'PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=']);

// ---------------------------------------------------------------- versions (§3)
const NUM = '(0|[1-9][0-9]{0,3})';
const TAG_RE = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}$`);
const RELEASE_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const CURRENT_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ETAG_RE = /^(W\/)?"[0-9a-f]{32,64}"$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REQ_ID = /^[0-9a-f]{16}$/;

// a release tag's version ('v1.2.0' -> '1.2.0'), or null for anything else (rc, prerelease, build metadata, ...)
function parseTag(tag) {
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) return null;
  return tag.slice(1);
}
const isReleaseVersion = (v) => typeof v === 'string' && RELEASE_RE.test(v);
// the running version: {nums, pre} or null (a development build: 'dev' or anything else)
function parseCurrent(v) {
  if (typeof v !== 'string') return null;
  const m = CURRENT_RE.exec(v);
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null } : null;
}
// a final release version strictly newer than the running one (semver precedence; X.Y.Z-pre < X.Y.Z)
function isNewer(release, current) {
  if (!isReleaseVersion(release)) return false;
  const c = parseCurrent(current);
  if (!c) return false;
  const r = release.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (r[i] !== c.nums[i]) return r[i] > c.nums[i];
  return !!c.pre;
}

// the asset this kind needs (§2.5); the prebuilt images': the compose file (signed like every asset, never downloaded)
function assetFor(kind, v) {
  if (kind === 'windows-installer') return `EncoreBridge-${v}-setup.exe`;
  if (kind === 'windows-zip') return `EncoreBridge-${v}-win64.zip`;
  if (kind === 'docker-image') return COMPOSE_ASSET;
  return `Encore-${v}-source.tar.gz`;
}
const notesUrl = (v) => `${RELEASES_PAGE}/tag/v${v}`;

// ---------------------------------------------------------------- SHA256SUMS.txt and its signature (§4)
const SUMS_LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9._+-]{1,128})$/;
// strict: LF only, one final newline allowed, no BOM, no empty lines, no '..', a name only once. Map name -> hex, or null.
function parseSums(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  let s = buf.toString('latin1');                  // any byte outside ASCII fails the line pattern
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (!s) return null;
  const out = new Map();
  for (const line of s.split('\n')) {
    const m = SUMS_LINE.exec(line);
    if (!m || m[2].includes('..') || out.has(m[2])) return null;
    out.set(m[2], m[1]);
  }
  return out;
}

const keyIdOf = (raw) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

// the trust list: [{id, name, obj}] from base64 raw 32-byte Ed25519 public keys. allowTest: the RFC 8032 test keys
// may be in it (test-only settings); a release build drops them.
function loadKeys(list, { allowTest = false } = {}) {
  const out = [];
  for (const k of list || []) {
    const b64 = typeof k === 'string' ? k : k && k.key;
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) continue;
    if (!allowTest && RFC_TEST_KEYS.includes(b64)) continue;
    const raw = Buffer.from(b64, 'base64');
    if (raw.length !== 32) continue;
    let obj;
    try { obj = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }); } catch (e) { continue; }
    out.push({ id: keyIdOf(raw), name: (k && k.name) || 'test', obj });
    if (out.length >= 3) break;
  }
  return out;
}

// Ed25519 over the exact bytes: {ok, key_id (the one that matched), tried: [ids]}
function verifySig(message, sig, keys) {
  const tried = keys.map((k) => k.id);
  if (!Buffer.isBuffer(sig) || sig.length !== 64) return { ok: false, key_id: null, tried };
  for (const k of keys) {
    let ok = false;
    try { ok = crypto.verify(null, message, k.obj, sig); } catch (e) { ok = false; }
    if (ok) return { ok: true, key_id: k.id, tried };
  }
  return { ok: false, key_id: null, tried };
}

// ---------------------------------------------------------------- redirects (§2.1, §4.2)
function apiHopAllowed(u, base) {
  if (base) return u.origin === new URL(base).origin;
  return u.protocol === 'https:' && u.hostname === 'api.github.com' && !u.port && !u.username && !u.password;
}
function downloadHopAllowed(u, base) {
  if (base) return u.origin === new URL(base).origin;
  return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com')) && !u.port && !u.username && !u.password;
}

// ---------------------------------------------------------------- one GET (with redirects), never an exception's text
// A plain getter by protocol: https for GitHub; http only ever reaches the test-only loopback bases (a redirect to
// http is refused by the hop rules above).
const defaultGet = (url, opts, cb) => (String(url).startsWith('http:') ? http : https).get(url, opts, cb);

// {status, headers, body} (body only for 200) or {fail: 'offline' | 'timeout' | 'too_big'}. offline: no connection was
// made (DNS, refused, unreachable, TLS before the request); timeout: the request was sent (it may have reached GitHub).
function fetchOnce(get, url, headers, maxBytes, msLeft, timers) {
  return new Promise((resolve) => {
    let done = false;
    let connected = false;
    let req = null;
    let timer = null;
    const end = (r) => {
      if (done) return;
      done = true;
      if (timer != null) timers.clear(timer);
      if (req) { try { req.destroy(); } catch (e) { /* gone */ } }
      resolve(r);
    };
    timer = timers.set(() => end({ fail: connected ? 'timeout' : 'offline' }), Math.max(1, msLeft));
    if (timer && typeof timer.unref === 'function') timer.unref();
    let tls = false;
    try { tls = new URL(url).protocol === 'https:'; } catch (e) { end({ fail: 'offline' }); return; }
    try {
      // agent: false: a connection of its own, closed after the answer (no cookies, no shared sockets)
      req = get(url, { headers, agent: false }, (res) => {
        connected = true;
        const status = res.statusCode;
        if (status !== 200) {
          const r = { status, headers: res.headers || {} };
          try { res.resume(); } catch (e) { /* gone */ }
          end(r);
          return;
        }
        const len = Number((res.headers || {})['content-length']);
        if (Number.isFinite(len) && len > maxBytes) { end({ fail: 'too_big' }); return; }
        const parts = [];
        let n = 0;
        res.on('data', (c) => {
          if (done) return;
          n += c.length;
          if (n > maxBytes) end({ fail: 'too_big' });
          else parts.push(c);
        });
        res.on('end', () => end({ status, headers: res.headers || {}, body: Buffer.concat(parts) }));
        res.on('error', () => end({ fail: 'timeout' }));
        res.on('close', () => end({ fail: 'timeout' }));          // (closed before its end; after 'end' a no-op)
      });
      if (req && typeof req.on === 'function') {
        req.on('socket', (s) => {
          if (s && typeof s.once === 'function') s.once(tls ? 'secureConnect' : 'connect', () => { connected = true; });
        });
        req.on('error', () => end({ fail: connected ? 'timeout' : 'offline' }));
      }
    } catch (e) { end({ fail: 'offline' }); }
  });
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
// follows redirects under hopAllowed; the whole exchange within timeoutMs. A refused hop: {fail: 'bad_hop'}.
async function fetchFollow({ get, url, headers, maxBytes, maxHops, hopAllowed, timeoutMs, timers }) {
  const deadline = performance.now() + timeoutMs;
  let cur = url;
  let contacted = false;
  for (let hop = 0; ; hop++) {
    const r = await fetchOnce(get, cur, headers, maxBytes, deadline - performance.now(), timers);
    if (r.fail) return { ...r, contacted: contacted || r.fail !== 'offline' };
    contacted = true;
    if (!REDIRECT.has(r.status)) return { ...r, contacted };
    if (hop >= maxHops) return { fail: 'bad_hop', contacted };
    let next = null;
    try { next = new URL(String(r.headers.location || ''), cur); } catch (e) { next = null; }
    if (!r.headers.location || !next || !hopAllowed(next)) return { fail: 'bad_hop', contacted };
    if (deadline - performance.now() <= 0) return { fail: 'timeout', contacted };
    cur = next.href;
  }
}

// ---------------------------------------------------------------- small helpers
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isIso = (s) => typeof s === 'string' && s.length <= 40 && ISO_RE.test(s) && Number.isFinite(Date.parse(s));
const msOf = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + 'Z';
const plainObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const safeInt = (n, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;

function writeJsonAtomic(file, obj) {
  const body = JSON.stringify(obj);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  try { fs.renameSync(tmp, file); } catch (e) {
    // (Windows: a scanner may hold the old file a moment) write it in place
    fs.writeFileSync(file, body);
    try { fs.unlinkSync(tmp); } catch (e2) { /* gone */ }
  }
}

// the stored state, checked field by field; anything odd (or a newer v) starts fresh
const FRESH = () => ({ v: 1, last_contact: null, next_check: null, etag: null, result: null, verified: null, error: null });
function sanitizeState(j) {
  if (!plainObj(j) || j.v !== 1) return FRESH();
  const s = FRESH();
  if (isIso(j.last_contact)) s.last_contact = j.last_contact;
  if (isIso(j.next_check)) s.next_check = j.next_check;
  if (typeof j.etag === 'string' && ETAG_RE.test(j.etag)) s.etag = j.etag;
  const r = j.result;
  if (plainObj(r) && (r.version === null || isReleaseVersion(r.version)) && plainObj(r.assets)) {
    const assets = {};
    let ok = true;
    for (const [n, a] of Object.entries(r.assets)) {
      if (!/^[A-Za-z0-9._+-]{1,128}$/.test(n) || !plainObj(a) || !safeInt(a.id, 1) || !safeInt(a.size)) { ok = false; break; }
      assets[n] = { id: a.id, size: a.size };
    }
    if (ok) s.result = { state: typeof r.state === 'string' ? r.state.slice(0, 32) : null, version: r.version, published_at: isIso(r.published_at) ? r.published_at : null, assets };
  }
  if (!s.result) s.etag = null;                              // an ETag only together with the result it belongs to
  const v = j.verified;
  if (plainObj(v) && isReleaseVersion(v.version) && typeof v.cache === 'string' && v.cache.length <= 400 && typeof v.ok === 'boolean') {
    const sha = {};
    if (plainObj(v.sha256)) for (const [n, h] of Object.entries(v.sha256)) if (/^[A-Za-z0-9._+-]{1,128}$/.test(n) && HEX64.test(String(h))) sha[n] = h;
    s.verified = { version: v.version, cache: v.cache, ok: v.ok, code: CODES.includes(v.code) ? v.code : null,
      key_id: typeof v.key_id === 'string' && /^[0-9a-f]{16}$/.test(v.key_id) ? v.key_id : null,
      tried: Array.isArray(v.tried) ? v.tried.filter((x) => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x)).slice(0, 3) : [], sha256: sha };
  }
  const e = j.error;
  if (plainObj(e) && CODES.includes(e.code)) {
    s.error = { code: e.code, version: isReleaseVersion(e.version) ? e.version : null, retry_at: isIso(e.retry_at) ? e.retry_at : null,
      http_status: safeInt(e.http_status, 100, 599) ? e.http_status : null };
  }
  return s;
}

// ================================================================ the bridge's own checker (Docker / other)
class Updater {
  // cfg: version, dataDir, platformKind, prebuiltImage, updateCheck, updateApiBase / updateDownloadBase / updateTestKeys (test-only).
  // Injected in tests: get (an https.get-like getter), now (wall clock ms), mono (monotonic ms), random, setTimer /
  // clearTimer (the per-request timer), setLater / setEvery / clearLater (the schedule's timers), file (null: memory only),
  // keys (base64 list), timeoutMs.
  constructor({ cfg, kind, get = defaultGet, now = Date.now, mono = () => performance.now(), random = Math.random,
    setTimer = setTimeout, clearTimer = clearTimeout, setLater = setTimeout, setEvery = setInterval, clearLater = (t) => { clearTimeout(t); clearInterval(t); },
    file, keys, timeoutMs = TIMEOUT_MS } = {}) {
    this.cfg = cfg || {};
    this.mode = 'bridge';
    this.kind = kind || (this.cfg.platformKind === 'docker' ? (this.cfg.prebuiltImage ? 'docker-image' : 'docker') : 'other');
    this.current = String(this.cfg.version || '');
    this.dev = !parseCurrent(this.current);
    this.test = !!(this.cfg.updateApiBase && this.cfg.updateDownloadBase);
    this.apiBase = this.test ? this.cfg.updateApiBase : API_BASE;
    this.downloadBase = this.test ? this.cfg.updateDownloadBase : DOWNLOAD_BASE;
    const testKeys = this.test && Array.isArray(this.cfg.updateTestKeys) && this.cfg.updateTestKeys.length ? this.cfg.updateTestKeys : null;
    this.keys = loadKeys(keys || testKeys || EMBEDDED_KEYS, { allowTest: !!(keys || testKeys) });
    Object.assign(this, { get, now, mono, random, timeoutMs });
    this.timers = { set: setTimer, clear: clearTimer };
    this.later = { set: setLater, every: setEvery, clear: clearLater };
    this.file = file !== undefined ? file : (this.cfg.dataDir ? path.join(this.cfg.dataDir, STATE_FILE) : null);
    this.st = this.load();
    this.running = null;
    this.lastAutoMono = null;          // the last automatic GitHub contact in this process (monotonic)
    this.handles = [];
    this.stopped = false;
  }

  autoOn() { return !this.dev && this.cfg.updateCheck !== false; }

  load() {
    if (!this.file) return FRESH();
    let j;
    try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') log.warn('update check: its state file is unreadable, so it starts fresh');
      return FRESH();
    }
    return sanitizeState(j);
  }

  save() {
    if (!this.file) return;
    try { writeJsonAtomic(this.file, this.st); } catch (e) { log.warn('update check: could not save its state (' + (e.code || 'error') + ')'); }
  }

  // ---- the schedule: the first look 10 min after start, then every 30 min (unref'd); none at all for a development
  // build or with UPDATE_CHECK=0 (read at start: `docker compose up -d` after a change)
  start() {
    if (this.handles.length || this.stopped || !this.autoOn()) return;
    const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };
    this.handles.push(unref(this.later.set(() => {
      this.tick();
      if (!this.stopped) this.handles.push(unref(this.later.every(() => this.tick(), LOOK_EVERY_MS)));
    }, FIRST_LOOK_MS)));
  }

  stop() {
    this.stopped = true;
    for (const h of this.handles.splice(0)) { try { this.later.clear(h); } catch (e) { /* gone */ } }
  }

  // is an automatic check due? (§2.6) Missing state: yes. The clock going back never makes it wait longer than a day,
  // and never makes two automatic contacts in this process less than 23 h apart.
  due() {
    const now = this.now();
    let next = msOf(this.st.next_check);
    const last = msOf(this.st.last_contact);
    const back = Number.isFinite(last) && last > now;
    if (back || (Number.isFinite(next) && next - now > MAX_PLAUSIBLE_MS)) {
      // the clock went back: a last contact "in the future" counts as now (noticed at the first look after the jump)
      if (Number.isFinite(next)) { next = Math.min(next, now + DAY); this.st.next_check = iso(next); }
      if (back) this.st.last_contact = iso(now);
      this.save();
    }
    if (this.lastAutoMono != null && this.mono() - this.lastAutoMono < MIN_AUTO_GAP_MS) return false;
    if (!Number.isFinite(next)) return true;
    return now >= next;
  }

  async tick() {
    if (this.stopped || !this.autoOn() || this.running) return false;
    if (!this.due()) return false;
    await this.run(false);
    return true;
  }

  // Check now (§2.3): a development build never asks; within 60 s of the last contact, or while a rate limit is in
  // force, the stored result (reused: true) without a request
  async checkNow() {
    if (this.dev) return { ...this.view(), reused: false };
    if (this.running) { await this.running; return { ...this.view(), reused: false }; }
    const now = this.now();
    const last = msOf(this.st.last_contact);
    if (Number.isFinite(last) && now >= last && now - last < MANUAL_REUSE_MS) return { ...this.view(), reused: true };
    const e = this.st.error;
    if (e && e.code === 'rate_limited' && Number.isFinite(msOf(e.retry_at)) && msOf(e.retry_at) > now) return { ...this.view(), reused: true };
    await this.run(true);
    return { ...this.view(), reused: false };
  }

  run(manual) {
    if (this.running) return this.running;
    this.running = this.check(manual).catch(() => {
      // (a programming error must never stop the bridge; the code only, never the text)
      this.fail({ code: 'bad_answer' }, true);
    }).finally(() => { this.running = null; });
    return this.running;
  }

  headers(extra = {}) {
    return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `EncoreBridge/${this.current}`, ...extra };
  }

  nextDaily(now) { return now + DAY + Math.floor(Math.max(0, Math.min(1, this.random())) * JITTER_MS); }

  // a failed check: the code, the next look, the log line; the stored result (a release found earlier) stays
  fail(err, contacted, { keepResult = true } = {}) {
    const now = this.now();
    this.st.error = { code: err.code, version: err.version || null, retry_at: err.retry_at || null, http_status: err.http_status || null };
    if (!keepResult) { this.st.result = null; this.st.etag = null; }
    if (contacted) this.st.last_contact = iso(now);
    let next = contacted ? this.nextDaily(now) : now + OFFLINE_RETRY_MS;
    if (err.code === 'rate_limited' && err.retry_at) next = Math.max(msOf(err.retry_at), now + DAY);
    this.st.next_check = iso(next);
    this.save();
    const what = err.code === 'rate_limited' ? `rate_limited until ${hhmm(msOf(err.retry_at))}` : err.code === 'http_error' ? `http_error ${err.http_status}`
      : err.code === 'incomplete_release' ? `incomplete_release ${err.version}` : err.code;
    if (err.code === 'no_release') log.info('update check: no release published yet');
    else if (err.code === 'bad_signature') log.warn(`update check: ${err.version} not offered: bad_signature (keys tried: ${(err.tried || []).join(', ') || 'none'})`);
    else if (err.code === 'sums_entry_missing') log.warn(`update check: ${err.version} not offered: sums_entry_missing`);
    else log.warn(`update check failed: ${what}`);
  }

  // the stored answer may stand for a 304 only when it holds this kind's file for a newer version: a data folder moved
  // between a source build and the prebuilt images keeps the other kind's list (only the files that kind needed)
  etagFits() {
    const r = this.st.result;
    if (!this.st.etag || !r) return false;
    return !r.version || !isNewer(r.version, this.current) || !!r.assets[assetFor(this.kind, r.version)];
  }

  async check(manual) {
    const now = this.now();
    const auto = !manual;
    const api = await fetchFollow({ get: this.get, url: `${this.apiBase}/repos/${UPDATE_REPO}/releases/latest`,
      headers: this.headers(this.etagFits() ? { 'If-None-Match': this.st.etag } : {}), maxBytes: API_MAX_BYTES, maxHops: API_HOPS,
      hopAllowed: (u) => apiHopAllowed(u, this.test ? this.apiBase : null), timeoutMs: this.timeoutMs, timers: this.timers });
    if (api.contacted && auto) this.lastAutoMono = this.mono();
    if (api.fail) {
      const code = api.fail === 'offline' ? 'offline' : api.fail === 'timeout' ? 'timeout' : 'bad_answer';
      return this.fail({ code }, api.contacted);
    }
    const st = api.status;
    const h = api.headers || {};
    if (st === 304) {
      if (!this.st.result) return this.fail({ code: 'bad_answer' }, true);
      log.info('update check: not changed since the last check');
      return this.evaluate(this.st.result, now, { quiet: true });
    }
    if (st === 404) return this.fail({ code: 'no_release' }, true, { keepResult: false });
    if (st === 403 || st === 429) {
      if (String(h['x-ratelimit-remaining']) === '0') {
        const reset = Number(h['x-ratelimit-reset']) * 1000;
        const at = Number.isFinite(reset) && reset > now ? Math.min(reset, now + DAY) : now + HOUR;
        return this.fail({ code: 'rate_limited', retry_at: iso(at) }, true);
      }
      if (h['retry-after'] != null) {
        let s = Number(h['retry-after']);
        if (!Number.isFinite(s)) s = (Date.parse(String(h['retry-after'])) - now) / 1000;
        const at = now + Math.min(Math.max(Number.isFinite(s) ? s : 3600, 1) * 1000, DAY);
        return this.fail({ code: 'rate_limited', retry_at: iso(at) }, true);
      }
    }
    if (st !== 200) return this.fail({ code: 'http_error', http_status: safeInt(st, 100, 599) ? st : null }, true);
    // a 200: the release, read field by field (name, body, html_url, author, browser_download_url: never read)
    let j;
    try { j = JSON.parse(api.body.toString('utf8')); } catch (e) { return this.fail({ code: 'bad_answer' }, true); }
    if (!plainObj(j) || typeof j.tag_name !== 'string' || typeof j.draft !== 'boolean' || typeof j.prerelease !== 'boolean' || !Array.isArray(j.assets)) {
      return this.fail({ code: 'bad_answer' }, true);
    }
    const etag = typeof h.etag === 'string' && ETAG_RE.test(h.etag) ? h.etag : null;
    const version = parseTag(j.tag_name);
    if (!version || j.draft || j.prerelease) {
      log.info('update check: latest release tag isn\'t a final version: ignored');
      this.st.result = { state: 'up_to_date', version: null, published_at: null, assets: {} };
      this.st.etag = etag;
      this.st.error = null;
      this.st.last_contact = iso(now);
      this.st.next_check = iso(this.nextDaily(now));
      this.save();
      return undefined;
    }
    const wanted = new Set([SUMS, SIG, assetFor(this.kind, version)]);
    const assets = {};
    const seen = new Set();
    for (const a of j.assets) {
      if (!plainObj(a) || typeof a.name !== 'string') return this.fail({ code: 'bad_answer' }, true);
      if (seen.has(a.name)) return this.fail({ code: 'bad_answer' }, true);
      seen.add(a.name);
      if (!wanted.has(a.name) || a.state !== 'uploaded') continue;
      if (!safeInt(a.id, 1) || !safeInt(a.size)) return this.fail({ code: 'bad_answer' }, true);
      assets[a.name] = { id: a.id, size: a.size };
    }
    const result = { state: null, version, published_at: isIso(j.published_at) ? j.published_at : null, assets };
    this.st.etag = etag;
    return this.evaluate(result, now, {});
  }

  // a release (fresh, or the stored one after a 304): up to date, incomplete, or verified (§2.5, §4.3 steps 1-4)
  async evaluate(result, now, { quiet = false } = {}) {
    this.st.result = result;
    this.st.last_contact = iso(now);
    const v = result.version;
    if (!v || !isNewer(v, this.current)) {
      result.state = 'up_to_date';
      this.st.error = null;
      this.st.next_check = iso(this.nextDaily(now));
      this.save();
      if (!quiet) log.info(`update check: up to date (${this.current})`);
      return;
    }
    const need = assetFor(this.kind, v);
    const a = result.assets;
    const sizeOk = a[SUMS] && a[SUMS].size > 0 && a[SUMS].size <= SUMS_MAX_BYTES && a[SIG] && a[SIG].size === 64
      && a[need] && a[need].size >= 1 && a[need].size <= ASSET_MAX_BYTES;
    if (!sizeOk) { result.state = 'incomplete_release'; return this.fail({ code: 'incomplete_release', version: v }, true); }
    const cache = `${v}|${a[SUMS].id}:${a[SUMS].size}|${a[SIG].id}:${a[SIG].size}|${this.keys.map((k) => k.id).join(',')}`;
    let ver = this.st.verified && this.st.verified.cache === cache && this.st.verified.version === v ? this.st.verified : null;
    if (ver && ver.ok && !ver.sha256[need]) ver = null;
    if (!ver) {
      const r = await this.verify(v, need, a);
      if (r.transport) return this.fail(r.transport, true);
      ver = { version: v, cache, ok: r.ok, code: r.code || null, key_id: r.key_id || null, tried: r.tried || [], sha256: r.sha256 || {} };
      this.st.verified = ver;
    }
    if (!ver.ok) { result.state = ver.code; return this.fail({ code: ver.code, version: v, tried: ver.tried }, true); }
    result.state = 'available';
    this.st.error = null;
    this.st.next_check = iso(this.nextDaily(now));
    this.save();
    if (!quiet) log.info(`update check: ${v} available (signature ok, key ${ver.key_id})`);
    return undefined;
  }

  // steps 1-4: the two small files (fresh downloads, links built from constants), the signature, the strict list, the
  // entry for this kind's archive. {ok, key_id, sha256} | {ok: false, code, tried} | {transport: {code, ...}}
  async verify(v, need, assets) {
    const dl = async (name, maxBytes) => {
      const r = await fetchFollow({ get: this.get, url: `${this.downloadBase}/${UPDATE_REPO}/releases/download/v${v}/${name}`, headers: this.headers(),
        maxBytes, maxHops: DOWNLOAD_HOPS, hopAllowed: (u) => downloadHopAllowed(u, this.test ? this.downloadBase : null), timeoutMs: this.timeoutMs, timers: this.timers });
      if (r.fail === 'offline' || r.fail === 'timeout') return { transport: { code: r.fail } };
      if (r.fail) return { transport: { code: 'bad_answer' } };
      if (r.status === 404) return { transport: { code: 'incomplete_release', version: v } };
      if (r.status !== 200) return { transport: { code: 'http_error', http_status: safeInt(r.status, 100, 599) ? r.status : null } };
      return { body: r.body };
    };
    const sums = await dl(SUMS, SUMS_MAX_BYTES);
    if (sums.transport) return sums;
    if (sums.body.length !== assets[SUMS].size) return { transport: { code: 'bad_answer' } };
    const sig = await dl(SIG, SIG_MAX_BYTES);
    if (sig.transport) return sig;
    const check = verifySig(sums.body, sig.body, this.keys);
    if (!check.ok) return { ok: false, code: 'bad_signature', tried: check.tried };
    const list = parseSums(sums.body);
    const hash = list && list.get(need);
    if (!hash) return { ok: false, code: 'sums_entry_missing', tried: check.tried };
    return { ok: true, key_id: check.key_id, tried: check.tried, sha256: { [need]: hash } };
  }

  // the update view (§8.3)
  view() {
    const s = this.st;
    const r = s.result;
    const ver = s.verified;
    let latest = null;
    if (r && r.version && isNewer(r.version, this.current) && ver && ver.ok && ver.version === r.version) {
      const need = assetFor(this.kind, r.version);
      if (ver.sha256[need] && r.assets[need]) {
        latest = { version: r.version, published_at: r.published_at || null, notes_url: notesUrl(r.version), asset: need, size: r.assets[need].size, sha256: ver.sha256[need] };
      }
    }
    // the prebuilt images: their workflow builds them after the release is published, so the card waits an hour after
    // publishing (nothing stored or fetched for this: the first view after the hour shows it). A source build never waits.
    if (latest && this.kind === 'docker-image') {
      const pub = msOf(latest.published_at);
      if (Number.isFinite(pub) && this.now() < pub + IMAGE_WAIT_MS) latest = null;
    }
    const e = s.error;
    // an error about a version that is no longer newer (the bridge was updated) isn't shown
    const error = e && !(e.version && !isNewer(e.version, this.current)) ? { code: e.code, version: e.version || null, retry_at: e.retry_at || null, http_status: e.http_status || null } : null;
    const auto = this.autoOn();
    let state;
    if (this.running) state = 'checking';
    else if (latest) state = 'available';
    else if (error) state = 'error';
    else if (s.last_contact || r) state = 'up_to_date';
    else state = 'never';
    return {
      v: 1, source: 'bridge', kind: this.kind, current: this.current,
      auto, auto_off: this.dev ? 'dev_build' : auto ? null : 'setting',
      state, checked_at: s.last_contact || null, next_check_at: auto && s.next_check ? s.next_check : null,
      latest, error, install: null,
    };
  }

  // what the admin page gets (§8.3 + the bridge's additions)
  adminView() {
    return { ...this.view(), request: null, request_expired: null, request_handled: null, can_install_here: false, relay_missing: false };
  }
}

// ================================================================ Windows: the launcher's view, relayed (§5.10, §5.11)
const isLoopbackPeer = (req) => {
  const ip = String((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, '');
  return ip === '127.0.0.1' || ip === '::1';
};

// the launcher's pushed view, checked: only known fields, fixed sets, versions by the grammar; else an error code
function validateView(b) {
  const bad = (why) => ({ error: why });
  if (!plainObj(b)) return bad('not an object');
  if (b.v !== 1) return bad('v');
  if (b.source !== 'launcher') return bad('source');
  if (!KINDS.includes(b.kind)) return bad('kind');
  if (typeof b.current !== 'string' || b.current.length > 64 || !(parseCurrent(b.current) || b.current === 'dev')) return bad('current');
  if (typeof b.auto !== 'boolean') return bad('auto');
  if (!(b.auto_off === null || b.auto_off === undefined || b.auto_off === 'setting' || b.auto_off === 'dev_build')) return bad('auto_off');
  if (!STATES.includes(b.state)) return bad('state');
  const optIso = (x) => x === null || x === undefined || isIso(x);
  if (!optIso(b.checked_at) || !optIso(b.next_check_at)) return bad('time');
  let latest = null;
  if (b.latest != null) {
    const l = b.latest;
    if (!plainObj(l) || !isReleaseVersion(l.version) || !optIso(l.published_at) || !safeInt(l.size, 0, 2 ** 40) || typeof l.sha256 !== 'string' || !HEX64.test(l.sha256)) return bad('latest');
    if (l.asset !== assetFor(b.kind, l.version)) return bad('latest.asset');
    latest = { version: l.version, published_at: l.published_at || null, notes_url: notesUrl(l.version), asset: l.asset, size: l.size, sha256: l.sha256 };
  }
  let error = null;
  if (b.error != null) {
    const e = b.error;
    if (!plainObj(e) || !CODES.includes(e.code) || !(e.version == null || isReleaseVersion(e.version)) || !optIso(e.retry_at)
      || !(e.http_status == null || safeInt(e.http_status, 100, 599))) return bad('error');
    error = { code: e.code, version: e.version || null, retry_at: e.retry_at || null, http_status: e.http_status == null ? null : e.http_status };
  }
  let install = null;
  if (b.install != null) {
    const i = b.install;
    if (!plainObj(i) || !isReleaseVersion(i.version) || !PHASES.includes(i.phase) || !safeInt(i.done, 0, 2 ** 40) || !safeInt(i.total, 0, 2 ** 40)
      || !(i.error == null || CODES.includes(i.error)) || !(i.exit_code == null || safeInt(i.exit_code, -(2 ** 31), 2 ** 32))) return bad('install');
    install = { version: i.version, phase: i.phase, done: i.done, total: i.total, error: i.error || null, exit_code: i.exit_code == null ? null : i.exit_code };
  }
  if (b.handled_request != null && !(typeof b.handled_request === 'string' && REQ_ID.test(b.handled_request))) return bad('handled_request');
  return {
    view: { v: 1, source: 'launcher', kind: b.kind, current: b.current, auto: b.auto, auto_off: b.auto_off || null, state: b.state,
      checked_at: b.checked_at || null, next_check_at: b.next_check_at || null, latest, error, install },
    handled: b.handled_request || null,
  };
}

class UpdateRelay {
  constructor({ cfg, now = Date.now, randomId = () => crypto.randomBytes(8).toString('hex') } = {}) {
    this.cfg = cfg || {};
    this.mode = 'relay';
    Object.assign(this, { now, randomId });
    this.pushed = null;              // the launcher's newest view (memory only)
    this.requests = [];              // [{id, action, at}], oldest first
    this.expired = null;             // the id of the newest request nobody picked up in 2 minutes
    this.handledIds = [];            // recently acknowledged ids (the page tells "handled" from "expired")
  }

  start() {}
  stop() {}

  // POST /local/v1/update: {ok} or throws {status: 400}
  push(body) {
    const r = validateView(body);
    if (r.error) throw Object.assign(new Error('The update view isn\'t valid.'), { status: 400, code: 'bad_request' });
    this.pushed = r.view;
    if (r.handled) this.ack(r.handled);
    return { ok: true };
  }

  ack(id) {
    const i = this.requests.findIndex((q) => q.id === id);
    if (i >= 0) this.requests.splice(i, 1);
    this.handledIds = [id, ...this.handledIds.filter((x) => x !== id)].slice(0, 8);
  }

  sweep() {
    const now = this.now();
    while (this.requests.length && now - this.requests[0].at >= REQUEST_TTL_MS) this.expired = this.requests.shift().id;
    // (a younger one can't be older than the first: the queue is in order)
  }

  // the oldest pending request, for GET /local/v1/status (update_request)
  pending() {
    this.sweep();
    const q = this.requests[0];
    return q ? { id: q.id, action: q.action } : null;
  }

  // an admin-page request; the same action already pending answers its id
  queue(action) {
    if (!ACTIONS.includes(action)) throw Object.assign(new Error('unknown action'), { status: 400, code: 'bad_request' });
    this.sweep();
    const same = this.requests.find((q) => q.action === action);
    if (same) return same.id;
    if (this.requests.length >= 4) this.expired = this.requests.shift().id;
    const id = this.randomId();
    this.requests.push({ id, action, at: this.now() });
    if (this.expired) this.expired = null;
    return id;
  }

  view() {
    if (this.pushed) return { ...this.pushed };
    return { v: 1, source: 'launcher', kind: null, current: String(this.cfg.version || ''), auto: null, auto_off: null, state: 'never',
      checked_at: null, next_check_at: null, latest: null, error: null, install: null };
  }

  adminView(req) {
    this.sweep();
    const v = this.view();
    const q = this.requests[this.requests.length - 1] || null;
    return { ...v, request: q ? { id: q.id, action: q.action, age_s: Math.max(0, Math.round((this.now() - q.at) / 1000)) } : null,
      request_expired: this.expired, request_handled: this.handledIds[0] || null,
      can_install_here: !!(this.pushed && v.kind === 'windows-installer' && v.state === 'available' && v.latest && isLoopbackPeer(req)),
      relay_missing: !this.pushed };
  }
}

// the launcher's relay on Windows (the tray program checks), the bridge's own checker everywhere else
function makeUpdate({ cfg, ...opts } = {}) {
  return cfg && cfg.launcher ? new UpdateRelay({ cfg, ...opts }) : new Updater({ cfg, ...opts });
}

// the admin routes' answers (http.js): {status, body}. English here: http.js translates them for the page (i18n.js).
const UPDATE_MSG = {
  update_here_only: (v) => (v ? t('en', 'To update, use the Encore Bridge icon on the PC: Encore Bridge {version} is available → Update now…', { version: v })
    : t('en', 'To update, use the Encore Bridge icon on the PC.')),
  not_available: t('en', 'There\'s no newer verified version of Encore Bridge to install right now. Press Check now first.'),
  not_installed: t('en', 'This copy of Encore Bridge doesn\'t install updates itself: the Updates section on the admin page shows the steps.'),
};

module.exports = {
  UPDATE_REPO, API_BASE, DOWNLOAD_BASE, RELEASES_PAGE, COMPOSE_ASSET, KINDS, STATES, PHASES, CODES, ACTIONS, RFC_TEST_KEYS, STATE_FILE,
  FIRST_LOOK_MS, LOOK_EVERY_MS, OFFLINE_RETRY_MS, MIN_AUTO_GAP_MS, MANUAL_REUSE_MS, TIMEOUT_MS, REQUEST_TTL_MS, IMAGE_WAIT_MS, API_MAX_BYTES, SUMS_MAX_BYTES,
  parseTag, parseCurrent, isNewer, isReleaseVersion, assetFor, notesUrl, parseSums, verifySig, loadKeys, keyIdOf, apiHopAllowed, downloadHopAllowed,
  fetchFollow, sanitizeState, validateView, isLoopbackPeer, Updater, UpdateRelay, makeUpdate, UPDATE_MSG, EMBEDDED_KEYS, ETAG_RE,
};
