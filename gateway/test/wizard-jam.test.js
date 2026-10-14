'use strict';
// The setup guide's step 10, Turn on Jam (wizard.js + jam.js access()): the step reads the one-time Jam check's answer
// as jam.js keeps it. Accepted ticks it, also on a bridge that was accepted before (data/jam.json, over a restart);
// refused shows until the 30-minute wait is over (retry_at), then access is unknown again; the check itself (jam.js)
// sends nothing during that wait, from any button, and a second press while one runs joins it; Skip Jam and Finish work
// whether Jam was accepted, skipped or neither; a setup that was complete before step 10 existed stays complete (never
// pushed back into the guide), and one in progress just gets step 10 as its last step; over HTTP the Jam card's own
// route (POST /admin/api/jam/check) ticks it, and Showcase leaves it as it is (nothing personal in it). The engine and
// "Spotify" are the scripted jam-engine model (nothing reaches a real Jam); every name is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PcmClock } = require('../src/pcm');
const { Player } = require('../src/player');
const { Jam } = require('../src/jam');
const { Wizard, STEPS } = require('../src/wizard');
const { JamEngine, fakeJamEngine, session } = require('./support/jam-engine');
const { wizardServer, capture, cleanup, tmp, AUTH } = require('./support/wizard-server');

after(cleanup);

const CID = '0123456789abcdef0123456789abcdef';    // a made-up Client ID
const HOLD = 30 * 60000;              // jam.js scRefusedHold
const FAST = { setDebounce: 20, inactiveDebounce: 30, ownConfirmMs: 300, endSettleMs: 400, leaveSettleMs: 60, noSession: 20, connectRead: 20,
  queueDebounce: 10, queueRetry: 50, queueTimeout: 1000, addGapMs: 5, joinGenWaitMs: 150, idleGrace: 30 };

// a real Jam (jam.js) over the patch-3 engine model, its state in dir/jam.json; nothing checked yet
async function realJam(dir) {
  const m = new JamEngine({ spacingMs: 0 });
  const engine = fakeJamEngine(m);
  const clock = new PcmClock(path.join(os.tmpdir(), 'unused-wizard-jam.pcm'), { leadMs: 10000 });
  const bus = { push() {} };
  const player = new Player({ engine, clock, bus, webapi: null, dataDir: dir });
  const jam = new Jam({ cfg: { dataDir: dir }, engine, player, bus, webapi: null, encoders: { listening: () => 1 }, timing: FAST });
  clearInterval(jam.ticker);
  player.jam = jam;
  await engine.refresh();
  return { m, jam };
}
const quietly = async (fn) => { const cap = capture(); try { return await fn(); } finally { cap.restore(); } };
const wizard = (o = {}) => new Wizard({ cfg: { dataDir: o.dir || tmp(), port: 8095, platformKind: 'docker' }, ...o });
const stubJam = (st) => ({ access: () => st.a });
const UNKNOWN = { access: 'unknown', retry_at: null };
const ACCEPTED = { access: 'accepted', retry_at: null };

test('step 10 is the last of ten steps, after Play a song; unknown access: not done', async () => {
  assert.deepEqual(STEPS, ['password', 'client_id', 'spotify', 'engine', 'network', 'app', 'pair', 'away', 'play', 'jam']);
  const a = await quietly(() => wizard({ jam: stubJam({ a: UNKNOWN }) }).answer());
  assert.deepEqual(Object.keys(a.steps), STEPS);
  assert.deepEqual(a.steps.jam, { done: false, access: 'unknown', retry_at: null });
  // no Jam module, one that throws, or an answer it doesn't know: unknown, never done
  for (const jam of [null, { access: () => { throw new Error('jam down'); } }, { access: () => ({ access: 'yes' }) }, { access: () => null }, {}]) {
    assert.deepEqual((await quietly(() => wizard({ jam }).answer())).steps.jam, { done: false, access: 'unknown', retry_at: null }, JSON.stringify(jam));
  }
  // refused without a usable time: no retry_at
  assert.deepEqual((await quietly(() => wizard({ jam: stubJam({ a: { access: 'refused', retry_at: 'soon' } }) }).answer())).steps.jam,
    { done: false, access: 'refused', retry_at: null });
});

test('jam.js: the check accepted ticks step 10 at once, and a restart remembers it (a bridge accepted before shows it done)', async () => {
  const dir = tmp();
  const a = await realJam(dir);
  const w = wizard({ jam: a.jam });
  assert.deepEqual(a.jam.access(), UNKNOWN);
  assert.equal((await quietly(() => w.answer())).steps.jam.done, false);
  a.m.spotify = session({ members: ['alex'] });
  const v = await quietly(() => a.jam.check());
  assert.equal(v.verdict, 'accepted');
  assert.deepEqual(a.jam.access(), ACCEPTED);
  assert.deepEqual((await quietly(() => w.answer())).steps.jam, { done: true, access: 'accepted', retry_at: null });
  a.jam.close();
  await a.jam.saveChain;                                   // (jam.json is written in order, after the answer)
  // a restart: data/jam.json keeps it, and a new guide shows step 10 done without another check
  const b = await realJam(dir);
  assert.deepEqual(b.jam.access(), ACCEPTED);
  const a2 = await quietly(() => wizard({ jam: b.jam }).answer());
  assert.equal(a2.steps.jam.done, true);
  assert.equal(b.m.sends(), 0, 'nothing sent to show it');
  b.jam.close();
});

test('jam.js: refused waits 30 minutes (retry_at), then access is unknown again; nothing personal in the answer', async () => {
  const c = await realJam(tmp());
  c.m.answer.current = () => ({ status: 403 });
  assert.equal((await quietly(() => c.jam.check())).verdict, 'refused');
  const at = c.jam.scAt;
  assert.ok(at > 0);
  assert.deepEqual(c.jam.access(), { access: 'refused', retry_at: at + HOLD });
  let now = at + 60000;
  c.jam.now = () => now;
  const w = wizard({ jam: c.jam, now: () => now });
  let a = await quietly(() => w.answer());
  assert.deepEqual(a.steps.jam, { done: false, access: 'refused', retry_at: at + HOLD });
  assert.deepEqual(Object.keys(a.steps.jam).sort(), ['access', 'done', 'retry_at']);
  now = at + 29 * 60000;
  assert.equal((await quietly(() => w.answer())).steps.jam.access, 'refused', 'still waiting at 29 min');
  now = at + 31 * 60000;
  a = await quietly(() => w.answer());
  assert.deepEqual(a.steps.jam, { done: false, access: 'unknown', retry_at: null }, 'unknown again after 30 min');
  c.jam.close();
});

test('jam.js: one check at a time (a second press joins it), and nothing sent during the 30-minute wait after a refusal', async () => {
  const c = await realJam(tmp());
  c.m.answer.current = () => ({ status: 403 });
  c.m.delay.current = 50;                                  // (Spotify takes a moment: the second press comes meanwhile)
  const [v1, v2] = await quietly(() => Promise.all([c.jam.check(), c.jam.check()]));
  assert.equal(v1.verdict, 'refused');
  assert.equal(v2, v1, 'the second press gets the first one\'s verdict');
  assert.equal(c.m.sends('current'), 1, 'one request to Spotify');
  const at = c.jam.scAt;
  let now = at + 60000;
  c.jam.now = () => now;
  // the wait (the Jam card's button, a second tab): the refusal again with the minutes left, nothing sent, the wait kept
  const v3 = await quietly(() => c.jam.check());
  assert.deepEqual(v3, { on: c.jam.on, verdict: 'refused', reason: 'Spotify refused Jam access. You can check again in 29 min.' });
  now = at + HOLD - 1000;
  assert.match((await quietly(() => c.jam.check())).reason, /again in 1 min\.$/);
  assert.equal(c.m.sends('current'), 1, 'nothing sent during the wait');
  assert.deepEqual(c.jam.access(), { access: 'refused', retry_at: at + HOLD });
  // the wait is over: access is unknown again and the check is sent
  now = at + HOLD + 1000;
  delete c.m.answer.current;
  c.m.spotify = session({ members: ['alex'] });
  assert.equal((await quietly(() => c.jam.check())).verdict, 'accepted');
  assert.equal(c.m.sends('current'), 2);
  assert.deepEqual(c.jam.access(), ACCEPTED);
  c.jam.close();
});

test('Skip Jam and Finish: skip persists, Finish completes whether Jam was skipped, accepted or neither; done wins over skipped', async () => {
  const st = { a: UNKNOWN };
  const dir = tmp();
  const w = wizard({ dir, jam: stubJam(st) });
  w.act({ action: 'skip', step: 'jam' });
  w.act({ action: 'skip', step: 'jam' });
  let a = await quietly(() => wizard({ dir, jam: stubJam(st) }).answer());
  assert.deepEqual(a.skipped, ['jam'], 'kept in data/wizard.json, once');
  assert.equal(a.steps.jam.done, false, 'a skipped step stays not done');
  assert.equal(a.complete, false);
  await quietly(() => w.act({ action: 'complete' }));
  a = await quietly(() => wizard({ dir, jam: stubJam(st) }).answer());
  assert.deepEqual([a.complete, a.complete_how, a.show], [true, 'finished', false], 'skipped, then Finish');
  st.a = ACCEPTED;                                         // checked later on the Jam card
  a = await quietly(() => wizard({ dir, jam: stubJam(st) }).answer());
  assert.deepEqual([a.steps.jam.done, a.skipped, a.complete], [true, ['jam'], true], 'done wins (the page shows ✓)');
  // Finish with Jam accepted
  const w2 = wizard({ jam: stubJam({ a: ACCEPTED }) });
  await quietly(() => w2.act({ action: 'complete' }));
  a = await quietly(() => w2.answer());
  assert.deepEqual([a.complete, a.steps.jam.done, a.skipped], [true, true, []]);
  // Finish with Jam neither accepted nor skipped (refused, waiting)
  const w3 = wizard({ jam: stubJam({ a: { access: 'refused', retry_at: Date.now() + HOLD } }) });
  await quietly(() => w3.act({ action: 'complete' }));
  a = await quietly(() => w3.answer());
  assert.deepEqual([a.complete, a.steps.jam.done, a.skipped], [true, false, []]);
  // an already set-up bridge completes by itself ("auto") without Jam: step 10 doesn't hold it back
  const auto = new Wizard({ cfg: { dataDir: tmp(), port: 8095 }, jam: stubJam({ a: UNKNOWN }), adminAuth: { mode: () => 'stored' },
    webapi: { clientId: CID, ready: true }, auth: { list: () => [{ id: 'dev_1', created: '2026-10-07T12:00:00.000Z' }] } });
  a = await quietly(() => auto.answer());
  assert.deepEqual([a.complete, a.complete_how, a.steps.jam.done], [true, 'auto', false]);
});

test('a setup completed before step 10 existed stays complete (never pushed back into the guide); one in progress gets step 10 last', async () => {
  for (const how of ['finished', 'auto']) {
    const dir = tmp();
    const file = path.join(dir, 'wizard.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1, complete: true, complete_how: how, completed_at: 1760000000000, dismissed: false, skipped: ['away'],
      away_seen_at: null, played_at: 1760000000000 }));
    const before = fs.readFileSync(file, 'utf8');
    const w = wizard({ dir, jam: stubJam({ a: UNKNOWN }) });          // no Jam access on this bridge
    const a = await quietly(() => w.answer());
    assert.deepEqual([a.complete, a.complete_how, a.show, a.dismissed], [true, how, false, false], how);
    assert.equal(a.steps.jam.done, false);
    assert.deepEqual(a.skipped, ['away']);
    assert.deepEqual(w.statusInfo(), { complete: true, dismissed: false }, 'no "Setup isn\'t finished." banner');
    assert.equal(w.isComplete(), true, 'the tray launcher doesn\'t open the guide');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing rewritten');
  }
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'wizard.json'), JSON.stringify({ v: 1, complete: false, complete_how: null, completed_at: null, dismissed: false,
    skipped: ['network', 'jam', 'nope'], away_seen_at: null, played_at: null }));
  const a = await quietly(() => wizard({ dir, jam: stubJam({ a: UNKNOWN }) }).answer());
  assert.deepEqual([a.complete, a.show], [false, true]);
  assert.deepEqual(a.skipped, ['network', 'jam'], 'jam is a known step now');
});

test('over HTTP: the Jam card\'s check ticks step 10; Skip Jam then Finish; Showcase leaves the step as it is', async () => {
  const st = { a: UNKNOWN, checks: 0 };
  const jam = { statusInfo: () => ({}), info: () => ({}), access: () => st.a,
    check: async () => { st.checks++; st.a = ACCEPTED; return { on: true, verdict: 'accepted', reason: 'Spotify answered with a session Encore can read', members: 1 }; } };
  const s = await wizardServer({ ctx: { jam } });
  try {
    let r = await s.call('/admin/api/wizard', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.j.steps), STEPS);
    assert.deepEqual(r.j.steps.jam, { done: false, access: 'unknown', retry_at: null });
    r = await s.call('/admin/api/jam/check', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.j.verdict, 'accepted');
    assert.equal(st.checks, 1);
    r = await s.call('/admin/api/wizard', { headers: AUTH });
    assert.deepEqual(r.j.steps.jam, { done: true, access: 'accepted', retry_at: null });
    await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    r = await s.call('/admin/api/wizard', { headers: AUTH });
    assert.equal(r.j.showcase, true);
    assert.deepEqual(r.j.steps.jam, { done: true, access: 'accepted', retry_at: null }, 'the same in Showcase');
    // the page's Skip Jam: skip, then complete
    st.a = UNKNOWN;
    r = await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body: { action: 'skip', step: 'jam' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.skipped, ['jam']);
    assert.equal(r.j.complete, false);
    r = await s.call('/admin/api/wizard', { method: 'POST', headers: AUTH, body: { action: 'complete' } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.j.complete, r.j.complete_how, r.j.show], [true, 'finished', false]);
  } finally { await s.close(); }
});
