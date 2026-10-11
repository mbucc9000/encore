'use strict';
// jam.js + the Jam rules in player.js (DESIGN-4b.md §5, §7.2) against the patch-3 engine model (jam-engine.js),
// whose "Spotify" is scripted: nothing here can create, join or end a real Jam.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PcmClock } = require('../src/pcm');
const { Player } = require('../src/player');
const { Jam, parseSession, shape, mask } = require('../src/jam');
const { JamEngine, fakeJamEngine, session, T, JAM, SOCIAL, ROUTES, PC } = require('./support/jam-engine');
const { tmp, sleep } = require('./support/helpers');

const FAST = { setDebounce: 20, inactiveDebounce: 30, ownConfirmMs: 300, endSettleMs: 400, leaveSettleMs: 60, noSession: 20, connectRead: 20,
  queueDebounce: 10, queueRetry: 50, queueTimeout: 1000, addGapMs: 5, joinGenWaitMs: 150, idleGrace: 30 };

async function setup(o = {}) {
  const m = new JamEngine({ spacingMs: 0, ...o.engine });
  const engine = fakeJamEngine(m);
  const clock = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-gw4b.pcm'), { leadMs: 10000 });
  const pushes = [];
  const bus = { push: (type, data) => pushes.push({ type, data }) };
  const dir = tmp('jam');
  if (o.jamJson) fs.writeFileSync(path.join(dir, 'jam.json'), JSON.stringify(o.jamJson));
  if (o.before) o.before(m);
  const player = new Player({ engine, clock, bus, webapi: o.webapi || null, dataDir: dir });
  const encoders = { n: o.listening == null ? 1 : o.listening, listening() { return this.n; } };
  const jam = new Jam({ cfg: { dataDir: dir, jam: o.flags || {} }, engine, player, bus, webapi: o.webapi || null, encoders, timing: { ...FAST, ...o.timing } });
  clearInterval(jam.ticker);                        // idleTick is driven by the tests
  player.jam = jam;
  if (!o.jamJson) jam.sc = 'sc' in o ? o.sc : 1;
  await engine.refresh();
  return { m, engine, player, jam, pushes, dir, encoders, clock };
}
const evs = (pushes) => pushes.filter((x) => x.type === 'jam' && x.data.ev).map((x) => x.data.ev);
const lastJam = (pushes) => { const j = pushes.filter((x) => x.type === 'jam'); return j.length ? j[j.length - 1].data : null; };
const settle = async (jam, ms = 60) => { await sleep(ms); if (jam.flight) await jam.flight; await sleep(5); };
const calls = (m, re) => m.log.filter((x) => re.test(x.path)).map((x) => x.path);

// a host Jam playing on Encore, session read
async function hosting(o = {}) {
  const s = await setup(o);
  s.m.spotify = session({ members: ['alex', 'jake'], ...o.session });
  s.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  s.m.jamStarts(1);
  await settle(s.jam);
  return s;
}

// a guest in jake's Jam, session read
async function guesting(o = {}) {
  const s = await setup(o);
  s.m.spotify = session({ owner: false, members: ['jake', 'alex', 'emma'], hostId: 'jake', ...o.session });
  s.m.jamStarts(2);
  await settle(s.jam);
  return s;
}

test('parseSession: t1mlange shape, fallbacks, unknown shape -> null + one log line of key names', () => {
  const s = parseSession({ session_id: 'S1', join_session_token: 'tok_1', is_session_owner: false, session_owner_id: 'jake', queue_only_mode: false,
    join_session_url: 'https://spotify.link/abc',
    session_members: [{ username: 'alex', display_name: 'Alex' }, { username: 'jake', display_name: ' ', large_image_url: 'https://i.scdn.co/image/' + 'a'.repeat(40) }, { id: 'x9' }, null] }, 'alex');
  assert.deepEqual(s.members.map((m) => [m.id, m.n, !!m.pic]), [['alex', 'Alex', false], ['jake', 'jake', true], ['x9', 'x9', false]]);
  assert.equal(s.hostId, 'jake'); assert.equal(s.role, 'guest'); assert.equal(s.gc, true); assert.equal(s.share, 'https://spotify.link/abc');
  const h = parseSession({ session_id: 'S2', session_members: [{ username: 'a' }, { username: 'alex', is_host: true }] }, 'alex');
  assert.equal(h.hostId, 'alex', 'flagged member'); assert.equal(h.role, 'host', 'no is_session_owner: me === host'); assert.equal(h.gc, null, 'gc unknown');
  assert.equal(parseSession({ session_id: 'S3', session_members: [{ username: 'z' }], join_session_url: 'https://evil.example/x' }).share, '', 'share links: open.spotify.com/spotify.link only');
  shape.logged = false;
  const out = [];
  const orig = console.warn;
  console.warn = (...a) => out.push(a.join(' '));
  try {
    assert.equal(parseSession({ id: 'x', members: [] }), null);
    assert.equal(parseSession({ other: 1 }), null);
  } finally { console.warn = orig; }
  assert.equal(out.length, 1, 'logged once per process');
  assert.match(out[0], /unexpected session shape: keys id,members$/);
});

test('latch: mode "on" sets it; ev start; one read fills the session; the snapshot carries jam', async () => {
  const { m, jam, pushes, player } = await setup();
  m.spotify = session({ members: ['alex', 'jake'] });
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.st.mode = 'on';
  m.jamEv();
  assert.equal(jam.on, true);
  assert.equal(jam.lim(), true, 'no session yet');
  await settle(jam);
  assert.equal(m.sends('current'), 1, 'one read (debounced 2 s in production)');
  const b = jam.body();
  assert.equal(b.r, 'host'); assert.equal(b.cnt, 2); assert.equal(b.hn, 'Alex'); assert.equal(b.ctl, 1);
  assert.ok(b.l === 'https://open.spotify.com/socialsession/' + b.t && /^u[A-Za-z0-9_-]+$/.test(b.ci));
  assert.equal(Buffer.from(b.ci.slice(1), 'base64url').toString(), 'https://scannables.scdn.co/uri/plain/png/2F9A2B/white/640/spotify%3Asocialsession%3A' + b.t);
  assert.deepEqual(b.m.map((x) => [x.id, x.h || 0, x.me || 0]), [['alex', 1, 1], ['jake', 0, 0]]);
  assert.deepEqual(b.x, { sc: 1, kick: 1, add: 1, code: 1 }, 'kick with the 4b-c remove route; no gc (item 7 unbuilt)');
  assert.deepEqual(evs(pushes), [{ k: 'start' }]);
  await sleep(100);
  assert.deepEqual(player.snapshot().jam, { r: 'host', hn: 'Alex', cnt: 2 });
});

test('latch: social origin + a jam-list with mode "" sets it; without sc: lim, no reads at all; without patch 3: origin + context only', async () => {
  const { m, jam } = await setup({ sc: undefined });
  m.load(T(1), { ctx: JAM(2), origin: SOCIAL });
  m.jamEv();
  assert.equal(jam.on, true);
  await settle(jam, 100);
  jam.watch();
  jam.pollTick();
  await jam.get({ fresh: true });
  jam.engineConnected();
  await settle(jam, 60);
  assert.equal(m.sends(), 0, 'sc unknown: nothing reaches social-connect');
  const b = jam.body();
  assert.equal(b.lim, 1); assert.equal(b.r, undefined); assert.equal(b.ctl, 1); assert.deepEqual(b.x, { add: 1 }, 'lim: the host\'s local add works, nothing else');
  const old = await setup({ engine: { patch3: false } });
  old.m.load(T(1), { ctx: JAM(3), origin: SOCIAL });
  await old.engine.refresh();
  assert.equal(old.jam.on, true, 'set from /status alone');
  assert.equal(old.jam.lim(), true);
  assert.deepEqual(old.jam.body().x, { add: 1 });
  await assert.rejects(old.jam.queue(), (e) => e.status === 404 && e.code === 'not_found', 'Up Next: 404 without patch 3');
  await assert.rejects(old.jam.start(), (e) => e.code === 'jam_unavailable');
  old.m.load(T(2), { origin: 'webapi-' + 'f'.repeat(32), ctx: 'spotify:playlist:' + 'q'.repeat(22) });
  await old.engine.refresh();
  assert.equal(old.jam.on, false, 'origin no longer social: off');
});

test('latch: a Jam\'s end, with item 10 and without (the list replayed from the top), with and without set_options off -> off, and not on again', async () => {
  for (const [item10, setOptionsOff] of [[true, true], [false, true], [true, false]]) {
    const { m, jam, pushes, engine } = await hosting();
    assert.equal(jam.on, true);
    m.jamEnds({ item10, setOptionsOff });
    await settle(jam);
    assert.equal(jam.on, false, `off (item10 ${item10}, set_options ${setOptionsOff})`);
    assert.deepEqual(evs(pushes).slice(-1), [{ k: 'end' }], 'a host: no n');
    // more of the same engine events, and /status: still off
    m.jamEv();
    await engine.refresh();
    m.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: false });
    m.load(T(100), { ctx: item10 ? '' : JAM(1), origin: SOCIAL });
    m.jamEv();
    await engine.refresh();
    await settle(jam);
    assert.equal(jam.on, false, 'not on again');
    assert.equal(evs(pushes).filter((e) => e.k === 'start').length, 1);
    assert.equal(m.sends('end'), 0, 'nothing ended anything');
  }
});

test('latch: the context emptying alone ends it after a short grace; an `inactive` within it -> the away read instead', async () => {
  const { m, jam, pushes } = await guesting();
  m.st.mode = '';
  m.jamEv();
  m.st.ctx = '';
  m.st.stopped = true;
  m.jamEv();
  assert.equal(jam.on, true, 'the grace');
  await settle(jam, 60);
  assert.equal(jam.on, false);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'end', n: 'Jake', id: 'jake' }]);
  const b = await guesting();
  b.m.st.ctx = '';
  b.m.st.stopped = true;
  b.m.st.track = null;
  b.m.jamEv();
  b.m.ev('inactive', {});
  await settle(b.jam, 80);
  assert.equal(b.jam.away, true, 'still in the session: away');
  assert.equal(b.m.sends('current'), 2);
});

test('latch: a guest sees the end: n = the host\'s name; a new Jam afterwards sets it again (mode off -> on, or another jam-list)', async () => {
  const { m, jam, pushes } = await guesting();
  assert.equal(jam.role(), 'guest');
  m.jamEnds({ item10: true });
  await settle(jam);
  assert.equal(jam.on, false);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'end', n: 'Jake', id: 'jake' }]);
  m.setJam('on', SOCIAL, '');
  assert.equal(jam.on, true, 'mode off -> on: a new Jam');
  m.jamEnds({ item10: true });
  assert.equal(jam.on, false);
  m.st.mode = '';
  m.load(T(7), { ctx: JAM(9), origin: SOCIAL });
  m.jamEv();
  assert.equal(jam.on, true, 'another jam-list with a social origin');
});

test('latch: our End with no engine signal at all (mode stays "on", same song) -> off, stays off, also after Alex plays a playlist', async () => {
  const { m, jam, pushes, player } = await hosting({ engine: { routes: ROUTES.filter((r) => r !== 'forget') } });
  const r = await jam.end();
  assert.equal(r.jam.on, undefined);
  assert.deepEqual(Object.keys(r.jam), ['x']);
  assert.ok(r.state && !r.gen, 'the engine kept the song: no play');
  assert.equal(calls(m, /^\/player\/play/).length, 0);
  assert.equal(m.st.mode, 'on', 'no signal (and this engine has no /jam/forget)');
  assert.equal(jam.on, false);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'end' }], 'never n on our own End');
  await player.play({ context_uri: 'spotify:playlist:' + 'z'.repeat(22) });
  await settle(jam);
  assert.equal(jam.on, false, 'a playlist with mode still "on": no new Jam');
  assert.equal(m.sends('end'), 1);
});

test('latch: a read with no session while set -> off; boot hint and jam.json endedCtx', async () => {
  const { m, jam, pushes } = await hosting();
  m.spotify = null;
  jam.watch();
  await settle(jam);
  assert.equal(m.sends('current'), 1, 'the set read only: the lease start read waits for 30 s');
  await jam.get({ fresh: true });
  assert.equal(jam.on, true, 'fresh=1 is skipped: the last read is < 10 s old');
  jam.lastSent = 0;
  await jam.get({ fresh: true });
  assert.equal(jam.on, false, 'no session -> off');
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'end' }]);
  // a boot with jam.json recording the engine's jam-list as ended
  const b = await setup({ jamJson: { sc: 1, endedCtx: JAM(4) }, before: (mm) => { mm.st.mode = 'on'; mm.load(T(1), { ctx: JAM(4), origin: SOCIAL }); } });
  assert.equal(b.jam.on, false, 'that jam-list ended');
  await b.engine.refresh();
  assert.equal(b.jam.on, false);
  // a boot mid-Jam: set from /status, the hint's since kept, the connect read confirms
  const c = await setup({ jamJson: { sc: 1, sid: 'sessX', token: 'tokX', role: 'host', since: 1234 },
    before: (mm) => { mm.st.mode = 'on'; mm.load(T(1), { ctx: JAM(5), origin: SOCIAL }); mm.spotify = session({ sid: 'sessX', token: 'tokX' }); } });
  assert.equal(c.jam.on, true);
  assert.equal(c.jam.since, 1234);
  c.jam.engineConnected();
  await settle(c.jam);
  assert.equal(c.m.sends('current'), 1);
  assert.equal(c.jam.body().r, 'host');
  const saved = JSON.parse(fs.readFileSync(path.join(c.dir, 'jam.json'), 'utf8'));
  assert.equal(saved.sid, 'sessX'); assert.equal(saved.sc, 1);
});

test('reads (fake clock): none without a Jam and a lease for 10 min; a lease reads ≤ 1 per 20 s; pushes change nothing; quiet cap; single-flight', async () => {
  const a = await setup();
  let now = 1e12;
  a.jam.now = () => now;
  for (let i = 0; i < 30; i++) { now += 20000; a.jam.pollTick(); a.jam.idleTick(); }
  await settle(a.jam);
  assert.equal(a.m.sends(), 0, 'no Jam, no lease: nothing');
  const { m, jam } = await hosting();
  jam.now = () => now;
  jam.lastSent = now;
  const n0 = m.sends('current');
  for (let i = 0; i < 12; i++) {
    now += 10000;
    jam.watch();
    jam.pollTick();
    m.ev('social_connect', { uri: 'hm://social-connect/v2/session_update/0123456789abcdef0123', payload: { session: { session_id: 'x' }, reason: 'MEMBER_JOINED' } });
    await settle(jam, 5);
  }
  assert.equal(m.sends('current') - n0, 6, `120 s with a lease: 6 reads (${m.sends('current') - n0}), pushes or not`);
  const d = jam.info().dealer;
  assert.equal(d.n, 12);
  assert.deepEqual(d.uris, [{ uri: 'hm://social-connect/v2/session_update/*', n: 12, keys: 'session,reason' }], 'masked URI + key names only');
  // the quiet cap: 15 calls in 5 min stop quiet triggers, fresh=1 still reads
  jam.callTimes = Array(15).fill(now);
  const n1 = m.sends('current');
  jam.lastSent = 0;
  jam.pollTick();
  assert.equal(await jam.read('poll'), null);
  assert.equal(m.sends('current'), n1, 'quiet triggers dropped');
  await jam.get({ fresh: true });
  assert.equal(m.sends('current'), n1 + 1, 'fresh=1 is not quiet');
  // single flight
  jam.callTimes = [];
  m.delay.current = 50;
  const [r1, r2] = await Promise.all([jam.read('poll'), jam.read('lease')]);
  assert.equal(r1, r2);
  assert.equal(m.sends('current'), n1 + 2, 'one send for two triggers');
});

test('reads (fake clock): the lease poll tapers (20 s for 2 min, 60 s, 120 s from 10 min: 39 in an hour, pushes or not); an event\'s read or a user action starts it over', async () => {
  const { m, jam } = await hosting({ engine: { cap: 1e6 } });   // the model's 5-min cap runs on the real clock
  let now = Date.now() + 1000;                       // after the set read's real time: the gateway's 5-min count rolls on
  jam.now = () => now;
  jam.lastSent = now - 60000;                        // the lease's start read goes
  let n = m.sends('current');
  // k app renewals and interval ticks 20 s apart, from now, each with a push -> the times of the reads they made
  const run = async (k) => {
    const at = [];
    for (let i = 0; i < k; i++) {
      jam.watch();
      jam.pollTick();
      m.ev('social_connect', { uri: 'hm://social-connect/v2/session_update/' + 'f'.repeat(20), payload: { reason: 'MEMBER_JOINED' } });
      await settle(jam, 2);
      if (m.sends('current') > n) { at.push(now); n = m.sends('current'); }
      now += 20000;
    }
    return at;
  };
  const gaps = (at) => at.slice(1).map((t, i) => (t - at[i]) / 1000);
  const rep = (v, k) => Array(k).fill(v);
  const hour = await run(180);
  assert.equal(hour.length, 39, `an hour with the Jam screen open and nothing happening: ${hour.length} reads (< 40)`);
  assert.deepEqual(gaps(hour), [...rep(20, 5), ...rep(60, 8), ...rep(120, 25)], 'the taper; 180 pushes started nothing over');
  assert.equal(jam.info().lease_poll_s, 120);
  assert.equal(jam.info().dealer.n, 180);
  // a user action: a pull to refresh reads, and the taper starts over from it
  await jam.get({ fresh: true });
  assert.equal(m.sends('current'), n + 1, 'fresh=1 read');
  n = m.sends('current');
  const t1 = now;
  let at = await run(36);
  assert.deepEqual(gaps([t1, ...at]), [...rep(20, 5), ...rep(60, 8), 120], 'fresh=1: 20 s again for 2 min, then the same taper');
  // an engine event's read (the events socket reconnected): the same
  jam.engineConnected();
  await settle(jam, 60);
  assert.equal(m.sends('current'), n + 1, 'the connect read');
  assert.equal(jam.reads.connect, 1);
  n = m.sends('current');
  const t2 = now;
  at = await run(7);
  assert.deepEqual(gaps([t2, ...at]), rep(20, 5), 'an event\'s read: 20 s again');
  // a user action that reads nothing (a host's local Add to Jam): the next tick may read at once, 20 s from the last
  await run(30);
  assert.equal(jam.info().lease_poll_s, 120, 'tapered again');
  const last = now - 40000;                          // that run's last read
  assert.equal(jam.lastSent, last);
  await jam.add(T(40));
  assert.equal(jam.info().lease_poll_s, 20, 'Add to Jam: back to 20 s');
  at = await run(3);
  assert.deepEqual(at, [last + 40000, last + 60000, last + 80000], 'a read on the next tick, then every 20 s');
  // the idle safety's timer read, like the lease's own, leaves the taper where it was
  await run(36);
  assert.equal(jam.info().lease_poll_s, 120);
  await jam.read('idle');
  assert.equal(jam.reads.idle, 1);
  assert.equal(jam.info().lease_poll_s, 120, 'the idle safety\'s read: still 120 s');
  assert.ok(!jam.reads.dropped, `nothing reached the quiet cap (${JSON.stringify(jam.reads)})`);
  // a pull to refresh 3 s after a read reads nothing, and is still an action
  const f0 = jam.reads.fresh;
  now += 3000;
  await jam.get({ fresh: true });
  assert.equal(jam.reads.fresh, f0, 'skipped: < 10 s since the last read');
  assert.equal(jam.info().lease_poll_s, 20, 'a pull to refresh, read or not: 20 s again');
});

test('reads: debounces (latch set 2 s, inactive 3 s) collapse their triggers; inactive -> away or ended', async () => {
  const { m, jam, pushes, engine } = await hosting();
  const n0 = m.sends('current');
  // another device took playback: inactive, the session goes on -> away
  m.st.ctx = '';
  m.st.track = null;
  m.st.stopped = true;
  m.st.origin = null;
  m.ev('inactive', {});
  m.ev('inactive', {});
  m.jamEv();
  await engine.refresh();
  assert.equal(jam.on, true, 'waiting for the read');
  await settle(jam, 80);
  assert.equal(m.sends('current') - n0, 1, 'one read for both triggers');
  assert.equal(jam.away, true);
  assert.equal(jam.body().away, 1);
  // the read shows no session any more -> off (ev end)
  m.spotify = null;
  jam.lastSent = 0;
  await jam.get({ fresh: true });
  assert.equal(jam.on, false);
  assert.equal(evs(pushes).slice(-1)[0].k, 'end');
  // the engine reports the Jam again while away -> on, away cleared
  const b = await hosting();
  b.m.st.ctx = '';
  b.m.ev('inactive', {});
  b.m.jamEv();
  await settle(b.jam, 80);
  assert.equal(b.jam.away, true);
  b.m.jamStarts(1);
  assert.equal(b.jam.away, false);
  assert.equal(b.jam.on, true);
});

test('engine restart mid-Jam (a deploy): the events reconnect, a context-less /status -> one read -> away, never ended', async () => {
  const { m, jam, pushes, engine } = await hosting();
  engine.emit('connected');                          // the events socket came back: a restarted engine plays nothing
  m.st.ctx = '';
  m.st.track = null;
  m.st.stopped = true;
  m.st.origin = null;
  m.st.mode = '';
  jam.lastJamEvAt = 0;                               // no `jam` event from a fresh engine: /status decides
  await engine.refresh();
  assert.equal(jam.on, true, 'not ended: waiting for the read');
  await settle(jam, 80);
  assert.equal(jam.away, true);
  assert.equal(evs(pushes).filter((e) => e.k === 'end').length, 0);
  assert.ok(m.sends('current') >= 2, 'the connect read and/or the away read');
});

test('ev: in (host only) / out / kicked from reads; one ev per apply', async () => {
  const { m, jam, pushes } = await hosting();
  m.spotify.session_members.push({ username: 'emma', display_name: 'Emma' }, { username: 'liam', display_name: 'Liam' });
  jam.lastSent = 0;
  await jam.get({ fresh: true });
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'in', n: 'Emma', id: 'emma' }], 'the first difference only');
  m.spotify.session_members = m.spotify.session_members.filter((x) => x.username !== 'jake');
  jam.lastSent = 0;
  await jam.get({ fresh: true });
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'out', n: 'Jake', id: 'jake' }]);
  const g = await guesting();
  g.m.spotify.session_members.push({ username: 'noah' });
  g.jam.lastSent = 0;
  await g.jam.get({ fresh: true });
  assert.equal(evs(g.pushes).filter((e) => e.k === 'in').length, 0, 'a guest gets no ev in');
  // (social-connect's `current` would rather show no session; a push or another read path may show the session without us)
  g.m.answer.current = () => ({ status: 200, json: { ...g.m.spotify, session_members: g.m.spotify.session_members.filter((x) => x.username !== 'alex') } });
  g.jam.lastSent = 0;
  await g.jam.get({ fresh: true });
  assert.deepEqual(evs(g.pushes).slice(-1), [{ k: 'kicked', n: 'Jake', id: 'jake' }]);
  assert.equal(g.jam.on, false);
});

test('attribution: value match, spotify:user: form, byKey learned + persisted, ownAdds, the unknown-member read ≤ 1 per 60 s', async () => {
  const { m, jam, dir, player } = await hosting();
  let now = Date.now();
  jam.now = () => now;
  m.next = [
    { uri: T(10), uid: 'u10', provider: 'queue', metadata: { added_by: 'spotify:user:jake' }, track: require('./support/jam-engine').track(T(10)) },
    { uri: T(11), uid: 'u11', provider: 'queue', metadata: { something: 'jake', other: 'x' }, track: require('./support/jam-engine').track(T(11)) },
    { uri: T(12), uid: 'u12', provider: 'context', metadata: {}, track: null },
    { uri: T(13), uid: 'u13', provider: 'autoplay', metadata: { 'autoplay.is_autoplay': 'true' }, track: require('./support/jam-engine').track(T(13)) },
  ];
  m.curMeta = { added_by: 'spotify:user:alex' };
  const q = (await jam.queue()).obj;
  assert.equal(q.now.by, 'alex');
  assert.deepEqual(q.q.map((r) => [r.u, r.uid, r.by]), [[T(10), 'u10', 'jake'], [T(11), 'u11', 'jake']]);
  assert.deepEqual(q.cq, [{ u: T(12), uid: 'u12', x: 1 }], 'no metadata yet: u + uid + x only');
  assert.equal(q.ap.length, 1); assert.equal(q.ap[0].by, undefined);
  assert.equal(q.retry_ms, 50); assert.equal(q.jam, 1);
  assert.deepEqual(q.ctx, { n: 'Alex’s Jam', u: JAM(1) });
  assert.ok(q.q[0].n && q.q[0].a && q.q[0].i && q.q[0].d, 'TR keys');
  assert.equal(jam.byKey, 'added_by');
  await sleep(30);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'jam.json'), 'utf8')).byKey, 'added_by', 'persisted');
  await sleep(100);
  assert.equal(player.snapshot().track.by, 'alex', 'track.by for the playing song');
  // our own add with nothing in its metadata: by = me
  await jam.add(T(20));
  assert.equal(calls(m, /^\/player\/add_to_queue/).length, 1, 'hostAdd local: the engine queue');
  const q2 = (await jam.queue()).obj;
  assert.equal(q2.q[0].u, T(20)); assert.equal(q2.q[0].by, 'alex');
  // a spotify:user: that isn't a member: one read, then none for 60 s, and none again for the same value
  m.next.push({ uri: T(30), uid: 'u30', provider: 'queue', metadata: { added_by: 'spotify:user:zoe' }, track: require('./support/jam-engine').track(T(30)) });
  const n0 = m.sends('current');
  await jam.queue();
  await settle(jam, 10);
  await jam.queue();
  now += 30000;
  await jam.queue();
  await settle(jam, 10);
  assert.equal(m.sends('current') - n0, 1);
  now += 31000;
  await jam.queue();
  await settle(jam, 10);
  assert.equal(m.sends('current') - n0, 1, 'the same unknown value (an ex-member\'s add): no second read');
  // another unknown value: one more read, ≥ 60 s after the last
  m.next.push({ uri: T(31), uid: 'u31', provider: 'queue', metadata: { added_by: 'spotify:user:liam' }, track: require('./support/jam-engine').track(T(31)) });
  await jam.queue();
  await settle(jam, 10);
  assert.equal(m.sends('current') - n0, 2);
  now += 61000;
  for (let i = 0; i < 3; i++) { await jam.queue(); await settle(jam, 5); now += 61000; }
  assert.equal(m.sends('current') - n0, 2, 'each value read once per Jam');
});

test('start: not_active, jam_elsewhere from the pre-check (no start sent), a not-owner session, then a start; jam_active', async () => {
  const { m, jam, pushes } = await setup();
  await assert.rejects(jam.start(), (e) => e.status === 409 && e.code === 'not_active');
  assert.equal(m.sends(), 0);
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.spotify = session({ members: ['alex'], hostDev: PC });     // a Jam Alex hosts on his PC (one hosted by Encore itself is activated: jam-wait.test.js W3)
  await assert.rejects(jam.start(), (e) => e.status === 409 && e.code === 'jam_elsewhere');
  assert.equal(m.sends('start'), 0, 'nothing created');
  m.spotify = null;
  m.answer.start = () => ({ status: 200, json: session({ owner: false, members: ['jake', 'alex'], hostId: 'jake' }) });
  await assert.rejects(jam.start(), (e) => e.code === 'jam_elsewhere');
  assert.equal(jam.on, false, 'changed nothing');
  delete m.answer.start;
  const n0 = m.sends('current');
  const r = await jam.start();
  assert.equal(m.sends('current'), n0, 'the pre-check is skipped right after a read that showed no session');
  assert.equal(r.jam.r, 'host'); assert.equal(r.jam.on, 1); assert.equal(r.jam.cnt, 1);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'start' }]);
  await assert.rejects(jam.start(), (e) => e.status === 409 && e.code === 'jam_active' && e.r === 'host');
  m.jamStarts(1);
  assert.equal(evs(pushes).filter((e) => e.k === 'start').length, 1, 'the engine confirming makes no second ev start');
  await sleep(30);
  assert.equal(JSON.parse(fs.readFileSync(jam.file, 'utf8')).okStart, 1);
});

test('start: Spotify never sends the Jam to Encore -> exactly one read and never an End: wait (session there) or off + notice', async () => {
  const a = await setup();
  a.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  await a.jam.start();
  const n0 = a.m.sends('current');
  await sleep(450);
  await settle(a.jam);
  assert.equal(a.m.sends('current') - n0, 1);
  assert.equal(a.jam.wait, true);
  assert.equal(a.jam.body().wait, 1);
  assert.equal(a.m.sends('end'), 0);
  a.m.jamStarts(1);
  assert.equal(a.jam.wait, false, 'the engine confirms later: wait cleared');
  const b = await setup();
  b.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  await b.jam.start();
  b.m.spotify = null;
  await sleep(450);
  await settle(b.jam);
  assert.equal(b.jam.on, false);
  assert.ok(b.pushes.some((x) => x.type === 'notice' && x.data.code === 'jam_not_started' && x.data.message === 'Spotify didn’t start the Jam.'));
  assert.equal(b.m.sends('end'), 0);
});

test('join: info then join back to back through the gate (≥ 1 s apart); the Jam\'s audio = gen; same token; info cache; no delay 0', async () => {
  const { m, jam, player, pushes } = await setup({ engine: { spacingMs: 1000 } });
  player.connectDelay = () => 7000;                // what syncConnect sends: no Jam code ever sets 0
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  await sleep(20);
  m.spotify = session({ owner: true, members: ['jake', 'emma'], hostId: 'jake', token: 'jakeTok_123' });
  const orig = m.spotifyAnswer.bind(m);
  m.spotifyAnswer = async (op, a) => {
    const r = await orig(op, a);
    if (op === 'join' && r.status === 200) setTimeout(() => { m.guestSkip(T(50)); m.st.ctx = JAM(7); m.jamEv(); }, 30);   // social-connect's transfer
    return r;
  };
  const g0 = player.gen;
  const r = await jam.join({ link: 'https://open.spotify.com/socialsession/jakeTok_123?si=abc' });
  const [ci, cj] = m.calls.filter((c) => c.op === 'info' || c.op === 'join');
  assert.equal(ci.op, 'info'); assert.equal(cj.op, 'join');
  assert.ok(cj.t - ci.t >= 990, `the gate spaced them (${cj.t - ci.t} ms)`);
  assert.equal(r.jam.r, 'guest'); assert.equal(r.jam.hn, 'Jake'); assert.equal(r.jam.cnt, 3);
  assert.ok(r.gen > g0 && r.gen === player.gen, 'the generation the Jam\'s audio started in');
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'join', n: 'Jake', id: 'jake' }]);
  assert.equal(jam.on, true);
  assert.ok((m.delays || []).length > 0 && m.delays.every((d) => d === 7000), `a guest keeps syncConnect: no output_delay 0 (${m.delays})`);
  const n = m.sends();
  const r2 = await jam.join({ link: 'spotify:socialsession:jakeTok_123' });
  assert.equal(r2.jam.r, 'guest');
  assert.equal(m.sends(), n, 'the same Jam: nothing sent');
  // info cache: a failed join, then again within 60 s: no second info
  const b = await setup();
  b.m.spotify = session({ members: ['jake'], hostId: 'jake', token: 'tokB_1234' });
  b.m.answer.join = () => ({ status: 403 });
  await assert.rejects(b.jam.join({ link: 'tokB_1234' }), (e) => e.status === 403 && e.code === 'jam_refused' && /full/.test(e.message));
  assert.equal(b.jam.scNow(), 1, 'a join\'s 403 doesn\'t flip sc');
  delete b.m.answer.join;
  await b.jam.join({ link: 'tokB_1234' });
  assert.equal(b.m.sends('info'), 1, 'info from the cache');
  assert.equal(b.m.sends('join'), 2);
});

test('join: replace as host (End first, no restart) and as a guest of another Jam (Leave first); bad links; jam_not_found; the 50 s deadline', async () => {
  const h = await hosting();
  h.m.answer.info = () => ({ status: 200, json: session({ sid: 'sOther', token: 'other_tok1', members: ['liam'], hostId: 'liam' }) });
  h.m.answer.join = () => ({ status: 200, json: session({ sid: 'sOther', token: 'other_tok1', owner: false, members: ['liam', 'alex'], hostId: 'liam' }) });
  await assert.rejects(h.jam.join({ link: 'other_tok1' }), (e) => e.status === 409 && e.code === 'jam_active' && e.r === 'host');
  const r = await h.jam.join({ link: 'other_tok1', replace: true });
  assert.equal(h.m.sends('end'), 1);
  assert.equal(calls(h.m, /^\/player\/play/).length, 0, 'no song restart');
  assert.equal(r.jam.r, 'guest'); assert.equal(r.jam.hn, 'Liam');
  const g = await guesting();
  g.m.answer.info = h.m.answer.info;
  g.m.answer.join = h.m.answer.join;
  await g.jam.join({ link: 'other_tok1' });
  assert.equal(g.m.sends('leave'), 1, 'a guest of another Jam leaves first');
  assert.equal(g.jam.body().hn, 'Liam');
  const s = await setup();
  await assert.rejects(s.jam.join({ link: 'https://open.spotify.com/track/abc' }), (e) => e.status === 400 && e.code === 'bad_link');
  await assert.rejects(s.jam.join({ link: 'nosuchtoken9' }), (e) => e.status === 404 && e.code === 'jam_not_found');
  const d = await setup({ timing: { actionDeadlineMs: 2500, engineCallMs: 2000 } });
  d.m.spotify = session({ members: ['jake'], token: 'slow_tok1' });
  d.m.delay.info = 1700;
  await assert.rejects(d.jam.join({ link: 'slow_tok1' }), (e) => e.status === 502 && e.code === 'spotify_error');
  assert.equal(d.m.sends('join'), 0, 'the deadline cut the chain before join');
});

test('leave: a Spotify 404 is success; the local pause after 3 s; /jam/forget only while the mode is still "on"; is_host / not_in_jam', async () => {
  const { m, jam, pushes } = await guesting();
  m.answer.leave = () => ({ status: 404 });
  const r = await jam.leave({});
  assert.deepEqual(Object.keys(r.jam), ['x']);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'leave' }]);
  await sleep(150);
  await jam.lock;
  assert.equal(calls(m, /^\/player\/pause/).length, 1, 'still playing the Jam: paused locally');
  assert.equal(calls(m, /^\/jam\/forget/).length, 1, 'the mode was still "on"');
  assert.equal(m.st.mode, 'off');
  await assert.rejects(jam.leave({}), (e) => e.status === 409 && e.code === 'not_in_jam');
  const b = await guesting();
  b.m.st.mode = '';
  await b.jam.leave({});
  await sleep(150);
  await b.jam.lock;
  assert.equal(calls(b.m, /^\/jam\/forget/).length, 0, 'mode not "on": no forget');
  const h = await hosting();
  await assert.rejects(h.jam.leave({}), (e) => e.status === 409 && e.code === 'is_host' && e.message === 'End the Jam instead.');
});

test('end: idle after item 10 -> one play at the listener position, then the q and cq rows re-added (≤ 20); paused -> loadPaused; not_host', async () => {
  const { m, jam, player, pushes } = await hosting();
  const tr = require('./support/jam-engine').track;
  m.next = [
    ...Array.from({ length: 3 }, (_, i) => ({ uri: T('q' + i), uid: 'q' + i, provider: 'queue', metadata: {}, track: tr(T('q' + i)) })),
    ...Array.from({ length: 25 }, (_, i) => ({ uri: T('c' + i), uid: 'c' + i, provider: 'context', metadata: {}, track: tr(T('c' + i)) })),
    { uri: T('ap'), uid: 'ap', provider: 'autoplay', metadata: {}, track: tr(T('ap')) },
  ];
  m.answer.end = () => { setTimeout(() => m.jamEnds({ item10: true }), 30); return { status: 200, json: {} }; };
  const g0 = player.gen;
  const r = await jam.end();
  assert.ok(r.gen > g0, 'restarted: a generation');
  const plays = m.log.filter((x) => x.path === '/player/play');
  assert.equal(plays.length, 1, '1 track load');
  assert.equal(plays[0].body.uri, T(100), 'the song the Jam was on');
  assert.ok(Number.isFinite(plays[0].body.position || 0));
  const adds = m.log.filter((x) => x.path === '/player/add_to_queue').map((x) => x.body.uri);
  assert.deepEqual(adds, [T('q0'), T('q1'), T('q2'), ...Array.from({ length: 17 }, (_, i) => T('c' + i))], 'q, then cq, 20 at most, no autoplay');
  assert.deepEqual(evs(pushes).filter((e) => e.k === 'end'), [{ k: 'end' }], 'never n');
  // paused when ended: loadPaused, no generation
  const p = await hosting();
  await p.player.pause({});
  await sleep(20);
  p.m.answer.end = () => { setTimeout(() => p.m.jamEnds({ item10: true }), 30); return { status: 200, json: {} }; };
  const gp = p.player.gen;
  const rp = await p.jam.end();
  assert.equal(rp.gen, undefined);
  assert.equal(p.player.gen, gp);
  const pp = p.m.log.filter((x) => x.path === '/player/play');
  assert.equal(pp.length, 1); assert.equal(pp[0].body.paused, true);
  const g = await guesting();
  await assert.rejects(g.jam.end(), (e) => e.status === 409 && e.code === 'not_host');
});

test('errors: a 401 anywhere and a 403 on current flip sc to 0; a 403 on the first-ever start too, not on a later one; Spotify 404 vs a missing route', async () => {
  const a = await setup();
  a.m.spotify = session({ members: ['jake'], token: 'tok401_1' });
  a.m.answer.info = () => ({ status: 401 });
  await assert.rejects(a.jam.join({ link: 'tok401_1' }), (e) => e.status === 403 && e.code === 'jam_refused');
  assert.equal(a.jam.scNow(), 0);
  assert.equal(a.m.sends('info'), 2, 'one renewal, 2 sends, never more');
  assert.equal(a.jam.body().x.sc, undefined);
  await assert.rejects(a.jam.start(), (e) => e.code === 'jam_unavailable');
  let now = Date.now() + 31 * 60000;
  a.jam.now = () => now;
  assert.equal(a.jam.scNow(), undefined, 'unknown again after 30 min');
  const b = await hosting();
  b.m.answer.current = () => ({ status: 403 });
  b.jam.lastSent = 0;
  await b.jam.get({ fresh: true });
  assert.equal(b.jam.scNow(), 0);
  assert.equal(b.jam.lim(), true, 'refused: lim while the engine plays the Jam');
  const c = await setup();
  c.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  c.m.answer.start = () => ({ status: 403 });
  await assert.rejects(c.jam.start(), (e) => e.status === 403 && e.code === 'jam_refused');
  assert.equal(c.jam.scNow(), 0, 'first-ever start');
  const d = await setup();
  d.jam.okStart = true;
  d.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  d.m.answer.start = () => ({ status: 403 });
  await assert.rejects(d.jam.start(), (e) => e.code === 'jam_refused');
  assert.equal(d.jam.scNow(), 1, 'a later start: sc unchanged');
  // settings: not listed in jam_routes -> unsupported, never called; listed but missing in the engine -> jam_unavailable
  const h = await hosting();
  await assert.rejects(h.jam.settings({ gc: true }), (e) => e.status === 409 && e.code === 'unsupported');
  assert.equal(calls(h.m, /^\/jam\/settings/).length, 0);
  const k = await hosting({ engine: { serve: ROUTES.filter((x) => x !== 'remove') } });
  assert.equal(k.jam.body().x.kick, 1);
  await assert.rejects(k.jam.remove({ id: 'jake' }), (e) => e.status === 503 && e.code === 'jam_unavailable', 'a 404 without X-Upstream-Status: the route is missing');
  await assert.rejects(k.jam.remove({ id: 'nobody' }), (e) => e.status === 404 && e.code === 'not_found');
  // the engine gate's 429: rate_limited with retry_after, quiet triggers held
  const r = await hosting();
  r.m.answer.current = () => ({ status: 429, retryAfter: 90 });
  r.jam.lastSent = 0;
  await r.jam.get({ fresh: true });
  assert.ok(r.jam.holdUntil > Date.now() + 80000);
  assert.equal(await r.jam.read('poll'), null, 'quiet triggers wait');
});

test('L0 check: accepted / refused / inconclusive ({}, not_found, a shape it can\'t read, no routes)', async () => {
  const a = await setup({ sc: undefined });
  a.m.spotify = session({ members: ['alex'] });
  let v = await a.jam.check();
  assert.equal(v.verdict, 'accepted'); assert.equal(a.jam.scNow(), 1);
  const b = await setup({ sc: undefined });
  b.m.answer.current = () => ({ status: 403 });
  v = await b.jam.check();
  assert.equal(v.verdict, 'refused'); assert.equal(b.jam.scNow(), 0);
  const c = await setup({ sc: undefined });
  v = await c.jam.check();
  assert.equal(v.verdict, 'inconclusive'); assert.equal(c.jam.scNow(), undefined, '{}: no session although a Jam is on');
  c.m.answer.current = () => ({ status: 404 });
  v = await c.jam.check();
  assert.equal(v.verdict, 'inconclusive'); assert.match(v.reason, /404/);
  c.m.answer.current = () => ({ status: 200, json: { sessionId: 'x', members: [] } });
  shape.logged = false;
  v = await c.jam.check();
  assert.equal(v.verdict, 'inconclusive'); assert.equal(c.jam.scNow(), undefined);
  const d = await setup({ sc: undefined, engine: { patch3: false } });
  v = await d.jam.check();
  assert.equal(v.verdict, 'inconclusive'); assert.equal(d.m.sends(), 0);
  // after L0, {"not_found":true} means no session
  const e = await hosting();
  e.m.answer.current = () => ({ status: 404 });
  e.jam.lastSent = 0;
  await e.jam.get({ fresh: true });
  assert.equal(e.jam.on, false);
});

test('player in a Jam: pause never steps back (no alignTo), seeks only within the song and only when it was playing; rememberOwn; jam_moved', async () => {
  const { m, jam, player } = await hosting();
  player.prevTrack = { uri: T(99), name: 'Prev', duration_ms: 200000 };
  player.noteTrack(player.prevTrack);
  await player.pause({ played_ms: 199000, uri: T(99) });
  assert.deepEqual(calls(m, /^\/player\/(seek|prev)/), [], 'the phone is on the previous song: no step back, no seek');
  await player.resume().catch(() => {});
  m.st.paused = false;
  player.st.status = 'playing';
  await player.pause({ played_ms: 5000, uri: player.st.track.uri });
  assert.deepEqual(calls(m, /^\/player\/seek/), ['/player/seek'], 'the same song, playing: seek');
  await sleep(20);
  await player.pause({ played_ms: 4000, uri: player.st.track.uri });
  assert.equal(calls(m, /^\/player\/seek/).length, 1, 'already paused: no seek');
  player.st.context_uri = JAM(1);
  player.rememberOwn();
  assert.equal(player.lastOwn.context_uri, null, 'a jam-list is kept as the song alone');
  // away: takeOver only by the Web API transfer; without it 409 jam_moved, never last.json
  m.st.ctx = '';
  m.st.track = null;
  m.st.stopped = true;
  m.ev('inactive', {});
  m.jamEv();
  await settle(jam, 80);
  assert.equal(jam.away, true);
  player.lastOwn = { uri: T(1), context_uri: null, position: 0 };
  const plays = calls(m, /^\/player\/play/).length;
  await assert.rejects(player.resume(), (e) => e.status === 409 && e.code === 'jam_moved' && /another device/.test(e.message));
  assert.equal(calls(m, /^\/player\/play/).length, plays, 'never last.json');
});

test('rules 2 and 3: only moving commands open the 2 s window (not set_options, a continuing transfer, or one while ours runs); a skip command makes a skip at a song\'s end', async () => {
  const { m, player } = await hosting();
  player.lastMovingCmd = 0;
  m.ev('command', { endpoint: 'set_options', from: SOCIAL });
  m.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: true });
  m.ev('command', { endpoint: 'add_to_queue', from: SOCIAL });
  assert.equal(player.lastMovingCmd, 0);
  player.pending = { gen: 99 };
  m.ev('command', { endpoint: 'skip_next', from: SOCIAL });
  player.pending = null;
  assert.equal(player.lastMovingCmd, 0, 'while ours runs');
  m.ev('command', { endpoint: 'seek_to', from: SOCIAL });
  assert.ok(Date.now() - player.lastMovingCmd < 100);
  // a guest's seek right after one of our commands: foreign (a generation), not an echo of ours
  player.ownUntil = Date.now() + 2500;
  const g0 = player.gen;
  m.ev('seek', { position: 60000 });
  assert.equal(player.gen, g0 + 1);
  // rule 3: at the old song's end, a skip command 5 s before the metadata still makes a skip
  const orig = player.posNow.bind(player);
  player.posNow = () => 198500;
  player.lastMetaAt = Date.now() - 20000;
  player.lastSkipCmd = Date.now() - 5000;
  const g1 = player.gen;
  m.load(T(60));
  assert.equal(player.gen, g1 + 1, 'a skip');
  player.lastSkipCmd = 0;
  player.lastMovingCmd = 0;
  m.load(T(61));
  assert.equal(player.gen, g1 + 1, 'no command: the song simply ended');
  player.posNow = orig;
});

test('guest guard: transport 403 jam_no_control, play 409 in_jam, pause a no-op, adds allowed; gc + guestTransport gives control', async () => {
  const { jam } = await guesting();
  for (const c of ['next', 'prev', 'seek', 'shuffle', 'repeat', 'resume']) {
    assert.throws(() => jam.guard(c), (e) => e.status === 403 && e.code === 'jam_no_control' && e.message === 'Only Jake can control the Jam’s playback. You can still add songs.');
  }
  assert.throws(() => jam.guard('play'), (e) => e.status === 409 && e.code === 'in_jam' && e.message === 'Leave Jake’s Jam to play something else.');
  assert.equal(jam.guard('pause'), 'noop');
  assert.equal(jam.guard('queue'), null);
  assert.equal(jam.body().ctl, undefined);
  await assert.rejects(jam.add(T(5)), (e) => e.status === 409 && e.code === 'unsupported', 'no /jam/queue route (before D2)');
  const g = await guesting({ session: { gc: true }, flags: { guestTransport: true } });
  assert.equal(g.jam.body().ctl, 1);
  assert.equal(g.jam.guard('next'), null);
  const h = await hosting();
  assert.equal(h.jam.guard('next'), null);
});

test('rule 10: an audio-key refusal storm as a guest leaves the Jam first (why refusing), then pauses; as host: pause + the Jam notice', async () => {
  const { m, jam, player, pushes } = await guesting();
  for (let i = 0; i < 4; i++) m.ev('playback_error', { message: 'failed getting audio key', kind: 'key' });
  await sleep(50);
  await jam.lock;
  const order = m.log.filter((x) => x.path === '/jam/leave' || x.path === '/player/pause').map((x) => x.path);
  assert.deepEqual(order.slice(0, 2), ['/jam/leave', '/player/pause']);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'leave', why: 'refusing' }]);
  assert.ok(player.keyHoldUntil > Date.now());
  const h = await hosting();
  for (let i = 0; i < 4; i++) h.m.ev('playback_error', { message: 'audio key error', kind: 'key' });
  await sleep(20);
  assert.equal(h.m.sends('leave') + h.m.sends('end'), 0);
  assert.ok(h.pushes.some((x) => x.type === 'notice' && /so the Jam is paused/.test(x.data.message)));
});

test('rule 14: hostJump "cut": next, prev, seek while hosting make no engine pause and exactly one generation; "pause" keeps today\'s sequence', async () => {
  const { m, jam, player } = await hosting({ flags: { hostJump: 'cut' } });
  for (const [cmd, args, path0] of [['next', {}, '/player/next'], ['seek', { position_ms: 30000 }, '/player/seek'], ['prev', { played_ms: 1000 }, '/player/prev']]) {
    m.log = [];
    const g0 = player.gen;
    const r = await player[cmd](args);
    assert.equal(player.gen, g0 + 1, `${cmd}: one generation`);
    assert.equal(r.gen, player.gen);
    assert.equal(calls(m, /^\/player\/(pause|resume)/).length, 0, `${cmd}: no pause/resume around it`);
    assert.ok(calls(m, /^\/player\//).includes(path0));
    await sleep(20);
  }
  jam.setFlags({ hostJump: 'pause' });
  m.log = [];
  const g0 = player.gen;
  await player.next({});
  await sleep(30);
  assert.deepEqual(calls(m, /^\/player\/(pause|next|resume)/), ['/player/pause', '/player/next', '/player/pause', '/player/resume'], 'today\'s exact boundary (0.8.1: next re-pauses, then seeks 0, after the metadata)');
  assert.equal(player.gen, g0 + 1);
});

test('idle safety (fake clock): guest -> one Leave at 10 min; host alone -> one read, then a pause; host with members -> re-check at 40 min, pause at 3 h; listeners reset', async () => {
  const g = await guesting({ listening: 0 });
  let now = Date.now();
  g.jam.now = () => now;
  g.player.st.status = 'playing';
  const tick = async (min) => { now += min * 60000; g.jam.idleTick(); await settle(g.jam, 10); };
  await tick(0);
  await tick(9);
  assert.equal(g.m.sends('leave'), 0);
  await tick(1.1);
  await g.jam.lock;
  assert.equal(g.m.sends('leave'), 1);
  assert.deepEqual(evs(g.pushes).slice(-1), [{ k: 'leave', why: 'idle' }]);
  // host alone
  const a = await hosting({ listening: 0, session: { members: ['alex'] } });
  let t = Date.now();
  a.jam.now = () => t;
  a.player.st.status = 'playing';
  a.jam.idleTick();
  t += 10 * 60000 + 1000;
  a.jam.idleTick();
  await settle(a.jam, 30);
  assert.equal(a.jam.reads.idle, 1);
  assert.equal(calls(a.m, /^\/player\/pause/).length, 1);
  assert.ok(a.pushes.some((x) => x.type === 'notice' && x.data.message === 'Nobody was listening to your Jam on Encore, so it’s paused.'));
  // host with members: no pause, a re-check at 40 min, a pause at 3 h; a listener resets the timers
  const b = await hosting({ listening: 0 });
  let u = Date.now();
  b.jam.now = () => u;
  b.player.st.status = 'playing';
  const step = async (min) => { u += min * 60000; b.jam.idleTick(); await settle(b.jam, 15); };
  await step(0);
  await step(10.1);
  assert.equal(b.jam.reads.idle, 1);
  assert.equal(calls(b.m, /^\/player\/pause/).length, 0, 'others are in the Jam: carry on');
  await step(20);
  assert.equal(b.jam.reads.idle, 1);
  await step(10.1);
  assert.equal(b.jam.reads.idle, 2, 're-check at 40 min');
  b.encoders.n = 1;
  await step(1);
  assert.equal(b.jam.idle, null, 'a listener resets');
  b.encoders.n = 0;
  await step(0);
  for (let i = 0; i < 18; i++) await step(10);
  assert.ok(b.jam.reads.idle >= 6);
  assert.equal(calls(b.m, /^\/player\/pause/).length, 1, 'the 3 h cap pauses');
  assert.equal(b.m.sends('end') + b.m.sends('leave'), 0, 'never an End');
});

test('fake Jam: x overrides, writes change only the fake, never the engine\'s /jam/*; ev in on a lease; flags in memory only', async () => {
  const { m, jam, pushes, dir, player } = await setup();
  jam.setFake({ role: 'host', members: 12 });
  let b = jam.body();
  assert.equal(b.fake, 1); assert.equal(b.r, 'host'); assert.equal(b.cnt, 12); assert.equal(b.ci, undefined); assert.deepEqual(b.x, { sc: 1, gc: 1, kick: 1, add: 1 });
  assert.equal(b.m.find((x) => x.me).n, 'You', 'no Web API account: "You", never a fixed name (1.1.0)');
  assert.equal(b.hn, 'You');
  assert.equal(jam.real(), false);
  assert.equal(jam.guard('next'), null);
  await sleep(100);
  assert.equal(player.snapshot().jam.cnt, 12);
  await jam.settings({ gc: true });
  assert.equal(jam.body().gc, 1);
  await jam.remove({ id: b.m[3].id });
  assert.equal(jam.body().cnt, 11);
  await jam.add(T(3));
  jam.leaseUntil = 0;
  let now = Date.now();
  jam.now = () => now;
  jam.watch();
  now += 21000;
  jam.leaseUntil = now + 25000;
  jam.pollTick();
  assert.equal(evs(pushes).slice(-1)[0].k, 'in');
  await jam.end();
  assert.equal(jam.body().on, undefined);
  jam.setFake({ role: 'guest', members: 4, x: { add: 0 }, wait: 1 });
  b = jam.body();
  assert.equal(b.r, 'guest'); assert.equal(b.wait, 1); assert.equal(b.x.add, undefined); assert.equal(b.ctl, undefined);
  await assert.rejects(jam.add(T(4)), (e) => e.code === 'unsupported');
  await jam.leave({});
  jam.setFake({ role: 'guest', members: 2, away: 1 });
  assert.equal(jam.body().away, 1);
  jam.setFake({ role: null });
  assert.equal(calls(m, /^\/jam\//).length, 0, 'never the engine\'s /jam/*');
  assert.equal(m.sends(), 0);
  // flags
  assert.throws(() => jam.setFlags({ hostAdd: 'nope' }), (e) => e.status === 400);
  jam.setFlags({ hostAdd: 'off', guestTransport: true, hostJump: 'cut' });
  // (DESIGN-JAM-WAIT G0 added startBroadcast and endBroadcastOff, DESIGN-JAM-SELF G0 selfJam, all on by default)
  assert.deepEqual(jam.flags, { hostAdd: 'off', guestTransport: true, hostJump: 'cut', jamEdit: true, selfJam: true, startBroadcast: true, endBroadcastOff: true });
  const again = new Jam({ cfg: { dataDir: dir, jam: {} }, engine: null, player, bus: { push() {} }, encoders: { listening: () => 0 } });
  clearInterval(again.ticker);
  assert.deepEqual(again.flags, { hostAdd: 'local', guestTransport: false, hostJump: 'pause', jamEdit: true, selfJam: true, startBroadcast: true, endBroadcastOff: true }, 'not persisted');
});

test('Up Next outside a Jam: sections, context name, no by; Add to Jam mechanisms (hostAdd off / webapi)', async () => {
  const { m, jam } = await setup();
  const tr = require('./support/jam-engine').track;
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.st.ctxName = 'Road Trip';
  m.next = [{ uri: T(2), uid: 'a', provider: 'queue', metadata: { added_by: 'spotify:user:jake' }, track: tr(T(2)) }, { uri: T(3), uid: 'b', provider: 'context', metadata: {}, track: tr(T(3)) }];
  const q = (await jam.queue()).obj;
  assert.equal(q.jam, undefined); assert.deepEqual(q.ctx, { n: 'Road Trip', u: 'spotify:playlist:' + 'p'.repeat(22) });
  assert.equal(q.q[0].by, undefined); assert.equal(q.retry_ms, undefined);
  const etag = (await jam.queue()).etag;
  assert.equal((await jam.queue()).etag, etag, 'the same content: the same ETag');
  const calls0 = [];
  const webapi = { ready: true, user: { id: 'alex' }, api: async (...a) => { calls0.push(a); return null; } };
  const h = await hosting({ webapi, flags: { hostAdd: 'webapi' } });
  await h.jam.add(T(8));
  assert.equal(calls0.length, 1);
  assert.match(calls0[0][1], /^\/me\/player\/queue\?uri=spotify%3Atrack%3A[0-9A-Za-z]{22}&device_id=encoredev0001$/);
  h.jam.setFlags({ hostAdd: 'off' });
  assert.equal(h.jam.body().x.add, undefined);
  await assert.rejects(h.jam.add(T(9)), (e) => e.status === 409 && e.code === 'unsupported');
});

// ---------------------------------------------------------------- review fixes (2026-10-06)
test('refusals: wait or away that no read can confirm any more -> off (sc 0); a no-session admin Check clears a wait too', async () => {
  // wait, then End answered 401 (after the one renewal): sc 0 and off, not a Jam "on" until a restart
  const a = await setup();
  a.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  await a.jam.start();
  await sleep(450);
  await settle(a.jam);
  assert.equal(a.jam.wait, true);
  a.m.answer.end = () => ({ status: 401 });
  await assert.rejects(a.jam.end(), (e) => e.status === 403 && e.code === 'jam_refused');
  assert.equal(a.m.sends('end'), 2, 'one renewal, never more');
  assert.equal(a.jam.scNow(), 0);
  assert.equal(a.jam.on, false); assert.equal(a.jam.real(), false); assert.equal(a.jam.wait, false);
  assert.deepEqual(a.jam.body(), { x: {} });
  // away: the away read refused -> off too
  const b = await hosting();
  b.m.answer.current = () => ({ status: 403 });
  b.m.st.ctx = '';
  b.m.st.track = null;
  b.m.st.stopped = true;
  b.m.st.origin = null;
  b.m.ev('inactive', {});
  b.m.jamEv();
  await b.engine.refresh();
  await settle(b.jam, 80);
  assert.equal(b.jam.scNow(), 0);
  assert.equal(b.jam.on, false); assert.equal(b.jam.away, false);
  // wait + the admin Check answered with no session: the verdict stays inconclusive, the wait goes
  const c = await setup();
  c.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  await c.jam.start();
  await sleep(450);
  await settle(c.jam);
  assert.equal(c.jam.wait, true);
  c.m.spotify = null;
  const v = await c.jam.check();
  assert.equal(v.verdict, 'inconclusive');
  assert.equal(c.jam.on, false);
});

test('refusals: a guest whose read is refused stays a guest behind lim: guard, no ctl, not hosting; idle -> the local pause alone', async () => {
  const g = await guesting({ listening: 0 });
  g.m.answer.current = () => ({ status: 403 });
  g.jam.lastSent = 0;
  await g.jam.get({ fresh: true });
  assert.equal(g.jam.scNow(), 0);
  assert.equal(g.jam.role(), 'guest'); assert.equal(g.jam.lim(), true); assert.equal(g.jam.hosting(), false);
  const b = g.jam.body();
  assert.equal(b.lim, 1); assert.equal(b.r, undefined); assert.equal(b.ctl, undefined); assert.equal(b.m, undefined); assert.equal(b.t, undefined);
  assert.deepEqual(b.x, {});
  assert.throws(() => g.jam.guard('next'), (e) => e.status === 403 && e.code === 'jam_no_control');
  assert.equal(g.jam.guard('pause'), 'noop');
  await assert.rejects(g.jam.leave({}), (e) => e.status === 503 && e.code === 'jam_unavailable');
  let now = Date.now();
  g.jam.now = () => now;
  g.player.st.status = 'playing';
  g.jam.idleTick();
  now += 10 * 60000 + 1000;
  g.jam.idleTick();
  await settle(g.jam, 30);
  assert.equal(g.m.sends('leave'), 0, 'Leave isn\'t possible');
  assert.equal(calls(g.m, /^\/player\/pause/).length, 1, 'the local pause alone, at 10 min');
});

test('member ids that aren\'t usernames: no false kicked (L0 included), the role kept; Start takes an owner-less session as ours', async () => {
  const opaque = (sid, ids) => ({ session_id: sid, join_session_token: 'tokOpaque1', session_members: ids.map((id, i) => ({ id, display_name: 'N' + i })) });
  const a = await setup({ sc: undefined });
  a.m.load(T(1), { ctx: JAM(3), origin: SOCIAL });
  a.m.jamEv();
  a.m.answer.current = () => ({ status: 200, json: opaque('sOp1', ['op4f9a', 'op77b2']) });
  const v = await a.jam.check();
  assert.equal(v.verdict, 'accepted'); assert.equal(a.jam.scNow(), 1);
  assert.equal(a.jam.on, true);
  assert.equal(a.jam.role(), 'host', 'no owner field and no Join of ours: plan B, Alex\'s own Jam');
  a.jam.lastSent = 0;
  await a.jam.get({ fresh: true });
  assert.equal(a.jam.on, true, 'a second read: still no removal');
  assert.equal(evs(a.pushes).filter((e) => e.k === 'kicked' || e.k === 'end').length, 0);
  // Start: current_or_new's session doesn't say who owns it -> ours, not jam_elsewhere; later reads keep host
  const b = await setup();
  b.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  b.m.answer.start = () => ({ status: 200, json: opaque('sOp2', ['op1']) });
  const r = await b.jam.start();
  assert.equal(r.jam.r, 'host');
  b.m.answer.current = () => ({ status: 200, json: opaque('sOp2', ['op1', 'op2']) });
  b.m.jamStarts(4);
  await settle(b.jam);
  b.jam.lastSent = 0;
  await b.jam.get({ fresh: true });
  assert.equal(b.jam.on, true); assert.equal(b.jam.role(), 'host');
  // a guest's read with no owner field keeps guest (a first-member guess would have made us host)
  const g = await guesting();
  const sp = g.m.spotify;
  g.m.answer.current = () => ({ status: 200, json: { session_id: sp.session_id, join_session_token: sp.join_session_token,
    session_members: [{ username: 'alex' }, { username: 'jake' }] } });
  g.jam.lastSent = 0;
  await g.jam.get({ fresh: true });
  assert.equal(g.jam.on, true); assert.equal(g.jam.role(), 'guest');
});

test('Spotify\'s 200 with {} on current (the engine answers {}; one before that fix, {"session":{}}) is no session: Start\'s pre-check, reads, L0', async () => {
  const a = await setup();
  a.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  a.m.answer.current = () => ({ status: 200, json: {} });
  const r = await a.jam.start();
  assert.equal(r.jam.r, 'host');
  const c = await setup({ sc: undefined });
  c.m.answer.current = () => ({ status: 200, json: {} });
  const v = await c.jam.check();
  assert.equal(v.verdict, 'inconclusive'); assert.match(v.reason, /no session/);
  const h = await hosting();
  h.m.answer.current = () => ({ status: 200, json: {} });
  h.jam.lastSent = 0;
  await h.jam.get({ fresh: true });
  assert.equal(h.jam.on, false, 'no session while on -> off');
  // an engine without the fix passed it on as {"session":{}}: the same answer
  const g = await hosting();
  assert.deepEqual(g.jam.applyRead({ status: 200, json: { session: {} } }, false), { ok: true, s: null });
  assert.equal(g.jam.on, false, '{"session":{}} while on -> off');
});

test('429s: Spotify\'s own (X-Upstream-Status) -> rate_limited; the engine gate\'s (nothing sent) -> busy, no "Spotify is limiting"', async () => {
  const h = await hosting({ engine: { waitMs: 50 } });
  const n0 = h.m.sends();
  h.m.gate.busy = true;                              // a call in flight: this one waits in line, then is refused
  let res = await h.jam.read('fresh', { quiet: false });
  assert.equal(res.error, 'busy'); assert.equal(res.e.status, 503); assert.equal(res.e.retry_after, 5);
  assert.doesNotMatch(res.e.message, /Spotify is limiting/);
  h.m.gate.busy = false;
  h.m.o.cap = 0;                                     // the engine's 5-min cap
  res = await h.jam.read('fresh', { quiet: false });
  assert.equal(res.error, 'busy'); assert.match(res.e.message, /holding back .* 60 s/);
  assert.equal(h.m.sends(), n0, 'nothing sent');
  h.m.o.cap = 30;
  h.m.answer.current = () => ({ status: 429, retryAfter: 90 });
  res = await h.jam.read('fresh', { quiet: false });
  assert.equal(res.error, 'rate_limited'); assert.match(res.e.message, /Spotify is limiting/); assert.equal(res.e.retry_after, 90);
});

test('join while lim: refused before any spotify.link expansion, replace or not', async () => {
  let gets = 0;
  const s = await setup();
  s.jam.fetch = async () => { gets++; return { status: 307, headers: { get: () => 'https://open.spotify.com/socialsession/tokLim_12' } }; };
  s.m.answer.current = () => ({ status: 502 });
  s.m.load(T(1), { ctx: JAM(6), origin: SOCIAL });
  s.m.jamEv();
  await settle(s.jam);
  assert.equal(s.jam.lim(), true);
  await assert.rejects(s.jam.join({ link: 'https://spotify.link/AbCdEf' }), (e) => e.status === 409 && e.code === 'jam_active' && !e.r);
  await assert.rejects(s.jam.join({ link: 'https://spotify.link/AbCdEf', replace: true }), (e) => e.status === 409 && e.code === 'jam_active');
  assert.equal(gets, 0, 'no redirect GETs');
  assert.equal(s.m.sends('info') + s.m.sends('join'), 0);
});

test('end: a late end transfer (item 10 after End\'s settle) still restarts the song, once; after the watch window, nothing', async () => {
  const { m, jam } = await hosting({ timing: { endWatchMs: 1500 } });
  m.answer.end = () => { setTimeout(() => m.jamEnds({ item10: true }), 700); return { status: 200, json: {} }; };
  const r = await jam.end();
  assert.ok(r.state && !r.gen, 'settle: the engine kept the song');
  assert.equal(calls(m, /^\/player\/play$/).length, 0);
  await sleep(900);
  await jam.lock;
  await sleep(50);
  const plays = m.log.filter((x) => x.path === '/player/play');
  assert.equal(plays.length, 1, 'restarted once');
  assert.equal(plays[0].body.uri, T(100));
  m.ev('command', { endpoint: 'transfer', from: SOCIAL, jam_end: true });
  await sleep(50);
  await jam.lock;
  assert.equal(m.log.filter((x) => x.path === '/player/play').length, 1, 'a second end transfer: nothing more');
  const b = await hosting({ timing: { endWatchMs: 200 } });
  b.m.answer.end = () => { setTimeout(() => b.m.jamEnds({ item10: true }), 900); return { status: 200, json: {} }; };
  await b.jam.end();
  await sleep(1100);
  await b.jam.lock;
  assert.equal(b.m.log.filter((x) => x.path === '/player/play').length, 0, 'outside the window');
});

test('away: a read that doesn\'t answer gets exactly one more (awayRetryMs on); then the next read decides', async () => {
  const lose = (s) => { s.m.st.ctx = ''; s.m.st.track = null; s.m.st.stopped = true; s.m.st.origin = null; s.m.ev('inactive', {}); s.m.jamEv(); };
  const a = await hosting({ timing: { awayRetryMs: 100 } });
  a.m.answer.current = () => ({ status: 502 });
  const n0 = a.m.sends('current');
  lose(a);
  await a.engine.refresh();
  await settle(a.jam, 80);
  assert.equal(a.jam.away, true);
  assert.equal(a.m.sends('current') - n0, 1);
  a.m.answer.current = () => ({ status: 204 });     // the Jam is over
  await sleep(150);
  await settle(a.jam, 20);
  assert.equal(a.m.sends('current') - n0, 2, 'one more read');
  assert.equal(a.jam.on, false, 'it showed no session: off');
  const b = await hosting({ timing: { awayRetryMs: 100 } });
  b.m.answer.current = () => ({ status: 502 });
  const b0 = b.m.sends('current');
  lose(b);
  await b.engine.refresh();
  await settle(b.jam, 80);
  await sleep(400);
  await settle(b.jam, 20);
  assert.equal(b.m.sends('current') - b0, 2, 'never a third');
  assert.equal(b.jam.away, true);
});

test('idle: main.js\'s 45 s pause gives way to the Jam\'s own safety only with patch 3 (jam.idleOwn)', async () => {
  const h = await hosting();
  assert.equal(h.jam.idleOwn(), true);
  const old = await setup({ engine: { patch3: false } });
  old.m.load(T(1), { ctx: JAM(3), origin: SOCIAL });
  await old.engine.refresh();
  assert.equal(old.jam.real(), true);
  assert.equal(old.jam.idleOwn(), false, 'the end would be invisible: the 45 s pause stays');
});

test('mask: dealer URIs keep plain words only (a UUID, an all-letter run of 12+ and mixed ids go whole)', () => {
  assert.equal(mask('hm://social-connect/v2/session_update/3f2b9c1e-7a4d-4e2b-9f1a-0c8d7e6b5a49'), 'hm://social-connect/v2/session_update/*');
  assert.equal(mask('hm://social-connect/v2/sessions/' + 'f'.repeat(20)), 'hm://social-connect/v2/sessions/*');
  assert.equal(mask('hm://social-connect/v3/sessions/AbC123/members/x_9'), 'hm://social-connect/v3/sessions/*/members/*');
});

test('player: a Jam link is never a play (400, nothing reaches the engine): URIs and links, any case, in any of the play\'s uris', async () => {
  const { m, player } = await setup();
  const pl = 'spotify:playlist:' + 'p'.repeat(22);
  const jams = ['spotify:socialsession:AbcdEf_123', JAM(1), ' Spotify:SocialSession:AbcdEf_123', 'spotify:socialsession',
    'https://open.spotify.com/socialsession/AbcdEf_123?si=abc', 'https://open.spotify.com/intl-pt-br/socialsession/AbcdEf_123',
    'open.spotify.com/socialsession/AbcdEf_123', 'HTTP://OPEN.SPOTIFY.COM/SOCIALSESSION/AbcdEf_123'];
  for (const u of jams) {
    for (const b of [{ context_uri: u }, { uri: u }, { context_uri: pl, uri: u }, { context_uri: pl, offset_uri: u }]) {
      assert.throws(() => player.play(b), (e) => e.status === 400 && e.code === 'bad_request' && /Jam link/.test(e.message), JSON.stringify(b));
    }
  }
  assert.equal(calls(m, /^\/player\/play/).length, 0);
  // not Jams: the word elsewhere, another site's link, a spotify.link (unknown until expanded; the engine can't play it)
  for (const u of ['spotify:user:socialsession:collection', 'spotify:playlist:socialsession0000000000', 'https://example.com/socialsession/AbcdEf_123',
    'https://open.spotify.com/playlist/' + 'p'.repeat(22), 'https://spotify.link/abc']) {
    assert.doesNotThrow(() => player.refuseJam({ context_uri: u, uri: u, offset_uri: u }), u);
  }
  assert.doesNotThrow(() => player.refuseJam({ context_uri: 42, uri: null }));
});

test('fake Jam (1.1.0): "you" carries the Web API account\'s name when it is known, else "You"; never a fixed name', async () => {
  const { jam } = await setup({ webapi: { ready: false, user: { id: 'alex', name: 'Alex Example' } } });
  jam.setFake({ role: 'guest', members: 3 });
  let b = jam.body();
  assert.equal(b.m.find((x) => x.me).n, 'Alex Example');
  assert.notEqual(b.hn, 'Alex Example', 'as a guest the host is one of the made-up names');
  jam.setFake({ role: 'host', members: 2 });
  b = jam.body();
  assert.equal(b.hn, 'Alex Example');
  jam.setFake({ role: null });
  const { jam: j2 } = await setup({ webapi: { ready: false, user: { id: 'alex', name: '   ' } } });
  j2.setFake({ role: 'host', members: 1 });
  assert.equal(j2.body().hn, 'You', 'a blank name: "You"');
  j2.setFake({ role: null });
});
