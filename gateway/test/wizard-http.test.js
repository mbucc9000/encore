'use strict';
// The setup guide over HTTP (http.js + wizard.js + clientid.js + netcheck.js; DESIGN-WIZARD.md §2-§4): every new
// admin route behind the network gate and the password (401), closed in setup mode (503), cross-site POSTs and proxy
// headers refused (403); the Client ID route's answers, its live apply (a new sign-in link carries the new ID at once,
// a replace disconnects the account and deletes tokens.json), a log without the ID; Showcase trimming; the additions
// to /admin/api/setup, /admin/api/status (app_repo, no repo) and /local/v1/status; step 8's tick: a signed phone
// request from a public peer (made up: 203.0.113.9) ticks it, a private, shared or loopback peer or an unsigned
// request doesn't, and the peer address is never logged or saved; /repo/ is an ordinary unknown path now. A local
// server with stubs: no engine, no Spotify. (The public-IP route has its own file: public-ip.test.js.)
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { wizardServer, capture, cleanup, AUTH, NAMES, DEFAULT_APP_REPO } = require('./support/wizard-server');

after(cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const V = '0123456789abcdef0123456789abcdef';
const W = 'fedcba9876543210fedcba9876543210';
const TOKEN = 'c0ffee'.repeat(10) + 'beef';
const L = { 'X-Encore-Launcher': TOKEN };

const ROUTES = [
  ['GET', '/admin/api/wizard'],
  ['POST', '/admin/api/wizard', { action: 'dismiss' }],
  ['POST', '/admin/api/wizard/client-id', { client_id: V }],
  ['GET', '/admin/api/wizard/network'],
  ['GET', '/admin/api/wizard/network?fresh=1'],
  ['POST', '/admin/api/wizard/public-ip', {}],
];

test('every new route: 401 without the password, 403 through a proxy or from another address, 503 in setup mode', async () => {
  let s = await wizardServer();
  try {
    for (const [method, p, body] of ROUTES) {
      let r = await s.call(p, { method, body });
      assert.equal(r.status, 401, `${method} ${p} without the password`);
      assert.match(r.headers['www-authenticate'], /^Basic realm="Encore Bridge"/);
      r = await s.call(p, { method, body, headers: { Authorization: 'Basic ' + Buffer.from('admin:wrong-made-up').toString('base64') } });
      assert.equal(r.status, 401, `${method} ${p} with a wrong password`);
      r = await s.call(p, { method, body, headers: { ...AUTH, 'X-Forwarded-For': '203.0.113.10' } });
      assert.equal(r.status, 403, `${method} ${p} through a proxy`);
      assert.equal(r.j.error.code, 'proxied');
    }
    s.ctx.adminAuth.allowed = () => false;
    for (const [method, p, body] of ROUTES) {
      const r = await s.call(p, { method, body, headers: AUTH });
      assert.equal(r.status, 403, `${method} ${p} from outside ADMIN_ALLOW`);
      assert.equal(r.j.error.code, 'forbidden');
    }
  } finally { await s.close(); }
  s = await wizardServer({ adminPassword: '' });
  try {
    for (const [method, p, body] of ROUTES) {
      const r = await s.call(p, { method, body, headers: AUTH });
      assert.equal(r.status, 503, `${method} ${p} in setup mode`);
      assert.equal(r.j.error.code, 'admin_setup');
    }
    assert.ok(!fs.existsSync(path.join(s.dir, 'settings.json')), 'no Client ID was saved in setup mode');
    const su = (await s.call('/admin/api/setup')).j;
    assert.deepEqual(su, { setup: true, code_needed: true, min_length: 8, platform: 'other' });
    const page = await s.call('/admin');
    assert.equal(page.status, 200, 'the page itself opens in setup mode (it shows the guide\'s step 1)');
    assert.match(page.text, /Setup guide/);
  } finally { await s.close(); }
});

test('cross-site writes: a non-JSON body or another Origin is 403, and nothing changes', async () => {
  const s = await wizardServer();
  try {
    for (const [p, body] of [['/admin/api/wizard', { action: 'complete' }], ['/admin/api/wizard/client-id', { client_id: V }]]) {
      let r = await s.call(p, { method: 'POST', headers: AUTH, body: JSON.stringify(body), type: 'text/plain' });
      assert.equal(r.status, 403, `${p} text/plain`);
      assert.equal(r.j.error.code, 'cross_site');
      r = await s.call(p, { method: 'POST', headers: AUTH, body: JSON.stringify(body), type: null });
      assert.equal(r.status, 403, `${p} no content type`);
      r = await s.call(p, { method: 'POST', headers: { ...AUTH, Origin: 'http://evil.example' }, body });
      assert.equal(r.status, 403, `${p} another Origin`);
      r = await s.call(p, { method: 'POST', headers: { ...AUTH, Origin: 'null' }, body });
      assert.equal(r.status, 403, `${p} Origin null`);
    }
    const w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.equal(w.complete, false);
    assert.equal(w.steps.client_id.done, false);
    // the page itself (same Origin) may
    const r = await s.call('/admin/api/wizard', { method: 'POST', headers: { ...AUTH, Origin: `http://127.0.0.1:${s.port}` }, body: { action: 'skip', step: 'network' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.j.skipped, ['network']);
  } finally { await s.close(); }
});

test('GET/POST /admin/api/wizard: the answer, skip / dismiss / complete, bad actions 400, no-store', async () => {
  const s = await wizardServer();
  try {
    let r = await s.call('/admin/api/wizard', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.j.show, true);
    assert.equal(r.j.platform, 'other');
    assert.deepEqual(r.j.steps.password, { done: true, how: 'env' });
    for (const body of [{ action: 'skip', step: 'password' }, { action: 'skip', step: 'x' }, { action: 'nope' }, {}, 'null', '[1]']) {
      r = await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.j.error.code, 'bad_request');
    }
    r = await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body: '{broken' });
    assert.equal(r.status, 400);
    // the body limit is 1 KB: refused (a 413, or the connection is dropped while the body still comes in), nothing changes
    r = await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body: { action: 'skip', step: 'app', pad: 'x'.repeat(2000) } })
      .catch(() => ({ status: 'dropped' }));
    assert.ok(r.status === 413 || r.status === 'dropped', String(r.status));
    assert.deepEqual((await s.call('/admin/api/wizard', { headers: AUTH })).j.skipped, []);
    r = await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body: { action: 'skip', step: 'engine' } });
    assert.deepEqual(r.j.skipped, ['engine']);
    r = await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body: { action: 'dismiss' } });
    assert.equal(r.j.dismissed, true);
    assert.equal(r.j.show, false);
    let st = (await s.call('/admin/api/status', { headers: AUTH })).j;
    assert.deepEqual(st.setup, { complete: false, dismissed: true }, 'the banner stays until complete');
    r = await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body: { action: 'complete' } });
    assert.equal(r.j.complete, true);
    assert.equal(r.j.complete_how, 'finished');
    st = (await s.call('/admin/api/status', { headers: AUTH })).j;
    assert.deepEqual(st.setup, { complete: true, dismissed: true });
    assert.equal(st.app_repo, DEFAULT_APP_REPO, 'the Phone setup card\'s Encore repo line');
    assert.ok(!('repo' in st), 'no built-in Cydia source any more');
    assert.equal((await s.call('/admin/api/wizard', { method: 'PUT', headers: AUTH, body: {} })).status, 404);
  } finally { await s.close(); }
});

test('the Client ID: bad_client_id, saved to data/settings.json, applied at once (a new sign-in link carries it), never logged', async () => {
  const cap = capture();
  let s;
  try {
    s = await wizardServer();
    let r = await s.call('/admin/api/spotify/login', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 503);
    assert.equal(r.j.error.code, 'no_client_id');
    assert.equal(r.j.error.message, 'Add your Spotify Client ID in the setup guide (step 2) first.');
    for (const bad of ['', 'abc', V + '0', 'g'.repeat(32), `${V.slice(0, 31)} `.padEnd(33, 'x'), null]) {
      r = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: bad } });
      assert.equal(r.status, 400, String(bad));
      assert.equal(r.j.error.code, 'bad_client_id');
      assert.equal(r.j.error.message, 'That isn\'t a Client ID. It is 32 letters (a-f) and digits, under Settings → Basic Information in your developer app. (Not the client secret.)');
    }
    r = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: `  ${V.toUpperCase()}\n` } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.j, { ok: true, source: 'data', hint: '…cdef', disconnected: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'settings.json'), 'utf8')), { v: 1, spotify_client_id: V });
    r = await s.call('/admin/api/spotify/login', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(new URL(r.j.url).searchParams.get('client_id'), V, 'no restart needed');
    const w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.deepEqual(w.steps.client_id, { done: true, source: 'data', editable: true, hint: '…cdef' });
    assert.equal(w.steps.spotify.configured, true);
    assert.equal(s.cfg.spotifyClientId, V);
    assert.equal(s.cfg.spotifyClientIdSource, 'data');
    // the same one again: 200, nothing written
    const before = fs.statSync(path.join(s.dir, 'settings.json')).mtimeMs;
    await sleep(20);
    r = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: V } });
    assert.equal(r.status, 200);
    assert.equal(fs.statSync(path.join(s.dir, 'settings.json')).mtimeMs, before);
    // another one with no account connected: no question
    r = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: W } });
    assert.deepEqual(r.j, { ok: true, source: 'data', hint: '…3210', disconnected: false });
    r = await s.call('/admin/api/spotify/login', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(new URL(r.j.url).searchParams.get('client_id'), W);
  } finally { cap.restore(); if (s) await s.close(); }
  const text = cap.text();
  for (const v of [V, W, V.toUpperCase(), V.slice(4), W.slice(4)]) assert.ok(!text.includes(v), `${v} in the log:\n${text}`);
  assert.ok(cap.lines.some((l) => /Spotify Client ID saved \(data\/settings\.json\)$/.test(l)), text);
});

test('the Client ID with an account connected: client_id_replace, then replace: true deletes tokens.json and disconnects', async () => {
  const cap = capture();
  let s;
  try {
    s = await wizardServer({ clientId: V, tokens: true, cfg: { spotifyClientId: V, spotifyClientIdSource: 'data' } });
    assert.equal(s.ctx.webapi.ready, true);
    let r = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: W } });
    assert.equal(r.status, 409);
    assert.equal(r.j.error.code, 'client_id_replace');
    assert.equal(r.j.error.message, 'Changing the Client ID disconnects your Spotify account. You\'ll connect it again in the next step. Change it?');
    assert.ok(fs.existsSync(path.join(s.dir, 'tokens.json')), 'nothing changed yet');
    assert.equal(s.ctx.webapi.clientId, V);
    r = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: W, replace: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.j, { ok: true, source: 'data', hint: '…3210', disconnected: true });
    assert.ok(!fs.existsSync(path.join(s.dir, 'tokens.json')), 'the old app\'s token is gone');
    assert.equal(s.ctx.webapi.ready, false);
    assert.equal(s.ctx.webapi.clientId, W);
    const w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.equal(w.steps.spotify.done, false);
    assert.equal(w.steps.client_id.hint, '…3210');
  } finally { cap.restore(); if (s) await s.close(); }
  assert.ok(cap.lines.some((l) => /Spotify account disconnected: the Client ID changed$/.test(l)), cap.text());
  assert.ok(!cap.text().includes(W) && !cap.text().includes(V));
});

test('the Client ID from the environment: 409 client_id_env, not editable; a settings.env bridge writes settings.env', async () => {
  let s = await wizardServer({ clientId: V, cfg: { spotifyClientId: V, spotifyClientIdSource: 'env' } });
  try {
    const r = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: W } });
    assert.equal(r.status, 409);
    assert.equal(r.j.error.code, 'client_id_env');
    const w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.deepEqual(w.steps.client_id, { done: true, source: 'env', editable: false, hint: '…cdef' });
  } finally { await s.close(); }
  const home = path.join(require('os').tmpdir(), `encore-wizard-home-${process.pid}-${Date.now()}`);
  s = await wizardServer({ cfg: { settingsFile: path.join(home, 'settings.env') } });
  const cap = capture();
  try {
    const r = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: V } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.j, { ok: true, source: 'settings', hint: '…cdef', disconnected: false });
    assert.match(fs.readFileSync(path.join(home, 'settings.env'), 'utf8'), new RegExp(`^SPOTIFY_CLIENT_ID=${V}\\r?\\n$`));
    assert.ok(!fs.existsSync(path.join(s.dir, 'settings.json')));
  } finally { cap.restore(); await s.close(); fs.rmSync(home, { recursive: true, force: true }); }
  assert.ok(cap.lines.some((l) => /Spotify Client ID saved \(settings\.env\)$/.test(l)));
});

test('Showcase trims the hint, the source address and the phone address (wizard and network answers)', async () => {
  const s = await wizardServer({ clientId: V, cfg: { spotifyClientId: V, spotifyClientIdSource: 'data' } });
  try {
    let w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.equal(w.steps.client_id.hint, '…cdef');
    assert.equal(w.steps.pair.address, '192.168.1.20');
    let n = (await s.call('/admin/api/wizard/network', { headers: AUTH })).j;
    assert.equal(n.address, '192.168.1.20');
    assert.equal(n.platform, 'other');
    assert.equal(n.profile, null);
    assert.equal(n.firewall, null);
    await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    const r = await s.call('/admin/api/wizard', { headers: AUTH });
    w = r.j;
    assert.equal(w.showcase, true);
    assert.equal(w.steps.client_id.hint, null);
    assert.equal(w.steps.client_id.done, true);
    assert.equal(w.steps.app.repo_url, DEFAULT_APP_REPO, 'the Encore repo address is public: it stays');
    assert.equal(w.steps.pair.address, null);
    assert.deepEqual([w.steps.away.address, w.steps.away.addresses], [null, null]);
    assert.ok(!r.text.includes('192.168.1.20') && !r.text.includes('cdef'));
    const st = (await s.call('/admin/api/status', { headers: AUTH })).j;
    assert.equal(st.app_repo, DEFAULT_APP_REPO, 'not trimmed in Showcase');
    assert.equal(st.phone, null);
    n = (await s.call('/admin/api/wizard/network', { headers: AUTH })).j;
    assert.equal(n.address, null);
    assert.equal(n.addresses, null);
    const c = await s.call('/admin/api/wizard/client-id', { method: 'POST', headers: AUTH, body: { client_id: V } });
    assert.equal(c.j.hint, null, 'the save answer has no hint either');
    // the network check itself still knows the address (it needs it even while Showcase hides it)
    n = (await s.call('/admin/api/wizard/network?fresh=1', { headers: AUTH })).j;
    assert.deepEqual(n.problems.filter((x) => x === 'no_address'), []);
  } finally { await s.close(); }
});

test('step 8\'s router (Open your router) over HTTP: in the admin\'s wizard answer only, gone in Showcase, never logged', async () => {
  const cap = capture();
  let asked = 0;
  const s = await wizardServer({ ctx: { routerAddress: async () => { asked++; return '192.168.1.1'; } } });
  try {
    let r = await s.call('/admin/api/wizard', { headers: AUTH });
    assert.equal(r.j.steps.away.router, '192.168.1.1');
    assert.equal(r.j.steps.away.address, '192.168.1.20', 'the Home address still comes from its own lookup');
    // the admin route's rules: no password, no answer
    r = await s.call('/admin/api/wizard');
    assert.equal(r.status, 401);
    assert.ok(!r.text.includes('192.168.1.1'));
    // not in the admin status, the tray's status or the phone API
    const st = await s.call('/admin/api/status', { headers: AUTH });
    assert.ok(!st.text.includes('192.168.1.1'), 'only the setup guide\'s answer has it');
    // looked up with the Home address, at most every 30 s
    await s.call('/admin/api/wizard', { headers: AUTH });
    assert.equal(asked, 1);
    // Showcase: hidden like the addresses
    await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    r = await s.call('/admin/api/wizard', { headers: AUTH });
    assert.equal(r.j.steps.away.router, null);
    assert.ok(!r.text.includes('192.168.1.1'));
  } finally { await s.close(); cap.restore(); }
  assert.ok(!cap.text().includes('192.168.1.1'), cap.text());
  // no router lookup (the Home address alone): none
  const t = await wizardServer({});
  try { assert.equal((await t.call('/admin/api/wizard', { headers: AUTH })).j.steps.away.router, null); } finally { await t.close(); }
});

test('the network check over HTTP: a fresh check on ?fresh=1, the step ticks when it is fine', async () => {
  // something listens on the "LAN address" (here: loopback), so the check passes
  const s = await wizardServer({ lanAddress: async () => '127.0.0.1' });
  try {
    s.cfg.port = s.port;
    const cap = capture();
    let n;
    try { n = (await s.call('/admin/api/wizard/network', { headers: AUTH })).j; } finally { cap.restore(); }
    assert.deepEqual(n.problems, [], JSON.stringify(n));
    assert.equal(n.ok, true);
    assert.equal(n.listening, true);
    assert.ok(cap.lines.some((l) => /network check: ok$/.test(l)));
    const w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.deepEqual([w.steps.network.done, w.steps.network.ok], [true, true]);
    const again = (await s.call('/admin/api/wizard/network', { headers: AUTH })).j;
    assert.equal(again.checked_at, n.checked_at, 'reused');
  } finally { await s.close(); }
});

test('/admin/api/setup has platform; /local/v1/status has setup.complete (false in setup mode, then the guide\'s)', async () => {
  let s = await wizardServer({ cfg: { platformKind: 'docker' } });
  try {
    assert.deepEqual((await s.call('/admin/api/setup')).j, { setup: false, code_needed: false, min_length: 8, platform: 'docker' });
  } finally { await s.close(); }
  s = await wizardServer({ adminPassword: '', cfg: { windows: true, platformKind: 'windows' } });
  Object.defineProperty(s.cfg, 'launcherToken', { value: TOKEN, enumerable: false });
  try {
    let st = (await s.call('/local/v1/status', { headers: L })).j;
    assert.deepEqual(st.setup, { complete: false });
    assert.equal(st.contract, 1);
    assert.deepEqual((await s.call('/admin/api/setup')).j.platform, 'windows');
  } finally { await s.close(); }
  s = await wizardServer();
  Object.defineProperty(s.cfg, 'launcherToken', { value: TOKEN, enumerable: false });
  try {
    assert.deepEqual((await s.call('/local/v1/status', { headers: L })).j.setup, { complete: false });
    await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body: { action: 'complete' } });
    assert.deepEqual((await s.call('/local/v1/status', { headers: L })).j.setup, { complete: true });
  } finally { await s.close(); }
  // an install that is already set up (password, Client ID, account, a phone): complete at start, "auto"
  const cap = capture();
  try {
    s = await wizardServer({ clientId: V, tokens: true, cfg: { spotifyClientId: V, spotifyClientIdSource: 'settings' },
      devices: [{ id: NAMES.dev, name: NAMES.phone, created: '2026-10-07T12:00:00.000Z', last_seen: null }] });
  } finally { cap.restore(); }
  Object.defineProperty(s.cfg, 'launcherToken', { value: TOKEN, enumerable: false });
  try {
    assert.deepEqual((await s.call('/local/v1/status', { headers: L })).j.setup, { complete: true });
    const w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.deepEqual([w.complete, w.complete_how, w.show], [true, 'auto', false]);
    assert.ok(cap.lines.some((l) => /setup guide: this bridge is already set up/.test(l)));
  } finally { await s.close(); }
});

test('no names, codes, IDs or paths in the guide\'s answers', async () => {
  const s = await wizardServer({ clientId: V, tokens: true, cfg: { spotifyClientId: V, spotifyClientIdSource: 'data' },
    devices: [{ id: NAMES.dev, name: NAMES.phone, created: '2026-10-07T12:00:00.000Z', last_seen: null }] });
  try {
    for (const p of ['/admin/api/wizard', '/admin/api/wizard/network']) {
      const t = (await s.call(p, { headers: AUTH })).text;
      for (const v of [V, NAMES.dev, NAMES.phone, NAMES.account, NAMES.accountName, s.dir, JSON.stringify(s.dir).slice(1, -1),
        path.basename(s.dir)]) assert.ok(!t.includes(v), `${p}: ${v}`);
    }
  } finally { await s.close(); }
});

// ---- step 8: the away tick (DESIGN-WIZARD.md §5.3)
const SIG = { 'X-Test-Signature': 'good' };
const signedOnly = (req) => (req.headers['x-test-signature'] === 'good' ? { id: NAMES.dev, name: NAMES.phone } : null);

test('step 8: a signed phone request from outside the home network ticks it once; private, shared and loopback peers never do', async () => {
  const cap = capture();
  let s;
  try {
    s = await wizardServer({ verify: signedOnly });
    // at home (loopback through a real connection, and made-up private / shared / link-local peers): no tick
    let r = await s.call('/v1/status', { headers: SIG });
    assert.equal(r.status, 200, r.text);
    for (const peer of ['192.168.1.30', '10.1.2.3', '172.16.5.4', '100.64.0.5', '127.0.0.1', '::1', '::ffff:192.168.1.30', 'fe80::1', 'fd00::5', '', 'not-an-address']) {
      r = await s.inject('/v1/status', { headers: SIG, peer });
      assert.equal(r.status, 200, `${peer}: ${r.text}`);
    }
    let w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.deepEqual([w.steps.away.done, w.steps.away.seen_at], [false, null]);
    assert.ok(!fs.existsSync(path.join(s.dir, 'wizard.json')) || JSON.parse(fs.readFileSync(path.join(s.dir, 'wizard.json'), 'utf8')).away_seen_at == null);
    // from outside, but not signed (no signature, a bad one, the unsigned routes): no tick
    r = await s.inject('/v1/status', { peer: '203.0.113.9' });
    assert.equal(r.status, 401);
    r = await s.inject('/v1/status', { peer: '203.0.113.9', headers: { 'X-Test-Signature': 'bad' } });
    assert.equal(r.status, 401);
    r = await s.inject('/', { peer: '203.0.113.9' });
    assert.equal(r.status, 200);
    r = await s.inject('/v1/pair', { method: 'POST', peer: '203.0.113.9', headers: { 'Content-Type': 'application/json' }, body: { code: '123456' } });
    assert.equal(r.status, 403, 'pairing only at home');
    w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.equal(w.steps.away.done, false);
    // signed, from a public address: ticks, and the next wizard read says so
    r = await s.inject('/v1/status', { headers: SIG, peer: '203.0.113.9' });
    assert.equal(r.status, 200, r.text);
    w = (await s.call('/admin/api/wizard', { headers: AUTH })).j;
    assert.equal(w.steps.away.done, true);
    assert.ok(w.steps.away.seen_at > 0);
    const seen = w.steps.away.seen_at;
    // later requests (IPv4-mapped and IPv6 public peers too) change nothing
    r = await s.inject('/v1/status', { headers: SIG, peer: '::ffff:198.51.100.20' });
    r = await s.inject('/v1/status', { headers: SIG, peer: '2001:db8::7' });
    assert.equal((await s.call('/admin/api/wizard', { headers: AUTH })).j.steps.away.seen_at, seen);
    const file = fs.readFileSync(path.join(s.dir, 'wizard.json'), 'utf8');
    assert.equal(JSON.parse(file).away_seen_at, seen);
    for (const v of ['203.0.113', '198.51.100', '2001:db8']) assert.ok(!file.includes(v), `${v} in wizard.json`);
  } finally { cap.restore(); if (s) await s.close(); }
  const text = cap.text();
  for (const v of ['203.0.113', '198.51.100', '2001:db8', '192.168.1.30', '100.64.0.5']) assert.ok(!text.includes(v), `${v} in the log:\n${text}`);
  assert.equal(cap.lines.filter((l) => /setup guide: a phone reached the bridge from outside the home network$/.test(l)).length, 1, text);
});

test('step 8 from outside: a public IPv4-mapped peer counts as well; a custom ADMIN_ALLOW doesn\'t change what counts', async () => {
  const s = await wizardServer({ verify: signedOnly, cfg: { adminAllow: 'private,203.0.113.0/24' } });
  const cap = capture();
  try {
    await s.inject('/v1/status', { headers: SIG, peer: '::ffff:203.0.113.44' });
    assert.equal((await s.call('/admin/api/wizard', { headers: AUTH })).j.steps.away.done, true, 'ADMIN_ALLOW lets it use the admin page, but it is still outside');
  } finally { cap.restore(); await s.close(); }
});

test('the built-in Cydia source is gone: /repo and /repo/... are the plain 404, for every method and peer', async () => {
  const s = await wizardServer();
  try {
    for (const p of ['/repo', '/repo/', '/repo/Packages', '/repo/Packages.gz', '/repo/Release', '/repo/debs/x.deb', '/repo/CydiaIcon.png']) {
      for (const method of ['GET', 'HEAD']) {
        const r = await s.call(p, { method });
        assert.equal(r.status, 404, `${method} ${p}`);
        if (method === 'GET') assert.deepEqual(r.j, { error: { code: 'not_found' } });
      }
      const r = await s.inject(p, { peer: '192.168.1.30' });
      assert.equal(r.status, 404);
    }
  } finally { await s.close(); }
});
