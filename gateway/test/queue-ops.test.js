'use strict';
// Up Next you can rearrange (DESIGN-QUEUE.md §4, engine patch 9): the QUEUE's `ops` per role, Play Next
// (POST /v1/jam/queue/top), edits of a shuffled context, and tap to jump (player.jump, POST /v1/player/jump), against the
// patch-9 engine model (support/jam-engine.js with queueOps; support/engine-model.js for the player without jam.js).
// Everything is a fake: nothing here reaches Spotify, and every uid, name and id is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const { PcmClock } = require('../src/pcm');
const { Player } = require('../src/player');
const { Jam } = require('../src/jam');
const { JamEngine, fakeJamEngine, session, track, T, JAM, SOCIAL, PC } = require('./support/jam-engine');
const { EngineModel, fakeEngine } = require('./support/engine-model');
const { tmp, sleep } = require('./support/helpers');
const { wizardServer, cleanup, AUTH } = require('./support/wizard-server');

after(cleanup);

const OPS = ['shuffled', 'top', 'jump'];
const FAST = { setDebounce: 20, inactiveDebounce: 30, ownConfirmMs: 300, endSettleMs: 400, leaveSettleMs: 60, noSession: 20, connectRead: 20,
  queueDebounce: 10, queueRetry: 50, queueTimeout: 1000, addGapMs: 5, joinGenWaitMs: 150, idleGrace: 30, queueEditTimeout: 300 };
const PL = 'spotify:playlist:' + 'p'.repeat(22);

async function setup(o = {}) {
  const m = new JamEngine({ spacingMs: 0, queueOps: OPS, ...o.engine });
  const engine = fakeJamEngine(m);
  const clock = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-gwq9.pcm'), { leadMs: 10000 });
  const pushes = [];
  const bus = { push: (type, data) => pushes.push({ type, data }) };
  const dir = tmp('q9');
  const player = new Player({ engine, clock, bus, webapi: null, dataDir: dir });
  const encoders = { n: 1, listening() { return this.n; } };
  const jam = new Jam({ cfg: { dataDir: dir, jam: o.flags || {} }, engine, player, bus, webapi: null, encoders, timing: { ...FAST, ...o.timing } });
  clearInterval(jam.ticker);
  player.jam = jam;
  jam.sc = 'sc' in o ? o.sc : 1;
  await engine.refresh();
  return { m, engine, player, jam, pushes, dir, clock };
}
const settle = async (jam, ms = 60) => { await sleep(ms); if (jam.flight) await jam.flight; await sleep(5); };
const calls = (m, re) => m.log.filter((x) => re.test(x.path));
const paths = (m, re) => calls(m, re).map((x) => x.path);
const trace = (jam, k) => jam.ring.filter((e) => e.k === k);
const queuePushes = (pushes) => pushes.filter((x) => x.type === 'queue').length;
const MOVES = /^\/player\/(pause|resume|seek|next|prev|queue\/jump)$/;

async function hosting(o = {}) {
  const s = await setup(o);
  s.m.spotify = session({ members: ['alex', 'jake'], ...o.session });
  s.m.load(T(1), { ctx: PL });
  s.m.jamStarts(1);
  await settle(s.jam);
  return s;
}
async function guesting(o = {}) {
  const s = await setup(o);
  s.m.spotify = session({ owner: false, members: ['jake', 'alex', 'emma'], hostId: 'jake', hostDev: PC, ...o.session });
  s.m.jamStarts(2);
  await settle(s.jam);
  return s;
}
// nothing Jam-related: a playlist playing on Encore
async function playing(o = {}) {
  const s = await setup(o);
  s.m.load(T(1), { ctx: PL });
  await sleep(20);
  return s;
}

async function captured(fn) {
  const out = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, keep); }
  return out.join('\n');
}

const ent = (tag, provider) => ({ uri: T(tag), uid: 'u-' + tag, provider,
  metadata: provider === 'queue' ? { is_queued: 'true' } : provider === 'autoplay' ? { 'autoplay.is_autoplay': 'true' } : {}, track: track(T(tag)) });
const ROWS = () => [ent('q1', 'queue'), ent('q2', 'queue'), ent('c1', 'context'), ent('c2', 'context'), ent('c3', 'context'), ent('a1', 'autoplay')];
const uids = (rows) => rows.map((r) => r.uid);

// ---------------------------------------------------------------- ops by role (§4.1)
test('ops by role: no Jam, host, plan B lim and the fake host get shuffled+top+jump; guests (with control, refused, fake) none', async () => {
  const a = await playing();
  a.m.next = ROWS();
  let q = (await a.jam.queue()).obj;
  assert.deepEqual(q.ops, OPS, 'no Jam'); assert.equal(q.ed, 1);
  const h = await hosting();
  assert.deepEqual((await h.jam.queue()).obj.ops, OPS, 'host');
  const l = await setup({ sc: undefined });
  l.m.load(T(1), { ctx: JAM(3), origin: SOCIAL });
  l.m.jamEv();
  assert.equal(l.jam.lim(), true); assert.equal(l.jam.hosting(), true);
  assert.deepEqual((await l.jam.queue()).obj.ops, OPS, 'plan B\'s lim, no session');
  const g = await guesting();
  q = (await g.jam.queue()).obj;
  assert.equal(q.ops, undefined, 'guest'); assert.equal(q.ed, undefined);
  const gc = await guesting({ session: { gc: true }, flags: { guestTransport: true } });
  assert.equal(gc.jam.ctl(), true);
  assert.equal((await gc.jam.queue()).obj.ops, undefined, 'guest with control: a jump is the host\'s');
  const rg = await guesting();
  rg.jam.refused('current', 401);
  assert.equal(rg.jam.lim(), true);
  assert.equal((await rg.jam.queue()).obj.ops, undefined, 'a refused guest (lim, its role kept)');
  const f = await setup();
  f.m.load(T(1));
  f.jam.setFake({ role: 'host', members: 3 });
  assert.deepEqual((await f.jam.queue()).obj.ops, OPS, 'fake host');
  f.jam.setFake({ role: 'guest', members: 3 });
  assert.equal((await f.jam.queue()).obj.ops, undefined, 'fake guest');
  for (const s of [a, h, l, g, gc, rg, f]) assert.equal((s.m.tops || 0) + (s.m.jumps || 0), 0, 'nothing sent');
});

test('ops: an old engine gives none (1.5.0\'s Up Next); a partial list only its ops; jamEdit off keeps jump only; a change pushes queue and moves the ETag', async () => {
  const old = await playing({ engine: { queueOps: [] } });
  old.m.next = ROWS();
  let m0 = await old.jam.queue();
  assert.equal(m0.obj.ops, undefined); assert.equal(m0.obj.ed, 1, 'remove/move as 1.5.0');
  assert.equal('queue_ops' in old.m.status().json, false, 'the old engine model lists nothing');
  // the engine is updated under a running bridge: its /status now lists the ops
  const n = queuePushes(old.pushes);
  old.m.o.queueOps = OPS;
  await old.engine.refresh();
  assert.equal(queuePushes(old.pushes), n + 1, 'ops changed: one queue event');
  const m1 = await old.jam.queue();
  assert.deepEqual(m1.obj.ops, OPS);
  assert.notEqual(m1.etag, m0.etag, 'the ETag covers ops');
  await old.engine.refresh();
  assert.equal(queuePushes(old.pushes), n + 1, 'the same ops: no event');
  // unknown words are ignored; the order is the QUEUE's
  old.m.o.queueOps = ['jump', 'later', 'top'];
  await old.engine.refresh();
  assert.deepEqual((await old.jam.queue()).obj.ops, ['top', 'jump']);
  assert.deepEqual(old.jam.info().queue_ops, ['top', 'jump']);
  // jamEdit off: no ed, top or shuffled, but the host may still jump; one queue event for the change
  const h = await hosting();
  const k = queuePushes(h.pushes);
  h.jam.setFlags({ jamEdit: false });
  assert.equal(queuePushes(h.pushes), k + 1);
  const q = (await h.jam.queue()).obj;
  assert.equal(q.ed, undefined); assert.deepEqual(q.ops, ['jump']);
});

// ---------------------------------------------------------------- Play Next: POST /v1/jam/queue/top (§4.2)
test('top: a q row moves to the head with its uid; a cq row becomes q<n> (reply uid, metadata kept); an ap row too; already first: 200, nothing changes', async () => {
  const { m, jam } = await playing();
  m.next = ROWS();
  m.next[3].metadata = { added_by: 'spotify:user:jake' };
  let q = (await jam.queue()).obj;
  let r = await jam.queueEdit('top', { uid: 'u-q2', rev: q.rev });
  assert.deepEqual(calls(m, /^\/player\/queue\/top$/).map((x) => x.body), [{ rev: q.rev, uid: 'u-q2' }], 'the engine body is {rev, uid}');
  assert.equal(r.uid, 'u-q2');
  assert.deepEqual(uids(r.queue.q), ['u-q2', 'u-q1']);
  assert.equal(r.queue.rev, m.rev());
  r = await jam.queueEdit('top', { uid: 'u-c2', rev: r.queue.rev });
  assert.equal(r.uid, 'q101', 'the reply\'s uid is the engine\'s new one');
  assert.deepEqual(uids(r.queue.q), ['q101', 'u-q2', 'u-q1']);
  assert.deepEqual(uids(r.queue.cq), ['u-c1', 'u-c3'], 'it left Next From');
  assert.equal(r.queue.q[0].u, T('c2'));
  assert.deepEqual(m.next[0].metadata, { added_by: 'spotify:user:jake', is_queued: 'true' }, 'the "added by" survives');
  r = await jam.queueEdit('top', { uid: 'u-a1', rev: r.queue.rev });
  assert.equal(r.uid, 'q102');
  assert.deepEqual(r.queue.ap, []);
  assert.deepEqual(m.next[0].metadata, { is_queued: 'true' }, 'no autoplay flag any more');
  const rev = r.queue.rev;
  r = await jam.queueEdit('top', { uid: 'q102', rev });
  assert.equal(r.uid, 'q102'); assert.equal(r.queue.rev, rev, 'already first: nothing changed');
  assert.deepEqual(trace(jam, 'edit').map((e) => [e.op, e.section, e.status]), [['top', 'q', 200], ['top', 'cq', 200], ['top', 'ap', 200], ['top', 'q', 200]]);
  assert.equal(calls(m, /^\/jam\//).length, 0, 'no Spotify request');
  assert.equal(m.edits || 0, 0);
});

test('top refusals: now -> not_editable, guest -> not_host, jamEdit off -> unsupported, stale rev -> queue_changed, old engine -> jam_unavailable, bad bodies', async () => {
  const { m, jam } = await playing();
  m.next = ROWS();
  const q = (await jam.queue()).obj;
  await assert.rejects(jam.queueEdit('top', { uid: q.now.uid, rev: q.rev }), (e) => e.status === 409 && e.code === 'not_editable' && e.message === 'This song can’t be moved or removed.');
  for (const b of [{ rev: q.rev }, { uid: 'u-q1' }, { uid: '', rev: q.rev }, { uid: 'x'.repeat(129), rev: q.rev }, { uid: 'u-q1', rev: 3 }]) {
    await assert.rejects(jam.queueEdit('top', b), (e) => e.status === 400 && e.code === 'bad_request', JSON.stringify(b));
  }
  assert.equal(m.tops || 0, 0, 'none of those reached the engine');
  await jam.queueEdit('top', { uid: 'u-c1', rev: q.rev });
  await assert.rejects(jam.queueEdit('top', { uid: 'u-c2', rev: q.rev }), (e) => e.status === 409 && e.code === 'queue_changed' && e.message === 'Up Next changed, so it was refreshed.');
  assert.equal(m.tops, 2, 'the stale one was the engine\'s 409');
  const g = await guesting();
  g.m.next = ROWS();
  const gq = (await g.jam.queue()).obj;
  await assert.rejects(g.jam.queueEdit('top', { uid: 'u-c1', rev: gq.rev }), (e) => e.status === 409 && e.code === 'not_host');
  const h = await hosting();
  h.m.next = ROWS();
  const hq = (await h.jam.queue()).obj;
  h.jam.setFlags({ jamEdit: false });
  await assert.rejects(h.jam.queueEdit('top', { uid: 'u-c1', rev: hq.rev }), (e) => e.status === 409 && e.code === 'unsupported');
  const old = await playing({ engine: { queueOps: [] } });
  old.m.next = ROWS();
  const oq = (await old.jam.queue()).obj;
  await assert.rejects(old.jam.queueEdit('top', { uid: 'u-c1', rev: oq.rev }), (e) => e.status === 503 && e.code === 'jam_unavailable' && e.message === 'Encore’s player can’t do this. Update the Encore player.');
  const nt = await playing({ engine: { queueOps: ['jump'] } });
  nt.m.next = ROWS();
  const nq = (await nt.jam.queue()).obj;
  assert.deepEqual(nq.ops, ['jump']);
  await assert.rejects(nt.jam.queueEdit('top', { uid: 'u-c1', rev: nq.rev }), (e) => e.code === 'jam_unavailable');
  for (const s of [g, h, old, nt]) assert.equal(s.m.tops || 0, 0);
  // an engine that listed top but has no route (404): jam_unavailable
  const gone = await playing();
  gone.m.next = ROWS();
  const xq = (await gone.jam.queue()).obj;
  gone.m.o.queueOps = ['shuffled', 'jump'];
  await assert.rejects(gone.jam.queueEdit('top', { uid: 'u-c1', rev: xq.rev }), (e) => e.status === 503 && e.code === 'jam_unavailable');
});

test('a shuffled context: remove, move and top of cq rows go through with `shuffled`; without it they stay refused (no engine call)', async () => {
  const { m, jam, player } = await playing();
  m.next = ROWS();
  m.st.shuffle = true;
  player.st.shuffle = true;
  let q = (await jam.queue()).obj;
  q = (await jam.queueEdit('move', { uid: 'u-c3', before: 'u-c1', rev: q.rev })).queue;
  assert.deepEqual(uids(q.cq), ['u-c3', 'u-c1', 'u-c2']);
  q = (await jam.queueEdit('remove', { uid: 'u-c1', rev: q.rev })).queue;
  assert.deepEqual(uids(q.cq), ['u-c3', 'u-c2']);
  const r = await jam.queueEdit('top', { uid: 'u-c2', rev: q.rev });
  assert.deepEqual(uids(r.queue.cq), ['u-c3']);
  assert.equal(r.queue.q[0].uid, r.uid);
  const o = await playing({ engine: { queueOps: ['top', 'jump'] } });
  o.m.next = ROWS();
  o.m.st.shuffle = true;
  o.player.st.shuffle = true;
  const oq = (await o.jam.queue()).obj;
  assert.deepEqual(oq.ops, ['top', 'jump']);
  for (const [op, b] of [['top', { uid: 'u-c2' }], ['remove', { uid: 'u-c2' }], ['move', { uid: 'u-c2', before: 'u-c1' }]]) {
    await assert.rejects(o.jam.queueEdit(op, { ...b, rev: oq.rev }), (e) => e.status === 409 && e.code === 'not_editable' && e.message === 'Turn shuffle off to change these songs.', op);
  }
  assert.equal((o.m.tops || 0) + (o.m.edits || 0), 0);
  // queue and autoplay rows still go to the top while shuffled
  const t = await o.jam.queueEdit('top', { uid: 'u-a1', rev: oq.rev });
  assert.equal(t.queue.q[0].uid, t.uid);
});

test('edit_lost: a transfer that undoes a top counts once (as a move of the row now first in q); a transfer that keeps it doesn\'t', async () => {
  const { m, jam } = await hosting();
  m.next = ROWS();
  const orig = ROWS();
  let q = (await jam.queue()).obj;
  const out = await captured(async () => {
    const r = await jam.queueEdit('top', { uid: 'u-c3', rev: q.rev });
    assert.deepEqual(uids(r.queue.q), [r.uid, 'u-q1', 'u-q2']);
    await sleep(5);
    m.rebuild(orig);                                  // Spotify's copy of the Jam: c3 back in its place
    await settle(jam, 40);
  });
  assert.deepEqual(jam.info().edits, { n: 1, lost: 1 });
  assert.deepEqual(trace(jam, 'edit_lost').map((e) => e.op), ['top']);
  assert.match(out, /jam: queue edit top cq -> 200 in \d+ ms/);
  for (const s of ['u-c3', 'q101', T('c3')]) assert.equal(out.includes(s), false, `logged: ${s}`);
  // kept: Spotify's copy carries the topped row first (under its own uids)
  const k = await hosting();
  k.m.next = ROWS();
  q = (await k.jam.queue()).obj;
  await k.jam.queueEdit('top', { uid: 'u-c3', rev: q.rev });
  await sleep(5);
  const r = {};
  for (const e of ROWS()) r[e.uid.slice(2)] = e;
  k.m.rebuild([{ ...r.c3, provider: 'queue' }, r.q1, r.q2, r.c1, r.c2, r.a1].map((e) => ({ ...e, uid: 's-' + e.uid })));
  await settle(k.jam, 40);
  assert.deepEqual(k.jam.info().edits, { n: 1, lost: 0 });
});

// ---------------------------------------------------------------- tap to jump: player.jump (§4.3)
test('jump: pause, the engine jump, resume; a gen at 0:00; the rows above go, the queue stays, and the window refills from the rest', async () => {
  const { m, player, jam } = await playing();
  const rest = Array.from({ length: 70 }, (_, i) => ent('s' + i, 'context'));
  m.next = [ent('q1', 'queue'), ...rest];
  let q = (await jam.queue()).obj;
  assert.equal(q.cq.length, 31, 'the 32-row window');
  m.log = [];
  const g0 = player.gen;
  const r = await player.jump({ uid: 'u-s19', uri: T('s19'), q: 'high' });
  assert.equal(r.gen, g0 + 1); assert.equal(player.gen, g0 + 1);
  assert.ok(player.pending && player.pending.gen === r.gen && player.pending.positionMs === 0, 'the generation starts at 0:00');
  assert.deepEqual(paths(m, MOVES), ['/player/pause', '/player/queue/jump', '/player/resume']);
  assert.deepEqual(calls(m, /^\/player\/queue\/jump$/).map((x) => x.body), [{ uid: 'u-s19' }], 'only the uid goes to the engine');
  assert.ok(m.log.findIndex((x) => x.path === '/player/queue') < m.log.findIndex((x) => x.path === '/player/pause'), 'the pre-check comes before the pause');
  q = (await jam.queue()).obj;
  assert.equal(q.now.uid, 'u-s19');
  assert.deepEqual(uids(q.q), ['u-q1'], 'Next in Queue stays (as in Spotify)');
  assert.equal(q.cq[0].uid, 'u-s20');
  assert.equal(q.cq.length, 31, 'the window is full again');
  assert.equal(q.cq[30].uid, 'u-s50', 'refilled from the rest of the list (rows the phone hadn\'t seen)');
  assert.equal(player.st.track.context_track_uri, T('s19'));
  // a queued target: the queued rows above it go, the context stays
  m.next = [ent('q1', 'queue'), ent('q2', 'queue'), ent('q3', 'queue'), ent('c1', 'context')];
  await player.jump({ uid: 'u-q2' });
  assert.deepEqual(uids(m.next), ['u-q3', 'u-c1']);
  await sleep(20);
});

test('jump refusals before anything pauses: bad uid, not loaded, not upcoming (queue_changed), an old engine, guests', async () => {
  const s = await playing();
  s.m.next = ROWS();
  s.m.log = [];
  for (const b of [{}, { uid: '' }, { uid: 7 }, { uid: 'x'.repeat(129) }]) {
    await assert.rejects(s.player.jump(b), (e) => e.status === 400 && e.code === 'bad_request' && e.message === 'That Up Next change isn’t valid.', JSON.stringify(b));
  }
  const g0 = s.player.gen;
  await assert.rejects(s.player.jump({ uid: 'u-gone' }), (e) => e.status === 409 && e.code === 'queue_changed' && e.message === 'Up Next changed, so it was refreshed.');
  assert.equal(s.player.gen, g0, 'no generation');
  assert.deepEqual(paths(s.m, MOVES), [], 'no pause, no engine jump: the music plays on');
  // nothing loaded: no engine call at all
  const idle = await setup();
  idle.m.log = [];
  await assert.rejects(idle.player.jump({ uid: 'u-c1' }), (e) => e.status === 409 && e.code === 'not_active' && e.message === 'Nothing is playing on Encore.');
  assert.equal(idle.m.log.length, 0);
  // an engine without jump
  const old = await playing({ engine: { queueOps: [] } });
  old.m.next = ROWS();
  old.m.log = [];
  await assert.rejects(old.player.jump({ uid: 'u-c1' }), (e) => e.status === 409 && e.code === 'unsupported' && e.message === 'Encore’s player can’t do this. Update the Encore player.');
  assert.equal(old.m.log.length, 0);
  // a guest without control: the guard (http.js) answers 403; with control: not_host, nothing sent
  const g = await guesting();
  assert.throws(() => g.jam.guard('jump'), (e) => e.status === 403 && e.code === 'jam_no_control');
  const gc = await guesting({ session: { gc: true }, flags: { guestTransport: true } });
  assert.equal(gc.jam.guard('jump'), null);
  gc.m.next = ROWS();
  gc.m.log = [];
  await assert.rejects(gc.player.jump({ uid: 'u-c1' }), (e) => e.status === 409 && e.code === 'not_host' && e.message === 'Only the Jam’s host can do this.');
  assert.equal(gc.m.jumps || 0, 0); assert.deepEqual(paths(gc.m, MOVES), []);
  // the fake Jam's guest
  const f = await playing();
  f.m.next = ROWS();
  f.jam.setFake({ role: 'guest', members: 3 });
  await assert.rejects(f.player.jump({ uid: 'u-c1' }), (e) => e.code === 'not_host');
  assert.equal(f.m.jumps || 0, 0);
});

test('jump: a row that just became current restarts at 0:00 with no engine jump; a late 409 is a no-op generation, or a restart when it became current', async () => {
  const { m, player } = await playing();
  m.next = ROWS();
  // the engine ran ahead into c1 (the phone still shows it upcoming)
  m.next.splice(2, 1);
  m.load(T('c1'), { ctx: PL, uid: 'u-c1' });
  await sleep(20);
  m.log = [];
  let g0 = player.gen;
  let r = await player.jump({ uid: 'u-c1' });
  assert.equal(r.gen, g0 + 1);
  assert.deepEqual(paths(m, MOVES), ['/player/pause', '/player/seek', '/player/resume']);
  assert.deepEqual(calls(m, /^\/player\/seek$/).map((x) => x.body), [{ position: 0 }]);
  assert.equal(m.jumps || 0, 0);
  // late 409: the row went meanwhile; the same song carries on in a new generation
  m.answer.jump = () => ({ status: 409 });
  await sleep(20);
  m.log = [];
  g0 = player.gen;
  const before = m.st.track.uri;
  r = await player.jump({ uid: 'u-c2' });
  assert.equal(r.gen, g0 + 1);
  assert.deepEqual(paths(m, MOVES), ['/player/pause', '/player/queue/jump', '/player/resume'], 'no seek: wherever the engine is');
  assert.equal(m.st.track.uri, before);
  // late 409, but the row is the current one now: start it over
  m.answer.jump = (b) => { m.st.curUid = b.uid; return { status: 409 }; };
  await sleep(20);
  m.log = [];
  await player.jump({ uid: 'u-c3' });
  assert.deepEqual(paths(m, MOVES), ['/player/pause', '/player/queue/jump', '/player/seek', '/player/resume']);
  await sleep(20);
});

test('jump: the engine\'s 204, 404, 400 and 500 mapped; the paused engine resumes so the music goes on; a transport error too', async () => {
  const { m, player } = await playing();
  m.next = ROWS();
  const cases = [[204, 409, 'not_active', 'Nothing is playing on Encore.'], [404, 409, 'unsupported', 'Encore’s player can’t do this. Update the Encore player.'],
    [400, 400, 'bad_request', 'That Up Next change isn’t valid.'], [500, 502, 'engine_error', 'Encore’s player refused the request.']];
  for (const [engine, status, code, message] of cases) {
    m.answer.jump = () => ({ status: engine });
    m.st.paused = false;
    player.st.status = 'playing';
    m.log = [];
    await assert.rejects(player.jump({ uid: 'u-c1' }), (e) => e.status === status && e.code === code && e.message === message, String(engine));
    assert.deepEqual(paths(m, MOVES), ['/player/pause', '/player/queue/jump', '/player/resume'], `${engine}: resumed`);
    await sleep(15);
  }
  m.answer.jump = null;
  const send = m.handle.bind(m);
  m.handle = async (method, p, b) => {
    if (p === '/player/queue/jump') throw Object.assign(new Error('Encore\'s player didn\'t answer in time.'), { status: 502, code: 'engine_error' });
    return send(method, p, b);
  };
  player.st.status = 'playing';
  m.log = [];
  await assert.rejects(player.jump({ uid: 'u-c1' }), (e) => e.status === 502 && e.code === 'engine_error');
  assert.ok(paths(m, MOVES).includes('/player/resume'));
  await sleep(20);
});

test('jump in hostJump "cut": no pause or resume, one generation by cutJump; refusals throw with the engine never paused', async () => {
  const { m, player, jam } = await hosting({ flags: { hostJump: 'cut' } });
  m.next = ROWS();
  m.log = [];
  const g0 = player.gen;
  const r = await player.jump({ uid: 'u-c2' });
  assert.equal(player.gen, g0 + 1); assert.equal(r.gen, player.gen);
  assert.deepEqual(paths(m, MOVES), ['/player/queue/jump']);
  assert.equal(m.st.curUid, 'u-c2');
  assert.ok(trace(jam, 'gen').some((e) => e.reason === 'jump'), 'traced like the other commands');
  await sleep(20);
  m.answer.jump = () => ({ status: 409 });
  m.log = [];
  await assert.rejects(player.jump({ uid: 'u-c3' }), (e) => e.status === 409 && e.code === 'queue_changed');
  assert.deepEqual(paths(m, MOVES), ['/player/queue/jump']);
  // the row became current: a seek to 0:00, cut too
  m.answer.jump = null;
  m.next = m.next.filter((e) => e.uid !== 'u-c3');
  m.load(T('c3'), { ctx: JAM(1), origin: SOCIAL, uid: 'u-c3' });
  await sleep(20);
  m.log = [];
  await player.jump({ uid: 'u-c3' });
  assert.deepEqual(paths(m, MOVES), ['/player/seek']);
});

test('jump in hostJump "cut" while paused: the command path, so the row plays in a new generation (no 8 s wait for a cut that never comes)', async () => {
  const { m, engine, player } = await hosting({ flags: { hostJump: 'cut' } });
  m.next = ROWS();
  await player.pause({});
  await sleep(20);
  await engine.refresh();
  assert.equal(player.st.status, 'paused');
  m.log = [];
  const g0 = player.gen;
  const t0 = Date.now();
  const r = await player.jump({ uid: 'u-c2' });
  assert.equal(r.gen, g0 + 1); assert.equal(player.gen, r.gen);
  assert.ok(Date.now() - t0 < 4000, 'no wait for a cut');
  assert.deepEqual(paths(m, MOVES), ['/player/queue/jump', '/player/resume'], 'jumped, then resumed: it plays');
  assert.equal(m.st.curUid, 'u-c2');
  assert.equal(m.st.paused, false);
  await sleep(20);
});

test('jump: never a uid in the log; /player/next never gets a body', async () => {
  const { m, player } = await hosting();
  m.next = ROWS();
  const out = await captured(async () => {
    await player.jump({ uid: 'u-c2' });
    await sleep(30);
    await assert.rejects(player.jump({ uid: 'u-nope' }), (e) => e.code === 'queue_changed');
    await player.next({ uri: T('c2') });
    await sleep(30);
  });
  assert.match(out, /jump -> 200 in \d+ ms/);
  assert.match(out, /jump -> queue_changed in \d+ ms/);
  for (const s of ['u-c2', 'u-nope', T('c2')]) assert.equal(out.includes(s), false, `logged: ${s}`);
  assert.equal(calls(m, /^\/player\/next$/).length, 1, 'only the Next pressed');
  for (const c of calls(m, /^\/player\/next$/)) assert.ok(!c.body || !('uid' in c.body), 'no uid to /player/next');
});

test('player.jump without jam.js (engine-model): the engine\'s queue_ops decide; the jump loads the row', async () => {
  const CTX = 'spotify:playlist:' + 'q'.repeat(22);
  const mk = async (modelOpts) => {
    const model = new EngineModel({ relink: true, ...modelOpts });
    const engine = fakeEngine(model);
    const clock = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-gwq9b.pcm'), { leadMs: 10000 });
    const player = new Player({ engine, clock, bus: { push() {} }, webapi: null, dataDir: tmp('q9p') });
    await player.play({ context_uri: CTX, offset_uri: 'spotify:track:' + 'A'.repeat(22) });
    await sleep(60);
    await engine.refresh();
    model.upNext = ['B', 'C', 'D'].map((x) => ({ uri: 'spotify:track:' + x.repeat(22), uid: 'n-' + x, provider: 'context' }));
    return { model, engine, player };
  };
  const a = await mk({ queueOps: OPS });
  assert.equal(a.player.loaded(), true);
  const r = await a.player.jump({ uid: 'n-C' });
  assert.equal(r.gen, a.player.gen);
  assert.deepEqual(a.model.counts.jumps, [{ uid: 'n-C' }]);
  assert.equal(a.model.track.uri, 'spotify:track:' + 'C'.repeat(22));
  assert.deepEqual(a.model.upNext.map((e) => e.uid), ['n-D']);
  const b = await mk({});
  await assert.rejects(b.player.jump({ uid: 'n-C' }), (e) => e.status === 409 && e.code === 'unsupported');
  assert.deepEqual(b.model.counts.jumps, []);
  await sleep(20);
});

// ---------------------------------------------------------------- the routes (http.js)
test('routes: /v1/player/jump and /admin/api/player/jump (COMMANDS), /v1/jam/queue/top {queue, uid}; a guest\'s jump is 403', async () => {
  const s = await playing();
  s.m.next = ROWS();
  const srv = await wizardServer({ verify: () => ({ id: 'dev_q9', name: 'Test Phone' }),
    ctx: { player: s.player, jam: s.jam, engine: s.engine, encoders: { warmAll() {}, info: () => [], listening: () => 1 } } });
  try {
    let r = await srv.call('/v1/player/queue');
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.ops, OPS);
    r = await srv.call('/v1/jam/queue/top', { method: 'POST', body: { uid: 'u-c3', rev: r.j.rev } });
    assert.equal(r.status, 200);
    assert.equal(r.j.uid, 'q101');
    assert.equal(r.j.queue.q[0].uid, 'q101');
    r = await srv.call('/v1/player/jump', { method: 'POST', body: { uid: 'u-c1', uri: T('c1'), q: 'high' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.j.gen, 'number'); assert.equal(r.j.stream, `/v1/stream?gen=${r.j.gen}`);
    await sleep(30);
    r = await srv.call('/v1/player/jump', { method: 'POST', body: { uid: 'u-nope' } });
    assert.equal(r.status, 409); assert.equal(r.j.error.code, 'queue_changed');
    r = await srv.call('/admin/api/player/jump', { method: 'POST', headers: AUTH, body: { uid: 'u-c2' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.j.gen, 'number');
    assert.deepEqual(calls(s.m, /^\/player\/queue\/jump$/).map((x) => x.body.uid), ['u-c1', 'u-c2']);
    await sleep(30);
  } finally { await srv.close(); }
  const g = await guesting();
  g.m.next = ROWS();
  const gs = await wizardServer({ verify: () => ({ id: 'dev_q9', name: 'Test Phone' }),
    ctx: { player: g.player, jam: g.jam, engine: g.engine, encoders: { warmAll() {}, info: () => [], listening: () => 1 } } });
  try {
    const r = await gs.call('/v1/player/jump', { method: 'POST', body: { uid: 'u-c1' } });
    assert.equal(r.status, 403); assert.equal(r.j.error.code, 'jam_no_control');
    assert.equal(g.m.jumps || 0, 0);
  } finally { await gs.close(); }
});
