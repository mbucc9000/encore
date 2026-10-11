'use strict';
// supervisor.js (R3g): the engine as the bridge's child process on Windows (gateway/windows/CONTRACT.md §5-§7), run
// here against a fake engine (support/fake-engine.js) through node, so it runs on any platform. Covers: the version
// check, config.yml from the template (once), the command line, restarts with backoff, stop, the engine's secrets-free
// environment, the cleaned log lines, and the device-code pass-through. Every name, path and code is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Supervisor, cleanLine, makeRedactor, engineVersionOf, parseLogrus } = require('../src/supervisor');

const FAKE = path.join(__dirname, 'support', 'fake-engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(20); }
}

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-supervisor-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// The bridge's log lines (log.js writes through console.*), captured until the test's engine has stopped and its last
// lines have arrived.
function capture(t, getSup = () => null) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  t.after(async () => {
    let sup = null;
    try { sup = getSup(); } catch (e) { /* the test failed before it made one */ }
    if (sup) await sup.stop();
    await sleep(150);
    Object.assign(console, orig);
  });
  return { lines };
}

const TEMPLATE = '# a template\ndevice_name: Encore\naudio_backend: pipe\n';
function setup({ template = TEMPLATE, cfg = {}, env = {} } = {}) {
  const root = tmp();
  const tpl = path.join(root, 'config.template.yml');
  if (template != null) fs.writeFileSync(tpl, template);
  const record = path.join(root, 'record.jsonl');
  const c = {
    version: '1.1.0', engineManaged: true, engineExe: process.execPath, engineConfigDir: path.join(root, 'engine'),
    engineConfigTemplate: tpl, engineVersionCheck: true, engineUrl: 'http://127.0.0.1:3678',
    pcmSource: 'pipe-server', pcmPipe: process.platform === 'win32' ? '\\\\.\\pipe\\encore-pcm-0123456789abcdef' : path.join(root, 'pcm.sock'), fifo: '/pipe/encore.pcm',
    ...cfg,
  };
  const sup = new Supervisor({ cfg: c, command: [process.execPath, FAKE], env: { ...process.env, FAKE_RECORD: record, ...env } });
  const starts = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, sup, cfg: c, starts, tpl };
}

test('unmanaged (Docker): start() does nothing and the state says so', async () => {
  const sup = new Supervisor({ cfg: { version: '1.1.0', engineManaged: false, engineUrl: 'http://127.0.0.1:1' } });
  await sup.start();
  assert.equal(sup.info().state, 'unmanaged');
  assert.equal(sup.child, null);
  await sup.stop();
  assert.equal(sup.info().state, 'unmanaged');
  assert.deepEqual(Object.keys(sup.info()).sort(), ['expected', 'managed', 'restarts', 'state', 'version']);
});

test('start: version check, config.yml from the template once, the command line, secrets kept from the engine', async (t) => {
  capture(t, () => sup);
  const { sup, cfg, starts, root, tpl } = setup({ env: { ENCORE_LAUNCHER_TOKEN: 'f'.repeat(64), ADMIN_PASSWORD: 'not-for-the-engine', SPOTIFY_CLIENT_ID: 'abc' } });
  await sup.start();
  await until(() => starts().length === 1 && sup.info().state === 'running', 5000, 'the engine to run');
  const info = sup.info();
  assert.equal(info.version, 'encore-1.1.0');
  assert.equal(info.expected, 'encore-1.1.0');
  assert.equal(info.restarts, 0);
  const conf = path.join(cfg.engineConfigDir, 'config.yml');
  assert.equal(fs.readFileSync(conf, 'utf8'), TEMPLATE, 'config.yml is a copy of the template');
  const { args, env } = starts()[0];
  const pairs = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-c') pairs.push(args[i + 1]);
  assert.equal(args[args.indexOf('--config_dir') + 1], cfg.engineConfigDir);
  assert.ok(pairs.includes(`audio_output_pipe=${cfg.pcmPipe}`), 'the named pipe');
  assert.ok(pairs.includes('audio_backend=pipe') && pairs.includes('audio_output_pipe_format=s16le'));
  assert.ok(pairs.includes('server.enabled=true') && pairs.includes('server.address=127.0.0.1') && pairs.includes('server.port=3678'), 'API on loopback');
  assert.ok(!pairs.some((p) => p.startsWith('device_name=')), 'config.yml names the device: no override');
  assert.deepEqual(env, { launcherToken: false, adminPassword: false, clientId: false }, 'the engine gets none of the bridge\'s secrets');
  await sup.stop();
  assert.equal(sup.info().state, 'stopped');

  // a second start keeps the user's edits; a config without device_name gets "Encore" on the command line
  fs.writeFileSync(conf, '# edited\nbitrate: 160\n');
  fs.writeFileSync(tpl, 'device_name: Something Else\n');
  sup.stopping = false;
  await sup.start();
  await until(() => starts().length === 2, 5000, 'the second start');
  assert.equal(fs.readFileSync(conf, 'utf8'), '# edited\nbitrate: 160\n', 'never overwritten');
  assert.ok(starts()[1].args.includes('device_name=Encore'), 'the computer\'s name never reaches Spotify');
  assert.ok(!fs.existsSync(path.join(root, 'engine', 'config.yaml')));
});

test('no template and no config.yml: the built-in defaults are written', async (t) => {
  capture(t, () => sup);
  const { sup, cfg, starts } = setup({ template: null });
  await sup.start();
  await until(() => starts().length === 1, 5000, 'the engine to start');
  const text = fs.readFileSync(path.join(cfg.engineConfigDir, 'config.yml'), 'utf8');
  assert.match(text, /^device_name: Encore$/m);
  assert.match(text, /^zeroconf_enabled: false$/m);
  assert.match(text, /^ {2}address: 127\.0\.0\.1$/m);
});

test('version mismatch: the engine never starts (also an unstamped engine, and one that fails --version)', async (t) => {
  const cap = capture(t);
  for (const [line, exit, expectVersion] of [
    ['encore-engine 1.0.9 (go-librespot 0.0.0-test, Encore patches 1-6)', 0, 'encore-1.0.9'],
    ['go-librespot 0.0.0-test (Encore patches 1-6, unstamped)', 0, null],
    ['unknown flag: --version', 1, null],
  ]) {
    const { sup, starts } = setup({ env: { FAKE_VERSION_LINE: line, FAKE_VERSION_EXIT: String(exit) } });
    await sup.start();
    await sleep(200);
    assert.equal(sup.info().state, 'version_mismatch', line);
    assert.equal(sup.info().version, expectVersion);
    assert.equal(starts().length, 0, 'not started');
    assert.equal(sup.child, null);
  }
  assert.ok(cap.lines.some((l) => /needs encore-1\.1\.0: reinstall/.test(l)));
});

test('ENGINE_VERSION_CHECK=0: any version runs', async (t) => {
  capture(t, () => sup);
  const { sup, starts } = setup({ cfg: { engineVersionCheck: false }, env: { FAKE_VERSION_LINE: 'go-librespot dev', FAKE_STARTUP: 'go-librespot dev' } });
  await sup.start();
  await until(() => starts().length === 1, 5000, 'the engine to start');
  assert.notEqual(sup.info().state, 'version_mismatch');
});

test('the startup line names another version: stopped, no restart', async (t) => {
  capture(t, () => sup);
  const { sup, starts } = setup({ env: { FAKE_STARTUP: 'encore-engine 2.0.0 (go-librespot 0.0.0-test, Encore patches 1-7)' } });
  try {
    await sup.start();
    await until(() => sup.info().state === 'version_mismatch', 5000, 'the mismatch');
    await sleep(1500);
    assert.equal(starts().length, 1, 'started once, never again');
    assert.equal(sup.info().version, 'encore-2.0.0');
  } finally { await sup.stop(); }
});

test('missing engine program: state "missing", nothing spawned', async (t) => {
  const cap = capture(t, () => sup);
  const sup = new Supervisor({ cfg: { version: '1.1.0', engineManaged: true, engineExe: path.join(tmp(), 'nope', 'encore-engine.exe'), engineConfigDir: tmp(), engineVersionCheck: true, engineUrl: 'http://127.0.0.1:3678' } });
  await sup.start();
  assert.equal(sup.info().state, 'missing');
  assert.ok(cap.lines.some((l) => /engine program is missing/.test(l)));
});

test('a crashing engine is restarted after 1 s, then 2 s; stop() ends it for good', async (t) => {
  const cap = capture(t, () => sup);
  const { sup, starts } = setup({ env: { FAKE_EXIT_AFTER: '150', FAKE_EXIT_CODE: '3' } });
  try {
    await sup.start();
    await until(() => sup.info().state === 'restarting', 5000, 'the first crash');
    assert.equal(sup.info().restarts, 1);
    const t1 = Date.now();
    await until(() => starts().length === 2, 3000, 'the restart');
    const waited = Date.now() - t1;
    assert.ok(waited >= 700, `waited about 1 s (${waited} ms)`);
    await until(() => sup.info().restarts === 2, 3000, 'the second crash');
    await sup.stop();
    assert.equal(sup.info().state, 'stopped');
    const n = starts().length;
    await sleep(2500);
    assert.equal(starts().length, n, 'no restart after stop()');
    assert.ok(cap.lines.some((l) => /the engine stopped \(exit 3\)/.test(l)));
    assert.ok(cap.lines.some((l) => /restarting the engine in 1 s/.test(l)) && cap.lines.some((l) => /restarting the engine in 2 s/.test(l)));
  } finally { await sup.stop(); }
});

test('engine log lines reach the bridge log without paths, names, codes or links', async (t) => {
  const cap = capture(t, () => sup);
  const prof = process.platform === 'win32' ? os.homedir() : '/var/lib/example-profile';
  const quotedProf = JSON.stringify(prof + (process.platform === 'win32' ? '\\AppData\\Local\\Encore\\engine\\lockfile' : '/.config/encore/lockfile'));
  const lines = [
    `time="2026-10-07T10:00:00Z" level=info msg="to complete authentication visit https://www.spotify.com/pair?code=WXYZ-1234 and, if prompted, enter code WXYZ-1234"`,
    `time="2026-10-07T10:00:01Z" level=info msg="loaded track \\"A Made-Up Song\\" (paused: false, position: 0ms, duration: 200000ms, prefetched: false)" uri="spotify:track:4uLU6hMCjMI75M1A2tKUQC"`,
    `time="2026-10-07T10:00:02Z" level=info msg="playback was transferred to Sam Sample's Laptop"`,
    `time="2026-10-07T10:00:03Z" level=info msg="authenticated AP" username="sa****le"`,
    `time="2026-10-07T10:00:04Z" level=error msg="could not lock config directory" error=${quotedProf}`,
    `time="2026-10-07T10:00:05Z" level=info msg="swept metadata for 12/40 tracks in My Secret Playlist"`,
    `time="2026-10-07T10:00:06Z" level=info msg="generated new device id: 0123456789abcdef0123456789abcdef01234567"`,
    'panic: something broke in ' + prof + (process.platform === 'win32' ? '\\x' : '/x'),
  ];
  const { sup, starts } = setup({ env: { FAKE_LINES: JSON.stringify(lines), USERPROFILE: prof, HOME: prof } });
  await sup.start();
  await until(() => starts().length === 1 && cap.lines.some((l) => /panic/.test(l)), 5000, 'the log lines');
  await sleep(100);
  const engineLines = cap.lines.filter((l) => / engine: /.test(l));
  const all = engineLines.join('\n');
  for (const bad of ['WXYZ-1234', 'spotify.com/pair', 'A Made-Up Song', 'Sam Sample', 'sa****le', 'My Secret Playlist', '0123456789abcdef0123456789abcdef01234567', prof]) {
    assert.ok(!all.includes(bad), `"${bad}" is not in the bridge log:\n${all}`);
  }
  assert.ok(/waiting for the Spotify sign-in/.test(all));
  assert.ok(/loaded track "…"/.test(all));
  assert.ok(/playback was transferred to another device/.test(all));
  assert.ok(/swept metadata for 12\/40 tracks$/m.test(all));
  assert.ok(/%USERPROFILE%/.test(all), 'the profile path is replaced');
  assert.ok(engineLines.some((l) => / E engine: could not lock config directory/.test(l)), 'error level kept');
  assert.ok(engineLines.some((l) => / W engine: panic: /.test(l)), 'raw lines come through as warnings');
});

test('cleanLine / parseLogrus / engineVersionOf / makeRedactor', () => {
  const r = makeRedactor({ USERPROFILE: 'C:\\Users\\Example Person', HOME: '' });
  assert.equal(r('open C:\\Users\\Example Person\\AppData\\x'), 'open %USERPROFILE%\\AppData\\x');
  assert.equal(r('open c:\\\\users\\\\example person\\\\x'), 'open %USERPROFILE%\\\\x', 'escaped and any case');
  assert.equal(r('open C:/Users/Example Person/x'), 'open %USERPROFILE%/x');
  assert.equal(r('D:\\Users\\Other\\x'), 'D:\\Users\\%USERNAME%\\x', 'another profile folder');
  const f = parseLogrus('time="2026-10-07T10:00:00Z" level=warning msg="a \\"b\\" c" error="x y" n=3');
  assert.deepEqual([f.level, f.msg, f.error, f.n], ['warning', 'a "b" c', 'x y', '3']);
  assert.equal(parseLogrus('just text'), null);
  const id = (s) => s;
  assert.deepEqual(cleanLine('level=warning msg="failed \\"x\\"" error="boom \\"y\\""', id), { level: 'warn', text: 'failed "…" (error: boom "…")' });
  assert.deepEqual(cleanLine('level=debug msg=ok', id), { level: 'info', text: 'ok' });
  assert.deepEqual(cleanLine('level=fatal msg="failed loading config"', id), { level: 'error', text: 'failed loading config' });
  assert.equal(cleanLine('   ', id), null);
  assert.equal(engineVersionOf('encore-engine 1.1.0 (go-librespot v0.6.2, Encore patches 1-6)'), 'encore-1.1.0');
  assert.equal(engineVersionOf('running go-librespot encore-1.1.0'), 'encore-1.1.0');
  assert.equal(engineVersionOf('go-librespot 4dbc0991 (Encore patches 1-6, unstamped)'), null);
  assert.equal(engineVersionOf(''), null);
});

test('signIn(): the pending device code passed through; only spotify.com https links; null otherwise', async () => {
  let answer = { status: 200, body: { code: 'ABCD-EFGH', url: 'https://www.spotify.com/pair?code=ABCD-EFGH', expires_at: '2026-10-07T10:10:00Z' } };
  const srv = http.createServer((req, res) => {
    if (req.url !== '/auth/code') { res.writeHead(404); return res.end(); }
    if (answer.status === 204) { res.writeHead(204); return res.end(); }
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const sup = new Supervisor({ cfg: { version: '1.1.0', engineManaged: false, engineUrl: `http://127.0.0.1:${srv.address().port}` } });
    assert.deepEqual(await sup.signIn(), { url: 'https://www.spotify.com/pair?code=ABCD-EFGH', code: 'ABCD-EFGH', expires_at: '2026-10-07T10:10:00Z' });
    answer = { status: 200, body: { code: 'ABCD-EFGH', url: 'http://phish.example/pair', expires_at: 1791000000 } };
    sup.signInMemo = { at: 0, p: null };
    assert.deepEqual(await sup.signIn(), { url: null, code: 'ABCD-EFGH', expires_at: 1791000000 });
    answer = { status: 204 };
    sup.signInMemo = { at: 0, p: null };
    assert.equal(await sup.signIn(), null);
    const down = new Supervisor({ cfg: { version: '1.1.0', engineManaged: false, engineUrl: 'http://127.0.0.1:1' } });
    assert.equal(await down.signIn(), null);
  } finally { srv.close(); }
});
