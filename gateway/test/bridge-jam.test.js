'use strict';
// Jams end to end (DESIGN-4b.md §7.3): the real bridge (src/main.js, started as a child process) against the patch-3
// stub engine (support/stub-jam-engine.js: the jam-engine.js model with the engine's gate, 1 s between sends), all on
// 127.0.0.1 with free ports. The stub's "Spotify" is scripted: nothing here can reach Spotify. Every /v1 request is
// HMAC-signed like the phone's. Covers C0-shaped sessions and session_update pushes, Remove (C0's kick), Up Next
// remove/move with rev (engine-local).
// Slow (about 10 minutes): it runs only with ENCORE_SLOW_TESTS=1. Needs a POSIX FIFO (Linux, macOS) and ffmpeg on PATH.
//   ENCORE_SLOW_TESTS=1 node gateway/test/bridge-jam.test.js        (LIVE=1 also prints the bridge's log)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { JamEngine, session, member, track, T, JAM, SOCIAL, sid32 } = require('./support/jam-engine');
const { startStubJamEngine } = require('./support/stub-jam-engine');
const { needs, freePort, ffmpeg } = require('./support/platform');
const { version } = require('../src/config');

const SKIP = needs({ slow: true, fifo: true, ffmpeg: true });
const MAIN = path.join(__dirname, '..', 'src', 'main.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PORT = 0;                                                  // the bridge's, picked at start
let ROOT = '';                                                 // a temporary folder, made at start
const SECRET = crypto.randomBytes(32).toString('base64');
const PL = 'spotify:playlist:' + 'P'.repeat(22);

function req(method, pathq, { body, etag, sign = true, auth } = {}) {
  return new Promise((resolve, reject) => {
    const b = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const headers = {};
    if (sign) {
      const t = String(Math.floor(Date.now() / 1000));
      const h = crypto.createHash('sha256').update(b).digest('hex');
      headers['X-Encore-Device'] = 'dev_test';
      headers['X-Encore-Time'] = t;
      headers['X-Encore-Sig'] = crypto.createHmac('sha256', Buffer.from(SECRET, 'base64')).update(`${method}\n${pathq}\n${t}\n${h}`).digest('hex');
    }
    if (auth) headers.Authorization = 'Basic ' + Buffer.from('x:pw').toString('base64');
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = b.length; }
    if (etag) headers['If-None-Match'] = etag;
    headers['Accept-Encoding'] = 'gzip';
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: pathq, headers }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(parts);
        const text = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString() : raw.toString();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(70000, () => r.destroy(new Error(`${method} ${pathq}: no answer`)));
    r.end(b);
  });
}
const admin = (method, p, body) => req(method, p, { sign: false, auth: true, body });

let cursor = 0;
async function events() {
  const r = await req('GET', `/v1/events?cursor=${cursor}&timeout=0`);
  cursor = r.json.cursor;
  return r.json.events;
}
const jamEvs = (list) => list.filter((e) => e.type === 'jam' && e.data.ev).map((e) => e.data.ev);
const gen = async () => (await req('GET', '/v1/player/state')).json.gen;

async function main() {
  const m = new JamEngine({ spacingMs: 1000 });
  const { srv: engineSrv } = await startStubJamEngine(m, 0);
  PORT = await freePort();
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-bridge-jam-'));
  fs.mkdirSync(ROOT + '/data', { recursive: true });
  fs.writeFileSync(ROOT + '/data/devices.json', JSON.stringify({ dev_test: { name: 'Test iPhone', secret: SECRET, created: new Date().toISOString(), last_seen: null } }));
  const gw = spawn(process.execPath, [MAIN], { env: { ...process.env, PORT: String(PORT), DATA_DIR: ROOT + '/data', PCM_FIFO: ROOT + '/pipe/encore.pcm',
    ENGINE_URL: `http://127.0.0.1:${engineSrv.address().port}`, FFMPEG: ffmpeg, ADMIN_PASSWORD: 'pw', ADMIN_ALLOW: '', ADMIN_TRUST_PROXY: '',
    SPOTIFY_CLIENT_ID: '',
    UPDATE_CHECK: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });     // (no automatic update check in a test: its first look is at 10 min)
  let out = '';
  const live = process.env.LIVE === '1';
  gw.stdout.on('data', (d) => { out += d; if (live) process.stdout.write('  gw| ' + d); });
  gw.stderr.on('data', (d) => { out += d; if (live) process.stdout.write('  gw| ' + d); });
  for (let i = 0; i < 50 && !/listening on/.test(out); i++) await sleep(100);
  await sleep(800);
  ok(out.includes(`Encore Bridge ${version} starting`), `the bridge ${version} started`);
  const pauses = () => m.count(/^\/player\/pause/);
  const plays = () => m.count(/^\/player\/play/);

  try {
    // ---------------------------------------------------------------- no Jam, before L0
    let r = await req('GET', '/v1/status');
    ok(r.json.gateway.version === version && r.json.jam && r.json.jam.calls === 0 && !('sc' in r.json.jam), `/v1/status jam ${JSON.stringify(r.json.jam)}`);
    r = await req('GET', '/v1/jam');
    ok(r.status === 200 && JSON.stringify(r.json) === '{"x":{}}' && /^"[0-9a-f]{20}"$/.test(r.headers.etag), `/v1/jam with no Jam and no check: ${JSON.stringify(r.json)}`);
    const e0 = r.headers.etag;
    r = await req('GET', '/v1/jam', { etag: e0 });
    ok(r.status === 304, '/v1/jam: 304 on the ETag');
    r = await req('POST', '/v1/jam/start', { body: {} });
    ok(r.status === 503 && r.json.error.code === 'jam_unavailable', `start before L0: ${r.status} ${r.json.error.code}`);
    r = await req('POST', '/v1/jam/join', { body: { link: 'https://example.com/x' } });
    ok(r.status === 400 && r.json.error.code === 'bad_link', 'join: a bad link 400');
    r = await req('POST', '/v1/jam/join', { body: { link: 'https://open.spotify.com/socialsession/AbcdEf_123' } });
    ok(r.status === 503 && r.json.error.code === 'jam_unavailable', 'join before L0: 503');
    for (const a of ['leave', 'end', 'settings', 'remove']) {
      r = await req('POST', '/v1/jam/' + a, { body: {} });
      ok(r.status === 409 && r.json.error.code === 'not_in_jam', `${a} with no Jam: 409 not_in_jam`);
    }
    r = await req('GET', '/v1/player/queue');
    ok(r.status === 200 && Array.isArray(r.json.q) && r.json.q.length === 0 && !r.json.now, `Up Next with nothing loaded: ${JSON.stringify(r.json)}`);
    r = await req('POST', '/v1/player/play', { body: { context_uri: 'spotify:socialsession:AbcdEf_123' } });
    ok(r.status === 400 && r.json.error.code === 'bad_request' && plays() === 0, 'a Jam link as a play (app 0.5.1): 400, nothing reaches the engine');
    ok(m.sends() === 0, 'nothing reached social-connect');
    await events();

    // ---------------------------------------------------------------- plan B: a Jam started on the PC (lim), then L0
    m.load(T(1), { ctx: PL });
    await sleep(300);
    m.jamStarts(1, T(100));
    await sleep(2500);
    r = await req('GET', '/v1/jam?w=1');
    ok(r.json.on === 1 && r.json.lim === 1 && !r.json.r && r.json.x.add === 1 && !r.json.x.sc, `lim before L0: ${JSON.stringify(r.json)}`);
    r = await req('GET', '/v1/player/state');
    ok(r.json.jam && r.json.jam.lim === 1 && r.json.jam.cnt === 0, `snapshot jam ${JSON.stringify(r.json.jam)}`);
    r = await req('GET', '/v1/player/queue');
    ok(r.status === 200 && r.json.ed === 1 && r.json.jam === 1, `plan B (lim, no session): Up Next editable as its host (ed ${r.json.ed})`);
    let ev = jamEvs(await events());
    ok(ev.length === 1 && ev[0].k === 'start', `ev start for a Jam started elsewhere (${JSON.stringify(ev)})`);
    ok(m.sends() === 0, 'sc unknown: no read, lease or not');
    await sleep(26000);                                    // that lease runs out before L0 (phase A is lease-free)
    ok(m.sends() === 0, 'still nothing after the lease ran out');
    m.spotify = session({ members: ['alex', 'jake'], sid: 'sessT3one0000', token: 'tokT3one000' });
    r = await admin('POST', '/admin/api/jam/check', {});
    ok(r.json.verdict === 'accepted' && m.sends('current') === 1, `L0 check: ${r.json.verdict} (${r.json.reason})`);
    r = await req('GET', '/v1/jam');
    ok(r.json.r === 'host' && r.json.cnt === 2 && r.json.x.sc === 1 && r.json.t === 'tokT3one000' && r.json.ci && r.json.hn === 'Alex', `after L0: host, 2 members, x ${JSON.stringify(r.json.x)}`);
    await sleep(600);                                      // the gate's counters arrive with the /status refresh after a call
    r = await req('GET', '/v1/status');
    ok(r.json.jam.sc === 1 && r.json.jam.calls === 1, `/v1/status jam after L0 ${JSON.stringify(r.json.jam)}`);

    // ---------------------------------------------------------------- phase A: 2 min without a lease, Jam events, pushes
    const tA = Date.now();
    const readsA = m.sends('current');
    const pausesA = pauses();
    let g = await gen();
    m.guestAdd(T(10), 'jake');
    await sleep(1500);
    ok(await gen() === g, 'a guest add: no generation');
    r = await req('GET', '/v1/player/queue');
    ok(r.json.jam === 1 && r.json.q[0].u === T(10) && r.json.q[0].by === 'jake' && r.json.ctx.n === 'Alex’s Jam', `Up Next: the add with by=jake (${JSON.stringify(r.json.q[0])})`);
    const qe = r.headers.etag;
    r = await req('GET', '/v1/player/queue', { etag: qe });
    ok(r.status === 304, 'Up Next: 304');
    m.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: false });
    m.load(T(11), { origin: SOCIAL, position: 198000 });
    await sleep(800);
    ok(await gen() === g + 1, 'a guest skip: one generation');
    g = await gen();
    m.ev('social_connect', { uri: 'hm://social-connect/v2/sessions/' + 'a1b2c3d4e5f6a7b8c9d0', payload: { session: { session_id: 'sessT3one0000' }, update_reason: 'MEMBER_JOINED' } });
    m.ev('social_connect', { uri: 'hm://social-connect/v2/sessions/' + 'a1b2c3d4e5f6a7b8c9d0', payload_bytes: 512 });
    r = await admin('POST', '/admin/api/jam/flags', { hostAdd: 'off' });
    ok(r.status === 200 && r.json.flags.hostAdd === 'off', 'flags: hostAdd off at runtime');
    r = await req('GET', '/v1/jam');
    ok(r.json.x.add === undefined, 'x.add gone with hostAdd off');
    r = await req('POST', '/v1/player/queue', { body: { uri: T(12) } });
    ok(r.status === 409 && r.json.error.code === 'unsupported', 'Add to Jam with hostAdd off: 409 unsupported');
    await admin('POST', '/admin/api/jam/flags', { hostAdd: 'local' });
    r = await req('POST', '/v1/player/queue', { body: { uri: T(12) } });
    ok(r.status === 200 && m.count(/^\/player\/add_to_queue/) === 1, 'Add to Jam (host, local): the engine queue');
    await sleep(16000);
    m.load(T(13));                                         // no command for 16 s: the song simply ended
    await sleep(800);
    ok(await gen() === g, 'a natural song end: no generation');
    while (Date.now() - tA < 120000) {
      m.ev('social_connect', { uri: 'hm://social-connect/v2/sessions/' + 'f'.repeat(20), payload: { reason: 'x' } });
      m.ev('queue', {});
      await sleep(10000);
    }
    ok(m.sends('current') === readsA, `no /jam/current in 2 min without a lease (${m.sends('current') - readsA}), pushes or not`);
    ok(pauses() === pausesA, 'no 45 s idle pause in a Jam (nobody listened for 2 min)');
    r = await admin('GET', '/admin/api/status');
    const dj = r.json.jam;
    ok(dj.dealer.n >= 8 && dj.dealer.uris.every((u) => /^hm:\/\/social-connect\/v2\/sessions\/\*$/.test(u.uri)), `admin: dealer pushes counted, URIs masked (${JSON.stringify(dj.dealer.uris)})`);
    ok(dj.loads.natural >= 1 && dj.loads.commands >= 1 && dj.foreign_loads_10m >= 1, `admin: loads ${JSON.stringify(dj.loads)}, foreign ${dj.foreign_loads_10m}`);

    // ---------------------------------------------------------------- phase B: 2 min with a lease
    const readsB = m.sends('current');
    const tB = Date.now();
    m.spotify.session_members.push({ username: 'emma', display_name: 'Emma' });
    while (Date.now() - tB < 120000) {
      r = await req('GET', '/v1/jam?w=1');
      m.ev('social_connect', { uri: 'hm://social-connect/v2/sessions/' + 'f'.repeat(20), payload: { reason: 'y' } });
      await sleep(Math.min(20000, 120000 - (Date.now() - tB)));
    }
    const nB = m.sends('current') - readsB;
    ok(nB >= 5 && nB <= 7, `with a lease: ${nB} reads in 2 min (≤ 7)`);
    ev = jamEvs(await events());
    ok(ev.some((x) => x.k === 'in' && x.n === 'Emma'), `ev in from a lease read (${JSON.stringify(ev)})`);

    // ---------------------------------------------------------------- 4b-c: a pushed join, Remove (C0's kick), Up Next edits
    const readsE = m.sends('current');
    m.spotify.session_members.push(member('rowan'));
    m.push('USER_JOINED', m.spotify, [member('rowan')]);
    await sleep(600);
    r = await req('GET', '/v1/jam');
    ev = jamEvs(await events());
    ok(r.json.m.some((x) => x.n === 'Rowan' && /^[0-9a-f]{40}$/.test(x.i)) && ev.some((x) => x.k === 'in' && x.n === 'Rowan') && m.sends('current') === readsE,
      `a pushed USER_JOINED reaches GET /v1/jam (with the picture) and ev in, with no /jam/current request (${m.sends('current') - readsE})`);
    ok(r.json.x.kick === 1 && r.json.l === 'https://open.spotify.com/socialsession/tokT3one000' && r.json.ci, `x.kick, the session's own share link, the code (${JSON.stringify(r.json.x)})`);
    const jakeId = r.json.m.find((x) => x.n === 'Jake').id;
    const cnt0 = r.json.cnt;
    r = await req('POST', '/v1/jam/remove', { body: { id: jakeId } });
    const rms = m.log.filter((x) => x.path === '/jam/remove');
    ok(r.status === 200 && r.json.jam.cnt === cnt0 - 1 && rms.length === 1 && rms[0].body.member_id === sid32('jake'),
      `Remove: one /jam/remove with the member's Spotify id (${r.status}, ${rms.length})`);
    ev = jamEvs(await events());
    ok(ev.some((x) => x.k === 'out' && x.n === 'Jake') && m.sends('current') === readsE, 'Remove: ev out from the kick\'s reply, no read');
    const ent = (tag, provider) => ({ uri: T(tag), uid: 'e-' + tag, provider, metadata: provider === 'queue' ? { is_queued: 'true' } : {}, track: track(T(tag)) });
    const rows = () => [ent('q1', 'queue'), ent('q2', 'queue'), ent('c1', 'context'), ent('c2', 'context'), ent('c3', 'context'), ent('a1', 'autoplay')];
    m.next = rows();
    r = await req('GET', '/v1/player/queue');
    const rev0 = r.json.rev;
    ok(r.json.ed === 1 && /^[0-9a-f]{16}$/.test(rev0) && rev0 === m.rev(), `Up Next as host: ed and the engine's rev (${JSON.stringify({ ed: r.json.ed, rev: rev0 })})`);
    const jc = m.count(/^\/jam\//);
    r = await req('POST', '/v1/jam/queue/remove', { body: { uid: 'e-q1', rev: rev0 } });
    ok(r.status === 200 && r.json.queue.rev !== rev0 && !r.json.queue.q.some((x) => x.uid === 'e-q1') && !m.next.some((x) => x.uid === 'e-q1'),
      `Up Next remove: the stub's list and the reply changed (${r.status})`);
    r = await req('POST', '/v1/jam/queue/move', { body: { uid: 'e-c3', before: 'e-c1', rev: r.json.queue.rev } });
    const rev2 = r.status === 200 ? r.json.queue.rev : '';
    ok(r.status === 200 && r.json.queue.cq.map((x) => x.uid).join() === 'e-c3,e-c1,e-c2', `Up Next move (${r.status})`);
    r = await req('GET', '/v1/player/queue');
    ok(r.json.rev === rev2 && r.json.cq[0].uid === 'e-c3', 'the next GET /v1/player/queue shows the edits, with the new rev');
    r = await req('POST', '/v1/jam/queue/remove', { body: { uid: 'e-q2', rev: rev0 } });
    ok(r.status === 409 && r.json.error.code === 'queue_changed' && m.next.some((x) => x.uid === 'e-q2'), 'a stale rev: 409 queue_changed, nothing changed');
    r = await req('POST', '/v1/jam/queue/move', { body: { uid: 'e-a1', before: '', rev: rev2 } });
    ok(r.status === 409 && r.json.error.code === 'not_editable', 'an autoplay row: 409 not_editable');
    r = await req('POST', '/v1/jam/queue/move', { body: { uid: 'e-q2', rev: rev2 } });
    ok(r.status === 400 && r.json.error.code === 'bad_request', 'a move without before: 400');
    ok(m.count(/^\/jam\//) === jc, 'Up Next edits: no Spotify request');
    m.rebuild(rows());                                     // social-connect's copy of the Jam puts the removed song back
    await sleep(1000);
    r = await admin('GET', '/admin/api/status');
    ok(r.json.jam.queue_edit === true && r.json.jam.edits.n === 2 && r.json.jam.edits.lost === 2 && r.json.jam.session.host_dev === 'encore',
      `admin: edits ${JSON.stringify(r.json.jam.edits)}, session ${JSON.stringify(r.json.jam.session)}`);
    r = await admin('GET', '/admin/api/jam/trace');
    ok(r.json.trace.some((x) => x.k === 'edit_lost') && r.json.trace.some((x) => x.k === 'queue' && x.new >= 1) && r.json.trace.some((x) => x.k === 'session' && x.src === 'push'),
      'trace: edit_lost, the queue diff, the pushed session');
    m.next = [];

    // ---------------------------------------------------------------- the Jam ends: set_options off, then item 10's idle
    m.spotify = null;
    m.jamEnds({ setOptionsOff: true, item10: true });
    await sleep(1500);
    r = await req('GET', '/v1/jam');
    ev = jamEvs(await events());
    ok(!r.json.on && ev.length === 1 && ev[0].k === 'end' && !ev[0].n, `end (set_options off + item 10): off, ev end without n (${JSON.stringify(ev)})`);
    const readsC = m.sends('current');
    const tC = Date.now();
    while (Date.now() - tC < 120000) {                      // 2 min of the old Jam's engine events
      m.st.mode = '';
      m.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: false });
      m.load(T(100), { ctx: JAM(1), origin: SOCIAL });
      m.jamEv();
      await sleep(15000);
      r = await req('GET', '/v1/jam?w=1');
      if (r.json.on) break;
    }
    ok(!r.json.on, 'stays off through 2 min of further engine events');
    ok(m.sends('current') === readsC, 'no reads while no Jam plays on Encore (lease or not)');

    // ---------------------------------------------------------------- a second Jam (PC) ends without set_options off
    m.spotify = session({ members: ['alex', 'liam'], sid: 'sessT3two0000', token: 'tokT3two000' });
    m.st.mode = '';
    m.jamEv();
    m.jamStarts(2, T(200));
    await sleep(3500);
    r = await req('GET', '/v1/jam');
    ok(r.json.on === 1 && r.json.r === 'host' && r.json.cnt === 2, 'a new Jam (mode off -> on): on, read 2 s later');
    m.spotify = null;
    m.jamEnds({ setOptionsOff: false, item10: true });
    await sleep(1500);
    r = await req('GET', '/v1/jam');
    ok(!r.json.on, 'end without set_options off: off');
    const tD = Date.now();
    while (Date.now() - tD < 120000) {
      m.st.mode = '';
      m.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: false, jam_end: true });
      m.st.ctx = JAM(2);
      m.st.origin = SOCIAL;
      m.jamEv();
      await sleep(15000);
      r = await req('GET', '/v1/jam');
      if (r.json.on) break;
    }
    ok(!r.json.on, 'stays off through 2 min of further engine events (order 2)');
    await events();

    // ---------------------------------------------------------------- our own Start (never confirmed -> wait), then End
    m.st.origin = null;
    m.st.mode = '';
    m.load(T(20), { ctx: PL });
    m.jamEv();
    await sleep(600);
    r = await req('POST', '/v1/jam/start', { body: {} });
    ok(r.status === 200 && r.json.jam.r === 'host' && r.json.jam.on === 1, `start: ${r.status} ${JSON.stringify(r.json.jam || r.json)}`);
    ok(m.sends('start') === 1 && m.sends('current') >= readsC + 2, 'start: the pre-check read, then current_or_new');
    await sleep(17500);
    r = await req('GET', '/v1/jam');
    ok(r.json.wait === 1 && m.sends('end') === 0, `never confirmed: wait (${JSON.stringify(r.json)}), no End`);
    m.jamStarts(3, T(300));
    await sleep(500);
    r = await req('GET', '/v1/jam');
    ok(r.json.on === 1 && !r.json.wait, 'the engine confirms: wait cleared');
    m.next = [{ uri: T(31), uid: 'n31', provider: 'queue', metadata: {}, track: track(T(31)) }, { uri: T(32), uid: 'n32', provider: 'context', metadata: {}, track: null }];
    r = await req('GET', '/v1/player/queue');
    ok(r.json.cq[0].x === 1 && r.json.retry_ms === 1500, 'Up Next: an x row and retry_ms');
    m.answer.end = () => { setTimeout(() => m.jamEnds({ setOptionsOff: true, item10: true }), 200); return { status: 200, json: {} }; };
    const p0 = plays();
    r = await req('POST', '/v1/jam/end', { body: {} });
    ok(r.status === 200 && JSON.stringify(Object.keys(r.json.jam)) === '["x"]' && r.json.gen, `end: ${r.status}, gen ${r.json.gen}`);
    ok(plays() - p0 === 1, `our End restarted exactly once (${plays() - p0})`);
    ok(m.count(/^\/player\/add_to_queue/) >= 3, 'the upcoming rows went back into the queue');
    ev = jamEvs(await events());
    ok(ev.filter((x) => x.k === 'end').length === 1 && !ev.find((x) => x.k === 'end').n, 'our own End: ev end without n');
    delete m.answer.end;

    // ---------------------------------------------------------------- a guest: join, guards, leave
    m.spotify = session({ owner: true, members: ['jake', 'emma'], hostId: 'jake', sid: 'sessT3jake000', token: 'jakeTokT3x' });
    const orig = m.spotifyAnswer.bind(m);
    m.spotifyAnswer = async (op, a) => {
      const res = await orig(op, a);
      if (op === 'join' && res.status === 200) {
        setTimeout(() => { m.st.mode = 'on'; m.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: false }); m.load(T(400), { ctx: JAM(4), origin: SOCIAL }); m.jamEv(); }, 300);
      }
      return res;
    };
    await sleep(4500);                                       // our End's play has started (its 4 s silence fallback)
    g = await gen();
    r = await req('POST', '/v1/jam/join', { body: { link: 'https://open.spotify.com/intl-de/socialsession/jakeTokT3x?si=abc' } });
    const ci = m.calls.filter((c) => c.op === 'info').pop();
    const cj = m.calls.filter((c) => c.op === 'join').pop();
    ok(r.status === 200 && r.json.jam.r === 'guest' && r.json.jam.hn === 'Jake' && cj.t - ci.t >= 990, `join: guest of Jake, info -> join ${cj.t - ci.t} ms apart`);
    ok(r.json.gen > g, `join: the Jam's audio is gen ${r.json.gen}`);
    r = await req('POST', '/v1/player/next', { body: {} });
    ok(r.status === 403 && r.json.error.code === 'jam_no_control' && r.json.error.message === 'Only Jake can control the Jam’s playback. You can still add songs.', 'guest next: 403 jam_no_control');
    r = await req('POST', '/v1/player/play', { body: { uri: T(1) } });
    ok(r.status === 409 && r.json.error.code === 'in_jam', 'guest play: 409 in_jam');
    const pj = plays();
    r = await req('POST', '/v1/player/play', { body: { context_uri: 'https://open.spotify.com/socialsession/AbcdEf_123' } });
    ok(r.status === 400 && r.json.error.code === 'bad_request' && plays() === pj, 'a guest\'s Jam link play: 400, ahead of the guest rules');
    const pp = pauses();
    r = await req('POST', '/v1/player/pause', { body: { played_ms: 1000, uri: T(400) } });
    await sleep(300);
    ok(r.status === 200 && pauses() === pp, 'a guest pause from the phone reaches the engine as nothing');
    r = await req('POST', '/v1/player/queue', { body: { uri: T(5) } });
    ok(r.status === 409 && r.json.error.code === 'unsupported', 'guest Add to Jam before D2: 409 unsupported');
    r = await req('POST', '/v1/jam/join', { body: { link: 'jakeTokT3x' } });
    ok(r.status === 200 && r.json.jam.r === 'guest', 'join the same Jam again: the current state');
    r = await req('POST', '/v1/jam/end', { body: {} });
    ok(r.status === 409 && r.json.error.code === 'not_host', 'guest end: 409 not_host');
    r = await req('POST', '/v1/jam/leave', { body: {} });
    ok(r.status === 200 && JSON.stringify(Object.keys(r.json.jam)) === '["x"]', 'leave: 200 {jam:{x}}');
    await sleep(3800);
    ok(pauses() === pp + 1, 'after leaving, the local pause (the engine still played the Jam)');
    ok(m.count(/^\/jam\/forget/) >= 1 && m.st.mode === 'off', 'the engine\'s Jam mode switched off (/jam/forget)');
    ev = jamEvs(await events());
    ok(ev.some((x) => x.k === 'join' && x.n === 'Jake') && ev.some((x) => x.k === 'leave' && !x.why), `ev join / leave (${JSON.stringify(ev)})`);
    m.spotifyAnswer = orig;

    // ---------------------------------------------------------------- the fake Jam never reaches the engine's /jam/*
    const jamCalls = m.count(/^\/jam\//);
    r = await admin('POST', '/admin/api/jam/fake', { role: 'host', members: 5 });
    ok(r.status === 200, 'fake host');
    r = await req('GET', '/v1/jam?w=1');
    ok(r.json.fake === 1 && r.json.cnt === 5 && r.json.r === 'host' && !r.json.ci, `fake JAM ${JSON.stringify({ cnt: r.json.cnt, x: r.json.x })}`);
    r = await req('POST', '/v1/jam/settings', { body: { gc: true } });
    ok(r.status === 200 && r.json.jam.gc === 1, 'fake settings');
    r = await req('POST', '/v1/jam/remove', { body: { id: r.json.jam.m[2].id } });
    ok(r.status === 200 && r.json.jam.cnt === 4, 'fake remove');
    r = await req('POST', '/v1/jam/end', { body: {} });
    ok(r.status === 200 && !r.json.jam.on, 'fake end');
    r = await admin('POST', '/admin/api/jam/fake', { role: 'guest', members: 3, x: { add: 0 } });
    r = await req('POST', '/v1/player/queue', { body: { uri: T(6) } });
    ok(r.status === 409 && r.json.error.code === 'unsupported', 'fake guest without x.add: 409');
    await admin('POST', '/admin/api/jam/fake', { role: null });
    ok(m.count(/^\/jam\//) === jamCalls, 'fake mode never called the engine\'s /jam/*');

    // ---------------------------------------------------------------- admin, trace, privacy
    r = await admin('GET', '/admin/api/jam/trace');
    const tr = JSON.stringify(r.json);
    ok(r.json.trace.length > 20 && r.json.trace.some((x) => x.k === 'command' && x.from === 'social-connect-*'), `trace: ${r.json.trace.length} entries, senders masked`);
    r = await admin('GET', '/admin/api/status');
    const st = JSON.stringify(r.json.jam);
    const secrets = ['sessT3one0000', 'tokT3one000', 'sessT3two0000', 'tokT3two000', 'sessT3jake000', 'jakeTokT3x', 'jake', 'Jake', 'emma', 'Emma', 'liam', 'rowan', 'Rowan',
      'a1b2c3d4e5f6a7b8c9d0', m.calls.length ? SOCIAL.slice(15) : 'x', ...['alex', 'jake', 'emma', 'liam', 'rowan'].map(sid32), 'e-q1', 'e-c3', T('q1'), T('c3')];
    ok(!secrets.some((s) => tr.includes(s) || st.includes(s)), 'trace and admin status: no ids, tokens or names');
    ok(!secrets.some((s) => out.includes(s)), `the gateway log: no session ids, tokens, member ids or names (${secrets.filter((s) => out.includes(s)).join(',') || 'none'})`);
    r = await admin('POST', '/admin/api/jam/trace/reset', {});
    r = await admin('GET', '/admin/api/jam/trace');
    ok(r.json.trace.length === 0 && r.json.info.loads.commands === 0, 'trace reset (and the per-test counters)');
    const persisted = JSON.parse(fs.readFileSync(ROOT + '/data/jam.json', 'utf8'));
    ok(persisted.sc === 1 && persisted.okStart === 1 && persisted.byKey === 'added_by' && !persisted.sid, `jam.json ${JSON.stringify(Object.keys(persisted))}`);
    ok(m.sends() <= 30, `social-connect sends in the whole run: ${m.sends()} (renewals ${m.gate.renewals})`);
  } catch (e) {
    fails++;
    console.log('FAIL (exception)', e.stack);
  }
  if (fails) console.log('---- gateway log (last 60 lines) ----\n' + out.trim().split('\n').slice(-60).join('\n'));
  console.log(fails ? `bridge-jam: ${fails} FAILED` : 'bridge-jam: all checks passed');
  gw.kill();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(fails ? 1 : 0);
}

if (SKIP) test('Jams end to end: the real bridge against the patch-3 stub engine', { skip: SKIP }, () => {});
else main().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
