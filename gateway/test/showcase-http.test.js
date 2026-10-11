'use strict';
// Showcase over HTTP (http.js + showcase.js, RELEASE-PLAN D4): the admin switch, the server-side trimming of the admin
// answers, phone diagnostics refused while it is on, and the phone API left alone (each phone has its own Anonymous
// Mode). A local server with stubs: no engine, no Spotify. Every name below is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('../src/http');
const { AdminAuth } = require('../src/adminauth');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-showcase-http-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const PW = 'pw-admin-showcase';
const AUTH = { Authorization: 'Basic ' + Buffer.from('admin:' + PW).toString('base64') };
const ID = { account: 'alexexample42', accountName: 'Alex Example', phone: 'Sam Sample’s iPhone', dev: 'dev_0123456789abcdef',
  seen: '2026-10-07T12:34:56.000Z', pc: 'Alex’s Work Laptop', host: 'Jordan Host', hostId: 'jordanhost77' };
const leaks = (text) => Object.values(ID).filter((v) => text.includes(v));

function capture() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, orig) };
}

async function server({ dir = tmp() } = {}) {
  const cfg = { dataDir: dir, version: '1.1.0', minApp: '1.0.0', tiers: { high: 256 }, defaultTier: 'high', adminPassword: PW };
  const snapshot = () => ({
    gen: 4, status: 'playing', position_ms: 1000, context_uri: `spotify:user:${ID.account}:collection`,
    track: { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', name: 'A Made-Up Song', artists: ['The Placeholders'], album: 'Sample Album', by: ID.hostId },
    remote: { device: ID.pc, type: 'computer', is_playing: true, track: null, position_ms: 0 },
    jam: { r: 'guest', hn: ID.host, cnt: 3 }, account: true,
  });
  const ctx = {
    cfg, adminAuth: new AdminAuth({ cfg }),
    player: { lastPhone: Date.now(), pollRemote: async () => {}, snapshot, st: { active: true, status: 'playing' }, genInfo: new Map(), pending: null,
      heardInfo: () => null, syncInfo: () => ({ supported: true, delay_ms: 0 }), publish() {}, remote: null,
      pause: async () => ({ gen: 4, stream: '/v1/stream?gen=4', state: snapshot() }) },
    auth: { verify: () => ({ id: ID.dev, name: ID.phone }), list: () => [{ id: ID.dev, name: ID.phone, created: ID.seen, last_seen: ID.seen }],
      revoke: () => true, newCode: () => ({ code: '123456' }) },
    bus: { wait: async () => [] },
    encoders: { warmAll() {}, info: () => [] },
    engine: { connected: true },
    clock: { sample: 0, lead: () => 0, leadMs: 10000, frozen: null, pipeBytes: 0, stats: { real: 0, silence: 0 } },
    started: Date.now(),
    webapi: { user: { id: ID.account, name: ID.accountName, product: 'premium' },
      info() { return { configured: true, connected: !!this.user, user: this.user, window: 0, last429_path: `/users/${ID.account}/playlists` }; },
      disconnect() { this.user = null; } },
    catalog: { counters: () => ({}), info: async () => ({ playlists: 3, enumerating: [{ ctx: `spotify:user:${ID.account}:collection`, age_s: 1 }] }) },
    images: { info: () => ({}) }, lyrics: { info: () => ({}) }, membership: { info: () => ({}) },
    jam: { statusInfo: () => ({}), info: () => ({ on: true, members: 3 }) }, personal: {}, social: null,
  };
  const srv = createServer(ctx);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = (p, { method = 'GET', headers = {}, body, type = 'application/json' } = {}) => new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null && type) h['Content-Type'] = type;
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        resolve({ status: res.statusCode, text, j });
      });
    });
    rq.on('error', reject);
    if (body != null) rq.write(typeof body === 'string' ? body : JSON.stringify(body));
    rq.end();
  });
  return { call, dir, ctx, close: () => new Promise((r) => srv.close(r)) };
}

test('admin: the switch is off at first; the status is as before, plus showcase:false', async () => {
  const s = await server();
  try {
    let r = await s.call('/admin/api/showcase', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(r.j, { showcase: false });
    r = await s.call('/admin/api/status', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.equal(r.j.showcase, false);
    assert.equal(r.j.spotify.user.name, ID.accountName);
    assert.equal(r.j.devices[0].name, ID.phone);
    assert.equal(r.j.player.remote.device, ID.pc);
    assert.equal(r.j.player.remote.type, 'computer');
    r = await s.call('/admin/api/diag', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(r.j, { lines: [] });
  } finally { await s.close(); }
});

test('admin: Showcase on trims the status, command replies and the Spotify card on the server, and refuses diagnostics', async () => {
  const s = await server();
  const cap = capture();
  try {
    let r = await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.j, { showcase: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'showcase.json'), 'utf8')).on, true);

    r = await s.call('/admin/api/status', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(leaks(r.text), []);
    assert.equal(r.j.showcase, true);
    assert.deepEqual(r.j.devices, [{ name: 'Phone 1' }]);
    assert.deepEqual(r.j.spotify.user, { product: 'premium' });
    assert.equal(r.j.spotify.connected, true);
    assert.equal(r.j.player.remote.device, 'your computer');
    assert.equal(r.j.player.track.name, 'A Made-Up Song', 'the music stays');
    assert.equal(r.j.player.jam.cnt, 3);

    r = await s.call('/admin/api/player/pause', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.j.gen, 4);
    assert.deepEqual(leaks(r.text), []);

    r = await s.call('/admin/api/diag', { headers: AUTH });
    assert.equal(r.status, 403);
    assert.equal(r.j.error.code, 'showcase_on');

    r = await s.call('/admin/api/pair-code', { method: 'POST', headers: AUTH, body: {} });
    assert.deepEqual(r.j, { code: '123456' }, 'the page masks the code (hold to show), so the bridge still sends it');

    r = await s.call('/admin/api/spotify/disconnect', { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.j.user, null);
    assert.deepEqual(leaks(r.text), []);

    r = await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: false } });
    assert.deepEqual(r.j, { showcase: false });
    r = await s.call('/admin/api/diag', { headers: AUTH });
    assert.equal(r.status, 200);
  } finally { cap.restore(); await s.close(); }
  assert.deepEqual(leaks(cap.lines.join('\n')), [], 'no name in the log');
  assert.ok(cap.lines.some((l) => /I showcase on$/.test(l)) && cap.lines.some((l) => /I showcase off$/.test(l)), cap.lines.join('\n'));
});

test('admin: the switch needs the password, the admin page itself (JSON, same origin) and a true/false', async () => {
  const s = await server();
  try {
    let r = await s.call('/admin/api/showcase', { method: 'POST', body: { on: true } });
    assert.equal(r.status, 401);
    r = await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: 'on=true', type: 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 403);
    assert.equal(r.j.error.code, 'cross_site');
    r = await s.call('/admin/api/showcase', { method: 'POST', headers: { ...AUTH, Origin: 'http://elsewhere.example' }, body: { on: true } });
    assert.equal(r.status, 403);
    assert.equal(r.j.error.code, 'cross_site');
    for (const body of [{ on: 'yes' }, {}, { on: 1 }, 'null', '[]']) {
      r = await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.j.error.code, 'bad_request');
    }
    r = await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: '{nope' });
    assert.equal(r.status, 400);
    r = await s.call('/admin/api/showcase', { headers: AUTH });
    assert.deepEqual(r.j, { showcase: false }, 'nothing above switched it');
    r = await s.call('/admin/api/showcase', { method: 'PUT', headers: AUTH, body: { on: true } });
    assert.equal(r.status, 404);
  } finally { await s.close(); }
});

test('phones: Showcase never trims the phone API (each phone has its own Anonymous Mode, D3); it survives a restart', async () => {
  const dir = tmp();
  let s = await server({ dir });
  try {
    await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    const r = await s.call('/v1/status');                                  // (the stub's verify accepts any request)
    assert.equal(r.status, 200);
    assert.equal(r.j.player.remote.device, ID.pc);
    assert.equal(r.j.player.remote.type, 'computer', 'H1');
    assert.equal(r.j.player.jam.hn, ID.host);
    assert.equal('showcase' in r.j, false, 'phones are not told (no forcing, D4)');
  } finally { await s.close(); }
  s = await server({ dir });
  try {
    const r = await s.call('/admin/api/status', { headers: AUTH });
    assert.equal(r.j.showcase, true, 'still on after a restart');
    assert.deepEqual(leaks(r.text), []);
  } finally { await s.close(); }
});
