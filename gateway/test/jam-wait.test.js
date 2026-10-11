'use strict';
// DESIGN-JAM-WAIT §3.2: Jams Encore starts but Spotify never hands to Encore ("wait"). jam.js's G0-G10 against the
// engine model (jam-engine.js) with patch 4's /jam/broadcast route listed, over its scripted "Spotify" (o.handOver:
// when it hands a started Jam to Encore; o.standby: SESSION_DELETED on end and the standby session). Nothing here can
// reach social-connect.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PcmClock } = require('../src/pcm');
const { Player } = require('../src/player');
const { Jam } = require('../src/jam');
const { JamEngine, fakeJamEngine, session, T, JAM, JAM_LIST, ROUTES, PC, DEV, LINK, RADAR, hex32, id22 } = require('./support/jam-engine');
const { tmp, sleep } = require('./support/helpers');

const FAST = { setDebounce: 20, inactiveDebounce: 30, ownConfirmMs: 300, endSettleMs: 400, leaveSettleMs: 60, noSession: 20, connectRead: 20,
  queueDebounce: 10, queueRetry: 50, queueTimeout: 1000, addGapMs: 5, joinGenWaitMs: 150, idleGrace: 30, queueEditTimeout: 300 };
const P4 = [...ROUTES, 'broadcast'];                 // a patch-4 engine's jam_routes
const live = [];                                     // every Jam made here: closed at the start of the next test

async function setup(o = {}) {
  const m = new JamEngine({ spacingMs: 0, routes: P4, ...o.engine });
  const engine = fakeJamEngine(m);
  const clock = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-gwwait.pcm'), { leadMs: 10000 });
  const pushes = [];
  const bus = { push: (type, data) => pushes.push({ type, data }) };
  const dir = tmp('jamwait');
  const player = new Player({ engine, clock, bus, webapi: null, dataDir: dir });
  const encoders = { n: 1, listening() { return this.n; } };
  const jam = new Jam({ cfg: { dataDir: dir, jam: o.flags || {} }, engine, player, bus, webapi: null, encoders, timing: { ...FAST, ...o.timing } });
  clearInterval(jam.ticker);
  player.jam = jam;
  jam.sc = 'sc' in o ? o.sc : 1;
  live.push(jam);
  await engine.refresh();
  return { m, engine, player, jam, pushes, dir };
}
const closeAll = () => { while (live.length) live.pop().close(); };
const evs = (pushes) => pushes.filter((x) => x.type === 'jam' && x.data.ev).map((x) => x.data.ev);
const settle = async (jam, ms = 60) => { await sleep(ms); if (jam.flight) await jam.flight; await sleep(5); };
const trace = (jam, k) => jam.ring.filter((e) => e.k === k);
const ops = (m) => m.calls.map((c) => c.op);
// the engine's /jam/* requests in order (forget is engine-local and left out), a broadcast write with its status
const jamCalls = (m) => m.log.filter((x) => x.path.startsWith('/jam/') && !x.path.startsWith('/jam/forget'))
  .map((x) => `${x.method} ${x.path.split('?')[0]}${x.method === 'POST' && x.path === '/jam/broadcast' ? ' ' + x.body.status : ''}`);
const play = (m) => m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
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

// a host Jam playing on Encore (started elsewhere), session read
async function hosting(o = {}) {
  const s = await setup(o);
  s.m.spotify = session({ members: ['alex', 'jake'], ...o.session });
  play(s.m);
  s.m.jamStarts(1);
  await settle(s.jam);
  return s;
}
// our Start, never handed over (the model's default handOver 'never'): wait
async function waiting(o = {}) {
  const s = await setup(o);
  play(s.m);
  await s.jam.start();
  await sleep(450);
  await settle(s.jam);
  assert.equal(s.jam.wait, true, 'waiting');
  return s;
}

// ---------------------------------------------------------------- G1: Start
test('W1 start: the pre-check, broadcast on, then current_or_new, in that order (3 sends); startBroadcast:false or a patch-3 engine: no broadcast', async () => {
  closeAll();
  const a = await setup();
  play(a.m);
  const out = await captured(async () => {
    const r = await a.jam.start();
    assert.equal(r.jam.on, 1); assert.equal(r.jam.r, 'host');
  });
  assert.deepEqual(jamCalls(a.m), ['GET /jam/current', 'POST /jam/broadcast on', 'POST /jam/start']);
  assert.deepEqual(ops(a.m), ['current', 'broadcast', 'start']);
  assert.equal(a.m.bc, 'BROADCAST_ON'); assert.equal(a.jam.bcOnSent, true);
  assert.match(out, /Start: Encore's Jam broadcast set on \(BROADCAST_ON\)/);
  assert.deepEqual(trace(a.jam, 'call').map((e) => [e.op, e.status]), [['current', 200], ['broadcast', 200], ['start', 200]]);
  // the flag off
  const b = await setup({ flags: { startBroadcast: false } });
  play(b.m);
  await b.jam.start();
  assert.deepEqual(ops(b.m), ['current', 'start']);
  assert.equal(b.jam.bcOnSent, false);
  // an engine without patch 4: as before, and canSocial() unchanged ('broadcast' isn't one of SOCIAL_ROUTES)
  const c = await setup({ engine: { routes: ROUTES } });
  play(c.m);
  assert.equal(c.jam.canSocial(), true);
  const rc = await c.jam.start();
  assert.equal(rc.jam.on, 1);
  assert.deepEqual(ops(c.m), ['current', 'start']);
  assert.equal(c.m.count(/^\/jam\/broadcast/), 0);
});

test('W2 hand-over: handOver "broadcast" -> the latch sets inside ownConfirmMs (no wait, no confirm read); "never" -> exactly one read, then wait, never an End', async () => {
  closeAll();
  const a = await setup({ engine: { handOver: 'broadcast' } });
  play(a.m);
  await a.jam.start();
  await sleep(450);
  await settle(a.jam);
  assert.equal(a.jam.latch.set, true);
  assert.equal(a.jam.wait, false);
  assert.equal(a.m.sends('current'), 1, 'only the pre-check');
  assert.ok(trace(a.jam, 'latch').some((e) => e.set === 1 && e.from === 'event'));
  assert.deepEqual(trace(a.jam, 'wait'), []);
  const b = await setup();
  play(b.m);
  await b.jam.start();
  await sleep(450);
  await settle(b.jam);
  assert.equal(b.m.sends('current'), 2, 'the pre-check and one confirm read');
  assert.equal(b.jam.wait, true); assert.equal(b.jam.body().wait, 1);
  assert.equal(b.m.sends('end'), 0);
  assert.deepEqual(trace(b.jam, 'wait').map((e) => e.read), [1]);
  await sleep(450);
  await settle(b.jam);
  assert.equal(b.m.sends(), 4, 'nothing more after the wait');
});

test('W3 start: Encore\'s standby in the pre-check -> activated (broadcast on + current_or_new, the same session), never adopted without a call', async () => {
  closeAll();
  const { m, jam } = await setup();
  play(m);
  m.spotify = session({ sid: hex32('standby0'), token: id22('sb0'), members: ['alex'], hostDev: DEV });
  const out = await captured(async () => {
    const r = await jam.start();
    assert.equal(r.jam.r, 'host'); assert.equal(r.jam.on, 1);
  });
  assert.deepEqual(ops(m), ['current', 'broadcast', 'start']);
  assert.deepEqual(trace(jam, 'start').map((e) => e.same), [1]);
  assert.match(out, /the account's session is hosted here, by Encore: activating it/);
  assert.match(out, /current_or_new answered the session the pre-check saw/);
  assert.doesNotMatch(out, /taking it back/);
  assert.equal(jam.sess.sid, hex32('standby0'));
  // current_or_new answering another session than the pre-check's: recorded as such
  const b = await setup();
  play(b.m);
  b.m.spotify = session({ sid: hex32('standby1'), members: ['alex'], hostDev: DEV });
  b.m.answer.start = () => ({ status: 200, json: session({ sid: hex32('fresh1'), members: ['alex'], hostDev: DEV }) });
  const outB = await captured(() => b.jam.start());
  assert.deepEqual(trace(b.jam, 'start').map((e) => e.same), [0]);
  assert.match(outB, /current_or_new answered another session/);
  // one of Encore's marked inactive: current_or_new?activate=true is sent for it too
  const c = await setup({ engine: { routes: ROUTES } });
  play(c.m);
  c.m.spotify = session({ members: ['alex'], hostDev: DEV });
  c.m.spotify.active = false;
  const outC = await captured(() => c.jam.start());
  assert.equal(c.m.sends('start'), 1);
  assert.match(outC, /hosted here, by Encore \(marked inactive\): activating it/);
});

test('W4 start: a session hosted elsewhere (active or not), or someone else\'s on Encore -> 409 jam_elsewhere after the pre-check only; current_or_new naming the PC -> away + notice, then one broadcast off', async () => {
  closeAll();
  const cases = [
    ['hosted on the PC', () => session({ members: ['alex'], hostDev: PC })],
    ['hosted on the PC, inactive', () => Object.assign(session({ members: ['alex'], hostDev: PC }), { active: false })],
    ['on Encore, another account\'s (we are a guest)', () => session({ owner: false, members: ['jake', 'alex'], hostId: 'jake', hostDev: DEV })],
  ];
  for (const [what, sp] of cases) {
    const { m, jam } = await setup();
    play(m);
    m.spotify = sp();
    await assert.rejects(jam.start(), (e) => e.status === 409 && e.code === 'jam_elsewhere', what);
    assert.deepEqual(ops(m), ['current'], what + ': no broadcast, no start, no end');
    assert.equal(jam.on, false, what);
  }
  const { m, jam, pushes } = await setup();
  play(m);
  m.answer.start = () => ({ status: 200, json: (m.spotify = session({ members: ['alex'], hostDev: PC })) });
  const r = await jam.start();
  assert.equal(r.jam.away, 1);
  assert.ok(pushes.some((x) => x.type === 'notice' && x.data.code === 'jam_away'));
  assert.equal(m.count(/^\/jam\/broadcast/), 1, 'the off goes after the reply');
  await settle(jam);
  assert.deepEqual(jamCalls(m), ['GET /jam/current', 'POST /jam/broadcast on', 'POST /jam/start', 'POST /jam/broadcast off']);
  assert.equal(m.bc, 'BROADCAST_OFF');
  assert.equal(jam.away, true, 'still away (End works)');
  // current_or_new answering someone else's session (review fix): 409 jam_elsewhere, nothing adopted, and the broadcast
  // our Start set on goes back off once, after the reply
  const o = await setup();
  play(o.m);
  o.m.answer.start = () => ({ status: 200, json: session({ owner: false, members: ['jake', 'alex'], hostId: 'jake', hostDev: PC }) });
  await assert.rejects(o.jam.start(), (e) => e.status === 409 && e.code === 'jam_elsewhere');
  await settle(o.jam);
  await o.jam.lock;
  assert.equal(o.jam.on, false);
  assert.deepEqual(jamCalls(o.m), ['GET /jam/current', 'POST /jam/broadcast on', 'POST /jam/start', 'POST /jam/broadcast off']);
  assert.equal(o.m.sends('end'), 0, 'never an End of it');
});

test('W5 start: the broadcast step failing -> Spotify 5xx/400/409: Start goes on without it; the gate\'s 429 -> busy; Spotify\'s 429 -> rate_limited + hold; 401 -> refused; no engine session; engine down', async () => {
  closeAll();
  for (const st of [500, 400, 409]) {
    const { m, jam } = await setup();
    play(m);
    m.answer.broadcast = () => ({ status: st });
    const out = await captured(async () => { await jam.start(); });
    assert.equal(m.sends('start'), 1, `${st}: started all the same`);
    assert.equal(jam.on, true);
    assert.equal(jam.lastErr.code, 'broadcast_failed'); assert.equal(jam.lastErr.upstream, st);
    assert.equal((out.match(/the broadcast step failed/g) || []).length, 1);
    assert.equal(jam.scNow(), 1);
    assert.equal(jam.bcOnSent, false);
  }
  // the engine's gate refuses (its 5-min cap here): nothing was sent, Start stops
  const g = await setup({ engine: { cap: 1 } });
  play(g.m);
  await assert.rejects(g.jam.start(), (e) => e.status === 503 && e.code === 'busy');
  assert.deepEqual(ops(g.m), ['current']);
  // Spotify's 429
  const s = await setup();
  play(s.m);
  s.m.answer.broadcast = () => ({ status: 429, retryAfter: 30 });
  await assert.rejects(s.jam.start(), (e) => e.status === 503 && e.code === 'rate_limited' && e.retry_after === 30);
  assert.equal(s.m.sends('start'), 0);
  assert.ok(s.jam.holdUntil > Date.now() + 20000, 'the quiet reads hold');
  // Spotify refuses the token (401 after the engine's one renewal -> 403 + X-Upstream-Status 401)
  const f = await setup();
  play(f.m);
  f.m.answer.broadcast = () => ({ status: 401 });
  await assert.rejects(f.jam.start(), (e) => e.status === 403 && e.code === 'jam_refused' && /didn’t let Encore start/.test(e.message));
  assert.equal(f.jam.scNow(), 0);
  assert.equal(f.m.sends('start'), 0); assert.equal(f.m.sends('broadcast'), 2, 'the engine\'s own renewal');
  // the engine lost its Spotify session (204 twice, nothing sent)
  const n = await setup();
  play(n.m);
  n.m.answer.current = () => { n.m.noSession = true; return { status: 204 }; };
  await assert.rejects(n.jam.start(), (e) => e.status === 503 && e.code === 'engine_no_session');
  assert.deepEqual(ops(n.m), ['current']);
  // the engine down
  const d = await setup();
  play(d.m);
  d.m.answer.current = () => { d.m.down = true; return { status: 204 }; };
  await assert.rejects(d.jam.start(), (e) => e.code === 'engine_error');
  assert.deepEqual(ops(d.m), ['current']);
});

// ---------------------------------------------------------------- G2: End
test('W6 end: an Encore-hosted Jam -> end, then broadcast off after the reply (once each); endBroadcastOff:false -> no off; a PC-hosted Jam or a failed End -> no off from End', async () => {
  closeAll();
  const a = await hosting();
  const out = await captured(async () => {
    await a.jam.end();
    assert.equal(a.m.count(/^\/jam\/broadcast/), 0, 'not before the reply');
    await settle(a.jam);
  });
  assert.deepEqual(jamCalls(a.m).filter((x) => /broadcast|end/.test(x)), ['POST /jam/end', 'POST /jam/broadcast off']);
  assert.deepEqual([a.m.sends('end'), a.m.sends('broadcast')], [1, 1]);
  assert.match(out, /jam: ended: Encore's Jam broadcast set off/);
  assert.equal(a.jam.info().broadcast.encore, 'BROADCAST_OFF');
  // the flag off
  const b = await hosting({ flags: { endBroadcastOff: false } });
  await b.jam.end();
  await settle(b.jam);
  assert.equal(b.m.sends('end'), 1); assert.equal(b.m.sends('broadcast'), 0);
  // a Jam our Start landed on the PC: Start's own off only, none from End
  const c = await setup();
  play(c.m);
  c.m.answer.start = () => ({ status: 200, json: (c.m.spotify = session({ members: ['alex'], hostDev: PC })) });
  await c.jam.start();
  await settle(c.jam);
  delete c.m.answer.start;
  assert.equal(c.m.sends('broadcast'), 2, 'on, and off after landing elsewhere');
  await c.jam.end();
  await settle(c.jam);
  assert.equal(c.m.sends('end'), 1); assert.equal(c.m.sends('broadcast'), 2, 'no off from End');
  // a failed End: nothing more
  const d = await hosting();
  d.m.answer.end = () => ({ status: 409 });
  await assert.rejects(d.jam.end(), (e) => e.status === 403 && e.code === 'jam_refused');
  await settle(d.jam);
  assert.equal(d.m.sends('broadcast'), 0); assert.equal(d.jam.on, true);
  // an engine without patch 4: End as before
  const p3 = await hosting({ engine: { routes: ROUTES } });
  await p3.jam.end();
  await settle(p3.jam);
  assert.equal(p3.m.count(/^\/jam\/broadcast/), 0);
});

// ---------------------------------------------------------------- G4: SESSION_DELETED
test('W7 SESSION_DELETED: the shown session while waiting -> off + ev end, no read; while the latch is set or of another session -> recorded only; during our own End -> one off, one ev end', async () => {
  closeAll();
  const a = await waiting();
  const n0 = a.m.sends();
  const out = await captured(async () => { a.m.pushDeleted(a.m.spotify); await settle(a.jam); });
  assert.equal(a.jam.on, false);
  assert.deepEqual(evs(a.pushes).slice(-1), [{ k: 'end' }]);
  assert.equal(a.m.sends(), n0, 'no read');
  assert.match(out, /Spotify deleted the shown session \(push\): no session/);
  assert.doesNotMatch(out, /not seen in C0/);
  assert.deepEqual(trace(a.jam, 'social_connect').slice(-1).map((e) => [e.reason, e.applied]), [['SESSION_DELETED', 1]]);
  // the engine plays the Jam: its own end signals decide
  const b = await hosting();
  b.m.pushDeleted(b.m.spotify);
  assert.equal(b.jam.on, true);
  assert.deepEqual(trace(b.jam, 'social_connect').slice(-1).map((e) => [e.reason, e.applied]), [['SESSION_DELETED', 0]]);
  // another session's
  const c = await waiting();
  c.m.pushDeleted(session({ sid: hex32('elsewhere'), members: ['alex'], hostDev: PC }));
  assert.equal(c.jam.on, true); assert.equal(c.jam.wait, true);
  // our own End of a waiting Jam: "Spotify" pushes SESSION_DELETED inside its answer (and, broadcast ON, a standby)
  const d = await waiting({ engine: { standby: true } });
  await d.jam.end();
  await settle(d.jam);
  assert.equal(trace(d.jam, 'off').length, 1, 'one off');
  assert.equal(evs(d.pushes).filter((e) => e.k === 'end').length, 1, 'one ev end');
  assert.ok(trace(d.jam, 'social_connect').some((e) => e.reason === 'SESSION_DELETED' && e.applied === 0));
  assert.equal(d.jam.on, false);
});

// ---------------------------------------------------------------- G3: Spotify's standby
test('W8 standby: a NEW_SESSION for Encore during or right after our End is recorded only (never held); a latch then reads; one with no end before it is still held', async () => {
  closeAll();
  // the model's order: SESSION_DELETED and NEW_SESSION inside the end's answer
  const a = await hosting({ engine: { standby: true, bc: 'BROADCAST_ON' }, flags: { endBroadcastOff: false } });
  const out = await captured(async () => { await a.jam.end(); await settle(a.jam); });
  assert.equal(a.jam.heldPush, null);
  const ns = trace(a.jam, 'social_connect').filter((e) => e.reason === 'NEW_SESSION');
  assert.deepEqual(ns.map((e) => [e.standby, e.host, e.n, e.active, e.applied]), [[1, 'encore', 1, 1, 0]]);
  assert.match(out, /Spotify's standby session, recorded only/);
  // a latch right after: the set read, not the standby push
  const n0 = a.m.sends('current');
  a.m.jamStarts(2);
  await settle(a.jam);
  assert.equal(a.m.sends('current') - n0, 1, 'the set read');
  // the pushes after our End's reply (within standbyMs of it, and of the SESSION_DELETED)
  const b = await hosting({ flags: { endBroadcastOff: false } });
  const old = JSON.parse(JSON.stringify(b.m.spotify));
  await b.jam.end();
  await settle(b.jam);
  b.m.pushDeleted(old);
  const sb = session({ sid: hex32('sbX'), token: id22('sbX'), members: ['alex'] });
  b.m.spotify = sb;
  b.m.push('NEW_SESSION', sb);
  assert.equal(b.jam.heldPush, null);
  assert.equal(trace(b.jam, 'social_connect').slice(-1)[0].standby, 1);
  // a NEW_SESSION for Encore with no end before it: held as before (jam-4c's test)
  const c = await setup();
  c.m.spotify = session({ members: ['alex', 'jake'] });
  play(c.m);
  c.m.push('NEW_SESSION', c.m.spotify);
  assert.ok(c.jam.heldPush, 'held');
  assert.equal(trace(c.jam, 'social_connect').slice(-1)[0].standby, undefined);
  // ... and dropped when Spotify deletes it
  c.m.pushDeleted(c.m.spotify);
  assert.equal(c.jam.heldPush, null);
  // review fix: current_or_new replacing the standby with a fresh session, its SESSION_DELETED and NEW_SESSION pushed
  // before the answer: the NEW_SESSION is this Start's, not a standby (no standby=1, no standby line)
  const d = await setup();
  play(d.m);
  const sb0 = session({ sid: hex32('standbyD'), token: id22('sbD'), members: ['alex'] });
  d.m.spotify = sb0;
  const fresh = session({ sid: hex32('freshD'), token: id22('frD'), members: ['alex'] });
  d.m.answer.start = () => { d.m.pushDeleted(sb0); d.m.push('NEW_SESSION', fresh); d.m.spotify = fresh; return { status: 200, json: fresh }; };
  const outD = await captured(() => d.jam.start());
  const pushed = trace(d.jam, 'social_connect').filter((e) => e.reason).map((e) => [e.reason, e.applied, e.standby]);
  assert.deepEqual(pushed, [['SESSION_DELETED', 0, undefined], ['NEW_SESSION', 0, undefined]]);
  assert.doesNotMatch(outD, /standby session/);
  assert.match(outD, /current_or_new answered another session/);
  assert.equal(d.jam.sess.sid, hex32('freshD'));
  assert.equal(d.jam.starting, false);
  // after the Start, the rule is as before: a NEW_SESSION for Encore within standbyMs of that SESSION_DELETED, not ours
  d.m.push('NEW_SESSION', session({ sid: hex32('standbyE'), token: id22('sbE'), members: ['alex'] }));
  assert.equal(trace(d.jam, 'social_connect').slice(-1)[0].standby, 1);
});

// ---------------------------------------------------------------- G5: reads naming another session
test('W9 reads: another session than the one shown -> off with ev end while waiting, away or checking (not adopted); shown as today while the engine plays a Jam; the confirm read -> off + jam_not_started', async () => {
  closeAll();
  const other = () => session({ sid: hex32('sb9'), token: id22('sb9'), members: ['alex'] });
  // waiting
  const a = await waiting();
  a.m.spotify = other();
  a.jam.lastSent = 0;
  const out = await captured(() => a.jam.get({ fresh: true }));
  assert.equal(a.jam.on, false);
  assert.deepEqual(evs(a.pushes).slice(-1), [{ k: 'end' }]);
  assert.ok(!a.pushes.some((x) => x.type === 'jam' && x.data.t === id22('sb9')), 'the other session never shown');
  assert.deepEqual(trace(a.jam, 'session').slice(-1).map((e) => [e.src, e.other, e.host_dev]), [['read', 1, 'encore']]);
  assert.match(out, /the session read names another session than the one shown: that one ended/);
  assert.equal(a.jam.lastRead.none, false, 'the account still has a session: Start keeps its pre-check');
  // away (our Start landed on the PC)
  const w = await setup({ engine: { routes: ROUTES } });
  play(w.m);
  w.m.answer.start = () => ({ status: 200, json: (w.m.spotify = session({ members: ['alex'], hostDev: PC })) });
  await w.jam.start();
  delete w.m.answer.start;
  w.m.spotify = session({ sid: hex32('pc2'), token: id22('pc2'), members: ['alex'], hostDev: PC });
  w.jam.lastSent = 0;
  await w.jam.get({ fresh: true });
  assert.equal(w.jam.on, false);
  assert.deepEqual(evs(w.pushes).slice(-1), [{ k: 'end' }]);
  // awayCheck: the engine lost the Jam and playback; the away read names another session
  const lose = (s) => { s.m.st.ctx = ''; s.m.st.track = null; s.m.st.stopped = true; s.m.st.origin = null; s.m.ev('inactive', {}); s.m.jamEv(); };
  const k = await hosting();
  k.m.spotify = other();
  lose(k);
  await k.engine.refresh();
  await settle(k.jam, 80);
  assert.equal(k.jam.on, false);
  assert.deepEqual(evs(k.pushes).slice(-1), [{ k: 'end' }]);
  // the latch set: shown, as today
  const h = await hosting();
  h.m.spotify = other();
  h.jam.lastSent = 0;
  await h.jam.get({ fresh: true });
  assert.equal(h.jam.on, true); assert.equal(h.jam.body().t, id22('sb9'));
  // the confirm read after our Start
  const c = await setup();
  play(c.m);
  await c.jam.start();
  c.m.spotify = other();
  await sleep(450);
  await settle(c.jam);
  assert.equal(c.jam.on, false); assert.equal(c.jam.wait, false);
  assert.ok(c.pushes.some((x) => x.type === 'notice' && x.data.code === 'jam_not_started'));
  assert.equal(c.m.sends('end'), 0);
});

// ---------------------------------------------------------------- G6: the confirm log
test('W10 confirm: a read that didn\'t answer -> wait + "didn\'t answer", never "Spotify has our Jam"; a read showing the session -> the old line', async () => {
  closeAll();
  const a = await setup();
  play(a.m);
  await a.jam.start();
  a.m.answer.current = () => ({ status: 500 });
  const out = await captured(async () => { await sleep(450); await settle(a.jam); });
  assert.equal(a.jam.wait, true);
  assert.match(out, /Spotify hasn't sent the Jam to Encore and the check read didn't answer \(spotify_error\): wait/);
  assert.doesNotMatch(out, /Spotify has our Jam/);
  assert.deepEqual(trace(a.jam, 'wait').map((e) => e.read), [0]);
  closeAll();
  const b = await setup();
  play(b.m);
  await b.jam.start();
  const outB = await captured(async () => { await sleep(450); await settle(b.jam); });
  assert.match(outB, /Spotify has our Jam but isn't sending it to Encore: wait/);
  assert.doesNotMatch(outB, /didn't answer/);
});

// ---------------------------------------------------------------- G3: broadcast pushes
test('W11 broadcast pushes: Encore\'s enum and whose it is in the trace, the inner object found by shape; info().broadcast an enum only; no device id, link or radar token anywhere', async () => {
  closeAll();
  const { m, jam } = await setup();
  const out = await captured(async () => {
    m.encoreBroadcast('BROADCAST_OFF');                        // C0's dealer[1]: keyed by the device id
    m.encoreBroadcast('BROADCAST_ON');                         // dealer[2]: with social_radar_token
    m.encoreBroadcast('BROADCAST_ON');                         // unchanged: no second info line
    m.broadcast('BROADCAST_ON');                               // the PC's
    m.ev('social_connect', { uri: 'social-connect/v2/broadcast_status_update', payload: m.bcObject('BROADCAST_OFF') });   // flat
    m.ev('social_connect', { uri: 'hm://social-connect/v2/broadcast_status_update', payload: { x: { broadcast_status: 'lower case', device_id: DEV } } });
    m.ev('social_connect', { uri: 'social-connect/v2/broadcast_status_update', payload: { y: { broadcast_status: 'BROADCAST_ON' } } });   // no device_id
    // several devices in one push: Encore's is the one kept
    m.ev('social_connect', { uri: 'social-connect/v2/broadcast_status_update', payload: { [PC]: { broadcast_status: 'BROADCAST_ON', device_id: PC }, [DEV]: m.bcObject('BROADCAST_UNAVAILABLE') } });
  });
  assert.deepEqual(trace(jam, 'social_connect').map((e) => [e.bc, e.bc_dev]), [['BROADCAST_OFF', 'encore'], ['BROADCAST_ON', 'encore'], ['BROADCAST_ON', 'encore'],
    ['BROADCAST_ON', 'other'], ['BROADCAST_OFF', 'encore'], ['OTHER', 'encore'], ['BROADCAST_ON', 'absent'], ['BROADCAST_UNAVAILABLE', 'encore']]);
  assert.equal((out.match(/Encore's Jam broadcast is BROADCAST_ON \(push\)/g) || []).length, 1);
  assert.equal((out.match(/Encore's Jam broadcast is BROADCAST_OFF \(push\)/g) || []).length, 2);
  assert.deepEqual(trace(jam, 'social_connect').map((e) => e.applied), Array(8).fill(undefined), 'never applied');
  const i = jam.info();
  assert.deepEqual(Object.keys(i.broadcast).sort(), ['age_s', 'encore', 'src']);
  assert.deepEqual([i.broadcast.encore, i.broadcast.src], ['BROADCAST_UNAVAILABLE', 'push']);
  assert.equal(i.dealer.updates, 0, 'broadcast pushes are no session updates');
  // through Start too (the reply and the push)
  const s = await setup();
  play(s.m);
  const outS = await captured(() => s.jam.start());
  assert.equal(s.jam.info().broadcast.encore, 'BROADCAST_ON');
  const text = [out, outS, JSON.stringify(jam.ring), JSON.stringify(i), JSON.stringify(s.jam.ring), JSON.stringify(s.jam.info())].join('\n');
  for (const v of [DEV, PC, LINK, RADAR, id22('lt'), s.m.spotify.session_id, s.m.spotify.join_session_token]) assert.equal(text.includes(v), false, v);
});

// ---------------------------------------------------------------- G7, G8: the engine's diagnostics
test('W12 trace: command error (patch 4), cluster entries with kinds only, jamlist sid_match once per list', async () => {
  closeAll();
  const { m, jam, player } = await setup();
  m.failedTransfer('unmarshal');
  m.failedTransfer('nothing_to_play');
  // a transfer the engine dropped moved nothing: the player's rules 2 and 3 (foreign events, a song end taken for a
  // skip) don't count it (review fix: they did, so a natural song end in the next 15 s became a new generation)
  assert.deepEqual([player.lastMovingCmd, player.lastSkipCmd], [0, 0]);
  m.ev('command', { endpoint: 'transfer', from: 'social-connect-' + hex32('x'), continues: true });
  assert.deepEqual(trace(jam, 'command').map((e) => [e.ep, e.from, e.continues, e.error]),
    [['transfer', 'social-connect-*', 0, 'unmarshal'], ['transfer', 'social-connect-*', 0, 'nothing_to_play'], ['transfer', 'social-connect-*', 1, undefined]]);
  m.ev('command', { endpoint: 'transfer', from: 'social-connect-' + hex32('x'), continues: false });
  assert.ok(player.lastMovingCmd > 0 && player.lastSkipCmd > 0, 'one that was applied still counts');
  m.cluster({ active: 'social', social_devices: 2, jam_context: true, jam_mode: 'on', social_origin: true });
  m.cluster({ active: 'a-much-longer-kind', social_devices: 'x', jam_mode: 'something-long' });
  assert.deepEqual(trace(jam, 'cluster').map(({ t, ...e }) => e), [{ k: 'cluster', active: 'social', sd: 2, jam_ctx: 1, mode: 'on', social: 1 },
    { k: 'cluster', active: 'a-much-l', sd: 0, jam_ctx: 0, mode: 'somethin', social: 0 }]);
  assert.equal(jam.on, false, 'diagnostics only');
  // jamlist: the engine's jam-list id against the session id (JAM(1)'s id is hex32('jam1'))
  const a = await hosting({ session: { sid: hex32('jam1') } });
  assert.deepEqual(trace(a.jam, 'jamlist').map((e) => e.sid_match), [1]);
  const b = await hosting();
  assert.deepEqual(trace(b.jam, 'jamlist').map((e) => e.sid_match), [0]);
  b.m.push('USER_JOINED', b.m.spotify);
  b.jam.lastSent = 0;
  await b.jam.get({ fresh: true });
  assert.equal(trace(b.jam, 'jamlist').length, 1, 'once per list');
  // a hand-over whose list id is the session id (the model's handOverSid)
  const c = await setup({ engine: { handOver: 'always', handOverSid: true } });
  play(c.m);
  await c.jam.start();
  await settle(c.jam);
  assert.equal(c.jam.latch.set, true);
  assert.equal(c.m.st.ctx, JAM_LIST + c.m.spotify.session_id);
  assert.deepEqual(trace(c.jam, 'jamlist').map((e) => e.sid_match), [1]);
  assert.equal(JSON.stringify(c.jam.ring).includes(c.m.spotify.session_id), false, 'neither id in the trace');
  assert.notEqual(JAM(1), c.m.st.ctx);
});

// ---------------------------------------------------------------- §4's live sequence, in the model
test('W13 the live sequence (handOver transition, broadcast ON and a standby at the start): Start -> wait (4), End (2), Start -> hosting (3), End (2): 11 sends, ≥ 1 s apart', async () => {
  closeAll();
  const { m, jam } = await setup({ engine: { spacingMs: 1000, handOver: 'transition', bc: 'BROADCAST_ON', standby: true } });
  play(m);
  m.spotify = session({ sid: hex32('standby0'), token: id22('sb0'), members: ['alex'] });   // an earlier Jam's standby
  m.standby = m.spotify;
  // Start #1: the standby activated; Encore already ON, so no OFF -> ON: no hand-over; one confirm read; wait
  await jam.start();
  assert.deepEqual(ops(m), ['current', 'broadcast', 'start']);
  await waitFor(() => jam.wait);
  await settle(jam);
  assert.deepEqual(ops(m), ['current', 'broadcast', 'start', 'current']);
  // End #1: end, then broadcast off; the standby the end left is deleted by the OFF
  await jam.end();
  await waitFor(() => m.sends() === 6);
  await jam.lock;
  assert.deepEqual(ops(m).slice(4), ['end', 'broadcast']);
  assert.equal(m.spotify, null); assert.equal(m.bc, 'BROADCAST_OFF');
  assert.equal(jam.on, false);
  // Start #2: no session; OFF -> ON; current_or_new -> the hand-over -> the latch, no wait
  await jam.start();
  assert.deepEqual(ops(m).slice(6), ['current', 'broadcast', 'start']);
  await waitFor(() => jam.latch.set);
  await sleep(500);
  await settle(jam);
  assert.equal(jam.wait, false); assert.equal(m.sends(), 9, 'no confirm read');
  assert.ok(trace(jam, 'latch').some((e) => e.set === 1));
  // End #2
  await jam.end();
  await waitFor(() => m.sends() === 11);
  await jam.lock;
  assert.deepEqual(ops(m).slice(9), ['end', 'broadcast']);
  assert.equal(m.spotify, null);
  const ts = m.calls.map((c) => c.t);
  assert.ok(ts.slice(1).every((t, i) => t - ts[i] >= 1000), 'the gate\'s spacing');
  assert.ok(m.sends() <= 30);
  assert.deepEqual(m.bcSets, ['BROADCAST_ON', 'BROADCAST_OFF', 'BROADCAST_ON', 'BROADCAST_OFF']);
});

// ---------------------------------------------------------------- G9, G10: flags, the admin read
test('W14 flags: startBroadcast / endBroadcastOff booleans only (400 otherwise), logged; the admin broadcast read: one GET, the enum only; without the route nothing is sent', async () => {
  closeAll();
  const { m, jam } = await setup();
  assert.deepEqual([jam.info().flags.startBroadcast, jam.info().flags.endBroadcastOff], [true, true]);
  const out = await captured(async () => { jam.setFlags({ startBroadcast: false, endBroadcastOff: false }); });
  assert.deepEqual([jam.info().flags.startBroadcast, jam.info().flags.endBroadcastOff], [false, false]);
  assert.match(out, /startBroadcast=false endBroadcastOff=false \(in memory\)/);
  for (const v of ['no', 1, null]) {
    assert.throws(() => jam.setFlags({ startBroadcast: v }), (e) => e.status === 400 && e.code === 'bad_request');
    assert.throws(() => jam.setFlags({ endBroadcastOff: v }), (e) => e.status === 400 && e.code === 'bad_request');
  }
  assert.equal(jam.info().flags.startBroadcast, false, 'unchanged by a refused value');
  jam.setFlags({ startBroadcast: true });
  assert.equal(jam.info().flags.startBroadcast, true);
  // the admin read
  const r = await jam.broadcastRead();
  assert.deepEqual(r, { ok: true, broadcast_status: 'BROADCAST_OFF', self: true });
  assert.deepEqual(ops(m), ['jam_status']);
  assert.deepEqual(jamCalls(m), ['GET /jam/broadcast']);
  assert.deepEqual([jam.info().broadcast.encore, jam.info().broadcast.src], ['BROADCAST_OFF', 'read']);
  m.answer.jam_status = () => ({ status: 404 });
  assert.deepEqual(await jam.broadcastRead(), { ok: false, code: 'jam_not_found', status: 404, upstream: 404 });
  delete m.answer.jam_status;
  m.down = true;
  assert.deepEqual(await jam.broadcastRead(), { ok: false, code: 'engine_error' });
  m.down = false;
  // the engine's body check (patch 4's api_server): anything but on/off is 400 and sends nothing
  const n0 = m.sends();
  for (const b of [{}, { status: 'ON' }, { status: true }, { status: 'BROADCAST_ON' }]) assert.equal((await m.handle('POST', '/jam/broadcast', b)).status, 400);
  assert.equal(m.sends(), n0);
  // an engine without patch 4
  const p3 = await setup({ engine: { routes: ROUTES } });
  const r3 = await p3.jam.broadcastRead();
  assert.equal(r3.ok, false); assert.match(r3.reason, /patch 4 missing/);
  assert.equal(p3.m.sends(), 0); assert.equal(p3.m.count(/^\/jam\//), 0);
  closeAll();
});
