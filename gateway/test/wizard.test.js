'use strict';
// The setup guide's state (wizard.js; DESIGN-WIZARD.md §1-§2, §5): a fresh bridge shows the guide (ten steps); a
// bridge that is already set up completes it by itself ("auto") and never reopens it; skip / dismiss / complete
// persist in data/wizard.json; step 6 (the app, from the Encore repo) ticks only with a paired phone; step 8 (Listen
// away from home): noteAway() ticks it once and for good; an older wizard.json (downloaded_at, an old skipped list)
// still loads; the "Play a song" rules; Showcase trims the answer (the repo address stays: it is public); nothing in an
// answer or in the file is a name, a code, a Client ID, a path or a public IP. Stubs only; every name below is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Wizard, STEPS } = require('../src/wizard');
const { capture, tmp, cleanup, NAMES, DEFAULT_APP_REPO } = require('./support/wizard-server');

after(cleanup);

const CID = '0123456789abcdef0123456789abcdef';
const REPO = 'https://repo.example/encore/';

// the facts a wizard reads, as stubs; o overrides
function facts(o = {}) {
  const st = { mode: 'stored', devices: [], ready: false, clientId: '', showcase: false, playing: null, heard: null, listening: 0,
    engine: { state: 'signed_out' }, address: '192.168.1.20', router: '192.168.1.1', net: null,
    candidates: [{ name: 'Wi-Fi', address: '192.168.1.20', virtual: false }], ...o };
  return {
    st,
    adminAuth: { mode: () => st.mode },
    webapi: { get clientId() { return st.clientId; }, get ready() { return st.ready; }, get authBroken() { return st.authBroken || null; }, catchCallback: !!st.catch,
      get lastCatch() { return st.lastCatch || null; } },
    auth: { list: () => st.devices },
    player: { get st() { return { status: st.playing ? 'playing' : 'stopped', track: st.playing }; }, heardInfo: () => st.heard },
    encoders: { listening: () => st.listening },
    showcase: { isOn: () => st.showcase },
    netcheck: { summary: () => (st.net ? { ok: st.net.ok, checked_at: st.net.checked_at } : { ok: null, checked_at: null }) },
    engineState: async () => st.engine,
    lanAddress: async () => st.address,
    router: async () => st.router,
    candidates: () => st.candidates,
  };
}

function wizard(f, { dir = tmp(), now = () => Date.now(), cfg = {} } = {}) {
  return new Wizard({ cfg: { dataDir: dir, port: 8095, platformKind: 'docker', appRepo: REPO, spotifyClientIdSource: f.st.clientId ? 'data' : null, ...cfg }, now, ...f });
}

test('a fresh bridge: the guide shows, nothing is done but the password, and every field of the answer is there', async () => {
  const f = facts();
  const dir = tmp();
  const w = wizard(f, { dir });
  const a = await w.answer();
  assert.equal(a.v, 1);
  assert.equal(a.platform, 'docker');
  assert.equal(a.show, true);
  assert.equal(a.complete, false);
  assert.equal(a.complete_how, null);
  assert.equal(a.dismissed, false);
  assert.deepEqual(a.skipped, []);
  assert.deepEqual(Object.keys(a.steps), STEPS);
  assert.deepEqual(STEPS, ['password', 'client_id', 'spotify', 'engine', 'network', 'app', 'pair', 'away', 'play', 'jam'], 'ten steps, away before play, Jam last');
  assert.deepEqual(a.steps.password, { done: true, how: 'stored' });
  assert.deepEqual(a.steps.client_id, { done: false, source: null, editable: true, hint: null });
  assert.deepEqual(a.steps.spotify, { done: false, configured: false, catch_callback: false, auth_broken: false, error: null });
  assert.deepEqual(a.steps.engine, { done: false, state: 'signed_out', managed: false });
  assert.deepEqual(a.steps.network, { done: false, ok: null, checked_at: null });
  assert.deepEqual(a.steps.app, { done: false, repo_url: REPO });
  assert.deepEqual(a.steps.pair, { done: false, paired: 0, newest_at: null, address: '192.168.1.20', port: 8095 });
  assert.deepEqual(a.steps.away, { done: false, seen_at: null, address: '192.168.1.20', addresses: ['192.168.1.20'], router: '192.168.1.1', port: 8095 });
  assert.deepEqual(a.steps.play, { done: false, played_at: null });
  assert.deepEqual(a.steps.jam, { done: false, access: 'unknown', retry_at: null }, 'step 10 (wizard-jam.test.js): no Jam module here');
  assert.ok(Math.abs(a.now - Date.now()) < 5000);
  assert.ok(!fs.existsSync(path.join(dir, 'wizard.json')), 'nothing written until something happens');
});

test('an install that is already set up completes by itself ("auto"), at start or at a later read, and stays complete', async () => {
  const dir = tmp();
  const cap = capture();
  let w;
  try {
    const f = facts({ clientId: CID, ready: true, devices: [{ id: NAMES.dev, name: NAMES.phone, created: '2026-10-07T12:00:00.000Z' }] });
    w = wizard(f, { dir });
  } finally { cap.restore(); }
  let a = await w.answer();
  assert.equal(a.complete, true);
  assert.equal(a.complete_how, 'auto');
  assert.equal(a.show, false);
  assert.ok(cap.lines.some((l) => /setup guide: this bridge is already set up/.test(l)));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'wizard.json'), 'utf8'));
  assert.equal(saved.complete, true);
  assert.equal(saved.complete_how, 'auto');
  assert.ok(saved.completed_at > 0);
  // every phone unpaired, the account disconnected: still complete
  const g = facts({ clientId: CID, ready: false, devices: [] });
  a = await wizard(g, { dir }).answer();
  assert.equal(a.complete, true);
  assert.equal(a.show, false);

  // not set up at start, set up later: complete at the next read
  const h = facts({ clientId: CID, ready: true });
  const w2 = wizard(h, { dir: tmp() });
  assert.equal((await w2.answer()).complete, false);
  h.st.devices = [{ id: NAMES.dev, name: NAMES.phone, created: '2026-10-07T12:00:00.000Z' }];
  a = await w2.answer();
  assert.equal(a.complete, true);
  assert.equal(a.complete_how, 'auto');
  // any one fact missing: not complete
  for (const miss of [{ mode: 'setup' }, { clientId: '' }, { ready: false }, { devices: [] }]) {
    const k = facts({ clientId: CID, ready: true, devices: [{ id: 'dev_1', created: 'x' }], ...miss });
    assert.equal((await wizard(k).answer()).complete, false, JSON.stringify(miss));
  }
});

test('skip, dismiss and complete persist; the password can\'t be skipped; anything else is a 400', async () => {
  const dir = tmp();
  const f = facts();
  const w = wizard(f, { dir });
  w.act({ action: 'skip', step: 'network' });
  w.act({ action: 'skip', step: 'app' });
  w.act({ action: 'skip', step: 'network' });
  w.act({ action: 'skip', step: 'away' });
  for (const b of [{ action: 'skip', step: 'password' }, { action: 'skip', step: 'nope' }, { action: 'skip' }, { action: 'reset' }, {}, { action: 'complete ' }]) {
    assert.throws(() => w.act(b), (e) => e.status === 400 && e.code === 'bad_request', JSON.stringify(b));
  }
  let a = await wizard(f, { dir }).answer();
  assert.deepEqual(a.skipped, ['network', 'app', 'away']);
  assert.equal(a.steps.network.done, false, 'a skipped step stays not done');
  assert.equal(a.steps.away.done, false);
  w.act({ action: 'dismiss' });
  a = await wizard(f, { dir }).answer();
  assert.equal(a.dismissed, true);
  assert.equal(a.show, false);
  assert.equal(a.complete, false);
  const cap = capture();
  try { w.act({ action: 'complete' }); } finally { cap.restore(); }
  assert.ok(cap.lines.some((l) => /setup guide: finished/.test(l)));
  a = await wizard(f, { dir }).answer();
  assert.equal(a.complete, true);
  assert.equal(a.complete_how, 'finished');
  w.act({ action: 'complete' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'wizard.json'), 'utf8')).complete_how, 'finished', 'a second Finish changes nothing');
});

test('data/wizard.json: written with tmp + rename, only the known keys; unreadable means a fresh state and a warning without content', async () => {
  const dir = tmp();
  const f = facts();
  const w = wizard(f, { dir });
  w.act({ action: 'skip', step: 'pair' });
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'wizard.json'), 'utf8'));
  assert.deepEqual(Object.keys(j).sort(), ['away_seen_at', 'complete', 'complete_how', 'completed_at', 'dismissed', 'played_at', 'skipped', 'v'].sort());
  assert.ok(!fs.existsSync(path.join(dir, 'wizard.json.tmp')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'wizard.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'wizard.json'), '{"complete": tru SECRET-CONTENT');
  const cap = capture();
  let a;
  try { a = await wizard(f, { dir }).answer(); } finally { cap.restore(); }
  assert.equal(a.complete, false);
  assert.deepEqual(a.skipped, []);
  assert.ok(cap.lines.some((l) => /wizard\.json is unreadable/.test(l)));
  assert.ok(!cap.text().includes('SECRET-CONTENT'));
  // odd values are cleaned up on load
  fs.writeFileSync(path.join(dir, 'wizard.json'), JSON.stringify({ v: 1, complete: 'yes', dismissed: 1, skipped: ['password', 'app', 'zzz', 'app'], downloaded_at: -5, away_seen_at: 'x', played_at: 'x', extra: NAMES.phone }));
  a = await wizard(f, { dir }).answer();
  assert.equal(a.complete, false);
  assert.equal(a.dismissed, false);
  assert.deepEqual(a.skipped, ['app']);
  assert.equal(a.steps.away.seen_at, null);
  assert.equal(a.steps.play.played_at, null);
});

test('an older data/wizard.json (before step 8): its downloaded_at is ignored and never written back; its skipped list still works', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'wizard.json'), JSON.stringify({ v: 1, complete: false, complete_how: null, completed_at: null, dismissed: true,
    skipped: ['network', 'app'], downloaded_at: 1760000000000, played_at: null }));
  const f = facts();
  const w = wizard(f, { dir });
  let a = await w.answer();
  assert.deepEqual(a.skipped, ['network', 'app']);
  assert.equal(a.dismissed, true);
  assert.equal(a.steps.app.done, false, 'an old Cydia download no longer ticks step 6');
  assert.deepEqual(Object.keys(a.steps.app).sort(), ['done', 'repo_url']);
  assert.deepEqual([a.steps.away.done, a.steps.away.seen_at], [false, null]);
  w.act({ action: 'skip', step: 'away' });
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'wizard.json'), 'utf8'));
  assert.ok(!('downloaded_at' in j), 'not written back');
  assert.deepEqual(j.skipped, ['network', 'app', 'away']);
  assert.equal(j.away_seen_at, null);
  a = await wizard(f, { dir }).answer();
  assert.deepEqual(a.skipped, ['network', 'app', 'away']);
});

test('step 8: noteAway() ticks it once, persisted, one log line without an address; a second call writes nothing', async () => {
  const dir = tmp();
  let clock = 1760000000000;
  const f = facts();
  const w = wizard(f, { dir, now: () => clock });
  w.act({ action: 'skip', step: 'away' });
  const cap = capture();
  let first, second;
  try {
    first = w.noteAway();
    const file = path.join(dir, 'wizard.json');
    const before = fs.readFileSync(file, 'utf8');
    const mtime = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    clock += 60000;
    second = w.noteAway();
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'no second write');
    assert.equal(fs.statSync(file).mtimeMs, mtime);
  } finally { cap.restore(); }
  assert.deepEqual([first, second], [true, false]);
  assert.equal(cap.lines.filter((l) => /setup guide: a phone reached the bridge from outside the home network$/.test(l)).length, 1, cap.text());
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(cap.text()), 'no address in the log');
  let a = await w.answer();
  assert.deepEqual(a.steps.away, { done: true, seen_at: 1760000000000, address: '192.168.1.20', addresses: ['192.168.1.20'], router: '192.168.1.1', port: 8095 });
  assert.deepEqual(a.skipped, ['away'], 'a skipped step that becomes done: done wins on the page');
  a = await wizard(f, { dir }).answer();
  assert.equal(a.steps.away.seen_at, 1760000000000, 'kept across a restart');
  // it never reverts
  f.st.devices = [];
  assert.equal((await wizard(f, { dir }).answer()).steps.away.done, true);
  // no data folder: in memory
  const quiet = capture();
  let m;
  try {
    m = new Wizard({ cfg: { port: 8095 }, ...facts(), now: () => 5 });
    assert.equal(m.noteAway(), true);
  } finally { quiet.restore(); }
  assert.equal((await m.answer()).steps.away.seen_at, 5);
});

test('step 8\'s addresses: the chosen one first, then other private addresses on real adapters, no duplicates; none known: null / []', async () => {
  const f = facts({ candidates: [{ name: 'vEthernet (WSL)', address: '172.20.1.1', virtual: true }, { name: 'Ethernet', address: '10.0.0.5', virtual: false },
    { name: 'Wi-Fi', address: '192.168.1.20', virtual: false }, { name: 'Wi-Fi 2', address: '10.0.0.5', virtual: false }] });
  let a = await wizard(f).answer();
  assert.deepEqual(a.steps.away.addresses, ['192.168.1.20', '10.0.0.5']);
  assert.equal(a.steps.away.address, '192.168.1.20');
  assert.equal(a.steps.away.port, 8095);
  f.st.address = null;
  f.st.candidates = [];
  a = await wizard(f).answer();
  assert.deepEqual([a.steps.away.address, a.steps.away.addresses], [null, []]);
  const g = facts();
  g.candidates = () => { throw new Error('no adapters'); };
  assert.deepEqual((await wizard(g).answer()).steps.away.addresses, ['192.168.1.20']);
  // another port
  assert.equal((await wizard(facts(), { cfg: { port: 18095 } }).answer()).steps.away.port, 18095);
});

test('step 8\'s router (Open your router): the address found, null when none or when the lookup fails, never in Showcase or the file', async () => {
  const dir = tmp();
  const f = facts();
  let a = await wizard(f, { dir }).answer();
  assert.equal(a.steps.away.router, '192.168.1.1');
  assert.equal(a.steps.pair.router, undefined, 'only step 8 has it');
  f.st.router = null;
  assert.equal((await wizard(f, { dir }).answer()).steps.away.router, null);
  const g = facts();
  g.router = async () => { throw new Error('no routes'); };
  a = await wizard(g, { dir }).answer();
  assert.deepEqual([a.steps.away.router, a.steps.away.address], [null, '192.168.1.20'], 'a failing lookup: no router, the rest as before');
  // the default (no router lookup given): none
  const h = facts();
  delete h.router;
  assert.equal((await wizard(h, { dir }).answer()).steps.away.router, null);
  // Showcase: hidden like the addresses
  a = await wizard(facts({ showcase: true }), { dir }).answer();
  assert.equal(a.steps.away.router, null);
  // never written to data/wizard.json
  const w = wizard(facts(), { dir });
  w.act({ action: 'skip', step: 'away' });
  assert.ok(!fs.readFileSync(path.join(dir, 'wizard.json'), 'utf8').includes('192.168.1.1'));
});

test('Play a song: a fresh, unstalled report about 1 s in, or a phone listening 5 s, while a song plays; persisted', async () => {
  const track = { name: 'A Made-Up Song' };
  let clock = 1760000000000;
  const cases = [
    [{ playing: track, heard: { age_ms: 1000, stalled: false, frame: 50 } }, true],
    [{ playing: track, heard: { age_ms: 1000, stalled: false, frame: 43 } }, true],
    [{ playing: track, heard: { age_ms: 1000, stalled: false, frame: 42 } }, false],
    [{ playing: track, heard: { age_ms: 1000, stalled: true, frame: 500 } }, false],
    [{ playing: track, heard: { age_ms: 15000, stalled: false, frame: 500 } }, false],
    [{ playing: null, heard: { age_ms: 100, stalled: false, frame: 500 } }, false],
    [{ playing: track, heard: null }, false],
  ];
  for (const [o, want] of cases) {
    const a = await wizard(facts(o), { now: () => clock }).answer();
    assert.equal(a.steps.play.done, want, JSON.stringify(o));
    assert.equal(a.steps.play.played_at != null, want);
  }
  // listening: needs 5 s of reads while playing
  const f = facts({ playing: track, listening: 1 });
  const dir = tmp();
  const w = wizard(f, { dir, now: () => clock });
  assert.equal((await w.answer()).steps.play.done, false);
  clock += 2000;
  assert.equal((await w.answer()).steps.play.done, false);
  f.st.listening = 0;                                // the phone stopped listening: the 5 s start over
  clock += 2000;
  assert.equal((await w.answer()).steps.play.done, false);
  f.st.listening = 1;
  clock += 2000;
  assert.equal((await w.answer()).steps.play.done, false);
  clock += 4000;
  assert.equal((await w.answer()).steps.play.done, false, '4 s');
  clock += 1000;
  const a = await w.answer();
  assert.equal(a.steps.play.done, true, '5 s');
  assert.equal(a.steps.play.played_at, clock);
  // it stays done after the music stops, and across a restart
  f.st.playing = null;
  f.st.listening = 0;
  assert.equal((await wizard(f, { dir, now: () => clock }).answer()).steps.play.played_at, clock);
});

test('the steps tick from the bridge\'s state: network (a check or a paired phone), app (only a paired phone), pair, spotify', async () => {
  const f = facts({ net: { ok: false, checked_at: 5 } });
  let a = await wizard(f).answer();
  assert.deepEqual(a.steps.network, { done: false, ok: false, checked_at: 5 });
  assert.equal(a.steps.app.done, false, 'no phone paired: the bridge can\'t tell whether Cydia installed it');
  f.st.net = { ok: true, checked_at: 6 };
  assert.equal((await wizard(f).answer()).steps.network.done, true);
  f.st.net = null;
  f.st.devices = [{ id: 'dev_1', name: NAMES.phone, created: '2026-10-07T12:00:00.000Z' }, { id: 'dev_2', name: 'Other', created: '2026-10-08T09:30:00.000Z' }];
  a = await wizard(f).answer();
  assert.equal(a.steps.network.done, true, 'a paired phone proves the network');
  assert.equal(a.steps.app.done, true, 'a paired phone has the app');
  assert.deepEqual(a.steps.pair, { done: true, paired: 2, newest_at: Date.parse('2026-10-08T09:30:00.000Z'), address: '192.168.1.20', port: 8095 });
  assert.equal(a.steps.app.repo_url, REPO);
  assert.equal(a.steps.away.done, false, 'a paired phone at home doesn\'t tick step 8');
  assert.equal(typeof Wizard.prototype.noteDownload, 'undefined', 'no Cydia downloads any more');
  // no appRepo in the settings: null (config.js always has one)
  assert.equal((await wizard(facts(), { cfg: { appRepo: undefined } }).answer()).steps.app.repo_url, null);
  // spotify: connected and not broken; the engine: signed in
  const h = facts({ clientId: CID, ready: true, authBroken: { at: 1 }, engine: { state: 'signed_in', managed: true, same_account: false }, catch: true });
  a = await wizard(h).answer();
  assert.deepEqual(a.steps.spotify, { done: false, configured: true, catch_callback: true, auth_broken: true, error: null });
  assert.deepEqual(a.steps.engine, { done: true, state: 'signed_in', managed: true });
  h.st.authBroken = null;
  assert.equal((await wizard(h).answer()).steps.spotify.done, true);
  // Windows: the caught redirect didn't connect (Spotify refused the account): its code, only while not connected
  h.st.lastCatch = { code: 'spotify_forbidden', at: 1 };
  assert.equal((await wizard(h).answer()).steps.spotify.error, null, 'connected: no error');
  h.st.ready = false;
  assert.equal((await wizard(h).answer()).steps.spotify.error, 'spotify_forbidden');
  // the engine's look failing: unknown, not done
  const k = facts({});
  k.engineState = async () => { throw new Error('engine down'); };
  assert.deepEqual((await wizard(k).answer()).steps.engine, { done: false, state: 'unknown', managed: false });
});

test('the Client ID: its source, editable unless it comes from the environment, a hint of the last 4 characters only', async () => {
  for (const [source, editable] of [['env', false], ['settings', true], ['data', true]]) {
    const a = await wizard(facts({ clientId: CID }), { cfg: { spotifyClientIdSource: source } }).answer();
    assert.deepEqual(a.steps.client_id, { done: true, source, editable, hint: '…cdef' });
  }
});

test('Showcase: no Client ID hint, no addresses (steps 7 and 8), the Encore repo address stays (public); no address known: nulls', async () => {
  const f = facts({ clientId: CID, showcase: true, candidates: [{ name: 'Wi-Fi', address: '192.168.1.20', virtual: false }, { name: 'Ethernet', address: '10.0.0.5', virtual: false }] });
  let a = await wizard(f).answer();
  assert.equal(a.showcase, true);
  assert.equal(a.steps.client_id.hint, null);
  assert.equal(a.steps.client_id.done, true);
  assert.deepEqual(a.steps.app, { done: false, repo_url: REPO });
  assert.equal(a.steps.pair.address, null);
  assert.equal(a.steps.pair.port, 8095);
  assert.deepEqual(a.steps.away, { done: false, seen_at: null, address: null, addresses: null, router: null, port: 8095 });
  const text = JSON.stringify(a);
  assert.ok(!text.includes('192.168.1.20') && !text.includes('10.0.0.5') && !text.includes('192.168.1.1'), text);
  const g = facts({ address: null });
  a = await wizard(g).answer();
  assert.equal(a.steps.pair.address, null);
  assert.equal(a.steps.away.address, null);
});

test('the default Encore repo address comes from config.js\'s DEFAULT_APP_REPO', async () => {
  assert.equal(DEFAULT_APP_REPO, 'https://mbucc9000.github.io/slopkit/');
  assert.equal((await wizard(facts(), { cfg: { appRepo: DEFAULT_APP_REPO } }).answer()).steps.app.repo_url, DEFAULT_APP_REPO);
});

test('no names, codes, Client IDs, paths or public IPs in any answer or in data/wizard.json', async () => {
  const dir = tmp();
  const f = facts({ clientId: CID, ready: true, catch: true, engine: { state: 'code', code: 'ABCD1234', url: 'https://www.spotify.com/pair?code=ABCD1234', managed: true },
    devices: [{ id: NAMES.dev, name: NAMES.phone, created: '2026-10-07T12:00:00.000Z', last_seen: '2026-10-07T12:00:00.000Z', address: '203.0.113.7' }] });
  const w = wizard(f, { dir });
  w.act({ action: 'skip', step: 'engine' });
  const cap = capture();
  try { w.noteAway(); } finally { cap.restore(); }
  for (const sc of [false, true]) {
    f.st.showcase = sc;
    const text = JSON.stringify(await w.answer());
    for (const v of [CID, NAMES.dev, NAMES.phone, 'ABCD1234', 'spotify.com/pair', dir, path.basename(dir), '203.0.113']) assert.ok(!text.includes(v), `${v} in ${text}`);
  }
  const file = fs.readFileSync(path.join(dir, 'wizard.json'), 'utf8');
  for (const v of [CID, NAMES.dev, NAMES.phone, '192.168.1.20', 'ABCD1234', '203.0.113']) assert.ok(!file.includes(v), v);
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(file), 'no address of any kind in the file');
});

test('the admin status line and the launcher\'s complete flag', () => {
  const f = facts();
  const w = wizard(f);
  assert.deepEqual(w.statusInfo(), { complete: false, dismissed: false });
  assert.equal(w.isComplete(), false);
  w.act({ action: 'dismiss' });
  assert.deepEqual(w.statusInfo(), { complete: false, dismissed: true });
  w.act({ action: 'complete' });
  assert.deepEqual(w.statusInfo(), { complete: true, dismissed: true });
  assert.equal(w.isComplete(), true);
});

test('no data folder: the guide works in memory', async () => {
  const f = facts();
  const w = new Wizard({ cfg: { port: 8095 }, ...f });
  w.act({ action: 'skip', step: 'network' });
  assert.deepEqual((await w.answer()).skipped, ['network']);
  assert.equal((await w.answer()).platform, 'other');
});
