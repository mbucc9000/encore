'use strict';
// The Windows twin of the bridge start-up tests (R3c): the real src/main.js the way the tray launcher runs it
// (gateway/windows/CONTRACT.md): ENCORE_LAUNCHER=1 with a per-start token, ENCORE_HOME with a settings.env, the engine
// as the bridge's own child (a fake engine), PCM over the named-pipe source (a Unix socket here), first-run setup from
// this computer without a code, and the loopback routes: the status the tray reads, the Showcase switch, the engine's
// device-code sign-in passed through, and the shutdown route. The engine's API is a stub in this process. It runs the
// Windows code paths on Linux and macOS; on Windows the fake engine would need a shell wrapper, so it is skipped there
// (the launcher's Wine smoke tests cover the real launcher). Nothing reaches Spotify.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const cfg = require('../src/config');
const { freePort } = require('./support/platform');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');
const FAKE = path.join(__dirname, 'support', 'fake-engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const TOKEN = 'ab'.repeat(32);
const CODE = 'TESTCODE42';
const PAIR_URL = `https://www.spotify.com/pair?code=${CODE}`;

function call(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null) h['Content-Type'] = 'application/json';
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: h, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        resolve({ status: res.statusCode, text, j });
      });
    });
    rq.on('error', reject);
    if (body != null) rq.write(JSON.stringify(body));
    rq.end();
  });
}

// The engine's API as the bridge sees it: a device-code sign-in waiting, until signIn() (then a session)
function engineApi() {
  const st = { signedIn: false, asks: { status: 0, code: 0 } };
  const srv = http.createServer((req, res) => {
    const json = (code, obj) => { const b = obj == null ? '' : JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };
    if (req.url === '/auth/code') { st.asks.code++; return st.signedIn ? json(204) : json(200, { url: PAIR_URL, code: CODE, expires_at: new Date(Date.now() + 600000).toISOString() }); }
    if (req.url === '/status') { st.asks.status++; return st.signedIn ? json(200, { username: 'alex.engine', device_name: 'Encore' }) : json(204); }
    json(404, { error: 'not in this stub' });
  });
  return { st, srv, listen: (port) => new Promise((r) => srv.listen(port, '127.0.0.1', r)), close: () => new Promise((r) => srv.close(r)) };
}

const skip = (process.platform === 'win32' && 'the fake engine needs a shell wrapper (the launcher\'s Wine smoke tests cover Windows)') || false;

test('main.js as the Windows launcher runs it: the loopback routes, first-run setup, Showcase, the engine sign-in, the shutdown route', { skip, timeout: 60000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-bridge-win-'));
  dirs.push(home);
  const port = await freePort();
  const enginePort = await freePort();
  fs.writeFileSync(path.join(home, 'settings.env'), `# written by the test\r\nPORT=${port}\r\nSPOTIFY_CLIENT_ID=\r\n`);
  const wrapper = path.join(home, 'encore-engine');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const line = `encore-engine ${cfg.version} (go-librespot 0.0.0-test, Encore patches 1-6)`;
  const api = engineApi();
  await api.listen(enginePort);

  const env = { ...process.env, ENCORE_HOME: home, ENCORE_LAUNCHER: '1', ENCORE_LAUNCHER_TOKEN: TOKEN, ENGINE_EXE: wrapper, ENGINE_MANAGED: '',
    ENGINE_URL: `http://127.0.0.1:${enginePort}`, PCM_SOURCE: 'pipe-server', PCM_PIPE: path.join(home, 'pcm.sock'), ADMIN_SETUP_LOOPBACK: '1',
    FAKE_VERSION_LINE: line, FAKE_STARTUP: line, FAKE_PCM: '8192', NODE_ENV: 'production' };
  for (const k of ['PORT', 'DATA_DIR', 'ADMIN_PASSWORD', 'SPOTIFY_CLIENT_ID', 'PCM_FIFO']) delete env[k];
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const kill = setTimeout(() => child.kill('SIGKILL'), 50000);
  const waitFor = async (re, ms = 15000) => { const t0 = Date.now(); while (!re.test(out)) { if (Date.now() - t0 > ms) throw new Error(`no ${re} in:\n${out}`); await sleep(50); } };
  const L = { 'X-Encore-Launcher': TOKEN };
  try {
    await waitFor(new RegExp(`listening on :${port}`));
    await waitFor(/engine: api server listening/);
    assert.ok(fs.existsSync(path.join(home, 'data')) && fs.existsSync(path.join(home, 'engine', 'config.yml')), 'ENCORE_HOME\'s data\\ and engine\\');

    // the routes hide without the token
    assert.equal((await call(port, '/local/v1/status')).status, 404);
    assert.equal((await call(port, '/local/v1/status', { headers: { ...L, Origin: 'http://127.0.0.1' } })).status, 404);

    // the status the tray reads
    let s;
    for (let i = 0; i < 40; i++) {                        // the engine reports "running" once its API line is in
      s = (await call(port, '/local/v1/status', { headers: L })).j;
      if (s && s.engine.state === 'running' && s.sign_in) break;
      await sleep(250);
    }
    assert.equal(s.contract, 1);
    assert.deepEqual(s.bridge.version, cfg.version);
    assert.equal(s.bridge.port, port, 'PORT from settings.env');
    assert.equal(s.engine.state, 'running');
    assert.equal(s.engine.version, cfg.version, 'the version handshake: the engine named the bridge\'s version');
    assert.equal(s.engine.expected, cfg.version);
    assert.equal(s.engine.signed_in, false);
    assert.equal(s.sign_in.code, CODE);
    assert.equal(s.sign_in.url, PAIR_URL);
    assert.ok(typeof s.sign_in.expires_at === 'string');
    assert.deepEqual(s.admin, { setup_needed: true });
    assert.deepEqual(s.spotify, { connected: false });
    assert.deepEqual(s.phones, { paired: 0, listening: 0 });
    assert.equal(s.playing, false);
    assert.equal(s.showcase, false);
    assert.ok(s.phone_url === null || /^http:\/\/\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s.phone_url), String(s.phone_url));
    assert.equal(api.st.asks.status, 0, 'a waiting device-code sign-in: the engine\'s /status is never asked');

    // first run on this computer: no setup code
    let r = await call(port, '/admin/api/setup');
    const { platform: kind, ...setupAnswer } = r.j;
    assert.deepEqual(setupAnswer, { setup: true, code_needed: false, min_length: 8 });
    assert.ok(['docker', 'other'].includes(kind), String(kind));        // (Linux: a container or not; the setup guide's wording)
    assert.deepEqual(s.setup, { complete: false }, 'the setup guide is not complete before the password');
    r = await call(port, '/admin/api/setup', { method: 'POST', body: { password: 'a long test password' } });
    assert.equal(r.status, 200, r.text);
    const AUTH = { Authorization: 'Basic ' + Buffer.from('me:a long test password').toString('base64') };
    assert.equal((await call(port, '/local/v1/status', { headers: L })).j.admin.setup_needed, false);

    // the admin page sees the managed engine, the PCM pipe and the sign-in card
    const st = (await call(port, '/admin/api/status', { headers: AUTH })).j;
    assert.equal(st.platform.engine, 'managed');
    assert.equal(st.platform.launcher, true);
    assert.equal(st.engine_process.state, 'running');
    assert.equal(st.pcm.source, 'pipe-server');
    assert.equal(st.pcm.connected, true, 'the engine reached the bridge\'s pipe');
    const card = (await call(port, '/admin/api/engine/signin', { headers: AUTH })).j;
    assert.equal(card.state, 'code');
    assert.equal(card.managed, true);

    // Showcase from the tray: the same switch as the admin page; the address is hidden
    r = await call(port, '/local/v1/showcase', { method: 'POST', headers: L, body: { on: true } });
    assert.deepEqual(r.j, { showcase: true });
    assert.equal((await call(port, '/admin/api/showcase', { headers: AUTH })).j.showcase, true);
    s = (await call(port, '/local/v1/status', { headers: L })).j;
    assert.equal(s.showcase, true);
    assert.equal(s.phone_url, null);

    // the user approves the sign-in: the next look says signed in, no code
    api.st.signedIn = true;
    await sleep(3200);
    await call(port, '/local/v1/status', { headers: L });   // starts the new look (the tray never waits on it)
    await sleep(300);
    s = (await call(port, '/local/v1/status', { headers: L })).j;
    assert.equal(s.engine.signed_in, true);
    assert.equal(s.sign_in, null);

    // the shutdown route: 202, then a graceful stop with the engine stopped first
    const t0 = Date.now();
    r = await call(port, '/local/v1/shutdown', { method: 'POST', headers: L, body: {} });
    assert.equal(r.status, 202);
    assert.deepEqual(r.j, { ok: true });
    const { code } = await exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 < 7000, 'within about 5 s');
    assert.match(out, /stop requested \(the launcher asked\)/);
    assert.match(out, /engine: stopping on SIGTERM/, 'the engine was stopped');
    for (const secret of [TOKEN, CODE, 'alex.engine', 'a long test password']) assert.ok(!out.includes(secret), 'never logged: ' + secret);
    assert.ok(!out.includes(home), 'no data folder path in the log');
  } finally {
    clearTimeout(kill);
    if (child.exitCode == null) child.kill('SIGKILL');
    await api.close();
  }
});
