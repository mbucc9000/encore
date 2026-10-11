'use strict';
// The Spotify Client ID without Notepad (clientid.js, config.js; DESIGN-WIZARD.md §3): the settings.env vectors of
// §3.3 (replace mode: the bridge is the only writer of SPOTIFY_CLIENT_ID lines), data/settings.json, the order
// config.js reads it in (environment > settings.env > data/settings.json) and which one won, the save rules of
// POST /admin/api/wizard/client-id, and a log that never has the value. Also config.js's Encore repo address
// (DEFAULT_APP_REPO, ENCORE_APP_REPO: §3.2). Every ID below is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cfgModule = require('../src/config');
const { editSettingsEnv, writeSettingsEnv, readDataClientId, writeDataClientId, saveClientId, normalize, hint, MSG } = require('../src/clientid');
const { capture, tmp, cleanup } = require('./support/wizard-server');

after(cleanup);
const load = cfgModule.load;

const V = '0123456789abcdef0123456789abcdef';
const W = 'fedcba9876543210fedcba9876543210';
const E = 'abcabcabcabcabcabcabcabcabcabcab';      // (the environment's)
const BOM = '﻿';

// DESIGN-WIZARD.md §3.3 (⏎ = CRLF, ↵ = LF): [name, input, replace mode output]
const VECTORS = [
  ['1 CRLF template line', '# note\r\nSPOTIFY_CLIENT_ID=\r\nPORT=8095\r\n', `# note\r\nSPOTIFY_CLIENT_ID=${V}\r\nPORT=8095\r\n`],
  ['2 spaces and quotes', '  SPOTIFY_CLIENT_ID = "abc"  \n', `SPOTIFY_CLIENT_ID=${V}\n`],
  ['3 two active lines', 'SPOTIFY_CLIENT_ID=\nX=1\nSPOTIFY_CLIENT_ID=\n', `SPOTIFY_CLIENT_ID=${V}\nX=1\nSPOTIFY_CLIENT_ID=${V}\n`],
  ['4 commented, no final EOL', '#SPOTIFY_CLIENT_ID=abc', `#SPOTIFY_CLIENT_ID=abc\nSPOTIFY_CLIENT_ID=${V}\n`],
  ['5 BOM kept', `${BOM}SPOTIFY_CLIENT_ID=\n`, `${BOM}SPOTIFY_CLIENT_ID=${V}\n`],
  ['6 empty file', '', `SPOTIFY_CLIENT_ID=${V}\n`],
  ['7 near-miss keys', 'SPOTIFY_CLIENT_IDX=1\nspotify_client_id=2\n', `SPOTIFY_CLIENT_IDX=1\nspotify_client_id=2\nSPOTIFY_CLIENT_ID=${V}\n`],
  ['8 no inline notes', 'SPOTIFY_CLIENT_ID=abc # note\n', `SPOTIFY_CLIENT_ID=${V}\n`],
  ['9 already this ID', `SPOTIFY_CLIENT_ID=${V}\r\n`, `SPOTIFY_CLIENT_ID=${V}\r\n`],
  ['10 mixed terminators', 'A=1\r\nB=2\n', `A=1\r\nB=2\nSPOTIFY_CLIENT_ID=${V}\r\n`],
];

test('settings.env: the ten vectors of §3.3 in replace mode, the only mode (the table\'s platform is LF)', () => {
  for (const [name, input, replace] of VECTORS) {
    const r = editSettingsEnv(input, V, { platform: 'linux' });
    assert.equal(r.text, replace, `${name}: replace`);
    assert.equal(r.changed, replace !== input, name);
    assert.deepEqual(Object.keys(r).sort(), ['changed', 'text']);
  }
  // the set-if-unset mode is gone: an old caller's mode is ignored, it replaces
  assert.equal(editSettingsEnv('  SPOTIFY_CLIENT_ID = "abc"  \n', V, { mode: 'set-if-unset', platform: 'linux' }).text, `SPOTIFY_CLIENT_ID=${V}\n`);
});

test('settings.env: the platform EOL only for a file with no terminator of its own; a BOM-only file counts as empty (as in Go)', () => {
  assert.equal(editSettingsEnv('', V, { platform: 'win32' }).text, `SPOTIFY_CLIENT_ID=${V}\r\n`);
  assert.equal(editSettingsEnv(null, V, { platform: 'win32' }).text, `SPOTIFY_CLIENT_ID=${V}\r\n`);
  assert.equal(editSettingsEnv('#SPOTIFY_CLIENT_ID=abc', V, { platform: 'win32' }).text, `#SPOTIFY_CLIENT_ID=abc\r\nSPOTIFY_CLIENT_ID=${V}\r\n`);
  assert.equal(editSettingsEnv(BOM, V, { platform: 'win32' }).text, `${BOM}SPOTIFY_CLIENT_ID=${V}\r\n`);
  assert.equal(editSettingsEnv('A=1\n', V, { platform: 'win32' }).text, `A=1\nSPOTIFY_CLIENT_ID=${V}\n`, 'the file\'s own EOL wins');
  // a lone CR stays part of its line; everything else byte for byte
  const odd = 'A=1\rB=2\nSPOTIFY_CLIENT_ID=old\n# é ü\n';
  assert.equal(editSettingsEnv(odd, V).text, `A=1\rB=2\nSPOTIFY_CLIENT_ID=${V}\n# é ü\n`);
  // the bridge's parser agrees with the editor about what the value is afterwards
  for (const [, input] of VECTORS) {
    const out = editSettingsEnv(input, V).text;
    assert.equal(cfgModule.parseSettings(out).values.SPOTIFY_CLIENT_ID, V);
  }
});

test('writeSettingsEnv: a missing file starts from the template (else empty); only the ID line changes; tmp + rename', () => {
  const dir = tmp();
  const tpl = path.join(dir, 'settings.env.template');
  fs.writeFileSync(tpl, '# Encore Bridge settings\r\n# The setup guide fills this in for you.\r\nSPOTIFY_CLIENT_ID=\r\nPORT=8095\r\n');
  const f = path.join(dir, 'home', 'settings.env');
  writeSettingsEnv(f, V, { template: tpl });
  assert.equal(fs.readFileSync(f, 'utf8'), `# Encore Bridge settings\r\n# The setup guide fills this in for you.\r\nSPOTIFY_CLIENT_ID=${V}\r\nPORT=8095\r\n`);
  assert.ok(!fs.existsSync(f + '.tmp'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  writeSettingsEnv(f, W, { template: tpl });
  assert.equal(fs.readFileSync(f, 'utf8'), `# Encore Bridge settings\r\n# The setup guide fills this in for you.\r\nSPOTIFY_CLIENT_ID=${W}\r\nPORT=8095\r\n`);
  const g = path.join(dir, 'other', 'settings.env');
  writeSettingsEnv(g, V, { template: path.join(dir, 'missing.template'), platform: 'linux' });
  assert.equal(fs.readFileSync(g, 'utf8'), `SPOTIFY_CLIENT_ID=${V}\n`);
  const h = path.join(dir, 'third', 'settings.env');
  writeSettingsEnv(h, V, { template: null, platform: 'win32' });
  assert.equal(fs.readFileSync(h, 'utf8'), `SPOTIFY_CLIENT_ID=${V}\r\n`);
});

test('data/settings.json: written as {v, spotify_client_id} only; read back; an invalid or unreadable one ignored with a warning that has no value', () => {
  const dir = tmp();
  writeDataClientId(dir, V);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { v: 1, spotify_client_id: V });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  assert.deepEqual(readDataClientId(dir), { id: V, warning: null });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ v: 1, spotify_client_id: '  ' + V.toUpperCase() + ' ', admin_password: 'nope' }));
  assert.deepEqual(readDataClientId(dir), { id: V, warning: null }, 'trimmed, lower-cased; other keys ignored');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ v: 1, spotify_client_id: 'not-a-client-id-made-up' }));
  const r = readDataClientId(dir);
  assert.equal(r.id, null);
  assert.equal(r.warning, 'data/settings.json: the saved Spotify Client ID isn\'t valid and is ignored');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{oops not-json-made-up');
  assert.equal(readDataClientId(dir).id, null);
  assert.ok(!readDataClientId(dir).warning.includes('not-json-made-up'));
  assert.deepEqual(readDataClientId(path.join(dir, 'nowhere')), { id: null, warning: null });
  assert.deepEqual(readDataClientId(null), { id: null, warning: null });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ v: 1, spotify_client_id: '' }));
  assert.deepEqual(readDataClientId(dir), { id: null, warning: null });
});

test('config.js: environment > settings.env > data/settings.json > unset, and spotifyClientIdSource says which', () => {
  const home = tmp();
  const data = path.join(home, 'data');
  fs.mkdirSync(data, { recursive: true });
  const L = { platform: 'linux', exists: () => false };
  const env = (o) => ({ ENCORE_HOME: home, ...o });
  // nothing anywhere
  let c = load(env({}), L);
  assert.equal(c.spotifyClientId, '');
  assert.equal(c.spotifyClientIdSource, null);
  // data/settings.json only
  writeDataClientId(data, W);
  c = load(env({}), L);
  assert.deepEqual([c.spotifyClientId, c.spotifyClientIdSource], [W, 'data']);
  // settings.env with an empty value: still data/settings.json
  fs.writeFileSync(path.join(home, 'settings.env'), 'SPOTIFY_CLIENT_ID=\n');
  c = load(env({}), L);
  assert.deepEqual([c.spotifyClientId, c.spotifyClientIdSource], [W, 'data']);
  // settings.env with a value wins
  fs.writeFileSync(path.join(home, 'settings.env'), `SPOTIFY_CLIENT_ID=${V}\n`);
  c = load(env({}), L);
  assert.deepEqual([c.spotifyClientId, c.spotifyClientIdSource], [V, 'settings']);
  // the environment wins over both; an empty one counts as unset
  c = load(env({ SPOTIFY_CLIENT_ID: E }), L);
  assert.deepEqual([c.spotifyClientId, c.spotifyClientIdSource], [E, 'env']);
  c = load(env({ SPOTIFY_CLIENT_ID: '' }), L);
  assert.deepEqual([c.spotifyClientId, c.spotifyClientIdSource], [V, 'settings']);
  // Docker: no settings.env, DATA_DIR, compose passes SPOTIFY_CLIENT_ID= from an untouched .env as an empty variable
  const d = tmp();
  writeDataClientId(d, W);
  c = load({ DATA_DIR: d, SPOTIFY_CLIENT_ID: '' }, { platform: 'linux', exists: (f) => f === '/.dockerenv' });
  assert.deepEqual([c.spotifyClientId, c.spotifyClientIdSource, c.settingsFile, c.platformKind], [W, 'data', null, 'docker']);
});

test('config.js: an invalid saved value is ignored with a warning that has no value; platformKind; no repoDir any more', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ v: 1, spotify_client_id: 'zz-made-up-zz' }));
  const c = load({ DATA_DIR: d }, { platform: 'linux', exists: () => false });
  assert.equal(c.spotifyClientId, '');
  assert.equal(c.spotifyClientIdSource, null);
  assert.ok(c.settingsWarnings.includes('data/settings.json: the saved Spotify Client ID isn\'t valid and is ignored'), c.settingsWarnings.join(' | '));
  assert.ok(!c.settingsWarnings.join(' ').includes('zz-made-up-zz'));
  assert.equal(load({ DATA_DIR: d }, { platform: 'win32' }).platformKind, 'windows');
  assert.equal(load({ DATA_DIR: d }, { platform: 'linux', exists: (f) => f === '/run/.containerenv' }).platformKind, 'docker');
  assert.equal(load({ DATA_DIR: d }, { platform: 'linux', exists: () => false }).platformKind, 'other');
  assert.equal(load({ DATA_DIR: d }, { platform: 'darwin', exists: () => { throw new Error('no'); } }).platformKind, 'other');
  const c2 = load({ DATA_DIR: d, ENCORE_REPO_DIR: '/srv/encore-repo-made-up' }, { platform: 'linux', exists: () => false });
  assert.ok(!('repoDir' in c2), 'the built-in Cydia source and ENCORE_REPO_DIR are gone');
  assert.ok(!JSON.stringify(c2).includes('encore-repo-made-up'));
});

test('config.js: the Encore repo address: DEFAULT_APP_REPO on one line of its own; a valid ENCORE_APP_REPO wins; an invalid one falls back with a warning without the value', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  const m = src.match(/DEFAULT_APP_REPO\s*=\s*'([^']+)'/);                     // (the release selftest reads it like this)
  assert.ok(m, 'the constant');
  assert.equal(m[1], 'https://mbucc9000.github.io/slopkit/');
  assert.match(src, /^const DEFAULT_APP_REPO = 'https:\/\/mbucc9000\.github\.io\/slopkit\/';$/m);
  assert.equal((src.match(/DEFAULT_APP_REPO\s*=\s*'/g) || []).length, 1, 'declared once');
  assert.equal(cfgModule.DEFAULT_APP_REPO, m[1]);
  assert.ok(!Object.keys(cfgModule).includes('DEFAULT_APP_REPO'), 'not a setting');
  const d = tmp();
  const L = { platform: 'linux', exists: () => false };
  const repo = (v) => load({ DATA_DIR: d, ...(v === undefined ? {} : { ENCORE_APP_REPO: v }) }, L);
  assert.equal(repo().appRepo, m[1]);
  assert.equal(repo('').appRepo, m[1], 'empty = unset');
  assert.deepEqual(repo().settingsWarnings, []);
  for (const [v, want] of [['https://fork.example/repo/', 'https://fork.example/repo/'], ['https://fork.example/repo', 'https://fork.example/repo/'],
    ['http://fork.example:8080/cydia', 'http://fork.example:8080/cydia/'], ['  https://fork.example/r/  ', 'https://fork.example/r/'], ['https://fork.example', 'https://fork.example/'],
    ['HTTPS://Fork.Example/Repo/', 'https://fork.example/Repo/']]) {
    const c = repo(v);
    assert.equal(c.appRepo, want, v);
    assert.deepEqual(c.settingsWarnings, [], v);
  }
  for (const v of ['ftp://fork.example/repo/', 'https://user-made-up:pw-made-up@fork.example/', 'https://u-made-up@fork.example/', 'https://fork.example/r/?q=made-up',
    'https://fork.example/r/#frag-made-up', 'https://fork.example/r/?', 'garbage-made-up', 'fork.example/repo', 'file:///etc/made-up', 'javascript:alert(1)', 'https://', 'https://fork example/']) {
    const c = repo(v);
    assert.equal(c.appRepo, m[1], v);
    assert.deepEqual(c.settingsWarnings, ['ENCORE_APP_REPO isn\'t an http(s) address, so the default Encore repo is used'], v);
    assert.ok(!c.settingsWarnings.join(' ').includes('made-up'), v);
  }
  // settings.env may set it too (the environment wins, as for every setting)
  const home = tmp();
  fs.writeFileSync(path.join(home, 'settings.env'), 'ENCORE_APP_REPO=https://from-file.example/repo\n');
  assert.equal(load({ ENCORE_HOME: home }, L).appRepo, 'https://from-file.example/repo/');
  assert.equal(load({ ENCORE_HOME: home, ENCORE_APP_REPO: 'https://from-env.example/' }, L).appRepo, 'https://from-env.example/');
});

test('normalize and hint', () => {
  assert.equal(normalize('  ' + V.toUpperCase() + '\r\n'), V);
  for (const bad of ['', 'abc', V.slice(1), V + '0', 'g'.repeat(32), `${V.slice(0, 16)} ${V.slice(17)}`, null, 42, { v: V }]) assert.equal(normalize(bad), null, String(bad));
  assert.equal(hint(V), '…cdef');
  assert.equal(hint(''), null);
});

// a webapi stub with the parts saveClientId uses
function fakeWebApi(clientId, connected) {
  return { clientId, refreshToken: connected ? 'rt' : null, calls: [],
    setClientId(id) { this.calls.push(id); const d = !!this.refreshToken; this.clientId = id; this.refreshToken = null; return { changed: true, disconnected: d }; } };
}

test('saveClientId: the cases of §3.1 in order; settings.env or data/settings.json; the log never has the value', () => {
  const home = tmp();
  const cap = capture();
  try {
    // 400 before anything else (even with an environment ID)
    for (const bad of ['', 'abc', V + 'x', null, 123]) {
      assert.throws(() => saveClientId({ cfg: { spotifyClientIdSource: 'env' }, webapi: fakeWebApi('', false), body: { client_id: bad } }),
        (e) => e.status === 400 && e.code === 'bad_client_id' && e.message === MSG.bad_client_id, String(bad));
    }
    // 409 from the environment
    assert.throws(() => saveClientId({ cfg: { spotifyClientIdSource: 'env', spotifyClientId: W }, webapi: fakeWebApi(W, true), body: { client_id: V } }),
      (e) => e.status === 409 && e.code === 'client_id_env' && e.message === MSG.client_id_env);
    // the same one: nothing written
    const cfg1 = { settingsFile: path.join(home, 'settings.env'), dataDir: path.join(home, 'data'), spotifyClientId: V, spotifyClientIdSource: 'settings' };
    let r = saveClientId({ cfg: cfg1, webapi: fakeWebApi(V, true), body: { client_id: V.toUpperCase() } });
    assert.deepEqual(r, { ok: true, source: 'settings', hint: '…cdef', disconnected: false });
    assert.ok(!fs.existsSync(cfg1.settingsFile), 'nothing written');
    // a different one while connected: ask first
    const wa = fakeWebApi(V, true);
    assert.throws(() => saveClientId({ cfg: cfg1, webapi: wa, body: { client_id: W } }), (e) => e.status === 409 && e.code === 'client_id_replace');
    assert.throws(() => saveClientId({ cfg: cfg1, webapi: wa, body: { client_id: W, replace: 'yes' } }), (e) => e.code === 'client_id_replace', 'only true counts');
    assert.deepEqual(wa.calls, []);
    // replace: true -> saved in settings.env, applied, disconnected
    let disc = 0;
    r = saveClientId({ cfg: cfg1, webapi: wa, body: { client_id: W, replace: true }, onDisconnect: () => disc++ });
    assert.deepEqual(r, { ok: true, source: 'settings', hint: '…3210', disconnected: true });
    assert.equal(fs.readFileSync(cfg1.settingsFile, 'utf8'), `SPOTIFY_CLIENT_ID=${W}${process.platform === 'win32' ? '\r\n' : '\n'}`);
    assert.deepEqual(wa.calls, [W]);
    assert.equal(disc, 1);
    assert.equal(cfg1.spotifyClientId, W);
    assert.equal(cfg1.spotifyClientIdSource, 'settings');
    // no settings.env (Docker): data/settings.json; not connected: no question; Showcase: no hint
    const cfg2 = { settingsFile: null, dataDir: path.join(home, 'd2'), spotifyClientId: '', spotifyClientIdSource: null };
    r = saveClientId({ cfg: cfg2, webapi: fakeWebApi('', false), body: { client_id: V }, showcase: true });
    assert.deepEqual(r, { ok: true, source: 'data', hint: null, disconnected: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg2.dataDir, 'settings.json'), 'utf8')), { v: 1, spotify_client_id: V });
    r = saveClientId({ cfg: cfg2, webapi: fakeWebApi(V, false), body: { client_id: W } });
    assert.deepEqual(r, { ok: true, source: 'data', hint: '…3210', disconnected: false }, 'set but not connected: no question');
    // the write fails: 500 with the error code only
    const cfg3 = { settingsFile: home, dataDir: path.join(home, 'd3'), spotifyClientId: '', spotifyClientIdSource: null };     // (a folder)
    assert.throws(() => saveClientId({ cfg: cfg3, webapi: fakeWebApi('', false), body: { client_id: V } }),
      (e) => e.status === 500 && e.code === 'client_id_save' && /^The Client ID couldn't be saved \([A-Z]+\)\.$/.test(e.message), 'EISDIR or similar');
  } finally { cap.restore(); }
  const text = cap.text();
  for (const v of [V, W, V.toUpperCase(), V.slice(-8), W.slice(-8)]) assert.ok(!text.includes(v), `${v} in the log:\n${text}`);
  assert.ok(cap.lines.some((l) => /Spotify Client ID saved \(settings\.env\)$/.test(l)), text);
  assert.ok(cap.lines.some((l) => /Spotify Client ID saved \(data\/settings\.json\)$/.test(l)), text);
  assert.ok(cap.lines.some((l) => /Spotify account disconnected: the Client ID changed$/.test(l)), text);
});

test('the template from <appDir>/settings.env.template when settings.env is missing', () => {
  const app = tmp();
  const home = tmp();
  fs.writeFileSync(path.join(app, 'settings.env.template'), '# made-up template\nSPOTIFY_CLIENT_ID=\nPORT=8095\n');
  const cfg = { settingsFile: path.join(home, 'settings.env'), appDir: app, dataDir: path.join(home, 'data'), spotifyClientId: '', spotifyClientIdSource: null };
  const cap = capture();
  try { saveClientId({ cfg, webapi: fakeWebApi('', false), body: { client_id: V } }); } finally { cap.restore(); }
  assert.equal(fs.readFileSync(cfg.settingsFile, 'utf8'), `# made-up template\nSPOTIFY_CLIENT_ID=${V}\nPORT=8095\n`);
});
