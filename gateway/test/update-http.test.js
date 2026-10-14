'use strict';
// The update routes (http.js; DESIGN-UPDATES.md §5.10, §5.11, §8.2): /admin/api/update, /admin/api/update/check,
// /install, /cancel behind the admin gate and password (POSTs cross-site-checked); `update` in the admin status, the same
// in Showcase. Docker / other: Check now runs the bridge's own check (against a local fake GitHub), throttled. Windows
// (the tray launcher): POST /local/v1/update (loopback + token + no Origin, else the plain 404; validated, 400; kept in
// memory only), update_request in GET /local/v1/status until handled_request or 2 minutes, Update now only from this
// PC (403 update_here_only from elsewhere), 409 not_installed / not_available, nothing written to DATA_DIR and nothing
// of a push in the log. The app's notice: /v1/status `update` ({latest, bridge} or null; signed phone requests only;
// versions only; the same in Showcase). Every version, hash and address here is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Updater, UpdateRelay } = require('../src/update');
const { FakeGitHub, KEYS, assetNames } = require('./support/fakegithub');
const { wizardServer, capture, cleanup, tmp, AUTH } = require('./support/wizard-server');

after(cleanup);

const T0 = Date.parse('2026-10-12T08:00:00Z');
const TOKEN = 'c0ffee'.repeat(10) + 'beef';
const L = { 'X-Encore-Launcher': TOKEN };
const HEX = 'ab'.repeat(32);
const LAN = '192.168.1.30';                      // another computer on the home network (an allowed admin address)

// Docker: the bridge's own checker against a fake GitHub (o.cfg: e.g. prebuiltImage, the prebuilt images)
async function dockerServer(o = {}) {
  const gh = await new FakeGitHub().start();
  const dir = tmp('encore-update-http-');
  const clock = { t: T0 };
  const cfg = { version: '1.1.0', platformKind: 'docker', updateCheck: true, dataDir: dir, updateApiBase: gh.base, updateDownloadBase: gh.base,
    updateTestKeys: [KEYS.rfc8032_test1.public_b64], ...o.cfg };
  const update = new Updater({ cfg, now: () => clock.t, mono: () => 0, random: () => 0.5, timeoutMs: 3000 });
  const s = await wizardServer({ dir, cfg: { platformKind: 'docker' }, ctx: { update }, verify: o.verify });
  return { s, gh, clock, update, close: async () => { await s.close(); await gh.close(); } };
}

// Windows with the tray launcher: the relay, with a fake clock for the 2-minute rule
async function relayServer(o = {}) {
  const clock = { t: T0 };
  let n = 0;
  const update = new UpdateRelay({ cfg: { version: '1.1.0' }, now: () => clock.t, randomId: () => (++n).toString(16).padStart(16, '0') });
  const s = await wizardServer({ cfg: { launcher: true, windows: true, platformKind: 'windows' }, ctx: { update }, verify: o.verify });
  Object.defineProperty(s.cfg, 'launcherToken', { value: TOKEN, enumerable: false });
  return { s, clock, update, close: () => s.close() };
}

// a launcher's view (§8.3)
function pushed(o = {}) {
  return { v: 1, source: 'launcher', kind: 'windows-installer', current: '1.1.0', auto: true, auto_off: null, state: 'available',
    checked_at: '2026-10-12T07:59:00Z', next_check_at: '2026-10-13T08:30:00Z',
    latest: { version: '1.2.0', published_at: '2026-10-11T09:30:00Z', notes_url: 'https://github.com/mbucc9000/encore/releases/tag/v1.2.0',
      asset: 'EncoreBridge-1.2.0-setup.exe', size: 32443228, sha256: HEX },
    error: null, install: null, ...o };
}

test('Docker: the routes need the password; GET answers the view; Check now runs the check (then reused within 60 s); cross-site POSTs are refused', async () => {
  const t = await dockerServer();
  const cap = capture();
  try {
    t.gh.setRelease();
    for (const [p, m] of [['/admin/api/update', 'GET'], ['/admin/api/update/check', 'POST'], ['/admin/api/update/install', 'POST'], ['/admin/api/update/cancel', 'POST']]) {
      const r = await t.s.call(p, { method: m, body: m === 'POST' ? {} : undefined });
      assert.equal(r.status, 401, p);
    }
    assert.equal(t.gh.requests.length, 0);
    let r = await t.s.call('/admin/api/update', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.j, { ...t.update.view(), request: null, request_expired: null, request_handled: null, can_install_here: false, relay_missing: false });
    assert.equal(r.j.state, 'never');
    // cross-site: refused before anything is asked
    for (const o of [{ type: 'text/plain' }, { headers: { ...AUTH, Origin: 'http://evil.example' } }]) {
      r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: '{}', ...o });
      assert.equal(r.status, 403);
      assert.equal(r.j.error.code, 'cross_site');
    }
    assert.equal(t.gh.requests.length, 0);
    r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.j.state, 'available');
    assert.equal(r.j.reused, false);
    assert.equal(r.j.latest.version, '1.2.0');
    assert.equal(r.j.kind, 'docker');
    assert.equal(t.gh.apiCalls().length, 1);
    t.clock.t += 30000;
    r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.j.reused, true);
    assert.equal(t.gh.apiCalls().length, 1, 'within 60 s: no request');
    // the admin status carries the same view, also in Showcase
    const st = (await t.s.call('/admin/api/status', { headers: AUTH })).j;
    const view = (await t.s.call('/admin/api/update', { headers: AUTH })).j;
    assert.deepEqual(st.update, view);
    await t.s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    const sc = (await t.s.call('/admin/api/status', { headers: AUTH })).j;
    assert.equal(sc.showcase, true);
    assert.deepEqual(sc.update, view, 'Showcase: unchanged (nothing personal)');
    // Docker never installs or cancels anything
    for (const p of ['/admin/api/update/install', '/admin/api/update/cancel']) {
      r = await t.s.call(p, { method: 'POST', headers: AUTH, body: {} });
      assert.equal(r.status, 409, p);
      assert.equal(r.j.error.code, 'not_installed');
    }
    // a body that isn't JSON: 400; other methods: the plain 404
    r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: '{nope' });
    assert.equal(r.status, 400);
    assert.equal((await t.s.call('/admin/api/update/check', { headers: AUTH })).status, 404);
    assert.equal((await t.s.call('/admin/api/update', { method: 'POST', headers: AUTH, body: {} })).status, 404);
    // no launcher here: /local/v1/update is the plain 404 even with a token
    Object.defineProperty(t.s.cfg, 'launcherToken', { value: TOKEN, enumerable: false });
    r = await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: pushed() });
    assert.equal(r.status, 404);
    assert.equal((await t.s.call('/local/v1/status', { headers: L })).j.update_request, null);
  } finally { cap.restore(); await t.close(); }
  assert.ok(!/127\.0\.0\.1|http:/.test(cap.text()), cap.text());
});

test('Docker: a slow check: the route answers within its 20 s budget with the view (the check goes on)', async () => {
  const t = await dockerServer();
  try {
    t.gh.setRelease();
    t.gh.api.mode = 'stall';
    const t0 = Date.now();
    const r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 6000, 'the 3 s test timeout ends the check first');
    assert.equal(r.j.error.code, 'timeout');
  } finally { await t.close(); }
});

test('Docker, the prebuilt images (kind docker-image): the view and Check now as for a source build; Update now / Cancel: 409 not_installed', async () => {
  const t = await dockerServer({ cfg: { prebuiltImage: true } });
  const cap = capture();
  try {
    t.gh.setRelease({ files: [...assetNames('1.2.0'), 'encore-docker-compose.yaml'] });
    let r = await t.s.call('/admin/api/update', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual([r.j.kind, r.j.state, r.j.can_install_here], ['docker-image', 'never', false]);
    r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.j.kind, r.j.state, r.j.latest.version, r.j.latest.asset], ['docker-image', 'available', '1.2.0', 'encore-docker-compose.yaml']);
    assert.equal(r.j.can_install_here, false);
    assert.equal(t.gh.downloadCalls('encore-docker-compose.yaml').length, 0, 'never downloaded');
    // the bridge never installs or cancels anything on Docker, the images included
    for (const p of ['/admin/api/update/install', '/admin/api/update/cancel']) {
      r = await t.s.call(p, { method: 'POST', headers: AUTH, body: {} });
      assert.equal(r.status, 409, p);
      assert.equal(r.j.error.code, 'not_installed', p);
      assert.equal(r.j.error.message, 'This copy of Encore Bridge doesn\'t install updates itself: the Updates section on the admin page shows the steps.');
    }
  } finally { cap.restore(); await t.close(); }
  assert.ok(!/127\.0\.0\.1|http:/.test(cap.text()), cap.text());
});

test('Windows: /local/v1/update hides like every launcher route (no token, a wrong one, an Origin: the plain 404) and checks the view (400)', async () => {
  const t = await relayServer();
  const cap = capture();
  try {
    const unknown = (await t.s.call('/nothing-here')).text;
    for (const h of [{}, { 'X-Encore-Launcher': TOKEN.slice(0, -1) + '0' }, { ...L, Origin: 'http://127.0.0.1:8095' }]) {
      const r = await t.s.call('/local/v1/update', { method: 'POST', headers: h, body: pushed() });
      assert.equal(r.status, 404);
      assert.equal(r.text, unknown);
    }
    // from another computer, even with the token
    let r = await t.s.inject('/local/v1/update', { method: 'POST', headers: { ...L, 'Content-Type': 'application/json' }, body: pushed(), peer: LAN });
    assert.equal(r.status, 404);
    assert.equal((await t.s.call('/admin/api/update', { headers: AUTH })).j.relay_missing, true, 'nothing was taken');
    // invalid views: 400, nothing kept
    const bad = [
      {}, pushed({ v: 2 }), pushed({ source: 'bridge' }), pushed({ kind: 'android' }), pushed({ kind: 'android', latest: null }), pushed({ kind: null, latest: null }),
      pushed({ current: '<b>1.1.0</b>' }), pushed({ state: 'great' }),
      pushed({ auto: 'yes' }), pushed({ checked_at: 'yesterday' }), pushed({ latest: { ...pushed().latest, version: 'v1.2.0' } }),
      pushed({ latest: { ...pushed().latest, version: '1.2.0-rc1' } }), pushed({ latest: { ...pushed().latest, sha256: 'AB'.repeat(32) } }),
      pushed({ latest: { ...pushed().latest, asset: 'EncoreBridge-1.2.0-win64.zip' } }), pushed({ latest: { ...pushed().latest, size: -1 } }),
      pushed({ error: { code: 'pwned', version: null, retry_at: null, http_status: null } }), pushed({ error: { code: 'http_error', http_status: 99 } }),
      pushed({ install: { version: '1.2.0', phase: 'exploding', done: 0, total: 1, error: null, exit_code: null } }),
      pushed({ install: { version: '1.2.0', phase: 'downloading', done: -5, total: 1 } }), pushed({ handled_request: '../../etc' }), [pushed()], 'null',
    ];
    for (const b of bad) {
      r = await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: typeof b === 'string' ? b : b });
      assert.equal(r.status, 400, JSON.stringify(b).slice(0, 120));
    }
    r = await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: '{not json' });
    assert.equal(r.status, 400);
    r = await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: { ...pushed(), pad: 'x'.repeat(9000) } }).catch(() => ({ status: 'dropped' }));
    assert.ok(r.status === 413 || r.status === 'dropped', String(r.status));
    assert.equal((await t.s.call('/admin/api/update', { headers: AUTH })).j.relay_missing, true, 'still nothing');
    // a good one: 200 {ok}; unknown fields dropped; the notes link rebuilt from the version
    r = await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: { ...pushed({ latest: { ...pushed().latest, notes_url: 'https://evil.example/' } }), extra: 'ignored' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.j, { ok: true });
    const v = (await t.s.call('/admin/api/update', { headers: AUTH })).j;
    assert.equal(v.relay_missing, false);
    assert.equal(v.latest.notes_url, 'https://github.com/mbucc9000/encore/releases/tag/v1.2.0');
    assert.equal(v.extra, undefined);
    assert.deepEqual(Object.keys(v).sort(), ['auto', 'auto_off', 'can_install_here', 'checked_at', 'current', 'error', 'install', 'kind', 'latest', 'next_check_at',
      'relay_missing', 'request', 'request_expired', 'request_handled', 'source', 'state', 'v'].sort());
    // a development launcher's version, an install in progress, an error: fine
    r = await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: pushed({ current: 'dev', auto: false, auto_off: 'dev_build', state: 'never', latest: null }) });
    assert.equal(r.status, 200);
    r = await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: pushed({ install: { version: '1.2.0', phase: 'downloading', done: 1048576, total: 32443228, error: null, exit_code: null },
      error: { code: 'rate_limited', version: null, retry_at: '2026-10-12T09:00:00Z', http_status: null } }) });
    assert.equal(r.status, 200);
  } finally { cap.restore(); await t.close(); }
  assert.ok(!/1\.2\.0|32443228|abab/.test(cap.text()), 'a push is never logged: ' + cap.text());
});

test('Windows: the page\'s requests reach the launcher through update_request until handled or 2 minutes old', async () => {
  const t = await relayServer();
  try {
    let st = (await t.s.call('/local/v1/status', { headers: L })).j;
    assert.equal(st.update_request, null);
    // Check now: queued (202), with the view
    let r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 202);
    const id = r.j.queued;
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.equal(r.j.update.request.id, id);
    assert.equal(r.j.update.request.action, 'check');
    st = (await t.s.call('/local/v1/status', { headers: L })).j;
    assert.deepEqual(st.update_request, { id, action: 'check' });
    // the same action again: the same request
    r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.j.queued, id);
    // the launcher acknowledges it with its next push
    await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: { ...pushed({ state: 'checking' }), handled_request: id } });
    st = (await t.s.call('/local/v1/status', { headers: L })).j;
    assert.equal(st.update_request, null);
    let v = (await t.s.call('/admin/api/update', { headers: AUTH })).j;
    assert.equal(v.request, null);
    assert.equal(v.request_handled, id);
    assert.equal(v.state, 'checking');
    // Cancel (from any admin address): queued; nobody picks it up for 2 minutes: dropped, and the page can tell
    await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: pushed() });
    r = await t.s.inject('/admin/api/update/cancel', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: {}, peer: LAN });
    assert.equal(r.status, 202, r.text);
    const cid = r.j.queued;
    t.clock.t += 119 * 1000;
    assert.deepEqual((await t.s.call('/local/v1/status', { headers: L })).j.update_request, { id: cid, action: 'cancel' });
    t.clock.t += 2000;
    assert.equal((await t.s.call('/local/v1/status', { headers: L })).j.update_request, null);
    v = (await t.s.call('/admin/api/update', { headers: AUTH })).j;
    assert.equal(v.request, null);
    assert.equal(v.request_expired, cid);
    // an unknown acknowledgement changes nothing; a request's id is never reused
    await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: { ...pushed(), handled_request: 'f'.repeat(16) } });
    r = await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    assert.notEqual(r.j.queued, id);
    assert.equal((await t.s.call('/admin/api/update', { headers: AUTH })).j.request_expired, null, 'a new request clears the old note');
  } finally { await t.close(); }
});

test('Windows: Update now only from this PC (403 update_here_only), only for the installer (409 not_installed), only when available (409 not_available)', async () => {
  const t = await relayServer();
  try {
    // before the launcher has pushed anything
    let r = await t.s.call('/admin/api/update/install', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.j.error.code, 'not_available');
    await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: pushed() });
    // another computer on the home network: the page there points to the tray
    r = await t.s.inject('/admin/api/update/install', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: {}, peer: LAN });
    assert.equal(r.status, 403);
    assert.deepEqual(r.j.error, { code: 'update_here_only', message: 'To update, use the Encore Bridge icon on the PC: Encore Bridge 1.2.0 is available → Update now…' });
    let v = await t.s.inject('/admin/api/update', { headers: AUTH, peer: LAN });
    assert.equal(v.j.can_install_here, false);
    v = await t.s.inject('/admin/api/status', { headers: AUTH, peer: LAN });
    assert.equal(v.j.update.can_install_here, false);
    assert.equal((await t.s.call('/local/v1/status', { headers: L })).j.update_request, null, 'nothing queued');
    // this PC (loopback): queued for the tray, which asks Windows
    v = (await t.s.call('/admin/api/update', { headers: AUTH })).j;
    assert.equal(v.can_install_here, true);
    r = await t.s.call('/admin/api/update/install', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual((await t.s.call('/local/v1/status', { headers: L })).j.update_request, { id: r.j.queued, action: 'install' });
    // up to date: nothing to install
    await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: { ...pushed({ state: 'up_to_date', latest: null }), handled_request: r.j.queued } });
    r = await t.s.call('/admin/api/update/install', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.j.error.code, 'not_available');
    // the portable zip: never installed from here
    await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: pushed({ kind: 'windows-zip', latest: { ...pushed().latest, asset: 'EncoreBridge-1.2.0-win64.zip' } }) });
    r = await t.s.call('/admin/api/update/install', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.j.error.code, 'not_installed');
    assert.equal((await t.s.call('/admin/api/update', { headers: AUTH })).j.can_install_here, false);
  } finally { await t.close(); }
});

test('Windows: the relay writes nothing to the data folder, and the admin status carries its view (the same in Showcase)', async () => {
  const t = await relayServer();
  try {
    await t.s.call('/admin/api/status', { headers: AUTH });
    const before = fs.readdirSync(t.s.dir).sort();
    await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: pushed() });
    await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    await t.s.call('/admin/api/update/install', { method: 'POST', headers: AUTH, body: {} });
    await t.s.call('/local/v1/status', { headers: L });
    const st = (await t.s.call('/admin/api/status', { headers: AUTH })).j;
    assert.equal(st.update.source, 'launcher');
    assert.equal(st.update.latest.version, '1.2.0');
    await t.s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    const sc = (await t.s.call('/admin/api/status', { headers: AUTH })).j;
    assert.deepEqual(sc.update, st.update);
    const after = fs.readdirSync(t.s.dir).filter((f) => f !== 'showcase.json').sort();
    assert.deepEqual(after, before.filter((f) => f !== 'showcase.json'));
    assert.ok(!fs.existsSync(path.join(t.s.dir, 'update.json')));
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- the app's notice: /v1/status `update`
const PHONE = { 'X-Encore-Device': 'dev_madeup0001' };
const signed = (req) => (req.headers['x-encore-device'] === 'dev_madeup0001' ? { id: 'dev_madeup0001', name: 'Sam Sample’s iPhone' } : null);
const phoneStatus = async (t) => {
  const r = await t.s.call('/v1/status', { headers: PHONE });
  assert.equal(r.status, 200, r.text);
  assert.ok('update' in r.j, 'always there (null or the notice)');
  return r.j;
};

test('/v1/status `update` (Docker): null until Check now finds a verified newer release, then {latest, bridge}; signed only; versions only; the same in Showcase; a failing check hides it', async () => {
  const t = await dockerServer({ verify: signed });
  const cap = capture();
  try {
    t.gh.setRelease();
    assert.equal((await t.s.call('/v1/status')).status, 401, 'a phone request: signed only');
    let j = await phoneStatus(t);
    assert.equal(j.update, null);
    assert.equal(j.gateway.version, '1.1.0');
    await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    j = await phoneStatus(t);
    assert.deepEqual(j.update, { latest: '1.2.0', bridge: true });
    assert.ok(!/https?:|github|sha|size|published|checked|tar\.gz|SHA256SUMS|error|127\.0\.0\.1/.test(JSON.stringify(j.update)), JSON.stringify(j.update));
    // the admin status keeps the full view under the same name
    const st = (await t.s.call('/admin/api/status', { headers: AUTH })).j;
    assert.deepEqual(st.update, (await t.s.call('/admin/api/update', { headers: AUTH })).j);
    assert.equal(st.update.latest.version, '1.2.0');
    // Showcase: the same (a version isn't personal; the phone API is never trimmed)
    await t.s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    assert.deepEqual((await phoneStatus(t)).update, { latest: '1.2.0', bridge: true });
    // a later check that fails: null while its error stands
    t.clock.t += 2 * 60000;
    t.gh.api.mode = 500;
    await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
    assert.equal((await phoneStatus(t)).update, null);
  } finally { cap.restore(); await t.close(); }
  assert.ok(!/dev_madeup0001|Sam Sample|latest/.test(cap.text()), cap.text());
});

test('/v1/status `update` (Docker): null with UPDATE_CHECK=0 and in a development build, whatever Check now found', async () => {
  for (const cfg of [{ updateCheck: false }, { version: 'dev' }]) {
    const t = await dockerServer({ verify: signed, cfg });
    const cap = capture();
    try {
      t.gh.setRelease();
      await t.s.call('/admin/api/update/check', { method: 'POST', headers: AUTH, body: {} });
      assert.equal((await phoneStatus(t)).update, null, JSON.stringify(cfg));
    } finally { cap.restore(); await t.close(); }
  }
});

test('/v1/status `update` (Windows): from the tray launcher\'s pushed view; null before a push and when the push holds no verified newer release', async () => {
  const t = await relayServer({ verify: signed });
  try {
    assert.equal((await phoneStatus(t)).update, null, 'nothing pushed yet');
    const push = async (body) => assert.equal((await t.s.call('/local/v1/update', { method: 'POST', headers: L, body })).status, 200);
    await push(pushed());
    assert.deepEqual((await phoneStatus(t)).update, { latest: '1.2.0', bridge: true });
    await push(pushed({ state: 'checking' }));
    assert.deepEqual((await phoneStatus(t)).update, { latest: '1.2.0', bridge: true }, 'a check running');
    for (const o of [{ auto: false, auto_off: 'setting' }, { state: 'error', latest: null, error: { code: 'offline', version: null, retry_at: null, http_status: null } },
      { state: 'up_to_date', latest: null }]) {
      await push(pushed(o));
      assert.equal((await phoneStatus(t)).update, null, JSON.stringify(o));
    }
    // an invalid push (400) changes nothing
    await push(pushed());
    assert.equal((await t.s.call('/local/v1/update', { method: 'POST', headers: L, body: pushed({ latest: { version: '1.2.0; x' } }) })).status, 400);
    assert.deepEqual((await phoneStatus(t)).update, { latest: '1.2.0', bridge: true });
  } finally { await t.close(); }
});
