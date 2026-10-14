'use strict';
// The bridge's update check (src/update.js; DESIGN-UPDATES.md §2-§4, §7, §11, §14): against a local fake GitHub
// (support/fakegithub.js) through the test-only bases, never the real one. The shared vectors (fixtures/
// update-vectors.json, byte-identical with the Windows launcher's copy): versions, tags, SHA256SUMS.txt parsing and
// Ed25519 signatures with the RFC 8032 test keys. Then: a newer release offered only after its signature verified;
// older / equal / rc / prerelease / draft / malformed tags never; a development build never asks; every bad signature,
// a missing entry, missing assets; the two small files fetched once per release; the ETag (a content hash only) and
// 304; rate limits; the 60 s manual throttle; offline, timeout, oversized / broken answers and refused redirects; the
// schedule over a simulated week, UPDATE_CHECK=0 and a clock that goes back; the headers of every request (nothing but
// the User-Agent and two fixed headers, no query, no cookie); a log and a state file with no address, URL, ETag or
// path; and the production constants (checked, never requested).
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const U = require('../src/update');
const { FakeGitHub, VECTORS, KEYS, sha256, assetNames } = require('./support/fakegithub');
const { capture } = require('./support/wizard-server');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-update-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-12T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const T1 = KEYS.rfc8032_test1.public_b64;
const T1_ID = KEYS.rfc8032_test1.id;
const T2_ID = KEYS.rfc8032_test2.id;
const TAR = 'Encore-1.2.0-source.tar.gz';
const strip = (l) => l.replace(/^\S+ /, '');            // the log line without its time

// a fake GitHub and an Updater pointed at it (the test-only bases and the RFC TEST 1 key), with a fake clock
async function setup(o = {}) {
  const gh = await new FakeGitHub().start();
  const dir = o.dir || tmp();
  const clock = { t: T0, m: 5 * DAY };
  const cfg = { version: '1.1.0', platformKind: 'docker', updateCheck: true, dataDir: dir, updateApiBase: gh.base, updateDownloadBase: gh.base,
    updateTestKeys: [T1], ...o.cfg };
  const up = new U.Updater({ cfg, now: () => clock.t, mono: () => clock.m, random: () => 0.5, timeoutMs: o.timeoutMs || 3000, ...o.opts });
  return { gh, up, clock, dir, cfg, tick: (ms) => { clock.t += ms; clock.m += ms; }, close: () => gh.close() };
}
async function quiet(fn) {
  const cap = capture();
  try { return await fn(cap); } finally { cap.restore(); }
}

// ---------------------------------------------------------------- constants, keys, vectors
test('the production constants and the embedded trust list (checked here, never requested)', () => {
  assert.equal(U.UPDATE_REPO, 'mbucc9000/encore');
  assert.equal(U.API_BASE, 'https://api.github.com');
  assert.equal(U.DOWNLOAD_BASE, 'https://github.com');
  assert.equal(U.RELEASES_PAGE, 'https://github.com/mbucc9000/encore/releases');
  assert.equal(U.notesUrl('1.2.0'), 'https://github.com/mbucc9000/encore/releases/tag/v1.2.0');
  const list = require('../src/updatekeys');
  assert.ok(Object.isFrozen(list) && list.length >= 1 && list.length <= 3, 'one to three keys');
  for (const k of list) {
    const raw = Buffer.from(k.key, 'base64');
    assert.equal(raw.length, 32);
    assert.equal(raw.toString('base64'), k.key, 'standard base64');
    assert.equal(k.id, U.keyIdOf(raw), 'the id is the key\'s id');
    assert.ok(!U.RFC_TEST_KEYS.includes(k.key), 'never an RFC 8032 test key');
    assert.match(k.name, /^encore-release-\d+$/);
  }
  assert.deepEqual(U.loadKeys(list).map((k) => k.id), list.map((k) => k.id));
  // the file's format, as the release tools parse it
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'updatekeys.js'), 'utf8');
  assert.match(text, /module\.exports = Object\.freeze\(\[\{ id: '[0-9a-f]{16}', key: '[A-Za-z0-9+/]{43}=', name: 'encore-release-1', added: '\d{4}-\d{2}-\d{2}' \}/);
  // a bridge without the test-only settings: the real hosts and the embedded keys only (nothing is requested here)
  const up = new U.Updater({ cfg: { version: '1.1.0', platformKind: 'docker' }, file: null, get: () => { throw new Error('never requested'); } });
  assert.equal(up.apiBase, 'https://api.github.com');
  assert.equal(up.downloadBase, 'https://github.com');
  assert.equal(up.test, false);
  assert.deepEqual(up.keys.map((k) => k.id), list.map((k) => k.id));
  assert.equal(up.kind, 'docker');
  assert.equal(new U.Updater({ cfg: { version: '1.1.0', platformKind: 'other' }, file: null }).kind, 'other');
  assert.equal(new U.Updater({ cfg: { version: '1.1.0', platformKind: 'windows' }, file: null }).kind, 'other', 'Windows without the launcher');
  // the RFC test keys: in the vectors, never trusted without the test-only settings
  assert.deepEqual([...U.RFC_TEST_KEYS], [KEYS.rfc8032_test1.public_b64, KEYS.rfc8032_test2.public_b64]);
  assert.equal(U.loadKeys([T1]).length, 0);
  assert.equal(U.loadKeys([T1], { allowTest: true }).length, 1);
  assert.equal(U.loadKeys(['not a key', 'AAAA', T1 + 'x'], { allowTest: true }).length, 0);
});

test('vectors: versions (§3.2), tags (§2.5) and the running version\'s forms (§3.1)', () => {
  const V = VECTORS.versions;
  assert.ok(V.compare.length >= 15);
  for (const r of V.compare) {
    const v = U.parseTag(r.tag);
    assert.equal(!!v && U.isNewer(v, r.current), r.offer, JSON.stringify(r));
  }
  for (const t of V.tags_accepted) assert.equal(U.parseTag(t.tag), t.version, t.tag);
  for (const t of V.tags_rejected) assert.equal(U.parseTag(t), null, JSON.stringify(t));
  for (const c of V.current_release) assert.ok(U.parseCurrent(c), c);
  for (const c of V.current_dev) assert.equal(U.parseCurrent(c), null, JSON.stringify(c));
  assert.deepEqual(U.parseCurrent('1.1.0-rc5'), { nums: [1, 1, 0], pre: 'rc5' });
});

test('vectors: SHA256SUMS.txt is parsed strictly', () => {
  const cases = VECTORS.sums.cases;
  assert.ok(cases.length >= 15);
  for (const c of cases) {
    const m = U.parseSums(Buffer.from(c.b64, 'base64'));
    if (c.ok) assert.deepEqual(Object.fromEntries(m), c.entries, c.name);
    else assert.equal(m, null, c.name);
  }
  assert.equal(U.parseSums(null), null);
});

test('vectors: Ed25519 signatures (any key of the trust list; the ids tried; the RFC\'s own vectors)', () => {
  for (const c of VECTORS.signatures.cases) {
    const keys = U.loadKeys(c.trusted.map((n) => KEYS[n].public_b64), { allowTest: true });
    const r = U.verifySig(Buffer.from(c.message_b64, 'base64'), Buffer.from(c.sig_b64, 'base64'), keys);
    assert.equal(r.ok, c.ok, c.name);
    assert.deepEqual(r.tried, c.trusted.map((n) => KEYS[n].id), c.name);
    if (c.ok) assert.ok(c.trusted.map((n) => KEYS[n].id).includes(r.key_id));
    else assert.equal(r.key_id, null);
  }
  for (const k of Object.values(KEYS)) assert.equal(U.keyIdOf(Buffer.from(k.public_hex, 'hex')), k.id);
});

test('redirects: the production rules (API: api.github.com only; downloads: github.com and *.githubusercontent.com, https)', () => {
  const api = (s) => U.apiHopAllowed(new URL(s), null);
  const dl = (s) => U.downloadHopAllowed(new URL(s), null);
  assert.equal(api('https://api.github.com/repositories/4242/releases/latest'), true);
  for (const s of ['http://api.github.com/x', 'https://api.github.com:8443/x', 'https://github.com/x', 'https://api.github.com.evil.example/x',
    'https://user:pw\x40api.github.com/x', 'https://evil.example/x']) assert.equal(api(s), false, s);     // (\x40: the at sign)
  for (const s of ['https://github.com/mbucc9000/encore/releases/download/v1.2.0/a', 'https://release-assets.githubusercontent.com/x?sig=1',
    'https://objects.githubusercontent.com/x']) assert.equal(dl(s), true, s);
  for (const s of ['http://github.com/x', 'http://objects.githubusercontent.com/x', 'https://githubusercontent.com.evil.example/x',
    'https://evilgithubusercontent.com/x', 'https://github.com:444/x', 'https://u@github.com/x', 'https://api.github.com/x', 'https://evil.example/x'])
    assert.equal(dl(s), false, s);
  // with the test-only bases: that origin only
  assert.equal(U.downloadHopAllowed(new URL('http://127.0.0.1:9/dl/x'), 'http://127.0.0.1:9'), true);
  assert.equal(U.downloadHopAllowed(new URL('http://127.0.0.2:9/dl/x'), 'http://127.0.0.1:9'), false);
  assert.equal(U.downloadHopAllowed(new URL('https://github.com/x'), 'http://127.0.0.1:9'), false);
});

// ---------------------------------------------------------------- checks against the fake GitHub
test('a newer release: offered only after its signature verified; the archive\'s hash from the signed list; one log line', () => quiet(async (cap) => {
  const t = await setup();
  try {
    t.gh.setRelease({ tag: 'v1.2.0' });
    assert.equal(t.up.view().state, 'never');
    const v = await t.up.checkNow();
    const tar = t.gh.release.files[TAR];
    assert.deepEqual(v, {
      v: 1, source: 'bridge', kind: 'docker', current: '1.1.0', auto: true, auto_off: null, state: 'available',
      checked_at: '2026-10-12T08:00:00Z', next_check_at: iso(T0 + DAY + 30 * MIN), reused: false,
      latest: { version: '1.2.0', published_at: '2026-10-11T09:30:00Z', notes_url: 'https://github.com/mbucc9000/encore/releases/tag/v1.2.0', asset: TAR,
        size: tar.length, sha256: sha256(tar) },
      error: null, install: null,
    });
    // the API once, the two small files (each a redirect, then the file), never the archive itself
    assert.equal(t.gh.apiCalls().length, 1);
    assert.equal(t.gh.downloadCalls('SHA256SUMS.txt').length, 2);
    assert.equal(t.gh.downloadCalls('SHA256SUMS.txt.sig').length, 2);
    assert.equal(t.gh.downloadCalls(TAR).length, 0);
    assert.deepEqual(cap.lines.map(strip), [`I update check: 1.2.0 available (signature ok, key ${T1_ID})`]);
    // the release's name, notes, author and download links are never read, shown, stored or logged
    const state = fs.readFileSync(path.join(t.dir, 'update.json'), 'utf8');
    for (const text of [JSON.stringify(v), JSON.stringify(t.up.adminView()), state, cap.text()]) {
      assert.ok(!/evil\.example|script|someone-made-up|9\.9\.9|onerror/.test(text), text);
    }
    // the admin page's additions
    assert.deepEqual(t.up.adminView(), { ...t.up.view(), request: null, request_expired: null, request_handled: null, can_install_here: false, relay_missing: false });
  } finally { await t.close(); }
}));

test('older, equal, release-candidate, prerelease, draft and malformed tags: nothing offered, nothing downloaded', () => quiet(async (cap) => {
  const cases = [
    [{ tag: 'v1.1.0' }, 'up to date (1.1.0)'], [{ tag: 'v1.0.9' }, 'up to date (1.1.0)'],
    [{ tag: 'v1.2.0-rc1' }, 'latest release tag isn\'t a final version: ignored'], [{ tag: 'v1.2.0', prerelease: true }, 'latest release tag isn\'t a final version: ignored'],
    [{ tag: 'v1.2.0', draft: true }, 'latest release tag isn\'t a final version: ignored'], [{ tag: '1.2.0' }, 'latest release tag isn\'t a final version: ignored'],
    [{ tag: 'v1.2' }, 'latest release tag isn\'t a final version: ignored'], [{ tag: 'v01.2.0' }, 'latest release tag isn\'t a final version: ignored'],
    [{ tag: 'v1.2.0+b1' }, 'latest release tag isn\'t a final version: ignored'],
  ];
  for (const [rel, line] of cases) {
    const t = await setup();
    try {
      cap.lines.length = 0;
      t.gh.setRelease(rel);
      const v = await t.up.checkNow();
      assert.equal(v.state, 'up_to_date', JSON.stringify(rel));
      assert.equal(v.latest, null);
      assert.equal(v.error, null);
      assert.equal(t.gh.downloadCalls().length, 0, 'nothing downloaded');
      assert.deepEqual(cap.lines.map(strip), ['I update check: ' + line], JSON.stringify(rel));
    } finally { await t.close(); }
  }
}));

test('a release candidate running: the final version is offered; a development build never asks', () => quiet(async () => {
  let t = await setup({ cfg: { version: '1.1.0-rc5' } });
  try {
    t.gh.setRelease({ tag: 'v1.1.0' });
    const v = await t.up.checkNow();
    assert.equal(v.state, 'available');
    assert.equal(v.latest.version, '1.1.0');
  } finally { await t.close(); }
  for (const dev of ['dev', '', '1.1', 'v1.1.0']) {
    t = await setup({ cfg: { version: dev } });
    try {
      t.gh.setRelease({ tag: 'v9.9.9' });
      const v = await t.up.checkNow();
      assert.equal(v.auto_off, 'dev_build');
      assert.equal(v.auto, false);
      assert.equal(v.state, 'never');
      for (let i = 0; i < 5; i++) { await t.up.tick(); t.tick(DAY); }
      assert.equal(t.gh.requests.length, 0, `${JSON.stringify(dev)}: no request at all`);
    } finally { await t.close(); }
  }
}));

test('bad signatures: never offered, a W line with the key ids tried; a missing entry; missing assets', () => quiet(async (cap) => {
  // the good list first (the same bytes every time: made-up content per name)
  const probe = await setup();
  const good = probe.gh.setRelease().files['SHA256SUMS.txt'];
  await probe.close();
  const changed = Buffer.from(good);
  changed[0] = changed[0] === 0x30 ? 0x31 : 0x30;
  const crlf = Buffer.from(good.toString().replace(/\n/g, '\r\n'));
  const sigCases = [
    [{ signedBy: 'rfc8032_test2' }, 'signed with another key'],
    [{ sums: changed }, 'the list changed after signing'],
    [{ sums: crlf }, 'CRLF line ends'],
    [{ sig: Buffer.alloc(64) }, 'zeros'],
  ];
  for (const [rel, why] of sigCases) {
    const t = await setup();
    try {
      cap.lines.length = 0;
      t.gh.setRelease(rel);
      const v = await t.up.checkNow();
      assert.equal(v.state, 'error', why);
      assert.equal(v.latest, null, why);
      assert.deepEqual(v.error, { code: 'bad_signature', version: '1.2.0', retry_at: null, http_status: null }, why);
      assert.deepEqual(cap.lines.map(strip), [`W update check: 1.2.0 not offered: bad_signature (keys tried: ${T1_ID})`], why);
    } finally { await t.close(); }
  }
  // two keys trusted: both ids named
  let t = await setup({ cfg: { updateTestKeys: [T1, KEYS.rfc8032_test2.public_b64] } });
  try {
    cap.lines.length = 0;
    t.gh.setRelease({ sig: Buffer.alloc(64, 7) });
    await t.up.checkNow();
    assert.deepEqual(cap.lines.map(strip), [`W update check: 1.2.0 not offered: bad_signature (keys tried: ${T1_ID}, ${T2_ID})`]);
    // and a release signed with the second key is offered (any key of the list)
    t.tick(2 * MIN);
    t.gh.setRelease({ signedBy: 'rfc8032_test2' });
    assert.equal((await t.up.checkNow()).state, 'available');
    assert.match(cap.lines.map(strip).pop(), new RegExp(`available \\(signature ok, key ${T2_ID}\\)$`));
  } finally { await t.close(); }
  // the RFC-signed release with only the embedded keys trusted (test bases, no test keys): never offered
  t = await setup({ cfg: { updateTestKeys: null } });
  try {
    t.gh.setRelease();
    assert.equal((await t.up.checkNow()).error.code, 'bad_signature');
  } finally { await t.close(); }
  // the signed list lacks this kind's archive: sums_entry_missing
  t = await setup();
  try {
    cap.lines.length = 0;
    t.gh.setRelease({ dropFromSums: TAR });
    const v = await t.up.checkNow();
    assert.deepEqual(v.error, { code: 'sums_entry_missing', version: '1.2.0', retry_at: null, http_status: null });
    assert.deepEqual(cap.lines.map(strip), ['W update check: 1.2.0 not offered: sums_entry_missing']);
  } finally { await t.close(); }
  // a signature that isn't 64 bytes, a missing .sig, list or archive, an archive not uploaded yet: incomplete_release, nothing downloaded
  for (const rel of [{ sig: Buffer.alloc(63) }, { omit: ['SHA256SUMS.txt.sig'] }, { omit: ['SHA256SUMS.txt'] }, { omit: [TAR] }, { notUploaded: [TAR] },
    { signedBy: null }]) {
    t = await setup();
    try {
      cap.lines.length = 0;
      t.gh.setRelease(rel);
      const v = await t.up.checkNow();
      assert.deepEqual(v.error, { code: 'incomplete_release', version: '1.2.0', retry_at: null, http_status: null }, JSON.stringify(rel));
      assert.equal(t.gh.downloadCalls().length, 0);
      assert.deepEqual(cap.lines.map(strip), ['W update check failed: incomplete_release 1.2.0']);
      assert.equal(v.next_check_at, iso(T0 + DAY + 30 * MIN), 'looked at again at the next daily check');
    } finally { await t.close(); }
  }
}));

test('the two small files are fetched once per release (by asset ids and sizes); a re-upload is checked again', () => quiet(async () => {
  const t = await setup();
  try {
    t.gh.api.etag = null;                                      // a full answer every time
    t.gh.setRelease();
    await t.up.checkNow();
    assert.equal(t.gh.downloadCalls().length, 4);
    for (let i = 0; i < 3; i++) {
      t.tick(2 * MIN);
      assert.equal((await t.up.checkNow()).state, 'available');
    }
    assert.equal(t.gh.apiCalls().length, 4);
    assert.equal(t.gh.downloadCalls().length, 4, 'not again');
    // a new process with the same data folder: still cached
    const again = new U.Updater({ cfg: t.cfg, now: () => t.clock.t + 3 * MIN, mono: () => 0, random: () => 0.5 });
    assert.equal((await again.checkNow()).state, 'available');
    assert.equal(t.gh.downloadCalls().length, 4);
    // re-uploaded (new asset ids): fetched and checked again
    t.tick(10 * MIN);
    t.gh.setRelease({ signedBy: 'rfc8032_test2' });
    const v = await t.up.checkNow();
    assert.equal(t.gh.downloadCalls().length, 8);
    assert.equal(v.error.code, 'bad_signature');
  } finally { await t.close(); }
}));

test('ETag: a content hash is sent back; 304 keeps the result and fetches nothing else; a non-hash ETag is never stored or sent', () => quiet(async (cap) => {
  let t = await setup();
  try {
    t.gh.setRelease();
    await t.up.checkNow();
    const etag = JSON.parse(fs.readFileSync(path.join(t.dir, 'update.json'), 'utf8')).etag;
    assert.match(etag, /^W\/"[0-9a-f]{64}"$/);
    assert.equal(t.gh.apiCalls()[0].headers['if-none-match'], undefined, 'nothing to send the first time');
    t.tick(2 * MIN);
    cap.lines.length = 0;
    const v = await t.up.checkNow();
    const second = t.gh.apiCalls()[1];
    assert.equal(second.headers['if-none-match'], etag);
    assert.equal(v.state, 'available');
    assert.equal(v.checked_at, iso(T0 + 2 * MIN));
    assert.equal(t.gh.downloadCalls().length, 4, 'nothing else fetched');
    assert.deepEqual(cap.lines.map(strip), ['I update check: not changed since the last check']);
    assert.ok(!cap.text().includes(etag.slice(3, 20)), 'never the ETag in the log');
    // a 404 drops the result and its ETag
    t.tick(2 * MIN);
    t.gh.api.mode = 404;
    cap.lines.length = 0;
    const n = await t.up.checkNow();
    assert.deepEqual(n.error, { code: 'no_release', version: null, retry_at: null, http_status: null });
    assert.equal(n.state, 'error');
    assert.equal(n.latest, null);
    assert.deepEqual(cap.lines.map(strip), ['I update check: no release published yet']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'update.json'), 'utf8')).etag, null);
    t.tick(2 * MIN);
    t.gh.api.mode = 'ok';
    await t.up.checkNow();
    assert.equal(t.gh.apiCalls()[3].headers['if-none-match'], undefined);
  } finally { await t.close(); }
  // a per-client ETag (a possible tracking value): never stored, never sent
  t = await setup();
  try {
    t.gh.api.etag = 'tracking';
    t.gh.setRelease();
    await t.up.checkNow();
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'update.json'), 'utf8')).etag, null);
    t.tick(2 * MIN);
    await t.up.checkNow();
    assert.equal(t.gh.apiCalls()[1].headers['if-none-match'], undefined);
  } finally { await t.close(); }
}));

test('rate limits: 403 + x-ratelimit-remaining 0 and 429 + retry-after; no request before max(reset, 24 h); a manual check during the limit makes none', () => quiet(async (cap) => {
  const t = await setup();
  try {
    t.gh.setRelease();
    t.gh.api = { ...t.gh.api, mode: 'ratelimit', reset: Math.floor((T0 + 30 * MIN) / 1000) };
    const v = await t.up.checkNow();
    assert.equal(v.state, 'error');
    assert.deepEqual(v.error, { code: 'rate_limited', version: null, retry_at: '2026-10-12T08:30:00Z', http_status: null });
    assert.equal(v.next_check_at, iso(T0 + DAY), 'max(reset, 24 h)');
    assert.deepEqual(cap.lines.map(strip), ['W update check failed: rate_limited until 08:30Z']);
    assert.ok(!cap.text().includes('203.0.113'), 'GitHub\'s message (with an address) is never logged');
    // manual checks while the limit is in force: the stored error, no request
    for (const ms of [2 * MIN, 20 * MIN]) {
      t.tick(ms);
      const r = await t.up.checkNow();
      assert.equal(r.reused, true);
      assert.equal(r.error.code, 'rate_limited');
    }
    assert.equal(t.gh.apiCalls().length, 1);
    // automatic: not before the next check
    for (let i = 0; i < 40; i++) { await t.up.tick(); t.tick(30 * MIN); }
    assert.equal(t.gh.apiCalls().length, 1, 'nothing within 20 h');
    // after the reset a manual check asks again
    t.gh.api.mode = 'ok';
    const r = await t.up.checkNow();
    assert.equal(r.reused, false);
    assert.equal(r.state, 'available');
    assert.equal(t.gh.apiCalls().length, 2);
  } finally { await t.close(); }
  const s = await setup();
  try {
    s.gh.setRelease();
    s.gh.api = { ...s.gh.api, mode: 'retry_after', retryAfter: 120 };
    const v = await s.up.checkNow();
    assert.deepEqual(v.error, { code: 'rate_limited', version: null, retry_at: iso(T0 + 120000), http_status: null });
    // any other error status: http_error with the status
    s.tick(5 * MIN);
    s.gh.api.mode = 500;
    assert.deepEqual((await s.up.checkNow()).error, { code: 'http_error', version: null, retry_at: null, http_status: 500 });
  } finally { await s.close(); }
}));

test('Check now within 60 s of the last contact answers the stored result (reused) without a request', () => quiet(async () => {
  const t = await setup();
  try {
    t.gh.setRelease({ tag: 'v1.1.0' });
    assert.equal((await t.up.checkNow()).reused, false);
    t.tick(59 * 1000);
    const r = await t.up.checkNow();
    assert.equal(r.reused, true);
    assert.equal(r.state, 'up_to_date');
    assert.equal(t.gh.apiCalls().length, 1);
    t.tick(2 * 1000);
    assert.equal((await t.up.checkNow()).reused, false);
    assert.equal(t.gh.apiCalls().length, 2);
    // two at once: one request
    t.tick(2 * MIN);
    const [a, b] = await Promise.all([t.up.checkNow(), t.up.checkNow()]);
    assert.equal(t.gh.apiCalls().length, 3);
    assert.deepEqual(a.state, b.state);
  } finally { await t.close(); }
}));

test('offline (nothing listening): offline, again in 1 h, no contact recorded; a stalled answer: timeout, again in 24 h', () => quiet(async (cap) => {
  const closed = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const base = `http://127.0.0.1:${closed}`;
  let t = await setup({ cfg: { updateApiBase: base, updateDownloadBase: base } });
  try {
    const v = await t.up.checkNow();
    assert.deepEqual(v.error, { code: 'offline', version: null, retry_at: null, http_status: null });
    assert.equal(v.state, 'error');
    assert.equal(v.checked_at, null, 'GitHub wasn\'t contacted');
    assert.equal(v.next_check_at, iso(T0 + HOUR));
    assert.deepEqual(cap.lines.map(strip), ['W update check failed: offline']);
    // an automatic retry an hour later is allowed (no contact was made)
    t.tick(HOUR);
    assert.equal(await t.up.tick(), true);
  } finally { await t.close(); }
  t = await setup({ timeoutMs: 300 });
  try {
    cap.lines.length = 0;
    t.gh.api.mode = 'stall';
    const v = await t.up.checkNow();
    assert.deepEqual(v.error, { code: 'timeout', version: null, retry_at: null, http_status: null });
    assert.equal(v.checked_at, iso(T0), 'it may have reached GitHub');
    assert.equal(v.next_check_at, iso(T0 + DAY + 30 * MIN));
    assert.deepEqual(cap.lines.map(strip), ['W update check failed: timeout']);
  } finally { await t.close(); }
  assert.ok(!cap.text().includes('127.0.0.1') && !cap.text().includes('ECONNREFUSED'), cap.text());
}));

test('answers that can\'t be used: oversized, broken JSON, a refused or endless redirect: bad_answer; a renamed repo\'s redirect is followed', () => quiet(async (cap) => {
  for (const mode of ['oversize', 'badjson', 'redirect_bad_host', 'redirect_http', 'redirect_loop']) {
    const t = await setup();
    try {
      cap.lines.length = 0;
      t.gh.setRelease();
      t.gh.api.mode = mode;
      const v = await t.up.checkNow();
      assert.deepEqual(v.error, { code: 'bad_answer', version: null, retry_at: null, http_status: null }, mode);
      assert.deepEqual(cap.lines.map(strip), ['W update check failed: bad_answer'], mode);
      if (mode === 'redirect_loop') assert.equal(t.gh.apiCalls().length, 4, 'the request and at most 3 redirects');
    } finally { await t.close(); }
  }
  const t = await setup();
  try {
    t.gh.setRelease();
    t.gh.api.mode = 'redirect';
    const v = await t.up.checkNow();
    assert.equal(v.state, 'available');
    assert.deepEqual(t.gh.apiCalls().map((q) => q.path), ['/repos/mbucc9000/encore/releases/latest', '/repositories/4242/releases/latest']);
  } finally { await t.close(); }
  assert.ok(!/evil|127\.0\.0|http/.test(cap.text()), cap.text());
}));

test('the small files\' downloads: a missing one is incomplete_release; a refused or endless redirect bad_answer; a stall a timeout', () => quiet(async () => {
  const cases = [['SHA256SUMS.txt', 'missing', 'incomplete_release'], ['SHA256SUMS.txt.sig', 'missing', 'incomplete_release'],
    ['SHA256SUMS.txt.sig', 'bad_host', 'bad_answer'], ['SHA256SUMS.txt', 'http', 'bad_answer'], ['SHA256SUMS.txt', 'loop', 'bad_answer'],
    ['SHA256SUMS.txt', 'stall', 'timeout'], ['SHA256SUMS.txt.sig', 'cut', 'timeout']];
  for (const [name, mode, code] of cases) {
    const t = await setup({ timeoutMs: 400 });
    try {
      t.gh.setRelease();
      t.gh.dl[name] = mode;
      const v = await t.up.checkNow();
      assert.equal(v.state, 'error', `${name} ${mode}`);
      assert.equal(v.error.code, code, `${name} ${mode}`);
      assert.equal(v.next_check_at, iso(T0 + DAY + 30 * MIN), 'GitHub was contacted: the next daily check');
      if (mode === 'loop') assert.equal(t.gh.downloadCalls(name).length, 6, 'the request and at most 5 redirects');
      // the next check fetches them again (nothing was cached)
      t.gh.dl = {};
      t.tick(2 * MIN);
      assert.equal((await t.up.checkNow()).state, 'available', `${name} ${mode}: then fine`);
    } finally { await t.close(); }
  }
}));

test('a failed check keeps a newer version found earlier (its error shown with it); an update of the bridge itself ends the offer', () => quiet(async () => {
  const t = await setup();
  try {
    t.gh.setRelease();
    await t.up.checkNow();
    t.tick(2 * MIN);
    t.gh.api.mode = 500;
    const v = await t.up.checkNow();
    assert.equal(v.state, 'available');
    assert.equal(v.latest.version, '1.2.0');
    assert.deepEqual(v.error, { code: 'http_error', version: null, retry_at: null, http_status: 500 });
    // the bridge is now 1.2.0 (Docker: a new container on the same data folder): nothing offered, nothing asked
    const now = new U.Updater({ cfg: { ...t.cfg, version: '1.2.0' }, now: () => t.clock.t, mono: () => 0, random: () => 0.5 });
    const w = now.view();
    assert.equal(w.latest, null);
    assert.notEqual(w.state, 'available');
    assert.equal(t.gh.apiCalls().length, 2);
  } finally { await t.close(); }
}));

// ---------------------------------------------------------------- the prebuilt images (DESIGN-DOCKER-IMAGES.md §5.2)
const COMPOSE = 'encore-docker-compose.yaml';
const withCompose = (v) => [...assetNames(v), COMPOSE];          // a release from 1.3.0 on: the compose file too

test('the prebuilt images: the kind from the settings, the compose file as its asset, the hour\'s wait (constants)', () => {
  const kind = (c) => new U.Updater({ cfg: { version: '1.2.1', ...c }, file: null, get: () => { throw new Error('never requested'); } }).kind;
  assert.equal(kind({ platformKind: 'docker', prebuiltImage: true }), 'docker-image');
  assert.equal(kind({ platformKind: 'docker', prebuiltImage: false }), 'docker');
  assert.equal(kind({ platformKind: 'docker' }), 'docker');
  assert.equal(kind({ platformKind: 'other', prebuiltImage: true }), 'other');
  assert.equal(kind({ platformKind: 'windows', prebuiltImage: true }), 'other');
  // through config.js: ENCORE_PREBUILT=1 inside a container
  const dataDir = tmp();
  const load = (env, exists) => require('../src/config').load({ DATA_DIR: dataDir, ...env }, { platform: 'linux', exists });
  assert.equal(kind(load({ ENCORE_PREBUILT: '1' }, (f) => f === '/.dockerenv')), 'docker-image');
  assert.equal(kind(load({ ENCORE_PREBUILT: '' }, (f) => f === '/.dockerenv')), 'docker');
  assert.equal(kind(load({ ENCORE_PREBUILT: '1' }, () => false)), 'other');
  assert.deepEqual([...U.KINDS], ['windows-installer', 'windows-zip', 'docker', 'docker-image', 'other']);
  assert.equal(U.COMPOSE_ASSET, COMPOSE);
  assert.equal(U.assetFor('docker-image', '1.3.0'), COMPOSE, 'no version in its name');
  assert.equal(U.assetFor('docker', '1.3.0'), 'Encore-1.3.0-source.tar.gz');
  assert.equal(U.assetFor('other', '1.3.0'), 'Encore-1.3.0-source.tar.gz');
  assert.equal(U.IMAGE_WAIT_MS, HOUR);
  // the constants block's line the release selftest reads
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'update.js'), 'utf8'), /^const COMPOSE_ASSET = 'encore-docker-compose\.yaml';$/m);
});

test('the prebuilt images: offered when the signed list names the compose file (never downloaded); not in the release or the list: not offered', () => quiet(async (cap) => {
  let t = await setup({ cfg: { prebuiltImage: true } });
  try {
    t.gh.setRelease({ tag: 'v1.2.0', files: withCompose('1.2.0') });
    const v = await t.up.checkNow();
    const yml = t.gh.release.files[COMPOSE];
    assert.equal(v.kind, 'docker-image');
    assert.equal(v.state, 'available');
    assert.deepEqual(v.latest, { version: '1.2.0', published_at: '2026-10-11T09:30:00Z', notes_url: 'https://github.com/mbucc9000/encore/releases/tag/v1.2.0',
      asset: COMPOSE, size: yml.length, sha256: sha256(yml) });
    assert.equal(t.gh.apiCalls().length, 1);
    assert.equal(t.gh.downloadCalls().length, 4, 'the two small files only (each a redirect, then the file)');
    assert.equal(t.gh.downloadCalls(COMPOSE).length, 0, 'the compose file is never downloaded');
    assert.deepEqual(cap.lines.map(strip), [`I update check: 1.2.0 available (signature ok, key ${T1_ID})`]);
    const j = JSON.parse(fs.readFileSync(path.join(t.dir, 'update.json'), 'utf8'));
    assert.deepEqual(Object.keys(j.result.assets).sort(), ['SHA256SUMS.txt', 'SHA256SUMS.txt.sig', COMPOSE], 'only what this kind needs');
    assert.deepEqual(Object.keys(j.verified.sha256), [COMPOSE]);
    assert.equal(t.up.adminView().can_install_here, false);
  } finally { await t.close(); }
  // a release without the compose file, or with it not uploaded yet: incomplete_release, nothing downloaded
  for (const rel of [{ tag: 'v1.2.0' }, { tag: 'v1.2.0', files: withCompose('1.2.0'), notUploaded: [COMPOSE] }]) {
    t = await setup({ cfg: { prebuiltImage: true } });
    try {
      cap.lines.length = 0;
      t.gh.setRelease(rel);
      const v = await t.up.checkNow();
      assert.equal(v.state, 'error', JSON.stringify(rel));
      assert.equal(v.latest, null);
      assert.deepEqual(v.error, { code: 'incomplete_release', version: '1.2.0', retry_at: null, http_status: null });
      assert.equal(t.gh.downloadCalls().length, 0);
      assert.deepEqual(cap.lines.map(strip), ['W update check failed: incomplete_release 1.2.0']);
    } finally { await t.close(); }
  }
  // in the release, not in the signed list: sums_entry_missing
  t = await setup({ cfg: { prebuiltImage: true } });
  try {
    cap.lines.length = 0;
    t.gh.setRelease({ tag: 'v1.2.0', files: withCompose('1.2.0'), dropFromSums: COMPOSE });
    const v = await t.up.checkNow();
    assert.equal(v.latest, null);
    assert.deepEqual(v.error, { code: 'sums_entry_missing', version: '1.2.0', retry_at: null, http_status: null });
    assert.deepEqual(cap.lines.map(strip), ['W update check: 1.2.0 not offered: sums_entry_missing']);
  } finally { await t.close(); }
  // a source build on that same release: its archive, as before
  t = await setup();
  try {
    t.gh.setRelease({ tag: 'v1.2.0', files: withCompose('1.2.0'), dropFromSums: COMPOSE });
    const v = await t.up.checkNow();
    assert.deepEqual([v.kind, v.state, v.latest.asset], ['docker', 'available', TAR]);
  } finally { await t.close(); }
}));

test('the prebuilt images: the card an hour after the release was published, with no request for it; a source build at once', () => quiet(async () => {
  const pub = T0 - 30 * MIN;
  let t = await setup({ cfg: { prebuiltImage: true } });
  try {
    t.gh.setRelease({ tag: 'v1.2.0', files: withCompose('1.2.0'), published_at: iso(pub) });
    let v = await t.up.checkNow();
    assert.deepEqual([v.state, v.latest, v.error, v.checked_at], ['up_to_date', null, null, iso(T0)]);
    // Check now during the wait: GitHub is asked, the card still waits
    t.tick(10 * MIN);
    v = await t.up.checkNow();
    assert.deepEqual([v.reused, v.state, v.latest], [false, 'up_to_date', null]);
    assert.equal(t.gh.apiCalls().length, 2);
    const n = t.gh.requests.length;
    t.tick(19 * MIN);                                          // 59 minutes after publishing
    assert.equal(t.up.view().state, 'up_to_date');
    assert.equal(t.up.adminView().latest, null);
    t.tick(1 * MIN);                                           // the hour is up: from what was already checked
    v = t.up.view();
    assert.equal(v.state, 'available');
    assert.deepEqual([v.latest.version, v.latest.asset, v.latest.published_at], ['1.2.0', COMPOSE, iso(pub)]);
    assert.equal(t.gh.requests.length, n, 'no new request to GitHub');
    // a new process on the same data folder (a restarted container): the hour counts from the release, not its start
    const again = new U.Updater({ cfg: t.cfg, now: () => t.clock.t, mono: () => 0, random: () => 0.5 });
    assert.equal(again.view().state, 'available');
    assert.equal(t.gh.requests.length, n);
  } finally { await t.close(); }
  // kind docker (a source build): never delayed
  t = await setup();
  try {
    t.gh.setRelease({ tag: 'v1.2.0', files: withCompose('1.2.0'), published_at: iso(T0 - MIN) });
    const v = await t.up.checkNow();
    assert.deepEqual([v.state, v.latest.asset], ['available', TAR]);
  } finally { await t.close(); }
  // a release time that can't be read: no wait
  t = await setup({ cfg: { prebuiltImage: true } });
  try {
    t.gh.setRelease({ tag: 'v1.2.0', files: withCompose('1.2.0'), published_at: null });
    const v = await t.up.checkNow();
    assert.deepEqual([v.state, v.latest.asset, v.latest.published_at], ['available', COMPOSE, null]);
  } finally { await t.close(); }
}));

test('the prebuilt images: a data folder moved from a source build is checked again for the compose file by itself (and back)', () => quiet(async () => {
  const t = await setup();                                     // a source build first
  try {
    t.gh.setRelease({ tag: 'v1.2.0', files: withCompose('1.2.0') });
    assert.equal((await t.up.checkNow()).latest.asset, TAR);
    assert.equal(t.gh.downloadCalls().length, 4);
    // the same data folder under the prebuilt images (a new container), a few minutes later
    t.tick(5 * MIN);
    const img = new U.Updater({ cfg: { ...t.cfg, prebuiltImage: true }, now: () => t.clock.t, mono: () => t.clock.m, random: () => 0.5 });
    assert.equal(img.kind, 'docker-image');
    assert.equal(img.view().latest, null, 'what is stored was checked for the archive, not the compose file');
    let v = await img.checkNow();
    const yml = t.gh.release.files[COMPOSE];
    assert.equal(v.state, 'available');
    assert.deepEqual([v.latest.asset, v.latest.sha256], [COMPOSE, sha256(yml)]);
    assert.equal(t.gh.apiCalls()[1].headers['if-none-match'], undefined, 'the full answer: the stored one lists only the archive');
    assert.equal(t.gh.downloadCalls().length, 8, 'the signed list fetched and checked again');
    assert.equal(t.gh.downloadCalls(COMPOSE).length, 0);
    // from then on the ETag works as before
    t.tick(5 * MIN);
    v = await img.checkNow();
    assert.equal(v.state, 'available');
    assert.match(String(t.gh.apiCalls()[2].headers['if-none-match']), /^W\/"[0-9a-f]{64}"$/);
    assert.equal(t.gh.downloadCalls().length, 8);
    // and back to a source build: the archive checked again
    t.tick(5 * MIN);
    const back = new U.Updater({ cfg: t.cfg, now: () => t.clock.t, mono: () => t.clock.m, random: () => 0.5 });
    v = await back.checkNow();
    assert.deepEqual([v.kind, v.state, v.latest.asset], ['docker', 'available', TAR]);
    assert.equal(t.gh.downloadCalls().length, 12);
  } finally { await t.close(); }
}));

// ---------------------------------------------------------------- the schedule
test('the schedule: at most one automatic GitHub contact a day over a simulated week (30-minute looks)', () => quiet(async () => {
  const t = await setup();
  try {
    t.gh.setRelease({ tag: 'v1.1.0' });
    const at = [];
    for (let i = 0; i < 7 * 48; i++) {
      const n = t.gh.apiCalls().length;
      await t.up.tick();
      if (t.gh.apiCalls().length > n) at.push(t.clock.t);
      t.tick(30 * MIN);
    }
    assert.equal(at.length, 7, at.map(iso).join(' '));
    assert.equal(at[0], T0, 'missing state: due at the first look');
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= DAY, iso(at[i]));
  } finally { await t.close(); }
}));

test('UPDATE_CHECK=0: no automatic request in a week; Check now still works; the view says so', () => quiet(async () => {
  const t = await setup({ cfg: { updateCheck: false } });
  try {
    t.gh.setRelease();
    for (let i = 0; i < 7 * 48; i++) { await t.up.tick(); t.tick(30 * MIN); }
    assert.equal(t.gh.requests.length, 0);
    assert.deepEqual([t.up.view().auto, t.up.view().auto_off], [false, 'setting']);
    const v = await t.up.checkNow();
    assert.equal(v.state, 'available');
    assert.equal(v.next_check_at, null, 'no automatic check is coming');
    assert.equal(t.gh.apiCalls().length, 1);
  } finally { await t.close(); }
}));

test('the clock going back: no extra contacts (23 h apart in one process), and never a wait of more than a day', () => quiet(async () => {
  const t = await setup();
  try {
    t.gh.setRelease({ tag: 'v1.1.0' });
    assert.equal(await t.up.tick(), true);
    // the wall clock jumps back three days; the process's monotonic clock goes on
    t.clock.t -= 3 * DAY;
    const at = [];
    for (let i = 0; i < 4 * 48; i++) {
      t.clock.t += 30 * MIN;
      t.clock.m += 30 * MIN;
      const n = t.gh.apiCalls().length;
      await t.up.tick();
      if (t.gh.apiCalls().length > n) at.push(i);
    }
    assert.ok(at.length >= 3 && at.length <= 4, String(at));
    assert.ok(at[0] >= 46 && at[0] <= 50, 'the next contact about a day after the jump, not three days later: ' + at[0]);
    for (let i = 1; i < at.length; i++) assert.ok((at[i] - at[i - 1]) * 30 * MIN >= 23 * HOUR);
    // a new process reading a last contact "in the future": due within a day, not when the old date says
    const later = JSON.parse(fs.readFileSync(path.join(t.dir, 'update.json'), 'utf8'));
    const st = { ...later, last_contact: iso(T0 + 10 * DAY), next_check: iso(T0 + 11 * DAY) };
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify(st));
    const clock = { t: T0 };
    const fresh = new U.Updater({ cfg: { ...t.cfg, dataDir: dir }, now: () => clock.t, mono: () => 0, random: () => 0.5 });
    assert.equal(fresh.due(), false);
    assert.equal(fresh.st.next_check, iso(T0 + DAY));
    assert.equal(fresh.st.last_contact, iso(T0), 'a last contact in the future counts as now');
    clock.t += DAY;
    assert.equal(fresh.due(), true);
  } finally { await t.close(); }
}));

test('the clock jumping forward: still never two automatic contacts less than 23 h apart in one process', () => quiet(async () => {
  const t = await setup();
  try {
    t.gh.setRelease({ tag: 'v1.1.0' });
    assert.equal(await t.up.tick(), true);
    t.clock.t += 3 * DAY;                                      // the wall clock leaps; the monotonic one doesn't
    const at = [];
    for (let i = 1; i <= 2 * 48; i++) {
      t.clock.t += 30 * MIN;
      t.clock.m += 30 * MIN;
      const n = t.gh.apiCalls().length;
      await t.up.tick();
      if (t.gh.apiCalls().length > n) at.push(i);
    }
    assert.ok(at.length >= 1, 'it does check again');
    assert.equal(at[0], 46, 'not before 23 h of the process\'s own time: ' + at[0]);
    for (let i = 1; i < at.length; i++) assert.ok((at[i] - at[i - 1]) * 30 * MIN >= 23 * HOUR);
  } finally { await t.close(); }
}));

test('start(): the first look 10 minutes after start, then every 30 minutes, timers unref\'d; stop() clears them', () => {
  const made = [];
  const timer = (kind) => (fn, ms) => { const h = { kind, fn, ms, unrefd: false, unref() { this.unrefd = true; } }; made.push(h); return h; };
  const cleared = [];
  const up = new U.Updater({ cfg: { version: '1.1.0', platformKind: 'docker' }, file: null, setLater: timer('later'), setEvery: timer('every'),
    clearLater: (h) => cleared.push(h), get: () => { throw new Error('never'); } });
  up.tick = () => { up.ticks = (up.ticks || 0) + 1; return Promise.resolve(false); };
  up.start();
  up.start();
  assert.deepEqual(made.map((h) => [h.kind, h.ms, h.unrefd]), [['later', 10 * MIN, true]]);
  made[0].fn();
  assert.equal(up.ticks, 1);
  assert.deepEqual(made.map((h) => [h.kind, h.ms, h.unrefd]), [['later', 10 * MIN, true], ['every', 30 * MIN, true]]);
  up.stop();
  assert.deepEqual(cleared, made);
  assert.equal(U.FIRST_LOOK_MS, 10 * MIN);
  assert.equal(U.LOOK_EVERY_MS, 30 * MIN);
  // no schedule at all for a development build or with UPDATE_CHECK=0
  made.length = 0;
  for (const cfg of [{ version: 'dev', platformKind: 'docker' }, { version: '1.1.0', platformKind: 'docker', updateCheck: false }]) {
    const x = new U.Updater({ cfg, file: null, setLater: timer('later'), setEvery: timer('every'), get: () => { throw new Error('never'); } });
    x.start();
  }
  assert.deepEqual(made, []);
});

// ---------------------------------------------------------------- privacy, the state file, the log
test('privacy: every request carries only the fixed headers (User-Agent EncoreBridge/<version>), no query, no cookie', () => quiet(async (cap) => {
  const t = await setup();
  try {
    t.gh.setRelease();
    await t.up.checkNow();                 // API (Set-Cookie in its answer) + 2 x (redirect + file)
    t.tick(2 * MIN);
    await t.up.checkNow();                 // If-None-Match -> 304
    t.tick(2 * MIN);
    t.gh.setRelease({ tag: 'v1.3.0' });
    await t.up.checkNow();
    assert.ok(t.gh.requests.length >= 10);
    const firstHops = new Set();
    for (const q of t.gh.requests) {
      const names = Object.keys(q.headers).sort();
      const want = ['accept', 'connection', 'host', 'user-agent', 'x-github-api-version'];
      if (q.headers['if-none-match']) want.push('if-none-match');
      assert.deepEqual(names, want.sort(), q.path);
      assert.equal(q.headers['user-agent'], 'EncoreBridge/1.1.0');
      assert.equal(q.headers.accept, 'application/vnd.github+json');
      assert.equal(q.headers['x-github-api-version'], '2022-11-28');
      assert.equal(q.method, 'GET');
      if (!q.path.startsWith('/dl/')) firstHops.add(q.query);
    }
    assert.deepEqual([...firstHops], [''], 'no query string on any request Encore makes itself');
    assert.ok(t.gh.requests.filter((q) => q.headers['if-none-match']).every((q) => q.path.startsWith('/repos/')), 'the ETag only to the API');
    // the log: codes and versions only
    const text = cap.text();
    assert.ok(!/127\.0\.0\.1|https?:|W\/"|\/dl\/|sig=|tmp|encore-update-/.test(text), text);
    assert.ok(!text.includes(t.dir));
  } finally { await t.close(); }
}));

test('the state file: <DATA_DIR>/update.json with times, versions, ids, sizes, a hash and codes only; read back; anything odd starts fresh', () => quiet(async (cap) => {
  const t = await setup();
  try {
    t.gh.setRelease();
    await t.up.checkNow();
    const file = path.join(t.dir, 'update.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(j).sort(), ['error', 'etag', 'last_contact', 'next_check', 'result', 'v', 'verified']);
    assert.equal(j.v, 1);
    assert.deepEqual(Object.keys(j.result.assets).sort(), ['Encore-1.2.0-source.tar.gz', 'SHA256SUMS.txt', 'SHA256SUMS.txt.sig'], 'only what this kind needs');
    assert.equal(j.result.state, 'available');
    assert.equal(j.verified.key_id, T1_ID);
    assert.ok(!/https?:|127\.0\.0|evil|tmp|\\\\|\/home\//.test(JSON.stringify(j)), JSON.stringify(j));
    assert.ok(!fs.existsSync(file + '.tmp'), 'written with temp + rename');
    // read back by a new process: the same view, no request
    const n = t.gh.requests.length;
    const again = new U.Updater({ cfg: t.cfg, now: () => t.clock.t, mono: () => 0, random: () => 0.5 });
    assert.deepEqual(again.view(), t.up.view());
    assert.equal(t.gh.requests.length, n);
    // unreadable, a newer format, wrong types: a fresh start (and a check is due)
    for (const body of ['{nope', JSON.stringify({ v: 2, last_contact: iso(T0) }), JSON.stringify({ v: 1, last_contact: 'yesterday', next_check: 5, etag: 'x',
      result: { version: '<b>', assets: [] }, verified: { version: '1.2.0' }, error: { code: 'something' } })]) {
      cap.lines.length = 0;
      fs.writeFileSync(file, body);
      const u = new U.Updater({ cfg: t.cfg, now: () => t.clock.t, mono: () => 0, random: () => 0.5 });
      assert.deepEqual(u.st, { v: 1, last_contact: null, next_check: null, etag: null, result: null, verified: null, error: null }, body);
      assert.equal(u.view().state, 'never');
      assert.equal(u.due(), true);
      assert.ok(!cap.text().includes('nope'));
    }
  } finally { await t.close(); }
}));
