'use strict';
// 4b-c (DESIGN-4b.md §7.2 after C0): parseSession on c0.json-shaped fixtures (synthetic values), session_update
// pushes, Remove (C0's kick), Start's host-device check, and Up Next edits (engine-local, patch 3 item 11) with the
// edit_lost count, against the patch-3 engine model (jam-engine.js) whose "Spotify" is scripted: nothing here can
// reach social-connect.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PcmClock } = require('../src/pcm');
const { Player } = require('../src/player');
const { Jam, parseSession, names } = require('../src/jam');
const { shareLink, shareOk } = require('../src/jamlink');
const { tokenFor } = require('../src/image');
const { JamEngine, fakeJamEngine, session, member, track, T, JAM, SOCIAL, ROUTES, PC, DEV, sid32, pic, hex32, id22 } = require('./support/jam-engine');
const { tmp, sleep } = require('./support/helpers');

const FAST = { setDebounce: 20, inactiveDebounce: 30, ownConfirmMs: 300, endSettleMs: 400, leaveSettleMs: 60, noSession: 20, connectRead: 20,
  queueDebounce: 10, queueRetry: 50, queueTimeout: 1000, addGapMs: 5, joinGenWaitMs: 150, idleGrace: 30, queueEditTimeout: 300 };
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
// the fixtures' synthetic values (gw4c_fixtures.py)
const F = { sid: '5f0c2a9e8b7d4c3a1e6f9b8a7c6d5e4f', tok: 'Qx7Lm2Np9Rs4Tv6Wy8Za1B', dev: 'e4c2a8b6d0f1357924680ace13579bdf02468ace',
  mId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', bId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', mUser: '31abcdefghijklmnopqrstuvw', bUser: '31zyxwvutsrqponmlkjihgfed' };

async function setup(o = {}) {
  const m = new JamEngine({ spacingMs: 0, ...o.engine });
  const engine = fakeJamEngine(m);
  const clock = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-gw4c.pcm'), { leadMs: 10000 });
  const pushes = [];
  const bus = { push: (type, data) => pushes.push({ type, data }) };
  const dir = tmp('jam4c');
  if (o.jamJson) fs.writeFileSync(path.join(dir, 'jam.json'), JSON.stringify(o.jamJson));   // a restart: jam.json's hint (and sc)
  const player = new Player({ engine, clock, bus, webapi: null, dataDir: dir });
  const encoders = { n: 1, listening() { return this.n; } };
  const jam = new Jam({ cfg: { dataDir: dir, jam: o.flags || {} }, engine, player, bus, webapi: null, encoders, timing: { ...FAST, ...o.timing } });
  clearInterval(jam.ticker);
  player.jam = jam;
  if (!o.jamJson) jam.sc = 'sc' in o ? o.sc : 1;
  await engine.refresh();
  return { m, engine, player, jam, pushes, dir };
}
const evs = (pushes) => pushes.filter((x) => x.type === 'jam' && x.data.ev).map((x) => x.data.ev);
const settle = async (jam, ms = 60) => { await sleep(ms); if (jam.flight) await jam.flight; await sleep(5); };
const calls = (m, re) => m.log.filter((x) => re.test(x.path));
const trace = (jam, k) => jam.ring.filter((e) => e.k === k);

async function hosting(o = {}) {
  const s = await setup(o);
  s.m.spotify = session({ members: ['alex', 'jake'], ...o.session });
  s.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
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

// everything logged while fn runs
async function captured(fn) {
  const out = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, keep); }
  return out.join('\n');
}

// an upcoming row of the model's list
const ent = (tag, provider) => ({ uri: T(tag), uid: 'u-' + tag, provider, metadata: provider === 'queue' ? { is_queued: 'true' } : {}, track: track(T(tag)) });
const ROWS = () => [ent('q1', 'queue'), ent('q2', 'queue'), ent('c1', 'context'), ent('c2', 'context'), ent('c3', 'context'), ent('a1', 'autoplay')];
const uids = (rows) => rows.map((r) => r.uid);

// ---------------------------------------------------------------- the session as C0 named it
test('parseSession (C0 fixtures): host = the member whose id is session_owner_id, me by is_current_user, pictures, caps, host device, share link, code URI', () => {
  for (const k of Object.keys(names)) names[k] = '';
  const s = parseSession(FIX('jam-session-c0-two.json'), 'notTheEngineUsername');
  assert.equal(s.sid, F.sid); assert.equal(s.token, F.tok);
  assert.deepEqual(s.members.map((m) => [m.id, m.sp, m.n]), [[F.mUser, F.mId, 'Alex Example'], [F.bUser, F.bId, 'Rowan']], 'MEM id = username; the Spotify id beside it');
  assert.equal(s.hostId, F.mUser); assert.equal(s.meId, F.mUser, 'me from is_current_user, whatever the engine\'s username');
  assert.equal(s.role, 'host'); assert.equal(s.ownerKnown, true);
  assert.equal(s.members[0].pic, FIX('jam-session-c0-two.json').session_members[0].large_image_url, 'large_image_url first');
  assert.deepEqual(s.caps, { invite: true, remove: true, manage: true });
  assert.deepEqual(s.hostDev, { id: F.dev, name: 'Encore' });
  assert.equal(s.active, true); assert.equal(s.gc, true, 'queue_only_mode false');
  assert.equal(s.share, `https://open.spotify.com/socialsession/${F.tok}?si=ab`, 'the scheme-less join_session_url, https:// in front');
  assert.equal(s.uri, 'spotify:socialsession:' + F.tok);
  assert.equal(s.listening, 1); assert.equal(s.controlling, 2);
  assert.deepEqual({ ...names }, { caps: 'user_capabilities', remove: 'remove_participants', control: 'playbackControl', limit: 'maxMemberCount',
    owner: 'id', share: 'no scheme, open.spotify.com' }, 'the masked keys\' real names, the owner rule, the link\'s kind');
  // other names for the masked keys: found by pattern and value all the same
  names.control = '';
  names.limit = '';
  const o = parseSession(FIX('jam-session-c0-other-names.json'));
  assert.deepEqual(o.caps, { invite: true, remove: true, manage: true });
  assert.deepEqual([names.caps, names.remove, names.control, names.limit], ['user_permissions', 'remove_members', 'controlMode', 'memberLimitCount']);
  // pushes carry the same session
  for (const f of ['new_session', 'user_joined', 'pause_changed', 'user_kicked']) {
    const p = FIX(`jam-push-c0-${f}.json`);
    const ps = parseSession(p.session);
    assert.ok(ps && ps.sid === F.sid && ps.hostId === F.mUser && ps.meId === F.mUser, f);
  }
  assert.equal(parseSession(FIX('jam-push-c0-user_kicked.json').session).members.length, 1);
  const one = parseSession(FIX('jam-session-c0-host.json'));
  assert.deepEqual([one.members.length, one.role, one.hostId, one.meId, one.listening], [1, 'host', F.mUser, F.mUser, 1]);
});

test('parseSession: pictures (large, then image_url, only what the image proxy takes), owner fallbacks, active:false, share-link forms, code URI', () => {
  const base = FIX('jam-session-c0-two.json');
  const b = JSON.parse(JSON.stringify(base));
  delete b.session_members[0].large_image_url;
  b.session_members[1].large_image_url = 'https://evil.example/x.jpg';
  const s = parseSession(b);
  assert.equal(s.members[0].pic, base.session_members[0].image_url, 'no large: image_url');
  assert.equal(s.members[1].pic, base.session_members[1].image_url, 'a large on a host the proxy refuses: image_url');
  b.session_members[1].image_url = 'http://i.scdn.co/image/' + 'a'.repeat(40);
  b.session_members[1].large_image_url = undefined;
  assert.equal(parseSession(b).members[1].pic, '', 'no https picture: none (initials)');
  // owner by username (2021–22), by the current user, unsure (first member)
  const u = JSON.parse(JSON.stringify(base));
  u.session_owner_id = F.bUser;
  assert.equal(parseSession(u).hostId, F.bUser);
  assert.equal(names.owner, 'username');
  u.session_owner_id = 'nobody';
  const cu = parseSession(u);
  assert.equal(cu.hostId, F.mUser); assert.equal(names.owner, 'current user');
  u.is_session_owner = false;
  delete u.session_members[0].is_current_user;
  const fm = parseSession(u, 'x');
  assert.equal(fm.hostId, F.mUser); assert.equal(names.owner, 'first member'); assert.equal(fm.role, 'guest'); assert.equal(fm.ownerKnown, true);
  // active:false; capabilities missing -> unknown
  const a = JSON.parse(JSON.stringify(base));
  a.active = false;
  delete a.user_capabilities;
  const as = parseSession(a);
  assert.equal(as.active, false); assert.deepEqual(as.caps, { invite: null, remove: null, manage: null });
  // join_session_url: https kept; scheme-less spotify.link; anything else -> '' (the link is built from the token)
  const link = (url) => { const x = JSON.parse(JSON.stringify(base)); x.join_session_url = url; return parseSession(x).share; };
  assert.equal(link('https://spotify.link/AbC123xyz'), 'https://spotify.link/AbC123xyz');
  assert.equal(link(' spotify.link/AbC123xyz '), 'https://spotify.link/AbC123xyz');
  assert.equal(names.share, 'no scheme, spotify.link');
  for (const bad of ['http://open.spotify.com/socialsession/x', 'https://evil.example/socialsession/x', 'open.spotify.com.evil.example/x', 'open.spotify.com:8080/x',
    'https://open.spotify.com:8443/x', 'spotify:socialsession:' + F.tok, 'javascript:alert(1)', '', 42, null]) assert.equal(link(bad), '', String(bad));
  // no join_session_uri: the token's; a bad one: ignored
  const c = JSON.parse(JSON.stringify(base));
  c.join_session_uri = 'spotify:socialsession:../x';
  assert.equal(parseSession(c).uri, '');
  delete c.join_session_token;
  c.join_session_uri = 'spotify:socialsession:' + F.tok;
  assert.equal(parseSession(c).token, F.tok, 'the token from the URI');
});

test('jamlink.shareLink: https as is, scheme-less with https:// in front, nothing else', () => {
  assert.deepEqual(shareLink('https://open.spotify.com/socialsession/AbC_1?si=x'), { url: 'https://open.spotify.com/socialsession/AbC_1?si=x', kind: 'https', host: 'open.spotify.com' });
  assert.deepEqual(shareLink('open.spotify.com/socialsession/AbC_1'), { url: 'https://open.spotify.com/socialsession/AbC_1', kind: 'no scheme', host: 'open.spotify.com' });
  assert.deepEqual(shareLink('spotify.link/Zz9'), { url: 'https://spotify.link/Zz9', kind: 'no scheme', host: 'spotify.link' });
  for (const bad of ['http://spotify.link/x', 'https://user:pw@open.spotify.com/x', 'open.spotify.com/a b', 'ftp://spotify.link/x', 'spotify.link', 'www.spotify.link/x', undefined]) {
    assert.equal(shareLink(bad), null, String(bad));
    assert.equal(shareOk(bad), false);
  }
  assert.equal(shareOk('open.spotify.com/socialsession/x'), true, 'shareOk gains the scheme-less case');
});

test('JAM from a C0 session: l from join_session_url, ci from join_session_uri, real pictures, me by is_current_user, x.kick', async () => {
  const { jam } = await hosting();
  jam.username = 'someoneElse';                      // me comes from is_current_user, not the engine's username
  const b = jam.body();
  const tok = b.t;
  assert.equal(b.l, 'https://open.spotify.com/socialsession/' + tok);
  assert.equal(Buffer.from(b.ci.slice(1), 'base64url').toString(), 'https://scannables.scdn.co/uri/plain/png/2F9A2B/white/640/spotify%3Asocialsession%3A' + tok);
  assert.deepEqual(b.m.map((x) => [x.id, x.i, x.h || 0, x.me || 0]), [['alex', tokenFor(pic('alex', 'large')), 1, 1], ['jake', tokenFor(pic('jake', 'large')), 0, 0]]);
  assert.ok(/^[0-9a-f]{40}$/.test(b.m[1].i), 'an i.scdn.co picture: a 40-hex token for /v1/img');
  assert.equal(JSON.stringify(b).includes(sid32('jake')), false, 'the Spotify ids never reach the phone');
  assert.deepEqual(b.x, { sc: 1, kick: 1, add: 1, code: 1 });
  // a join_session_url Encore can't use (another scheme): the link built from the token
  const o = await hosting({ session: { url: 'http://open.spotify.com/socialsession/zz' } });
  assert.equal(o.jam.body().l, 'https://open.spotify.com/socialsession/' + o.jam.body().t);
  const sl = await hosting({ session: { url: 'spotify.link/AbCdEf12' } });
  assert.equal(sl.jam.body().l, 'https://spotify.link/AbCdEf12');
});

test('reads: a session marked active:false is no session (off, ev end); in L0 it is inconclusive', async () => {
  const { m, jam, pushes } = await hosting();
  m.spotify.active = false;
  jam.lastSent = 0;
  await jam.get({ fresh: true });
  assert.equal(jam.on, false);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'end' }]);
  const c = await setup({ sc: undefined });
  c.m.load(T(1), { ctx: JAM(3), origin: SOCIAL });
  c.m.jamEv();
  c.m.spotify = session({ members: ['alex'] });
  c.m.spotify.active = false;
  const v = await c.jam.check();
  assert.equal(v.verdict, 'inconclusive'); assert.match(v.reason, /no longer active/);
  assert.equal(c.jam.scNow(), undefined);
  assert.equal(c.jam.on, true, 'L0 changes nothing else');
});

// ---------------------------------------------------------------- session_update pushes
test('pushes: the known session\'s USER_JOINED / USER_KICKED -> ev in / ev out with no read; sc never changes; the trace has the reason', async () => {
  const { m, jam, pushes } = await hosting();
  const n0 = m.sends();
  m.spotify.session_members.push(member('rowan'));
  m.push('USER_JOINED', m.spotify, [member('rowan')]);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'in', n: 'Rowan', id: 'rowan' }]);
  assert.equal(jam.body().cnt, 3);
  m.spotify.session_members = m.spotify.session_members.filter((x) => x.username !== 'rowan');
  m.push('USER_KICKED', m.spotify, [member('rowan')]);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'out', n: 'Rowan', id: 'rowan' }]);
  m.push('SESSION_MEMBER_PAUSE_CHANGED', { ...m.spotify, is_jam_paused: true });
  assert.equal(evs(pushes).length, 3, 'start, in, out: a pause change adds no ev');
  await settle(jam);
  assert.equal(m.sends(), n0, 'pushes trigger no read');
  assert.equal(jam.scNow(), 1);
  const sc = trace(jam, 'social_connect');
  assert.deepEqual(sc.map((e) => [e.uri, e.reason, e.applied]), [['social-connect/v2/session_update', 'USER_JOINED', 1], ['social-connect/v2/session_update', 'USER_KICKED', 1],
    ['social-connect/v2/session_update', 'SESSION_MEMBER_PAUSE_CHANGED', 1]]);
  assert.deepEqual(trace(jam, 'session').slice(-1), [{ t: trace(jam, 'session').slice(-1)[0].t, k: 'session', src: 'push', n: 2, listening: 1, controlling: 2, host_dev: 'encore' }]);
  assert.deepEqual([jam.info().dealer.updates, jam.info().dealer.applied, jam.info().dealer.push_fed], [3, 3, true]);
  // the C0 fixtures through the same path (a session id the Jam doesn't have: recorded only)
  m.ev('social_connect', { uri: 'social-connect/v2/session_update', payload: FIX('jam-push-c0-user_joined.json') });
  assert.equal(jam.info().dealer.applied, 3);
  assert.equal(trace(jam, 'social_connect').slice(-1)[0].applied, 0);
});

test('pushes: a USER_KICKED naming this account -> kicked (a guest); a push of a session marked active:false -> ended', async () => {
  const { m, jam, pushes } = await guesting();
  m.spotify.session_members = m.spotify.session_members.filter((x) => x.username !== 'alex');
  m.push('USER_KICKED', m.spotify, [member('alex', { me: true })]);
  assert.equal(jam.on, false);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'kicked', n: 'Jake', id: 'jake' }]);
  // nothing told us which member we are (no is_current_user, no username, nothing learned): a session without us isn't
  // a removal by itself, only a USER_KICKED that names this account is
  const o = await guesting();
  o.jam.meIds.clear();
  o.jam.username = '';
  o.engine.status = null;
  const strip = (sp) => ({ ...sp, session_members: sp.session_members.filter((x) => x.username !== 'alex').map((x) => { const y = { ...x }; delete y.is_current_user; return y; }) });
  o.m.push('USER_KICKED', strip(o.m.spotify), [member('emma')]);
  assert.equal(o.jam.on, true, 'someone else was kicked: still in');
  o.m.push('USER_KICKED', strip(o.m.spotify), [member('alex', { me: true })]);
  assert.equal(o.jam.on, false);
  assert.deepEqual(evs(o.pushes).slice(-1), [{ k: 'kicked', n: 'Jake', id: 'jake' }]);
  const h = await hosting();
  h.m.push('SESSION_MEMBER_PAUSE_CHANGED', { ...h.m.spotify, active: false });
  assert.equal(h.jam.on, false);
  assert.deepEqual(evs(h.pushes).slice(-1), [{ k: 'end' }]);
});

test('pushes before L0: one hosted on Encore is applied while the engine shows the Jam (lim cleared, End still unavailable); one hosted elsewhere is recorded only', async () => {
  const { m, jam } = await setup({ sc: undefined });
  m.load(T(1), { ctx: JAM(3), origin: SOCIAL });
  m.jamEv();
  assert.equal(jam.lim(), true);
  m.push('NEW_SESSION', session({ sid: 'aa'.repeat(16), members: ['alex'], hostDev: PC }));
  assert.equal(jam.lim(), true, 'the account\'s Jam on another device: recorded only');
  assert.equal(trace(jam, 'social_connect').slice(-1)[0].applied, 0);
  m.spotify = session({ members: ['alex', 'jake'] });
  m.push('NEW_SESSION', m.spotify, [member('alex')]);
  const b = jam.body();
  assert.equal(b.lim, undefined); assert.equal(b.r, 'host'); assert.equal(b.cnt, 2); assert.ok(b.l && b.ci && b.m[1].i);
  assert.deepEqual(b.x, { add: 1, code: 1 }, 'no sc: no Start/End/Leave/Remove');
  await assert.rejects(jam.end(), (e) => e.status === 503 && e.code === 'jam_unavailable');
  assert.equal(jam.scNow(), undefined, 'a push never sets sc');
  assert.equal(m.sends(), 0, 'nothing reached social-connect');
  // a broadcast_status_update: counted and recorded (its device-id key masked), never applied
  m.broadcast();
  const last = trace(jam, 'social_connect').slice(-1)[0];
  assert.equal(last.uri, 'social-connect/v2/broadcast_status_update'); assert.equal(last.keys, '*'); assert.equal(last.applied, undefined);
  assert.equal(JSON.stringify(jam.info()).includes(PC), false);
  assert.equal(jam.info().dealer.updates, 2);
});

test('pushes: one for Encore that comes just before the engine shows the Jam is applied when it does (no set read); an old one is dropped', async () => {
  const { m, jam } = await setup();
  m.spotify = session({ members: ['alex', 'jake'] });
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.push('NEW_SESSION', m.spotify);
  assert.equal(jam.on, false);
  m.jamStarts(1);
  await settle(jam);
  assert.equal(jam.body().r, 'host'); assert.equal(jam.body().cnt, 2);
  assert.equal(m.sends('current'), 0, 'the push supplied the session: no set read');
  const b = await setup();
  let now = Date.now();
  b.jam.now = () => now;
  b.m.spotify = session({ members: ['alex'] });
  b.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  b.m.push('NEW_SESSION', b.m.spotify);
  now += 20000;
  b.m.jamStarts(1);
  await settle(b.jam);
  assert.equal(b.m.sends('current'), 1, 'older than 15 s: dropped, the set read as before');
});

test('pushes: unseen reasons are logged once and applied; payloads without a session object are recorded only', async () => {
  const { m, jam } = await hosting();
  const out = await captured(async () => {
    m.push('MEMBER_RENAMED', m.spotify);
    m.push('MEMBER_RENAMED', m.spotify);
    m.ev('social_connect', { uri: 'social-connect/v2/session_update', payload: { reason: 'USER_JOINED' } });
    m.ev('social_connect', { uri: 'hm://social-connect/v2/session_update', payload: { session: [], reason: 'lowercase junk' } });
  });
  assert.equal((out.match(/not seen in C0: MEMBER_RENAMED/g) || []).length, 1);
  assert.equal(jam.info().dealer.applied, 2);
  assert.equal(jam.info().dealer.updates, 2, 'only payloads with a session object are session updates');
});

test('pushes: a push-fed lease polls every 120 s (pushes count as fresh reads for the gap)', async () => {
  const { m, jam } = await hosting({ engine: { cap: 1e6 } });
  let now = Date.now() + 1000;
  jam.now = () => now;
  jam.lastSent = now;                               // the lease's start read doesn't go
  m.push('USER_JOINED', m.spotify);
  const t0 = now;
  const n0 = m.sends('current');
  const at = [];
  for (let i = 0; i < 30; i++) {
    now += 20000;
    jam.watch();
    jam.pollTick();
    await settle(jam, 2);
    if (m.sends('current') > n0 + at.length) at.push(now);
  }
  assert.equal(jam.info().lease_poll_s, 120);
  assert.equal(at.length, 5, `10 min push-fed: ${at.length} reads`);
  assert.ok(at.slice(1).every((t, i) => t - at[i] === 120000));
  assert.equal(at[0] - t0, 120000);
  // a push within the gap: the next read waits a full gap from it (at t0 + 820 s, not t0 + 720 s)
  const n1 = m.sends('current');
  let readAt = 0;
  for (let i = 0; i < 12; i++) {
    now += 20000;
    if (i === 4) m.push('USER_JOINED', m.spotify);
    jam.watch();
    jam.pollTick();
    await settle(jam, 2);
    if (!readAt && m.sends('current') > n1) readAt = now;
  }
  assert.equal(readAt - t0, 820000);
});

test('pushes: the Jam that just went off never stands in for the next one (a trailing push isn\'t held or applied); the new Jam\'s own are', async () => {
  const { m, jam } = await setup({ sc: undefined });          // before L0: pushes are all there is
  const A = session({ members: ['alex', 'jake'] });
  m.spotify = A;
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.jamStarts(1);
  await settle(jam);
  m.push('NEW_SESSION', A);
  assert.equal(jam.body().t, A.join_session_token);
  m.jamEnds();
  await settle(jam);
  assert.equal(jam.on, false);
  m.push('SESSION_MEMBER_PAUSE_CHANGED', { ...A, is_jam_paused: true });   // A's, trailing (C0: one came after the kick)
  m.push('NEW_SESSION', A);
  assert.equal(jam.heldPush, null, 'not kept for the next Jam');
  const B = session({ sid: hex32('s2'), token: id22('t2'), members: ['alex', 'emma'] });
  m.spotify = B;
  m.jamStarts(2);                                              // Alex starts another Jam on Encore within 15 s
  await settle(jam);
  assert.equal(jam.lim(), true, 'B with no session yet: lim, not A');
  m.push('SESSION_MEMBER_PAUSE_CHANGED', A);                   // one more of A's, now that B is on
  assert.equal(jam.lim(), true, 'still not A');
  m.push('NEW_SESSION', B);
  m.push('USER_JOINED', B);
  const b = jam.body();
  assert.equal(b.t, B.join_session_token); assert.deepEqual(b.m.map((x) => x.id), ['alex', 'emma']);
  assert.equal(jam.info().dealer.applied, 3, 'A\'s first, then B\'s two');
  assert.equal(m.sends(), 0);
});

test('pushes after a restart: the jam.json session\'s push while Encore plays nothing makes no away before L0; with sc 1 it does, and one read confirms or clears it', async () => {
  const S = session({ members: ['alex', 'jake'] });
  const hint = { sid: S.session_id, token: S.join_session_token, role: 'host', since: 1234 };
  const a = await setup({ jamJson: hint });
  a.engine.emit('connected');
  await settle(a.jam);
  a.m.push('SESSION_MEMBER_PAUSE_CHANGED', S);                 // the Jam goes on elsewhere; nothing could ever clear an away
  assert.equal(a.jam.on, false); assert.equal(a.jam.away, false);
  assert.equal(trace(a.jam, 'social_connect').slice(-1)[0].applied, 0);
  assert.equal(a.jam.heldPush, null, 'not a NEW_SESSION: not kept for a later Jam either');
  assert.equal(a.jam.idleOwn(), false);
  assert.equal(a.m.sends(), 0);
  // the engine shows that Jam again: its pushes apply (the hint, while on)
  a.m.load(T(1), { ctx: JAM(7), origin: SOCIAL });
  a.m.jamEv();
  a.m.push('USER_JOINED', S);
  assert.equal(a.jam.body().r, 'host'); assert.equal(a.jam.body().cnt, 2);
  // sc 1: the push (before the connect read) makes away, and one read follows: the session is there -> away stays
  const b = await setup({ jamJson: { ...hint, sc: 1 } });
  b.m.spotify = S;
  b.engine.emit('connected');
  b.m.push('SESSION_MEMBER_PAUSE_CHANGED', S);
  assert.equal(b.jam.away, true);
  await settle(b.jam, 80);
  assert.equal(b.m.sends('current'), 1, 'one read');
  assert.equal(b.jam.away, true); assert.equal(b.jam.on, true);
  // ... no session any more -> off
  const c = await setup({ jamJson: { ...hint, sc: 1 } });
  c.engine.emit('connected');
  c.m.push('SESSION_MEMBER_PAUSE_CHANGED', S);
  assert.equal(c.jam.away, true);
  await settle(c.jam, 80);
  assert.equal(c.m.sends('current'), 1);
  assert.equal(c.jam.on, false);
});

test('reads: an answer older than a push of the same session (the read went out before it) keeps the push\'s members: no out / in flicker', async () => {
  const { m, jam, pushes } = await hosting();
  const before = JSON.parse(JSON.stringify(m.spotify));        // what Spotify answers: made before Emma joined
  m.delay.current = 80;
  m.answer.current = () => ({ status: 200, json: before });
  jam.lastSent = 0;
  const p = jam.get({ fresh: true });
  await sleep(25);                                             // the read is out
  m.spotify.session_members.push(member('emma'));
  m.push('USER_JOINED', m.spotify, [member('emma')]);
  await p;
  const io = () => evs(pushes).filter((e) => e.k === 'in' || e.k === 'out');
  assert.deepEqual(io(), [{ k: 'in', n: 'Emma', id: 'emma' }]);
  assert.equal(jam.body().cnt, 3);
  assert.equal(jam.scNow(), 1);
  assert.equal(trace(jam, 'session').slice(-1)[0].stale, 1);
  // a read that went out after the push is applied as usual
  delete m.answer.current;
  delete m.delay.current;
  m.spotify.session_members = m.spotify.session_members.filter((x) => x.username !== 'emma');
  jam.lastSent = 0;
  await jam.get({ fresh: true });
  assert.deepEqual(io(), [{ k: 'in', n: 'Emma', id: 'emma' }, { k: 'out', n: 'Emma', id: 'emma' }]);
});

test('start: an inactive session in the pre-check is still the account\'s: jam_elsewhere, nothing created; a read that saw one doesn\'t let Start skip it', async () => {
  const { m, jam } = await setup();
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.spotify = session({ members: ['alex'], hostDev: PC });   // a dormant Jam Alex hosted on the PC
  m.spotify.active = false;
  await assert.rejects(jam.start(), (e) => e.status === 409 && e.code === 'jam_elsewhere');
  assert.equal(m.sends('start'), 0, 'current_or_new never sent');
  await jam.read('lease');                                     // a read that sees it: no session for the state...
  assert.equal(jam.on, false);
  const n0 = m.sends('current');
  await assert.rejects(jam.start(), (e) => e.code === 'jam_elsewhere');
  assert.equal(m.sends('current') - n0, 1, '...but Start still reads first');
  assert.equal(m.sends('start'), 0);
  assert.equal(jam.on, false);
});

// DESIGN-JAM-WAIT G1: 0.8.2 adopted such a session without any call that activates it, and every such Start ended in
// wait; now current_or_new is sent for it (it answers that same session), as the desktop's Start does
test("start: the account's session is Encore's OWN (hosted on this engine: Spotify's standby, or a Jam a restart forgot): current_or_new activates it (the same session); one on the PC still refused", async () => {
  const { m, jam } = await setup();
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.spotify = session({ members: ['alex'], hostDev: DEV });  // seen live 2026-10-07: owner Alex, host Encore, 1 member
  const sid = m.spotify.session_id;
  const r = await jam.start();
  assert.equal(m.sends('start'), 1, 'current_or_new sent once for it (no more 0.8.2 shortcut)');
  assert.equal(jam.sess.sid, sid, 'the same session');
  assert.deepEqual(trace(jam, 'start').map((e) => e.same), [1]);
  assert.equal(r.jam.on, 1);
  assert.equal(r.jam.r, 'host');
  assert.equal(jam.on, true);
  await assert.rejects(jam.start(), (e) => e.status === 409 && e.code === 'jam_active');
  // the same on another device stays refused
  const b = await setup();
  b.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  b.m.spotify = session({ members: ['alex'], hostDev: PC });
  await assert.rejects(b.jam.start(), (e) => e.status === 409 && e.code === 'jam_elsewhere');
  assert.equal(b.jam.on, false);
});

// ---------------------------------------------------------------- Remove (C0's kick)
test('remove: sends the member\'s Spotify id (never the username), applies the reply\'s session (ev out, no read); {} -> one read; 404 -> not_found + one read', async () => {
  const { m, jam, pushes } = await hosting();
  const n0 = m.sends('current');
  const r = await jam.remove({ id: 'jake' });
  const call = calls(m, /^\/jam\/remove$/);
  assert.equal(call.length, 1);
  assert.deepEqual(call[0].body, { session_id: m.spotify.session_id, member_id: sid32('jake') });
  assert.equal(r.jam.cnt, 1);
  assert.deepEqual(evs(pushes).slice(-1), [{ k: 'out', n: 'Jake', id: 'jake' }]);
  await settle(jam);
  assert.equal(m.sends('current'), n0, 'the kick answered the session: no read');
  m.push('USER_KICKED', m.spotify, [member('jake')]);
  assert.equal(evs(pushes).filter((e) => e.k === 'out').length, 1, 'the push that comes second changes nothing');
  // {} -> one read
  const b = await hosting();
  b.m.answer.remove = () => ({ status: 200 });
  const b0 = b.m.sends('current');
  await b.jam.remove({ id: 'jake' });
  await settle(b.jam);
  assert.equal(b.m.sends('current') - b0, 1);
  // Spotify 404 -> not_found, one read
  const c = await hosting();
  c.m.answer.remove = () => ({ status: 404 });
  const c0 = c.m.sends('current');
  await assert.rejects(c.jam.remove({ id: 'jake' }), (e) => e.status === 404 && e.code === 'not_found');
  await settle(c.jam);
  assert.equal(c.m.sends('current') - c0, 1);
  assert.equal(c.m.sends('remove'), 1, 'never retried');
  // 403 -> jam_refused, sc unchanged
  c.m.answer.remove = () => ({ status: 403 });
  await assert.rejects(c.jam.remove({ id: 'jake' }), (e) => e.status === 403 && e.code === 'jam_refused' && /Spotify refused/.test(e.message));
  assert.equal(c.jam.scNow(), 1);
});

test('remove: not host / no x.kick / the session denies it / me / a member without a Spotify id -> the §4.4 errors, no engine call', async () => {
  const g = await guesting();
  await assert.rejects(g.jam.remove({ id: 'emma' }), (e) => e.status === 409 && e.code === 'not_host');
  const h = await hosting({ engine: { routes: ROUTES.filter((x) => x !== 'remove') } });
  assert.equal(h.jam.body().x.kick, undefined);
  await assert.rejects(h.jam.remove({ id: 'jake' }), (e) => e.status === 409 && e.code === 'unsupported');
  const d = await hosting();
  d.m.spotify.user_capabilities.remove_participants = false;
  d.jam.lastSent = 0;
  await d.jam.get({ fresh: true });
  assert.equal(d.jam.body().x.kick, undefined, 'the session\'s remove capability false: no kick');
  await assert.rejects(d.jam.remove({ id: 'jake' }), (e) => e.code === 'unsupported');
  const k = await hosting();
  await assert.rejects(k.jam.remove({ id: 'alex' }), (e) => e.status === 404 && e.code === 'not_found', 'me');
  await assert.rejects(k.jam.remove({ id: 42 }), (e) => e.status === 404);
  k.m.spotify.session_members.push({ username: 'oldstyle', display_name: 'Old' });
  k.jam.lastSent = 0;
  await k.jam.get({ fresh: true });
  await assert.rejects(k.jam.remove({ id: 'oldstyle' }), (e) => e.status === 409 && e.code === 'unsupported');
  for (const s of [g, h, d, k]) assert.equal(calls(s.m, /^\/jam\/remove/).length, 0);
});

test('remove: a Spotify 400 or 409 on the kick -> 403 jam_refused ("Spotify refused…"), never "try again"; one send each, the upstream status kept for L1; End\'s 409 likewise', async () => {
  const { m, jam } = await hosting();
  const refused = (e) => e.status === 403 && e.code === 'jam_refused' && e.message === 'Spotify refused. Try it in Spotify on your phone or computer.';
  m.answer.remove = () => ({ status: 400 });                   // L1 step 12: the kick may want the username, not the id
  await assert.rejects(jam.remove({ id: 'jake' }), refused);
  assert.equal(m.sends('remove'), 1);
  assert.deepEqual(trace(jam, 'call').filter((e) => e.op === 'remove').map((e) => [e.status, e.up]), [[502, 400]]);
  assert.equal(jam.lastErr.upstream, 400); assert.equal(jam.info().last_error, 'jam_refused');
  m.answer.remove = () => ({ status: 409 });
  await assert.rejects(jam.remove({ id: 'jake' }), refused);
  assert.equal(m.sends('remove'), 2);
  assert.equal(jam.scNow(), 1, 'sc unchanged'); assert.equal(jam.body().cnt, 2);
  m.answer.end = () => ({ status: 409 });
  await assert.rejects(jam.end(), refused);
  assert.equal(m.sends('end'), 1);
  assert.equal(jam.on, true, 'a refused End changes nothing');
  // Spotify's 5xx is still "didn't answer"; a start's 400 is Start's refusal
  m.answer.remove = () => ({ status: 503 });
  await assert.rejects(jam.remove({ id: 'jake' }), (e) => e.status === 502 && e.code === 'spotify_error');
  const s = await setup();
  s.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  s.m.answer.start = () => ({ status: 400 });
  await assert.rejects(s.jam.start(), (e) => e.status === 403 && e.code === 'jam_refused' && /didn’t let Encore start/.test(e.message));
  assert.equal(s.jam.scNow(), 1);
});

// ---------------------------------------------------------------- Start: the session's host device
test('start: a session hosted on another device -> on, host, away + the notice; no confirmation read; End works', async () => {
  const { m, jam, pushes } = await setup();
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.answer.start = () => ({ status: 200, json: (m.spotify = session({ members: ['alex'], hostDev: PC })) });
  const r = await jam.start();
  assert.equal(r.jam.on, 1); assert.equal(r.jam.r, 'host'); assert.equal(r.jam.away, 1); assert.equal(r.jam.wait, undefined);
  assert.ok(pushes.some((x) => x.type === 'notice' && x.data.code === 'jam_away' && x.data.message === 'Spotify started the Jam on Living Room PC. Play it on Encore from there, or end it.'));
  const n0 = m.sends('current');
  await sleep(450);
  await settle(jam);
  assert.equal(m.sends('current'), n0, 'Start step 5 doesn\'t run');
  assert.equal(jam.away, true);
  await jam.end();
  assert.equal(m.sends('end'), 1);
  assert.equal(jam.on, false);
  // Encore's own device: as before (on, no away)
  const b = await setup();
  b.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  const rb = await b.jam.start();
  assert.equal(rb.jam.away, undefined);
});

// ---------------------------------------------------------------- Up Next edits (engine-local)
test('Up Next: ed per §4.4 (no Jam, host, guest, plan B\'s lim, a refused guest or host, jamEdit off, an engine without queue_edit, the fake); rev passes through', async () => {
  const a = await setup();
  a.m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  a.m.next = ROWS();
  let q = (await a.jam.queue()).obj;
  assert.equal(q.ed, 1, 'no Jam: editable');
  assert.match(q.rev, /^[0-9a-f]{16}$/);
  assert.equal(q.rev, a.m.rev());
  const old = await setup({ engine: { queueEdit: false } });
  old.m.load(T(1));
  q = (await old.jam.queue()).obj;
  assert.equal(q.ed, undefined); assert.equal(q.rev, undefined);
  await assert.rejects(old.jam.queueEdit('remove', { uid: 'x', rev: 'y' }), (e) => e.status === 503 && e.code === 'jam_unavailable');
  const h = await hosting();
  assert.equal((await h.jam.queue()).obj.ed, 1, 'host');
  const qe = h.pushes.filter((x) => x.type === 'queue').length;
  h.jam.setFlags({ jamEdit: false });
  assert.equal(h.pushes.filter((x) => x.type === 'queue').length, qe + 1, 'ed changed: a queue event so an open Up Next refetches');
  assert.equal((await h.jam.queue()).obj.ed, undefined, 'jamEdit off in a Jam');
  await assert.rejects(h.jam.queueEdit('remove', { uid: 'x', rev: 'y' }), (e) => e.status === 409 && e.code === 'unsupported');
  const g = await guesting();
  assert.equal((await g.jam.queue()).obj.ed, undefined, 'guest');
  await assert.rejects(g.jam.queueEdit('move', { uid: 'x', rev: 'y', before: '' }), (e) => e.status === 409 && e.code === 'not_host' && e.message === 'Only the Jam’s host can change its queue.');
  // plan B: lim with no session at all (a Jam started in Spotify with Encore playing it: Alex's own, as hosting(),
  // Add to Jam and the transport already take it) edits as its host
  const l = await setup({ sc: undefined });
  l.m.load(T(1), { ctx: JAM(3), origin: SOCIAL });
  l.m.jamEv();
  assert.equal(l.jam.lim(), true); assert.equal(l.jam.hosting(), true);
  assert.equal((await l.jam.queue()).obj.ed, 1, 'plan B\'s lim, no session');
  // a guest whose reads are now refused shows lim but keeps its role: never; a refused host still edits
  const rg = await guesting();
  rg.jam.refused('current', 401);
  assert.equal(rg.jam.lim(), true); assert.equal(rg.jam.role(), 'guest');
  assert.equal((await rg.jam.queue()).obj.ed, undefined, 'a refused guest');
  await assert.rejects(rg.jam.queueEdit('remove', { uid: 'x', rev: 'y' }), (e) => e.code === 'not_host');
  const rh = await hosting();
  rh.jam.refused('current', 401);
  assert.equal(rh.jam.lim(), true); assert.equal(rh.jam.role(), 'host');
  assert.equal((await rh.jam.queue()).obj.ed, 1, 'a refused host');
  const f = await setup();
  f.m.load(T(1));
  f.jam.setFake({ role: 'host', members: 3 });
  assert.equal((await f.jam.queue()).obj.ed, 1, 'fake host');
  f.jam.setFake({ role: 'guest', members: 3 });
  assert.equal((await f.jam.queue()).obj.ed, undefined, 'fake guest: the read-only screen');
  for (const s of [a, old, h, g, l, rg, rh, f]) assert.equal(s.m.edits || 0, 0, 'none of these reached the engine\'s edit routes');
});

test('Up Next edits in plan B (lim with no session, before L0): engine-local, no Spotify request; remembered for edit_lost; jamEdit off hides them', async () => {
  const { m, jam } = await setup({ sc: undefined });
  m.load(T(1), { ctx: JAM(3), origin: SOCIAL });
  m.jamEv();
  m.next = ROWS();
  let q = (await jam.queue()).obj;
  assert.equal(jam.lim(), true); assert.equal(q.ed, 1); assert.equal(q.jam, 1);
  q = (await jam.queueEdit('move', { uid: 'u-c3', before: 'u-c1', rev: q.rev })).queue;
  assert.deepEqual(uids(q.cq), ['u-c3', 'u-c1', 'u-c2']);
  q = (await jam.queueEdit('remove', { uid: 'u-q1', rev: q.rev })).queue;
  assert.deepEqual(uids(q.q), ['u-q2']);
  assert.equal(jam.edits.length, 2, 'remembered: the Jam is on');
  assert.equal(calls(m, /^\/jam\//).length, 0); assert.equal(m.sends(), 0);
  jam.setFlags({ jamEdit: false });
  assert.equal((await jam.queue()).obj.ed, undefined);
  await assert.rejects(jam.queueEdit('remove', { uid: 'u-q2', rev: q.rev }), (e) => e.status === 409 && e.code === 'unsupported');
  assert.equal(m.edits, 2);
});

test('Up Next edits: remove and move go to the engine as received; the reply is the fresh QUEUE (new rev); stale rev -> queue_changed', async () => {
  const { m, jam } = await setup();
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.next = ROWS();
  const q0 = (await jam.queue()).obj;
  let r = await jam.queueEdit('remove', { uid: 'u-q1', rev: q0.rev });
  assert.deepEqual(calls(m, /^\/player\/queue\/remove$/).map((x) => x.body), [{ rev: q0.rev, uid: 'u-q1' }]);
  assert.deepEqual(uids(r.queue.q), ['u-q2']);
  assert.notEqual(r.queue.rev, q0.rev);
  assert.equal(r.queue.rev, m.rev());
  assert.equal(r.queue.ed, 1);
  r = await jam.queueEdit('move', { uid: 'u-c3', before: 'u-c1', rev: r.queue.rev });
  assert.deepEqual(uids(r.queue.cq), ['u-c3', 'u-c1', 'u-c2']);
  r = await jam.queueEdit('move', { uid: 'u-c3', before: '', rev: r.queue.rev });
  assert.deepEqual(uids(r.queue.cq), ['u-c1', 'u-c2', 'u-c3'], '"" = the end of its section');
  assert.deepEqual(uids(r.queue.ap), ['u-a1']);
  assert.deepEqual((await jam.queue()).obj, r.queue, 'the next GET answers the same');
  await assert.rejects(jam.queueEdit('remove', { uid: 'u-q2', rev: q0.rev }), (e) => e.status === 409 && e.code === 'queue_changed' && e.message === 'Up Next changed, so it was refreshed.');
  assert.equal(m.next.length, 5, 'the stale edit changed nothing');
  const ed = trace(jam, 'edit');
  assert.deepEqual(ed.map((e) => [e.op, e.section, e.status]), [['remove', 'q', 200], ['move', 'cq', 200], ['move', 'cq', 200], ['remove', 'q', 409]]);
  assert.deepEqual(jam.info().edits, { n: 3, lost: 0 });
  assert.equal(calls(m, /^\/jam\//).length, 0, 'no Spotify request');
});

test('Up Next edits: the gateway\'s own not_editable checks (autoplay, now, another section, the same row, context while shuffled) and bad bodies, with no engine call', async () => {
  const { m, jam, player } = await setup();
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.next = ROWS();
  const q = (await jam.queue()).obj;
  const no = async (op, b, code, msg) => assert.rejects(jam.queueEdit(op, b), (e) => e.status === (code === 'bad_request' ? 400 : 409) && e.code === code && (!msg || e.message === msg), JSON.stringify(b));
  await no('remove', { uid: 'u-a1', rev: q.rev }, 'not_editable', 'Autoplay songs can’t be moved or removed.');
  await no('remove', { uid: q.now.uid, rev: q.rev }, 'not_editable', 'This song can’t be moved or removed.');
  await no('move', { uid: 'u-q1', before: 'u-c1', rev: q.rev }, 'not_editable', 'Songs can only move within their own section.');
  await no('move', { uid: 'u-c1', before: 'u-a1', rev: q.rev }, 'not_editable', 'Songs can only move within their own section.');
  await no('move', { uid: 'u-c1', before: 'u-c1', rev: q.rev }, 'not_editable');
  player.st.shuffle = true;
  await no('move', { uid: 'u-c2', before: 'u-c1', rev: q.rev }, 'not_editable', 'Turn shuffle off to change these songs.');
  await no('remove', { uid: 'u-c2', rev: q.rev }, 'not_editable', 'Turn shuffle off to change these songs.');
  for (const b of [{ rev: q.rev }, { uid: 'u-q1' }, { uid: 'u-q1', rev: 7 }, { uid: '', rev: q.rev }, { uid: 'x'.repeat(129), rev: q.rev }, { uid: 'u-q1', rev: 'r'.repeat(129) }]) {
    await no('remove', b, 'bad_request');
  }
  await no('move', { uid: 'u-q1', rev: q.rev }, 'bad_request');
  await no('move', { uid: 'u-q1', rev: q.rev, before: null }, 'bad_request');
  assert.equal(m.edits || 0, 0, 'nothing reached the engine');
  // queue rows can still be edited while shuffled
  const r = await jam.queueEdit('move', { uid: 'u-q2', before: 'u-q1', rev: q.rev });
  assert.deepEqual(uids(r.queue.q), ['u-q2', 'u-q1']);
});

test('Up Next edits: the engine\'s answers mapped (400 -> not_editable, 204 -> not_active, 409, down -> 502 engine_error)', async () => {
  const { m, jam } = await setup();
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.next = ROWS();
  const rev = m.rev();                               // no QUEUE served yet: only the engine checks
  await assert.rejects(jam.queueEdit('remove', { uid: 'u-a1', rev }), (e) => e.status === 409 && e.code === 'not_editable' && e.message === 'This song can’t be moved or removed.');
  await assert.rejects(jam.queueEdit('remove', { uid: 'u-gone', rev }), (e) => e.code === 'queue_changed');
  m.st.shuffle = true;
  await assert.rejects(jam.queueEdit('remove', { uid: 'u-c1', rev }), (e) => e.code === 'not_editable');
  m.st.shuffle = false;
  m.noSession = true;
  await assert.rejects(jam.queueEdit('remove', { uid: 'u-q1', rev }), (e) => e.status === 409 && e.code === 'not_active' && e.message === 'Play something on Encore first.');
  m.noSession = false;
  m.down = true;
  await assert.rejects(jam.queueEdit('remove', { uid: 'u-q1', rev }), (e) => e.status === 502 && e.code === 'engine_error');
  m.down = false;
  assert.deepEqual(trace(jam, 'edit').map((e) => e.status), [400, 409, 400, 204, 'error']);
});

test('Up Next edits: one at a time, in order (the second waits for the first, and its stale rev is refused)', async () => {
  const { m, jam, engine } = await setup();
  m.load(T(1), { ctx: 'spotify:playlist:' + 'p'.repeat(22) });
  m.next = ROWS();
  const q = (await jam.queue()).obj;
  m.editDelay = 60;
  const spans = [];
  const send = engine.send;
  engine.send = async (method, p, b, o) => {
    const t0 = Date.now();
    const r = await send(method, p, b, o);
    if (p.startsWith('/player/queue/')) spans.push([t0, Date.now(), b.uid]);
    return r;
  };
  const [a, b] = await Promise.allSettled([jam.queueEdit('remove', { uid: 'u-q1', rev: q.rev }), jam.queueEdit('remove', { uid: 'u-q2', rev: q.rev })]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected'); assert.equal(b.reason.code, 'queue_changed');
  assert.deepEqual(spans.map((s) => s[2]), ['u-q1', 'u-q2']);
  assert.ok(spans[1][0] >= spans[0][1], 'the second started after the first had answered');
  // and a later one with the reply's rev goes through
  const c = await jam.queueEdit('remove', { uid: 'u-q2', rev: a.value.queue.rev });
  assert.deepEqual(c.queue.q, []);
});

test('edit_lost: a removal undone by social-connect\'s transfer counts once; our own add of the song doesn\'t; a move undone counts; no uid or uri in any log line', async () => {
  const { m, jam } = await hosting();
  m.next = ROWS();
  const orig = ROWS();
  let q = (await jam.queue()).obj;
  const out = await captured(async () => {
    q = (await jam.queueEdit('remove', { uid: 'u-c2', rev: q.rev })).queue;
    await sleep(5);
    m.rebuild(orig);                                  // Spotify's copy of the Jam still has the song
    await settle(jam, 40);
    assert.deepEqual(jam.info().edits, { n: 1, lost: 1 });
    assert.equal(trace(jam, 'edit_lost').length, 1);
    m.ev('command', { endpoint: 'set_options', from: SOCIAL });
    m.ev('queue', {});
    await settle(jam, 40);
    assert.equal(jam.info().edits.lost, 1, 'counted once');
    // our own add of a removed song is ours, not Spotify's overwrite
    q = (await jam.queue()).obj;
    q = (await jam.queueEdit('remove', { uid: 'u-c3', rev: q.rev })).queue;
    await sleep(5);
    await jam.add(T('c3'));
    m.ev('command', { endpoint: 'set_options', from: SOCIAL });
    m.ev('queue', {});
    await settle(jam, 40);
    assert.equal(jam.info().edits.lost, 1, 'our own add: not lost');
    // a move that the next transfer puts back
    q = (await jam.queue()).obj;
    q = (await jam.queueEdit('move', { uid: 'u-c1', before: '', rev: q.rev })).queue;
    await sleep(5);
    m.rebuild(orig);
    await settle(jam, 40);
    assert.deepEqual(jam.info().edits, { n: 3, lost: 2 });
  });
  assert.deepEqual(trace(jam, 'edit_lost').map((e) => e.op), ['remove', 'move']);
  for (const s of [...uids(orig), ...orig.map((r) => r.uri), m.spotify.session_id, m.spotify.join_session_token]) assert.equal(out.includes(s), false, `logged: ${s}`);
  assert.match(out, /jam: queue edit remove cq -> 200 in \d+ ms/);
  // outside a Jam nothing is remembered
  const n = await setup();
  n.m.load(T(1));
  n.m.next = ROWS();
  const nq = (await n.jam.queue()).obj;
  await n.jam.queueEdit('remove', { uid: 'u-c2', rev: nq.rev });
  assert.equal(n.jam.edits.length, 0);
});

// Spotify's copy of the Jam: the same songs under its own uids
const respot = (rows) => rows.map((e) => ({ ...e, uid: 's-' + e.uid }));
// one hosted Jam with ROWS() upcoming (c1 and c3 the same song when dup), one edit, then Spotify's next transfer
async function editThen(op, b, after, { dup = false } = {}) {
  const s = await hosting();
  const rows = ROWS();
  if (dup) { rows[4] = { ...rows[4], uri: rows[2].uri, track: track(rows[2].uri) }; }
  s.m.next = rows;
  let q = (await s.jam.queue()).obj;
  q = (await s.jam.queueEdit(op, { ...b, rev: q.rev })).queue;
  await sleep(5);
  const r = {};
  for (const e of s.m.next) r[e.uid.slice(2)] = e;
  s.m.rebuild(respot(after(r)));
  await settle(s.jam, 40);
  return { ...s, q };
}

test('edit_lost: no loss when Spotify kept Encore\'s edit (a guest\'s row lands by a moved row; an add after a row moved to the end of the queue; one copy of a song removed)', async () => {
  const g = ent('g1', 'context');
  // 1. c3 moved before c1; the transfer keeps that order but puts a guest's new row right after c3
  const a = await editThen('move', { uid: 'u-c3', before: 'u-c1' }, (r) => [r.q1, r.q2, r.c3, g, r.c1, r.c2, r.a1]);
  assert.deepEqual(uids(a.q.cq), ['u-c3', 'u-c1', 'u-c2']);
  assert.deepEqual(a.jam.info().edits, { n: 1, lost: 0 });
  // 2. (L1 step 4b/4c) a queued row moved to the end of the queue; B's add is appended to the queue right after it
  const b = await editThen('move', { uid: 'u-q1', before: '' }, (r) => [r.q2, r.q1, ent('g2', 'queue'), r.c1, r.c2, r.c3, r.a1]);
  assert.deepEqual(uids(b.q.q), ['u-q2', 'u-q1']);
  assert.deepEqual(b.jam.info().edits, { n: 1, lost: 0 });
  // 3. two copies of one song upcoming (c1, c3), one removed; the transfer keeps the list exactly as Encore left it
  const c = await editThen('remove', { uid: 'u-c3' }, (r) => [r.q1, r.q2, r.c1, r.c2, r.a1], { dup: true });
  assert.deepEqual(c.jam.info().edits, { n: 1, lost: 0 });
  // 4. a removed song only suggested again by autoplay: not the Jam's list
  const d = await editThen('remove', { uid: 'u-c2' }, (r) => [r.q1, r.q2, r.c1, r.c3, { ...ent('c2', 'autoplay'), uid: 'x-c2' }]);
  assert.deepEqual(d.jam.info().edits, { n: 1, lost: 0 });
  // 5. a moved row whose neighbours both went (played or removed elsewhere) can't be judged: no loss
  const e = await editThen('move', { uid: 'u-c3', before: 'u-c1' }, (r) => [r.q1, r.q2, r.c2, r.c3, r.a1]);
  assert.deepEqual(e.jam.info().edits, { n: 1, lost: 0 });
  for (const s of [a, b, c, d, e]) assert.equal(trace(s.jam, 'edit_lost').length, 0);
});

test('edit_lost: an order the transfer put back counts (a guest\'s row in it too), and so does a removed copy of a song that comes back', async () => {
  const g = ent('g1', 'context');
  const a = await editThen('move', { uid: 'u-c3', before: 'u-c1' }, (r) => [r.q1, r.q2, r.c1, r.c2, r.c3, g, r.a1]);
  assert.deepEqual(a.jam.info().edits, { n: 1, lost: 1 });
  const b = await editThen('move', { uid: 'u-q1', before: '' }, (r) => [ent('g2', 'queue'), r.q1, r.q2, r.c1, r.c2, r.c3, r.a1]);
  assert.deepEqual(b.jam.info().edits, { n: 1, lost: 1 }, 'q1 back before q2');
  const c = await editThen('remove', { uid: 'u-c3' }, (r) => [r.q1, r.q2, r.c1, r.c2, { ...r.c1, uid: 'u-c3' }, r.a1], { dup: true });
  assert.deepEqual(c.jam.info().edits, { n: 1, lost: 1 }, 'the second copy is back');
  assert.deepEqual(trace(c.jam, 'edit_lost').map((x) => x.op), ['remove']);
});

test('trace: a queue entry per changed fetch while on (rows per section, new / gone / moved by uid), none for an unchanged one', async () => {
  const { m, jam } = await hosting();
  m.next = ROWS();
  await jam.queue();
  const first = trace(jam, 'queue').slice(-1)[0];
  assert.deepEqual([first.q, first.cq, first.ap, first.new], [2, 3, 1, 6]);
  const before = trace(jam, 'queue').length;
  await jam.queue();
  assert.equal(trace(jam, 'queue').length, before, 'unchanged: nothing new');
  const r = ROWS();
  m.rebuild([r[0], r[1], r[4], r[2], r[3], r[5]]);     // the PC dragged c3 up two places
  await settle(jam, 40);
  const mv = trace(jam, 'queue').slice(-1)[0];
  assert.deepEqual([mv.new, mv.gone, mv.moved], [0, 0, 1]);
  m.rebuild([r[0], r[1], r[4], r[2], ent('c9', 'context'), r[5]]);
  await settle(jam, 40);
  const ch = trace(jam, 'queue').slice(-1)[0];
  assert.deepEqual([ch.new, ch.gone, ch.moved], [1, 1, 0]);
  assert.deepEqual(trace(jam, 'command').slice(-1).map((e) => [e.ep, e.from, e.continues]), [['transfer', 'social-connect-*', 1]]);
});

test('admin info: the session as C0 named it (kinds and key names only), edits, flags with jamEdit; no ids, tokens or names', async () => {
  const { m, jam } = await hosting();
  m.push('USER_JOINED', m.spotify);
  const i = jam.info();
  assert.equal(i.session.host_dev, 'encore');
  assert.deepEqual(i.session.caps, { invite: true, remove: true, manage: true });
  assert.equal(i.session.owner_match, 'id');
  assert.match(i.session.share, /^no scheme, open\.spotify\.com$/);
  assert.equal(i.session.keys.caps, 'user_capabilities');
  assert.equal(i.queue_edit, true);
  assert.equal(i.flags.jamEdit, true);
  const text = JSON.stringify(i);
  for (const s of [m.spotify.session_id, m.spotify.join_session_token, sid32('alex'), sid32('jake'), 'jake', 'Jake', 'Alex', 'encoredev0001']) assert.equal(text.includes(s), false, s);
  assert.throws(() => jam.setFlags({ jamEdit: 'no' }), (e) => e.status === 400);
  jam.setFlags({ jamEdit: false });
  assert.equal(jam.info().flags.jamEdit, false);
});
