'use strict';
// H2 (RELEASE-PLAN D3, 1.1.0): every Jam event that names a member also carries that member's id, the same id as in the
// JAM object's m[] (and h for the host), so the app's Anonymous Mode gives a HUD the same made-up name as the member
// rows. Real sessions against the patch-3 engine model (support/jam-engine.js), whose "Spotify" is scripted: nothing
// here can create, join or end a real Jam. (The fake Jam's events: showcase.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { PcmClock } = require('../src/pcm');
const { Player } = require('../src/player');
const { Jam } = require('../src/jam');
const { JamEngine, fakeJamEngine, session, T, JAM } = require('./support/jam-engine');
const { tmp, sleep } = require('./support/helpers');

const FAST = { setDebounce: 20, inactiveDebounce: 30, ownConfirmMs: 300, endSettleMs: 400, leaveSettleMs: 60, noSession: 20, connectRead: 20,
  queueDebounce: 10, queueRetry: 50, queueTimeout: 1000, addGapMs: 5, joinGenWaitMs: 150, idleGrace: 30 };

async function setup() {
  const m = new JamEngine({ spacingMs: 0 });
  const engine = fakeJamEngine(m);
  const clock = new PcmClock(path.join(os.tmpdir(), 'unused-showcase-jam.pcm'), { leadMs: 10000 });
  const pushes = [];
  const bus = { push: (type, data) => pushes.push({ type, data }) };
  const dir = tmp('showcase-jam');
  const player = new Player({ engine, clock, bus, webapi: null, dataDir: dir });
  const jam = new Jam({ cfg: { dataDir: dir, jam: {} }, engine, player, bus, webapi: null, encoders: { listening: () => 1 }, timing: FAST });
  clearInterval(jam.ticker);
  player.jam = jam;
  jam.sc = 1;
  await engine.refresh();
  return { m, engine, player, jam, pushes };
}
const settle = async (jam, ms = 60) => { await sleep(ms); if (jam.flight) await jam.flight; await sleep(5); };
const jams = (pushes) => pushes.filter((x) => x.type === 'jam').map((x) => x.data);
const lastEv = (pushes) => { const e = jams(pushes).filter((j) => j.ev); return e.length ? e[e.length - 1].ev : null; };
const lastBody = (pushes) => { const j = jams(pushes); return j[j.length - 1]; };

async function hosting() {
  const s = await setup();
  s.m.spotify = session({ members: ['alex', 'jake'] });
  s.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  s.m.jamStarts(1);
  await settle(s.jam);
  return s;
}
async function guesting() {
  const s = await setup();
  s.m.spotify = session({ owner: false, members: ['jake', 'alex', 'emma'], hostId: 'jake' });
  s.m.jamStarts(2);
  await settle(s.jam);
  return s;
}

test('H2 host: ev in / out carry the member id that m[] uses', async () => {
  const { m, jam, pushes } = await hosting();
  m.spotify.session_members.push({ username: 'emma', display_name: 'Emma' });
  jam.lastSent = 0;
  await jam.get({ fresh: true });
  const ein = lastEv(pushes);
  assert.deepEqual(ein, { k: 'in', n: 'Emma', id: 'emma' });
  assert.ok(lastBody(pushes).m.some((x) => x.id === ein.id && x.n === ein.n), 'the same id as the member row');
  m.spotify.session_members = m.spotify.session_members.filter((x) => x.username !== 'jake');
  jam.lastSent = 0;
  await jam.get({ fresh: true });
  assert.deepEqual(lastEv(pushes), { k: 'out', n: 'Jake', id: 'jake' });
});

test('H2 guest: ev kicked and a foreign end carry the host\'s id (h in the JAM object)', async () => {
  const g = await guesting();
  const h = lastBody(g.pushes).h;
  assert.equal(h, 'jake');
  g.m.answer.current = () => ({ status: 200, json: { ...g.m.spotify, session_members: g.m.spotify.session_members.filter((x) => x.username !== 'alex') } });
  g.jam.lastSent = 0;
  await g.jam.get({ fresh: true });
  assert.deepEqual(lastEv(g.pushes), { k: 'kicked', n: 'Jake', id: h });

  const e = await guesting();
  e.m.jamEnds({ item10: true });
  await settle(e.jam);
  assert.equal(e.jam.on, false);
  assert.deepEqual(lastEv(e.pushes), { k: 'end', n: 'Jake', id: 'jake' });

  const own = await hosting();                                      // a host's own Jam ending names no one
  own.m.jamEnds({ item10: true });
  await settle(own.jam);
  assert.deepEqual(lastEv(own.pushes), { k: 'end' });
});

test('H2 join: ev join carries the host\'s id', async () => {
  const { m, jam, pushes } = await setup();
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  await sleep(20);
  m.spotify = session({ owner: true, members: ['jake', 'emma'], hostId: 'jake', token: 'jakeTok_123' });
  const orig = m.spotifyAnswer.bind(m);
  m.spotifyAnswer = async (op, a) => {
    const r = await orig(op, a);
    if (op === 'join' && r.status === 200) setTimeout(() => { m.guestSkip(T(50)); m.st.ctx = JAM(7); m.jamEv(); }, 30);   // social-connect's transfer
    return r;
  };
  const r = await jam.join({ link: 'https://open.spotify.com/socialsession/jakeTok_123?si=abc' });
  assert.equal(r.jam.h, 'jake');
  const ev = jams(pushes).filter((j) => j.ev && j.ev.k === 'join').pop().ev;
  assert.deepEqual(ev, { k: 'join', n: 'Jake', id: r.jam.h });
});
