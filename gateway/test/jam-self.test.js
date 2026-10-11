'use strict';
// DESIGN-JAM-SELF §3.11: the device that starts a Jam switches itself into Jam mode; Spotify never hands it to the host
// (live, 2026-10-07). jam.js's G0-G7 against the engine model (jam-engine.js) with patches 4 and 5's routes listed:
// after our own Start of a session hosted on Encore, one engine-local POST /jam/activate (never a social-connect send),
// and one /jam/forget when that Jam ends. The model's "Spotify" never hands a started Jam over (o.handOver 'never')
// unless a test says so. Nothing here can reach social-connect.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PcmClock } = require('../src/pcm');
const { Player } = require('../src/player');
const { Jam } = require('../src/jam');
const { JamEngine, fakeJamEngine, session, T, ROUTES, PC, DEV, LINK, RADAR, hex32, id22 } = require('./support/jam-engine');
const { tmp, sleep } = require('./support/helpers');

const FAST = { setDebounce: 20, inactiveDebounce: 30, ownConfirmMs: 300, endSettleMs: 400, leaveSettleMs: 60, noSession: 20, connectRead: 20,
  queueDebounce: 10, queueRetry: 50, queueTimeout: 1000, addGapMs: 5, joinGenWaitMs: 150, idleGrace: 30, queueEditTimeout: 300 };
const SELF = { ...FAST, selfJamMs: 60, selfCheckMs: 50 };
const P4 = [...ROUTES, 'broadcast'];                 // a patch-4 engine's jam_routes
const P5 = [...ROUTES, 'broadcast', 'activate'];     // a patch-5 engine's
const PL = 'spotify:playlist:' + 'p'.repeat(22);
const live = [];                                     // every Jam made here: closed at the start of the next test

// a gateway (player + jam) over the model m, its data in dir
function make(m, dir, o = {}) {
  const engine = fakeJamEngine(m);
  const clock = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-gwself.pcm'), { leadMs: 10000 });
  const pushes = [];
  const bus = { push: (type, data) => pushes.push({ type, data }) };
  const player = new Player({ engine, clock, bus, webapi: null, dataDir: dir });
  const encoders = { n: 1, listening() { return this.n; } };
  const jam = new Jam({ cfg: { dataDir: dir, jam: o.flags || {} }, engine, player, bus, webapi: null, encoders, timing: { ...SELF, ...o.timing } });
  clearInterval(jam.ticker);
  player.jam = jam;
  live.push(jam);
  return { m, engine, player, jam, pushes, dir };
}
async function setup(o = {}) {
  const m = new JamEngine({ spacingMs: 0, routes: P5, ...o.engine });
  const s = make(m, tmp('jamself'), o);
  s.jam.sc = 'sc' in o ? o.sc : 1;
  await s.engine.refresh();
  return s;
}
// a gateway restart on the same data dir and engine: the old one hears nothing more; the new one's first /status
async function restart(s) {
  await s.jam.saveChain;
  s.engine.removeAllListeners();
  s.jam.close();
  const r = make(s.m, s.dir);
  await r.engine.refresh();
  return r;
}
const closeAll = () => { while (live.length) live.pop().close(); };
const evs = (pushes) => pushes.filter((x) => x.type === 'jam' && x.data.ev).map((x) => x.data.ev);
const settle = async (jam, ms = 60) => { await sleep(ms); if (jam.flight) await jam.flight; await sleep(5); };
const trace = (jam, k) => jam.ring.filter((e) => e.k === k);
const ops = (m) => m.calls.map((c) => c.op);
// the engine's /jam/* requests in order, the local ones (activate, forget) included, a broadcast write with its status
const jamCalls = (m) => m.log.filter((x) => x.path.startsWith('/jam/'))
  .map((x) => `${x.method} ${x.path.split('?')[0]}${x.method === 'POST' && x.path === '/jam/broadcast' ? ' ' + x.body.status : ''}`);
const forgets = (m) => m.count(/^\/jam\/forget/);
const saved = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'jam.json'), 'utf8'));
const play = (m) => m.load(T(1), { ctx: PL });
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(20);
  }
}

// everything logged while fn runs
async function captured(fn) {
  const out = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, keep); }
  return out.join('\n');
}

// a host Jam playing on Encore, started elsewhere (Spotify drives it), session read
async function hosting(o = {}) {
  const s = await setup(o);
  s.m.spotify = session({ members: ['alex', 'jake'], ...o.session });
  play(s.m);
  s.m.jamStarts(1);
  await settle(s.jam);
  return s;
}
// our Start, never handed over: Encore switched itself into Jam mode, the latch set
async function selfHosting(o = {}) {
  const s = await setup(o);
  play(s.m);
  await s.jam.start();
  await waitFor(() => !!s.jam.selfJam && s.jam.latch.set);
  await settle(s.jam);
  return s;
}

// ---------------------------------------------------------------- G1, G2, G3: Start -> self
test('S1 start -> self: one POST /jam/activate selfJamMs after start\'s reply, the event latches; no confirm read, no wait; 3 sends, calls5m 3', async () => {
  closeAll();
  const { m, jam, pushes } = await setup();
  play(m);
  const out = await captured(async () => {
    const r = await jam.start();
    assert.equal(r.jam.on, 1); assert.equal(r.jam.r, 'host');
    assert.equal(m.activations, 0, 'not before selfJamMs');
    await sleep(150);
    await settle(jam);
  });
  assert.deepEqual(jamCalls(m), ['GET /jam/current', 'POST /jam/broadcast on', 'POST /jam/start', 'POST /jam/activate']);
  assert.equal(m.activations, 1);
  assert.deepEqual(ops(m), ['current', 'broadcast', 'start']);
  assert.equal(m.sends(), 3); assert.equal(jam.calls5m(), 3, 'the local call is not counted'); assert.equal(m.gate.sends.length, 3);
  assert.equal(jam.latch.set, true); assert.equal(m.st.mode, 'on');
  assert.ok(trace(jam, 'latch').some((e) => e.set === 1 && e.from === 'event'));
  assert.deepEqual(trace(jam, 'call').filter((e) => e.op === 'activate').map((e) => e.status), [200]);
  assert.deepEqual(trace(jam, 'self').map(({ t, ...e }) => e), [{ k: 'self', status: 200, changed: 1 }]);
  assert.deepEqual(trace(jam, 'jam').map((e) => [e.mode, e.social, e.ctx]), [['on', 0, 'playlist']]);
  assert.deepEqual(trace(jam, 'cluster').map((e) => [e.active, e.mode]), [['self', 'on']], 'Spotify\'s echo, traced');
  assert.match(out, /jam: Start: no hand-over from Spotify \d+ s after our start: Encore switches itself into Jam mode/);
  assert.match(out, /jam: a Jam plays on Encore \(event: mode "on", other origin, playlist\)/);
  assert.match(out, /jam: Encore is in Jam mode \(switched on\); its Connect state says so/);
  assert.equal(jam.selfJam.sid, m.spotify.session_id);
  // past ownConfirmMs: still no confirm read, no wait, hosting
  await sleep(450);
  await settle(jam);
  assert.equal(m.sends('current'), 1, 'no confirm read');
  assert.equal(jam.wait, false);
  const b = jam.body();
  assert.equal(b.on, 1); assert.equal(b.r, 'host'); assert.equal(b.wait, undefined);
  assert.deepEqual(evs(pushes).map((e) => e.k), ['start']);
  assert.equal(m.activations, 1, 'once');
});

test('S2 event orders: the event after the reply -> the same; the event lost -> the selfcheck\'s one /status latches; one activate, no wait', async () => {
  closeAll();
  const a = await setup({ engine: { activateEvAfter: 30 } });
  play(a.m);
  const outA = await captured(async () => { await a.jam.start(); await sleep(450); await settle(a.jam); });
  assert.equal(a.jam.latch.set, true); assert.equal(a.jam.wait, false);
  assert.ok(trace(a.jam, 'latch').some((e) => e.set === 1 && e.from === 'event'));
  assert.deepEqual(trace(a.jam, 'self').map((e) => [e.status, e.changed]), [[200, 1]]);
  assert.equal(a.m.activations, 1); assert.equal(a.m.sends('current'), 1);
  assert.doesNotMatch(outA, /no jam event after/);
  // the event lost
  const b = await setup({ engine: { dropJamEvent: true } });
  play(b.m);
  const outB = await captured(async () => { await b.jam.start(); await sleep(450); await settle(b.jam); });
  assert.deepEqual(trace(b.jam, 'jam'), [], 'no event');
  assert.match(outB, /jam: no jam event after Encore switched itself into Jam mode: reading the engine's \/status/);
  assert.ok(trace(b.jam, 'latch').some((e) => e.set === 1 && e.from === 'status'));
  assert.equal(b.jam.latch.set, true); assert.equal(b.jam.wait, false);
  assert.equal(b.m.activations, 1); assert.equal(b.m.sends('current'), 1);
});

test('S3 Spotify first: a hand-over inside selfJamMs latches from the social path; /jam/activate is never called', async () => {
  closeAll();
  const { m, jam } = await setup({ engine: { handOver: 'always', handOverMs: 10 } });
  play(m);
  await jam.start();
  await sleep(450);
  await settle(jam);
  assert.equal(jam.latch.set, true); assert.equal(jam.latch.social, true);
  assert.ok(trace(jam, 'jam').some((e) => e.mode === 'on' && e.social === 1 && e.ctx === 'jam-list'));
  assert.equal(m.activations, 0); assert.equal(m.count(/^\/jam\/activate/), 0);
  assert.equal(jam.selfJam, null); assert.equal(jam.wait, false);
  assert.equal(m.sends('current'), 1);
});

test('S4 not armed, today\'s behaviour: flag off / patch-4 engine (one confirm read, wait, never an End); PC-hosted (away, one broadcast off); no host_device_info (wait); End before selfJamMs (timer cancelled)', async () => {
  closeAll();
  for (const [what, o] of [['selfJam off', { flags: { selfJam: false } }], ['a patch-4 engine', { engine: { routes: P4 } }]]) {
    const { m, jam } = await setup(o);
    play(m);
    await jam.start();
    assert.equal(jam.timers.has('self'), false, what + ': not armed');
    await sleep(450);
    await settle(jam);
    assert.equal(m.count(/^\/jam\/activate/), 0, what);
    assert.equal(m.sends('current'), 2, what + ': the pre-check and one confirm read');
    assert.equal(jam.wait, true, what); assert.equal(m.sends('end'), 0, what);
    assert.deepEqual(trace(jam, 'self'), [], what);
    await sleep(450);
    await settle(jam);
    assert.equal(m.sends(), 4, what + ': nothing more after the wait');
  }
  // current_or_new answering a session hosted on the PC: away + notice, W4's one broadcast off, no activate
  const p = await setup();
  play(p.m);
  p.m.answer.start = () => ({ status: 200, json: (p.m.spotify = session({ members: ['alex'], hostDev: PC })) });
  const r = await p.jam.start();
  assert.equal(r.jam.away, 1);
  assert.ok(p.pushes.some((x) => x.type === 'notice' && x.data.code === 'jam_away'));
  await sleep(150);
  await settle(p.jam);
  await p.jam.lock;
  assert.deepEqual(jamCalls(p.m), ['GET /jam/current', 'POST /jam/broadcast on', 'POST /jam/start', 'POST /jam/broadcast off']);
  assert.equal(p.m.activations, 0);
  // a session without host_device_info: wait as today
  const n = await setup();
  play(n.m);
  n.m.answer.start = () => { const s = session({ members: ['alex'] }); delete s.host_device_info; n.m.spotify = s; return { status: 200, json: s }; };
  await n.jam.start();
  assert.equal(n.jam.hostDevKind(n.jam.sess), 'absent');
  await sleep(450);
  await settle(n.jam);
  assert.equal(n.m.activations, 0); assert.equal(n.jam.wait, true);
  // End tapped right after Start: off() cancels the timer, no activate (and nothing to switch off)
  const e = await setup({ timing: { selfJamMs: 250, ownConfirmMs: 600 } });
  play(e.m);
  await e.jam.start();
  assert.ok(e.jam.timers.has('self'), 'armed');
  await e.jam.end();
  assert.equal(e.jam.timers.has('self'), false, 'cancelled by off()');
  await sleep(400);
  await settle(e.jam);
  await e.jam.lock;
  assert.equal(e.m.activations, 0);
  assert.equal(e.jam.on, false);
  assert.equal(forgets(e.m), 0);
});

test('S5 refused or failed: once, never retried, a warn (+ lastErr self_failed); then today\'s fallback (one confirm read, wait)', async () => {
  closeAll();
  const cases = [
    ['409 (not the active device)', (m) => { m.st.inactive = true; }, 409, 1, 'self_failed',
      /Encore didn't switch itself into Jam mode \(engine 409: not the active device, nothing loaded, or a Jam's playback already\): waiting for Spotify/],
    ['502', (m) => { m.answer.activate = () => ({ status: 502 }); }, 502, 1, 'self_failed', /Encore didn't switch itself into Jam mode \(engine 502\): waiting for Spotify/],
    ['204 twice (jcall\'s one retry)', (m) => { m.answer.activate = () => ({ status: 204 }); }, 204, 2, 'self_failed',
      /Encore didn't switch itself into Jam mode \(engine 204\): waiting for Spotify/],
    ['the engine unreachable', (m) => { m.down = true; }, 'error', 0, 'engine_error', /Encore couldn't switch itself into Jam mode \(engine_error\): waiting for Spotify/],
  ];
  for (const [what, fault, status, n, err, warn] of cases) {
    const { m, jam } = await setup();
    play(m);
    const out = await captured(async () => {
      await jam.start();
      fault(m);                                          // before selfJamMs
      await sleep(150);
      await settle(jam);
      assert.deepEqual(trace(jam, 'self').map((e) => e.status), [status], what);
      assert.equal(jam.info().last_error, err, what);
      assert.equal(jam.wait, false, what + ': not yet');
      await sleep(400);
      await settle(jam);
    });
    m.down = false;
    assert.match(out, warn, what);
    if (status !== 409) assert.doesNotMatch(out, /not the active device/, what);
    assert.equal(m.activations, n, what + ': never retried');
    assert.equal(jam.wait, true, what + ': the fallback');
    assert.equal(jam.selfJam, null, what); assert.equal(jam.latch.set, false, what);
    assert.equal(m.sends('end'), 0, what);
  }
  // a Jam's list or a social-connect origin: the engine refuses too (the model's 409s)
  const j = await setup();
  play(j.m);
  j.m.st.origin = 'social-connect-' + hex32('x');
  await j.jam.start();
  await sleep(150);
  await settle(j.jam);
  assert.deepEqual(trace(j.jam, 'self').map((e) => e.status), [409]);
  assert.equal(j.m.st.mode, '');
});

test('S6 already on: {changed:false} -> the latch from activate (no event comes), no wait', async () => {
  closeAll();
  const { m, jam } = await setup();
  play(m);
  await settle(jam);
  m.st.mode = 'on';                                    // no event: the engine's mode is on, the latch never saw it
  const out = await captured(async () => { await jam.start(); await sleep(150); await settle(jam); });
  assert.deepEqual(trace(jam, 'self').map((e) => [e.status, e.changed]), [[200, 0]]);
  assert.ok(trace(jam, 'latch').some((e) => e.set === 1 && e.from === 'activate'));
  assert.match(out, /jam: Encore is in Jam mode \(already on\)/);
  assert.match(out, /jam: a Jam plays on Encore \(activate: mode "on"/);
  await sleep(450);
  await settle(jam);
  assert.equal(jam.latch.set, true); assert.equal(jam.wait, false);
  assert.equal(m.sends('current'), 1, 'no confirm read');
  assert.equal(m.activations, 1);
  assert.ok(jam.selfJam);
});

// ---------------------------------------------------------------- G4, G5: the end of a self Jam
test('S7 End of a self Jam: end, forget (before the settle and the broadcast off), broadcast off; mode off when end() resolves; one ev end; jam.json and info().self cleared', async () => {
  closeAll();
  const { m, jam, pushes, dir } = await selfHosting();
  await jam.saveChain;
  assert.equal(saved(dir).self, 1);
  assert.ok(jam.info().self && jam.info().self.age_s >= 0);
  const n0 = m.sends();
  const k0 = m.log.length;
  const modes = [];                                  // the engine's jam mode at each /status read after the End's DELETE
  const status0 = m.status.bind(m);
  m.status = () => { if (m.log.slice(k0).some((x) => x.path === '/jam/end')) modes.push(m.st.mode); return status0(); };
  const out = await captured(async () => {
    await jam.end();
    assert.equal(m.st.mode, 'off', 'off when end() resolves');
    await settle(jam);
    await jam.lock;
  });
  assert.deepEqual(jamCalls({ log: m.log.slice(k0) }), ['POST /jam/end', 'POST /jam/forget', 'POST /jam/broadcast off']);
  // at once, before the settle: every /status the End read (the settle's) already says "off". (jamCalls alone can't
  // tell: the settle's backstop forget gives the same /jam/* order, and the model doesn't log /status reads)
  assert.ok(modes.length > 0, 'the settle read /status');
  assert.deepEqual([...new Set(modes)], ['off'], 'the mode was off before the settle\'s first read');
  assert.equal(forgets(m), 1, 'exactly one');
  assert.equal(m.sends() - n0, 2, 'end and broadcast off');
  assert.deepEqual(ops(m).slice(-2), ['end', 'broadcast']);
  assert.equal(jam.latch.set, false); assert.equal(jam.on, false, 'the jam event "off" sets nothing');
  assert.deepEqual(evs(pushes).filter((e) => e.k === 'end'), [{ k: 'end' }]);
  assert.match(out, /jam: off \(end\)/);
  assert.match(out, /jam: the engine's Jam mode switched off/);
  assert.equal(jam.selfJam, null); assert.equal(jam.info().self, null);
  await jam.saveChain;
  assert.equal(saved(dir).self, undefined);
});

test('S8 ended elsewhere: SESSION_DELETED of a self Jam -> off, ev end, one forget, no send; a Spotify-driven Jam, or a self Jam Spotify drives later -> recorded only; a lease read with no session -> off, one forget', async () => {
  closeAll();
  const a = await selfHosting();
  const n0 = a.m.sends();
  const out = await captured(async () => { a.m.pushDeleted(a.m.spotify); await settle(a.jam); await a.jam.lock; });
  assert.equal(a.jam.on, false);
  assert.deepEqual(evs(a.pushes).slice(-1), [{ k: 'end' }]);
  assert.deepEqual(trace(a.jam, 'social_connect').slice(-1).map((e) => [e.reason, e.applied]), [['SESSION_DELETED', 1]]);
  assert.match(out, /Spotify deleted the shown session \(push\): no session/);
  assert.equal(forgets(a.m), 1); assert.equal(a.m.st.mode, 'off');
  assert.equal(a.m.sends(), n0, 'no send');
  assert.equal(a.jam.selfJam, null);
  // a Jam Spotify drives (W7 holds)
  const b = await hosting();
  b.m.pushDeleted(b.m.spotify);
  assert.equal(b.jam.on, true);
  assert.deepEqual(trace(b.jam, 'social_connect').slice(-1).map((e) => [e.reason, e.applied]), [['SESSION_DELETED', 0]]);
  // a self Jam Spotify started driving after the activation (set_options on, the jam-list's transfer)
  const c = await selfHosting();
  c.m.jamStarts(1);
  await settle(c.jam);
  assert.equal(c.jam.latch.social, true);
  c.m.pushDeleted(c.m.spotify);
  assert.equal(c.jam.on, true);
  assert.deepEqual(trace(c.jam, 'social_connect').slice(-1).map((e) => [e.reason, e.applied]), [['SESSION_DELETED', 0]]);
  assert.equal(forgets(c.m), 0);
  // a lease read finding no session
  const d = await selfHosting();
  d.m.spotify = null;
  d.jam.lastSent = 0;
  await d.jam.get({ w: true });
  await settle(d.jam);
  await d.jam.lock;
  d.jam.stopPoll();
  assert.equal(d.jam.on, false);
  assert.deepEqual(evs(d.pushes).slice(-1), [{ k: 'end' }]);
  assert.equal(forgets(d.m), 1); assert.equal(d.m.st.mode, 'off');
});

test('S9 Join replacing a self Jam: End, then forget before the Join\'s info; the joined Jam\'s latch stays set (no forget after it)', async () => {
  closeAll();
  const { m, jam } = await selfHosting();
  m.answer.info = () => ({ status: 200, json: session({ sid: 'sOther', token: 'other_tok1', members: ['liam'], hostId: 'liam', hostDev: PC }) });
  m.answer.join = () => ({ status: 200, json: session({ sid: 'sOther', token: 'other_tok1', owner: false, members: ['liam', 'alex'], hostId: 'liam', hostDev: PC }) });
  const k0 = m.log.length;
  const r = await jam.join({ link: 'other_tok1', replace: true });
  assert.equal(r.jam.r, 'guest');
  assert.deepEqual(jamCalls({ log: m.log.slice(k0) }), ['POST /jam/end', 'POST /jam/forget', 'GET /jam/info', 'POST /jam/join']);
  assert.equal(m.st.mode, 'off');
  // the model's guest hand-over: set_options on, then the jam-list's transfer
  m.jamStarts(2);
  await settle(jam);
  await jam.lock;
  assert.equal(jam.latch.set, true); assert.equal(jam.latch.social, true);
  assert.equal(forgets(m), 1, 'none after the Join');
  assert.equal(jam.role(), 'guest');
  assert.equal(jam.selfJam, null);
  assert.equal(m.activations, 1);
});

test('S9b Join replacing a self Jam while a read answers "no session" during its End: forget once, before the Join\'s info; none after the Join (the joined Jam keeps its mode and latch)', async () => {
  closeAll();
  const { m, jam } = await selfHosting();
  m.answer.end = () => {
    m.spotify = null;
    // a lease read's answer of no session, landing while the End is out: off() from outside the Join (selfJam dropped,
    // its forget queued behind the Join)
    jam.applyRead({ status: 200, json: {} }, false, Date.now());
    return { status: 200, json: {} };
  };
  m.answer.info = () => ({ status: 200, json: session({ sid: 'sOther', token: 'other_tok1', members: ['liam'], hostId: 'liam', hostDev: PC }) });
  m.answer.join = () => {
    setTimeout(() => m.jamStarts(2), 5);             // the guest hand-over arrives while the Join waits for its generation
    return { status: 200, json: session({ sid: 'sOther', token: 'other_tok1', owner: false, members: ['liam', 'alex'], hostId: 'liam', hostDev: PC }) };
  };
  const k0 = m.log.length;
  const r = await jam.join({ link: 'other_tok1', replace: true });
  assert.equal(r.jam.r, 'guest');
  await settle(jam);
  await jam.lock;
  assert.deepEqual(jamCalls({ log: m.log.slice(k0) }), ['POST /jam/end', 'POST /jam/forget', 'GET /jam/info', 'POST /jam/join']);
  assert.equal(forgets(m), 1, 'none after the Join');
  assert.equal(jam.latch.set, true); assert.equal(jam.latch.social, true);
  assert.equal(m.st.mode, 'on', 'the joined Jam\'s mode');
  assert.equal(jam.role(), 'guest');
  assert.equal(jam.selfJam, null);
});

// ---------------------------------------------------------------- G6: a gateway restart
test('S10 restart: jam.json keeps self; the connect read finding no session -> off + one forget; the session still live -> hosting, self kept, End switches it off', async () => {
  closeAll();
  const a = await selfHosting();
  await a.jam.saveChain;
  assert.deepEqual([saved(a.dir).self, saved(a.dir).role], [1, 'host']);
  a.m.spotify = null;
  const b = await restart(a);
  assert.equal(b.jam.on, true, 'the boot latch: the engine still says "on"');
  assert.ok(b.jam.selfJam);
  b.jam.engineConnected();
  await settle(b.jam, 80);
  await b.jam.lock;
  assert.equal(b.jam.on, false);
  assert.equal(forgets(b.m), 1); assert.equal(b.m.st.mode, 'off');
  assert.equal(b.jam.selfJam, null);
  // the session still live
  const c = await selfHosting();
  const d = await restart(c);
  d.jam.engineConnected();
  await settle(d.jam, 80);
  await d.jam.lock;
  assert.equal(d.jam.on, true); assert.equal(d.jam.body().r, 'host');
  assert.ok(d.jam.info().self, 'self kept');
  assert.equal(forgets(d.m), 0);
  await d.jam.end();
  await settle(d.jam);
  await d.jam.lock;
  assert.equal(forgets(d.m), 1); assert.equal(d.m.st.mode, 'off');
  assert.equal(d.jam.info().self, null);
});

// ---------------------------------------------------------------- G7: flags, info; hygiene
test('S11 flags and info: selfJam a boolean (400 otherwise), logged; false -> the next Start isn\'t armed; info().self {age_s} while on, null after End', async () => {
  closeAll();
  const { m, jam } = await setup();
  assert.equal(jam.info().flags.selfJam, true);
  assert.equal(jam.info().self, null);
  const out = await captured(async () => { jam.setFlags({ selfJam: false }); });
  assert.match(out, /selfJam=false startBroadcast=true endBroadcastOff=true \(in memory\)/);
  assert.equal(jam.info().flags.selfJam, false);
  for (const v of ['yes', 1, null]) assert.throws(() => jam.setFlags({ selfJam: v }), (e) => e.status === 400 && e.code === 'bad_request');
  assert.equal(jam.info().flags.selfJam, false, 'unchanged by a refused value');
  play(m);
  await jam.start();
  assert.equal(jam.timers.has('self'), false, 'not armed');
  await jam.end();
  await settle(jam);
  await jam.lock;
  assert.equal(m.activations, 0);
  jam.setFlags({ selfJam: true });
  await jam.start();
  await waitFor(() => !!jam.selfJam && jam.latch.set);
  const i = jam.info();
  assert.deepEqual(Object.keys(i.self), ['age_s']);
  assert.equal(typeof i.self.age_s, 'number');
  await jam.end();
  await settle(jam);
  await jam.lock;
  assert.equal(jam.info().self, null);
  assert.equal(m.activations, 1);
});

test('S12 hygiene: no device id, session id, join token, link or radar token in the log, the trace or info()', async () => {
  closeAll();
  const { m, jam } = await setup();
  play(m);
  const out = await captured(async () => {
    await jam.start();
    await waitFor(() => !!jam.selfJam && jam.latch.set);
    await settle(jam);
    await jam.end();
    await settle(jam);
    await jam.lock;
  });
  assert.match(out, /Encore is in Jam mode \(switched on\)/);
  assert.match(out, /the engine's Jam mode switched off/);
  const text = [out, JSON.stringify(jam.ring), JSON.stringify(jam.info())].join('\n');
  for (const v of [DEV, hex32('s1'), id22('t1'), LINK, RADAR]) assert.equal(text.includes(v), false, v);
});

// ---------------------------------------------------------------- §4's live sequence, in the model
test('S13 the live sequence (spacingMs 1000): play, Start (self), End -> 5 social sends ≥ 1 s apart and 2 local calls (activate, forget); calls5m 5', async () => {
  closeAll();
  const { m, jam } = await setup({ engine: { spacingMs: 1000 } });
  play(m);
  await jam.start();
  await waitFor(() => !!jam.selfJam && jam.latch.set);
  await sleep(450);
  await settle(jam);
  assert.equal(jam.wait, false);
  await jam.end();
  await waitFor(() => m.sends() === 5);
  await jam.lock;
  assert.deepEqual(ops(m), ['current', 'broadcast', 'start', 'end', 'broadcast']);
  assert.deepEqual(jamCalls(m), ['GET /jam/current', 'POST /jam/broadcast on', 'POST /jam/start', 'POST /jam/activate', 'POST /jam/end',
    'POST /jam/forget', 'POST /jam/broadcast off']);
  assert.equal(m.activations, 1); assert.equal(forgets(m), 1);
  assert.equal(jam.calls5m(), 5);
  const ts = m.calls.map((c) => c.t);
  assert.ok(ts.slice(1).every((t, i) => t - ts[i] >= 1000), 'the gate\'s spacing');
  assert.ok(m.sends() <= 30);
  assert.equal(m.st.mode, 'off'); assert.equal(jam.on, false);
  closeAll();
});
