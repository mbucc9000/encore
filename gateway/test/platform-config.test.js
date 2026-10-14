'use strict';
// config.js platform defaults and settings.env (R3g, D25, gateway/windows/CONTRACT.md §1-§4), the update check's
// settings (UPDATE_CHECK and the test-only bases, DESIGN-UPDATES.md §9), and main.js's launcher contract (stdin "quit",
// exit codes 10/11/12, the managed engine).
//  - Linux / Docker defaults are exactly what they were before Windows support: /data, the FIFO, no managed engine.
//  - The Windows defaults are built here on any platform (config.load(env, { platform: 'win32' })).
//  - The main.js tests start the real bridge; it listens on all addresses, so on Windows they only run with
//    ENCORE_WIN_LISTEN_TESTS=1 (a firewall prompt otherwise).
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('../src/config');
const { freePort } = require('./support/platform');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');
const FAKE = path.join(__dirname, 'support', 'fake-engine.js');
const win = process.platform === 'win32';
const listenSkip = win && !/^(1|true|yes|on)$/i.test(process.env.ENCORE_WIN_LISTEN_TESTS || '') && 'starts the bridge, which listens on all addresses (set ENCORE_WIN_LISTEN_TESTS=1)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-platform-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// What config.js computed from the environment before R3g, for the fields that depend on it.
function before(env) {
  const dataDir = env.DATA_DIR || '/data';
  return {
    port: Number(env.PORT || 8095), dataDir, fifo: env.PCM_FIFO || '/pipe/encore.pcm', engineUrl: env.ENGINE_URL || 'http://127.0.0.1:3678',
    adminPassword: env.ADMIN_PASSWORD || '', adminAllow: env.ADMIN_ALLOW || '', adminTrustProxy: /^(1|true|yes|on)$/i.test(env.ADMIN_TRUST_PROXY || ''),
    spotifyClientId: env.SPOTIFY_CLIENT_ID || '', spotifyApi: env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1',
    spotifyAccounts: env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com', ffmpeg: env.FFMPEG || 'ffmpeg', cacheDir: path.posix.join(dataDir, 'cache'),
    spclient: env.SPOTIFY_SPCLIENT_BASE || 'https://spclient.wg.spotify.com',
  };
}
const pickNow = (c) => ({
  port: c.port, dataDir: c.dataDir, fifo: c.fifo, engineUrl: c.engineUrl, adminPassword: c.adminPassword, adminAllow: c.adminAllow,
  adminTrustProxy: c.adminTrustProxy, spotifyClientId: c.spotifyClientId, spotifyApi: c.spotifyApi, spotifyAccounts: c.spotifyAccounts,
  ffmpeg: c.ffmpeg, cacheDir: c.cacheDir, spclient: c.profiles.spclient,
});

test('Linux / Docker: the defaults and every environment-driven value are what they were', () => {
  const envs = [
    {},
    { PORT: '8095', DATA_DIR: '/data', PCM_FIFO: '/pipe/encore.pcm', ENGINE_URL: 'http://127.0.0.1:3678', SPOTIFY_CLIENT_ID: 'abc', ADMIN_PASSWORD: 'pw', ADMIN_ALLOW: '' },
    { PORT: '9000', DATA_DIR: '/srv/encore', PCM_FIFO: '/tmp/p.pcm', FFMPEG: '/usr/local/bin/ffmpeg', ADMIN_TRUST_PROXY: 'yes', SPOTIFY_API_BASE: 'http://127.0.0.1:9/v1' },
    { PORT: '', DATA_DIR: '', ADMIN_PASSWORD: '' },                       // empty = unset, as before
  ];
  for (const env of envs) {
    const c = cfg.load(env, { platform: 'linux' });
    assert.deepEqual(pickNow(c), before(env), JSON.stringify(env));
    assert.deepEqual(c.settingsErrors, []);
    assert.equal(c.windows, false);
    assert.equal(c.pcmSource, 'fifo', 'the FIFO, as always');
    assert.equal(c.engineManaged, false, 'the engine is its own container');
    assert.equal(c.dataRoot, null);
    assert.equal(c.settingsFile, null, 'no settings.env is looked for');
    assert.equal(c.launcher, false);
    assert.equal(c.engineVersionCheck, true);
  }
  // the same on macOS (development)
  assert.deepEqual(pickNow(cfg.load({}, { platform: 'darwin' })), before({}));
  // the settings this test process got are the same thing
  assert.deepEqual(Object.keys(cfg).sort(), Object.keys(cfg.load(process.env)).sort());
  assert.equal(Object.keys(cfg).includes('launcherToken'), false, 'the launcher token is never listed');
});

test('Windows defaults: %LOCALAPPDATA%\\Encore, a random named pipe, a managed engine, the bundled ffmpeg', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local', ENCORE_APP_DIR: 'C:\\Program Files\\Encore Bridge' };
  const c = cfg.load(env, { platform: 'win32' });
  assert.equal(c.windows, true);
  assert.equal(c.dataRoot, 'C:\\Users\\Example\\AppData\\Local\\Encore');
  assert.equal(c.settingsFile, 'C:\\Users\\Example\\AppData\\Local\\Encore\\settings.env');
  assert.equal(c.dataDir, 'C:\\Users\\Example\\AppData\\Local\\Encore\\data');
  assert.equal(c.cacheDir, 'C:\\Users\\Example\\AppData\\Local\\Encore\\data\\cache');
  assert.equal(c.engineConfigDir, 'C:\\Users\\Example\\AppData\\Local\\Encore\\engine');
  assert.equal(c.engineConfigTemplate, 'C:\\Program Files\\Encore Bridge\\engine\\config.template.yml');
  assert.equal(c.engineExe, 'C:\\Program Files\\Encore Bridge\\engine\\encore-engine.exe');
  assert.equal(c.engineManaged, true);
  assert.equal(c.pcmSource, 'pipe-server');
  assert.match(c.pcmPipe, /^\\\\\.\\pipe\\encore-pcm-[0-9a-f]{16}$/);
  assert.notEqual(cfg.load(env, { platform: 'win32' }).pcmPipe, c.pcmPipe, 'a new name every run');
  assert.equal(c.pcmPipeBytes, 65536);
  assert.equal(c.ffmpeg, 'ffmpeg', 'not bundled here: ffmpeg from PATH');
  assert.equal(c.port, 8095);
  assert.equal(c.fifo, '/pipe/encore.pcm', 'unused on Windows');
  assert.deepEqual(c.settingsErrors, []);

  // the launcher's variables (CONTRACT.md §1)
  const l = cfg.load({ ...env, ENCORE_HOME: 'D:\\EncoreData', ENCORE_LAUNCHER: '1', ENCORE_LAUNCHER_TOKEN: 'a'.repeat(64),
    ENGINE_EXE: 'C:\\X\\engine\\e.exe', ENGINE_CONFIG_TEMPLATE: 'C:\\X\\t.yml', FFMPEG: 'C:\\X\\ffmpeg\\ffmpeg.exe' }, { platform: 'win32' });
  assert.equal(l.dataRoot, 'D:\\EncoreData');
  assert.equal(l.dataDir, 'D:\\EncoreData\\data');
  assert.equal(l.engineConfigDir, 'D:\\EncoreData\\engine');
  assert.equal(l.engineExe, 'C:\\X\\engine\\e.exe');
  assert.equal(l.engineConfigTemplate, 'C:\\X\\t.yml');
  assert.equal(l.ffmpeg, 'C:\\X\\ffmpeg\\ffmpeg.exe');
  assert.equal(l.launcher, true);
  assert.equal(l.launcherToken, 'a'.repeat(64));
  assert.equal(JSON.stringify(l).includes('a'.repeat(64)), false, 'the token never shows up in a dump of the settings');

  // an engine run by hand: ENGINE_MANAGED=0; PCM_SOURCE=fifo is refused nowhere, but PCM_PIPE must be a local pipe
  assert.equal(cfg.load({ ...env, ENGINE_MANAGED: '0' }, { platform: 'win32' }).engineManaged, false);
  assert.match(cfg.load({ ...env, PCM_PIPE: '\\\\server\\pipe\\x' }, { platform: 'win32' }).settingsErrors.join(), /PCM_PIPE/);
  assert.deepEqual(cfg.load({ ...env, PCM_PIPE: '\\\\.\\pipe\\mine' }, { platform: 'win32' }).settingsErrors, []);
});

test('ENCORE_HOME on Linux: the same layout; ENGINE_EXE alone makes the engine managed', () => {
  const c = cfg.load({ ENCORE_HOME: '/opt/encore-home', ENGINE_EXE: '/opt/engine' }, { platform: 'linux' });
  assert.equal(c.dataDir, '/opt/encore-home/data');
  assert.equal(c.settingsFile, '/opt/encore-home/settings.env');
  assert.equal(c.engineConfigDir, '/opt/encore-home/engine');
  assert.equal(c.engineManaged, true);
  assert.equal(c.pcmSource, 'fifo', 'still the FIFO unless PCM_SOURCE says otherwise');
  const p = cfg.load({ PCM_SOURCE: 'pipe-server' }, { platform: 'linux' });
  assert.equal(p.pcmSource, 'pipe-server');
  assert.ok(p.pcmPipe.startsWith(os.tmpdir()) && p.pcmPipe.endsWith('.sock'), 'a Unix socket for development and tests');
});

test('settings.env: under the environment, the contract\'s parsing rules, warnings without values', () => {
  const home = tmp();
  const text = '\uFEFF# a note\r\n' +
    'PORT=9001\r\n' +
    '  SPOTIFY_CLIENT_ID = "quoted-id"  \n' +
    "ADMIN_ALLOW='192.168.1.0/24'\n" +
    'ADMIN_PASSWORD=secret#not-a-note\n' +
    'this line has no equals sign secret-value\n' +
    'lower_case=secret-value-2\n' +
    'FFMPEG=\n' +                               // empty: unset here
    'DATA_DIR=/first\n' +
    'DATA_DIR=' + path.join(home, 'later-wins') + '\n' +
    'ENGINE_URL=http://127.0.0.1:4000\n' +
    'PCM_PIPE_BYTES=16384\n';
  fs.writeFileSync(path.join(home, 'settings.env'), text);
  const c = cfg.load({ ENCORE_HOME: home, ENGINE_URL: 'http://127.0.0.1:5000', ADMIN_ALLOW: '' }, { platform: 'linux' });
  assert.equal(c.port, 9001);
  assert.equal(c.spotifyClientId, 'quoted-id', 'trimmed, one pair of quotes removed');
  assert.equal(c.adminAllow, '192.168.1.0/24', 'an empty environment value counts as unset');
  assert.equal(c.adminPassword, 'secret#not-a-note', 'no inline notes');
  assert.equal(c.ffmpeg, 'ffmpeg');
  assert.equal(c.dataDir, path.join(home, 'later-wins'), 'a later line wins');
  assert.equal(c.engineUrl, 'http://127.0.0.1:5000', 'the environment wins over settings.env');
  assert.equal(c.pcmPipeBytes, 16384);
  assert.equal(c.settingsWarnings.length, 2);
  assert.match(c.settingsWarnings[0], /line 6\b/);
  assert.match(c.settingsWarnings[1], /line 7\b/);
  assert.ok(!c.settingsWarnings.join().includes('secret'), 'a bad line is named by number, never by content');
  assert.deepEqual(c.settingsErrors, []);
  // the same parser, directly
  const { values } = cfg.parseSettings('A="x"\nB=\'y\'\nC="z\'\nD= spaced value \n');
  assert.deepEqual(values, { A: 'x', B: 'y', C: '"z\'', D: 'spaced value' });
  // no settings.env: fine
  assert.deepEqual(cfg.load({ ENCORE_HOME: path.join(home, 'nothing-here') }, { platform: 'linux' }).settingsErrors, []);
});

test('bad values are settings errors (the bridge exits with 12)', () => {
  const bad = (env, re) => assert.match(cfg.load(env, { platform: 'linux' }).settingsErrors.join(' | '), re, JSON.stringify(env));
  bad({ PORT: 'abc' }, /PORT/);
  bad({ PORT: '70000' }, /PORT/);
  bad({ PORT: '0' }, /PORT/);
  bad({ PCM_SOURCE: 'stdout' }, /PCM_SOURCE/);
  bad({ PCM_PIPE_BYTES: '-1' }, /PCM_PIPE_BYTES/);
  assert.deepEqual(cfg.load({ PORT: '65535' }, { platform: 'linux' }).settingsErrors, []);
  // an unreadable settings.env (a folder in its place)
  const home = tmp();
  fs.mkdirSync(path.join(home, 'settings.env'));
  assert.match(cfg.load({ ENCORE_HOME: home }, { platform: 'linux' }).settingsErrors.join(), /settings\.env can't be read/);
});

// ---------------------------------------------------------------- the update check's settings (DESIGN-UPDATES.md §9)
test('UPDATE_CHECK: on by default; 0, false, no, off turn the automatic check off; where it came from; the environment wins', () => {
  const load = (env) => cfg.load(env, { platform: 'linux' });
  assert.deepEqual([load({}).updateCheck, load({}).updateCheckSource], [true, null]);
  for (const v of ['0', 'false', 'no', 'off', 'OFF', 'False']) assert.equal(load({ UPDATE_CHECK: v }).updateCheck, false, v);
  for (const v of ['1', 'true', 'yes', 'on', '']) assert.equal(load({ UPDATE_CHECK: v }).updateCheck, true, v);
  assert.equal(load({ UPDATE_CHECK: '0' }).updateCheckSource, 'env');
  const home = tmp();
  fs.writeFileSync(path.join(home, 'settings.env'), '# a note\r\nUPDATE_CHECK=0\r\n');
  let c = load({ ENCORE_HOME: home });
  assert.deepEqual([c.updateCheck, c.updateCheckSource], [false, 'settings']);
  c = load({ ENCORE_HOME: home, UPDATE_CHECK: '1' });
  assert.deepEqual([c.updateCheck, c.updateCheckSource], [true, 'env']);
  // the defaults: the real GitHub (no test-only bases or keys)
  assert.deepEqual([load({}).updateApiBase, load({}).updateDownloadBase, load({}).updateTestKeys], [null, null, null]);
});

test('the update check\'s test-only settings: loopback bases only, ignored otherwise with a warning that never repeats the value', () => {
  const K1 = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
  const K2 = 'PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=';
  const load = (env) => cfg.load(env, { platform: 'linux' });
  let c = load({ UPDATE_API_BASE: 'http://127.0.0.1:9001', UPDATE_DOWNLOAD_BASE: 'http://[::1]:9002/', UPDATE_TEST_KEYS: `${K1}, ${K2}` });
  assert.deepEqual([c.updateApiBase, c.updateDownloadBase, c.updateTestKeys], ['http://127.0.0.1:9001', 'http://[::1]:9002', [K1, K2]]);
  assert.deepEqual(c.settingsWarnings, []);
  c = load({ UPDATE_API_BASE: 'http://localhost:9001', UPDATE_DOWNLOAD_BASE: 'http://localhost:9001' });
  assert.deepEqual([c.updateApiBase, c.updateTestKeys], ['http://localhost:9001', null]);
  const bad = [
    { UPDATE_API_BASE: 'https://api.github.com', UPDATE_DOWNLOAD_BASE: 'https://github.com' },
    { UPDATE_API_BASE: 'http://192.168.1.20:9001', UPDATE_DOWNLOAD_BASE: 'http://127.0.0.1:9002' },
    { UPDATE_API_BASE: 'http://127.0.0.1:9001' },
    { UPDATE_TEST_KEYS: K1 },
    { UPDATE_API_BASE: 'http://localhost.evil.example:9001', UPDATE_DOWNLOAD_BASE: 'http://127.0.0.1:9002' },
    { UPDATE_API_BASE: 'http://127.0.0.1:9001/path', UPDATE_DOWNLOAD_BASE: 'http://127.0.0.1:9002' },
    { UPDATE_API_BASE: 'http://user@127.0.0.1:9001', UPDATE_DOWNLOAD_BASE: 'http://127.0.0.1:9002' },
    { UPDATE_API_BASE: 'http://127.0.0.1:70000', UPDATE_DOWNLOAD_BASE: 'http://127.0.0.1:9002' },
    { UPDATE_API_BASE: 'http://127.0.0.1', UPDATE_DOWNLOAD_BASE: 'http://127.0.0.1:9002' },
    { UPDATE_API_BASE: 'https://127.0.0.1:9001', UPDATE_DOWNLOAD_BASE: 'http://127.0.0.1:9002' },
  ];
  for (const env of bad) {
    c = load(env);
    assert.deepEqual([c.updateApiBase, c.updateDownloadBase, c.updateTestKeys], [null, null, null], JSON.stringify(env));
    assert.equal(c.settingsWarnings.length, 1, JSON.stringify(env));
    for (const v of Object.values(env)) assert.ok(!c.settingsWarnings[0].includes(v), 'the value is never repeated');
    assert.deepEqual(c.settingsErrors, [], 'a warning, never a reason to stop');
  }
  c = load({ UPDATE_API_BASE: 'http://127.0.0.1:9001', UPDATE_DOWNLOAD_BASE: 'http://127.0.0.1:9002', UPDATE_TEST_KEYS: 'not-a-key-value' });
  assert.equal(c.updateTestKeys, null);
  assert.equal(c.updateApiBase, 'http://127.0.0.1:9001');
  assert.equal(c.settingsWarnings.length, 1);
  assert.ok(!c.settingsWarnings[0].includes('not-a-key-value'));
});

// ---------------------------------------------------------------- the prebuilt Docker image (DESIGN-DOCKER-IMAGES.md §5.1)
test('ENCORE_PREBUILT: prebuiltImage only inside a container with ENCORE_PREBUILT=1 (set by the prebuilt image); never elsewhere', () => {
  const docker = { platform: 'linux', exists: (f) => f === '/.dockerenv' };
  const podman = { platform: 'linux', exists: (f) => f === '/run/.containerenv' };
  const linux = { platform: 'linux', exists: () => false };
  const pb = (env, how) => cfg.load(env, how).prebuiltImage;
  assert.equal(pb({ ENCORE_PREBUILT: '1' }, docker), true);
  assert.equal(pb({ ENCORE_PREBUILT: '1' }, podman), true);
  assert.equal(cfg.load({ ENCORE_PREBUILT: '1' }, docker).platformKind, 'docker');
  // 0, empty (a source build's image: ENV ENCORE_PREBUILT= with nothing), unset: a source build
  for (const env of [{ ENCORE_PREBUILT: '0' }, { ENCORE_PREBUILT: '' }, {}, { ENCORE_PREBUILT: 'false' }, { ENCORE_PREBUILT: 'off' }]) {
    assert.equal(pb(env, docker), false, JSON.stringify(env));
  }
  // outside a container the flag means nothing: plain Linux, Windows (even if a container file seemed to be there)
  assert.equal(pb({ ENCORE_PREBUILT: '1' }, linux), false);
  assert.equal(pb({ ENCORE_PREBUILT: '1', LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local', ENCORE_APP_DIR: 'C:\\Program Files\\Encore Bridge' },
    { platform: 'win32', exists: () => true }), false);
  assert.equal(pb({}, linux), false);
  // the other Linux / Docker values don't change with it
  assert.deepEqual(pickNow(cfg.load({ ENCORE_PREBUILT: '1' }, docker)), before({}));
});

// ---------------------------------------------------------------- main.js (the real bridge)
function bridge(env, { stdin = 'pipe' } = {}) {
  const root = tmp();
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, DATA_DIR: path.join(root, 'data'), PCM_SOURCE: 'pipe-server', PCM_PIPE: win ? '' : path.join(root, 'pcm.sock'),
      ENGINE_MANAGED: '0', ENGINE_URL: 'http://127.0.0.1:1', ADMIN_PASSWORD: 'pw', SPOTIFY_CLIENT_ID: '', ENCORE_HOME: '', ENCORE_LAUNCHER: '', ...env },
    stdio: [stdin, 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  exited.then(() => clearTimeout(timeout));
  return { child, root, out: () => out, exited };
}
async function waitFor(b, re, ms = 10000) {
  const t0 = Date.now();
  while (!re.test(b.out())) { if (Date.now() - t0 > ms) throw new Error(`no ${re} in:\n${b.out()}`); await sleep(50); }
}

test('main.js: a bad setting stops it before anything starts, with exit code 12', { skip: listenSkip }, async () => {
  const b = bridge({ PORT: 'not-a-port' });
  const { code } = await b.exited;
  assert.equal(code, 12);
  assert.match(b.out(), / E PORT must be a port number/);
  assert.doesNotMatch(b.out(), /starting/);
});

test('main.js: the port in use is exit code 10, with the reason', { skip: listenSkip }, async () => {
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, '0.0.0.0', r));
  try {
    const b = bridge({ PORT: String(holder.address().port) });
    const { code } = await b.exited;
    assert.equal(code, 10);
    assert.match(b.out(), new RegExp(` E port ${holder.address().port} is in use by another program`));
  } finally { holder.close(); }
});

test('main.js with ENCORE_LAUNCHER=1: the stdin "quit" line and the end of stdin stop it with exit code 0', { skip: listenSkip }, async () => {
  for (const how of ['quit', 'eof']) {
    const b = bridge({ PORT: String(await freePort()), ENCORE_LAUNCHER: '1' });
    await waitFor(b, /listening on :/);
    b.child.stdin.write('hello\nsomething else\n');               // other lines: ignored
    await sleep(200);
    assert.equal(b.child.exitCode, null, 'still running');
    const t0 = Date.now();
    if (how === 'quit') b.child.stdin.write('quit\n'); else b.child.stdin.end();
    const { code } = await b.exited;
    assert.equal(code, 0, how);
    assert.ok(Date.now() - t0 < 6000, 'within about 5 s');
    assert.match(b.out(), /shutting down/);
    assert.doesNotMatch(b.out(), /something else|hello/, 'stdin lines are never logged');
  }
});

test('main.js without the launcher: stdin is left alone; SIGTERM stops it at once (Docker)', { skip: (win && 'POSIX signals') || false }, async () => {
  const b = bridge({ PORT: String(await freePort()) });
  await waitFor(b, /listening on :/);
  b.child.stdin.end();
  await sleep(500);
  assert.equal(b.child.exitCode, null, 'the end of stdin means nothing without ENCORE_LAUNCHER');
  b.child.kill('SIGTERM');
  const { code } = await b.exited;
  assert.equal(code, 0);
  assert.match(b.out(), /shutting down/);
});

test('main.js with a managed engine: started with the pipe and loopback API, stopped on "quit"', { skip: (win && 'needs a shell wrapper for the fake engine') || false }, async () => {
  const root = tmp();
  const wrapper = path.join(root, 'encore-engine');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const record = path.join(root, 'record.jsonl');
  const enginePort = await freePort();
  const line = `encore-engine ${cfg.version} (go-librespot 0.0.0-test, Encore patches 1-6)`;
  const b = bridge({ PORT: String(await freePort()), ENCORE_LAUNCHER: '1', ENCORE_LAUNCHER_TOKEN: 'b'.repeat(64), ENGINE_MANAGED: '', ENGINE_EXE: wrapper,
    ENGINE_URL: `http://127.0.0.1:${enginePort}`, FAKE_RECORD: record, FAKE_VERSION_LINE: line, FAKE_STARTUP: line, FAKE_PCM: '4096' });
  await waitFor(b, /listening on :/);
  await waitFor(b, /engine: api server listening/);
  const start = JSON.parse(fs.readFileSync(record, 'utf8').trim().split('\n')[0]);
  assert.ok(start.args.includes(`audio_output_pipe=${path.join(b.root, 'pcm.sock')}`), start.args.join(' '));
  assert.ok(start.args.includes(`server.port=${enginePort}`) && start.args.includes('server.address=127.0.0.1'));
  assert.ok(start.args.includes('device_name=Encore') === false, 'the default config.yml names the device');
  assert.equal(start.env.launcherToken, false, 'the engine never gets the launcher token');
  assert.ok(fs.existsSync(path.join(b.root, 'data', 'engine', 'config.yml')), 'config.yml under DATA_DIR/engine without ENCORE_HOME');
  assert.doesNotMatch(b.out(), /failed to open pipe/, 'the engine reached the bridge\'s pipe');
  b.child.stdin.write('quit\n');
  const { code } = await b.exited;
  assert.equal(code, 0);
  assert.match(b.out(), /engine: stopping on SIGTERM/, 'the engine was stopped first');
});
