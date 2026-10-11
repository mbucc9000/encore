'use strict';
// The setup guide's public-IP finder (step 8, Listen away from home; netcheck.js's PublicIp and
// POST /admin/api/wizard/public-ip; DESIGN-WIZARD.md §5.2): the three IP-check services one after another (a timeout,
// an HTTP error, a redirect, a network error or an answer that isn't a strict IPv4 moves on to the next), every request
// IPv4 only with a generic User-Agent (never the bridge's name) and a 4 s timer, the shared (CGNAT) and not-public warnings, 502
// public_ip_failed, Showcase refusing before anything is contacted, the admin route's gate / password / setup mode /
// cross-site rules, one lookup at a time, the 30 s reuse and Check again's 5 s, the answer dropped after its 30 s,
// nothing written to disk, and a log with
// service names and codes only: never the IP. No network: https.get is replaced by a fake, and every address in here
// is a documentation or private example.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { PublicIp, PUBLIC_IP_SERVICES, PUBLIC_IP_MSG, publicIpWarning, isStrictIpv4, PIP_TIMEOUT_MS, PIP_MAX_BYTES, PIP_REUSE_MS, PIP_USER_AGENT } = require('../src/netcheck');
const { wizardServer, capture, cleanup, AUTH } = require('./support/wizard-server');

after(cleanup);

const IP = '203.0.113.7';
const HOSTS = ['api.ipify.org', 'ipv4.icanhazip.com', 'ifconfig.me'];
const FAILED = 'Couldn\'t find your public IP: no IP-check service answered. Check that this computer is online and press Find my public IP again, or look it up in your router\'s admin page (its Internet or WAN address).';
const SHOWCASE = 'Showcase is on, so your public IP stays hidden. Turn Showcase off to find it.';

// A fake https.get. script(host, n) -> what that request does: {status, body, headers} answers; {hang: true} never
// answers (the bridge's timer ends it); {error: true} fails like a refused connection (its message carries an address,
// which must never reach the log). gate: a promise the answers wait for (for the concurrency test).
function fakeGet(script, { gate = null } = {}) {
  const calls = [];
  const get = (url, opts, cb) => {
    const host = new URL(url).hostname;
    calls.push({ url, host, opts });
    const a = typeof script === 'function' ? script(host, calls.length) : script[host];
    const req = new EventEmitter();
    req.destroyed = false;
    req.answered = false;
    req.destroy = () => {
      if (req.destroyed) return;
      req.destroyed = true;
      if (!req.answered) setImmediate(() => req.emit('error', Object.assign(new Error('socket hang up (198.51.100.1:443)'), { code: 'ECONNRESET' })));
      setImmediate(() => req.emit('close'));
    };
    (async () => {
      if (gate) await gate;
      await new Promise((r) => setImmediate(r));
      if (req.destroyed || !a || a.hang) return;
      if (a.error) { req.emit('error', Object.assign(new Error('connect ECONNREFUSED 198.51.100.1:443'), { code: 'ECONNREFUSED' })); return; }
      const body = a.body == null ? '' : a.body;
      const res = Readable.from(body === '' ? [] : [Buffer.from(body)]);
      res.statusCode = a.status || 200;
      res.headers = a.headers || {};
      req.answered = true;
      cb(res);
    })();
    return req;
  };
  get.calls = calls;
  return get;
}

// the bridge's 4 s timer, recorded and shortened to 40 ms (a fake answer comes within a tick, long before that)
function fakeTimers(shortMs = 40) {
  const delays = [];
  return {
    delays,
    setTimer: (fn, ms) => { delays.push(ms); return { t: setTimeout(fn, shortMs) }; },
    clearTimer: (h) => { if (h) clearTimeout(h.t); },
  };
}

function pip(script, o = {}) {
  const get = fakeGet(script, o);
  const timers = fakeTimers();
  let clock = 1760000000000;
  const p = new PublicIp({ cfg: { port: 8095, version: '1.1.0', ...o.cfg }, get, now: () => clock, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  return { p, get, timers, tick: (ms) => { clock += ms; }, now: () => clock };
}

async function quiet(fn) {
  const cap = capture();
  try { return await fn(cap); } finally { cap.restore(); }
}

test('the services: a fixed list of three HTTPS addresses, in this order', () => {
  assert.deepEqual(PUBLIC_IP_SERVICES.map((s) => s.host), HOSTS);
  assert.deepEqual(PUBLIC_IP_SERVICES.map((s) => s.url), ['https://api.ipify.org/', 'https://ipv4.icanhazip.com/', 'https://ifconfig.me/ip']);
  assert.ok(Object.isFrozen(PUBLIC_IP_SERVICES) && PUBLIC_IP_SERVICES.every((s) => Object.isFrozen(s)));
  assert.equal(PIP_TIMEOUT_MS, 4000);
  assert.equal(PIP_MAX_BYTES, 64);
  assert.deepEqual(PUBLIC_IP_MSG, { public_ip_failed: FAILED, showcase_on: SHOWCASE });
});

test('the first service answers: its IP, the Away address, no warning; IPv4 only, a generic User-Agent, text/plain, a 4 s timer', () => quiet(async (cap) => {
  const { p, get, timers } = pip({ 'api.ipify.org': { body: IP } });
  const r = await p.lookup();
  assert.deepEqual(r, { ip: IP, port: 8095, away: `http://${IP}:8095`, warning: null, service: 'api.ipify.org', checked_at: 1760000000000, reused: false });
  assert.equal(get.calls.length, 1);
  const o = get.calls[0].opts;
  assert.equal(o.family, 4);
  assert.deepEqual(o.headers, { 'User-Agent': 'Mozilla/5.0', Accept: 'text/plain' });
  assert.equal(PIP_USER_AGENT, 'Mozilla/5.0');
  assert.ok(!/encore|bridge/i.test(JSON.stringify(o.headers)), 'the services never learn that this IP runs Encore Bridge');
  assert.ok(!('rejectUnauthorized' in o) && !('checkServerIdentity' in o), 'certificates are always checked');
  assert.deepEqual(timers.delays, [4000]);
  assert.equal(cap.lines.length, 1, cap.text());
  assert.match(cap.lines[0], /public IP check: ok \(api\.ipify\.org\)$/);
  assert.ok(!cap.text().includes(IP));
}));

test('the first one times out, the second answers with a final newline: its service; the log names the timeout, never the IP', () => quiet(async (cap) => {
  const { p, get, timers } = pip({ 'api.ipify.org': { hang: true }, 'ipv4.icanhazip.com': { body: `${IP}\n` } });
  const r = await p.lookup();
  assert.equal(r.ip, IP);
  assert.equal(r.service, 'ipv4.icanhazip.com');
  assert.equal(r.away, `http://${IP}:8095`);
  assert.deepEqual(get.calls.map((c) => c.host), ['api.ipify.org', 'ipv4.icanhazip.com']);
  assert.ok(get.calls.every((c) => c.opts.family === 4 && c.opts.headers['User-Agent'] === 'Mozilla/5.0'));
  assert.deepEqual(timers.delays, [4000, 4000]);
  assert.ok(cap.lines.some((l) => /public IP check: ok \(ipv4\.icanhazip\.com\) after api\.ipify\.org timeout$/.test(l)), cap.text());
  assert.ok(!cap.text().includes('203.0.113') && !cap.text().includes('198.51.100'), cap.text());
}));

test('all three fail (timeout, HTTP 503, a network error): 502 public_ip_failed with the guide\'s message; one log line with the codes only', () => quiet(async (cap) => {
  const { p, get } = pip({ 'api.ipify.org': { hang: true }, 'ipv4.icanhazip.com': { status: 503, body: 'busy' }, 'ifconfig.me': { error: true } });
  await assert.rejects(p.lookup(), (e) => e.status === 502 && e.code === 'public_ip_failed' && e.message === FAILED);
  assert.deepEqual(get.calls.map((c) => c.host), HOSTS);
  const lines = cap.lines.filter((l) => l.includes('public IP check'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /public IP check: failed \(api\.ipify\.org timeout, ipv4\.icanhazip\.com http_503, ifconfig\.me network\)$/);
  assert.ok(!cap.text().includes('198.51.100') && !cap.text().includes('ECONNREFUSED') && !cap.text().includes('hang up'), cap.text());
  // a failure isn't kept: the next press looks again
  const n = get.calls.length;
  await assert.rejects(p.lookup());
  assert.equal(get.calls.length, n + 3);
}));

test('a redirect is never followed (the next service is asked); answers that aren\'t a strict IPv4 are bad_answer, next', () => quiet(async (cap) => {
  const { p, get } = pip({ 'api.ipify.org': { status: 301, headers: { location: 'https://redirect.example/ip' } }, 'ipv4.icanhazip.com': { body: '<html>203.0.113.7</html>' },
    'ifconfig.me': { body: ` ${IP} \r\n` } });
  const r = await p.lookup();
  assert.equal(r.service, 'ifconfig.me');
  assert.equal(r.ip, IP);
  assert.deepEqual(get.calls.map((c) => c.host), HOSTS, 'never redirect.example');
  assert.ok(cap.lines.some((l) => /ok \(ifconfig\.me\) after api\.ipify\.org http_301, ipv4\.icanhazip\.com bad_answer$/.test(l)), cap.text());
  // each of these from the first service: bad_answer, then the second one's good answer
  const bad = ['<!doctype html><p>hi</p>', '2001:db8::1', '999.1.1.1', '01.2.3.4', '1.2.3', '1.2.3.4.5', '1.2.3.4 5.6.7.8', '', ' ', '256.0.0.1', '1.2.3.-4',
    '1.2.3.4' + ' '.repeat(57) + 'x', '1'.repeat(65)];
  for (const body of bad) {
    const t = pip({ 'api.ipify.org': { body }, 'ipv4.icanhazip.com': { body: IP } });
    const x = await t.p.lookup();
    assert.equal(x.service, 'ipv4.icanhazip.com', JSON.stringify(body));
  }
  // more than 64 bytes: bad_answer even when it starts with an IP; exactly 64 with padding is fine
  const long = pip({ 'api.ipify.org': { body: IP + ' '.repeat(65 - IP.length) }, 'ipv4.icanhazip.com': { body: IP } });
  assert.equal((await long.p.lookup()).service, 'ipv4.icanhazip.com');
  const edge = pip({ 'api.ipify.org': { body: IP + ' '.repeat(64 - IP.length) } });
  assert.equal((await edge.p.lookup()).service, 'api.ipify.org');
}));

test('strict IPv4 and the warnings: 100.64/10 is shared; private, loopback, link-local, reserved, benchmark and multicast are not public', () => {
  for (const ok of ['203.0.113.7', '0.0.0.0', '255.255.255.255', '8.8.4.4', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '198.51.100.1']) assert.ok(isStrictIpv4(ok), ok);
  for (const bad of ['01.2.3.4', '1.02.3.4', '256.1.1.1', '1.1.1', '1.1.1.1.', ' 1.1.1.1', '1.1.1.1\n', '::1', 'a.b.c.d', '', null, 7]) assert.ok(!isStrictIpv4(bad), String(bad));
  const want = {
    '203.0.113.7': null, '198.51.100.20': null, '192.0.2.4': null, '8.8.8.8': null, '100.63.255.255': null, '100.128.0.0': null, '172.15.255.255': null,
    '172.32.0.0': null, '198.17.255.255': null, '198.20.0.0': null, '223.255.255.255': null, '192.0.1.1': null,
    '100.64.0.0': 'shared', '100.64.1.2': 'shared', '100.127.255.255': 'shared',
    '0.1.2.3': 'not_public', '10.0.0.5': 'not_public', '127.0.0.1': 'not_public', '169.254.1.1': 'not_public', '172.16.0.1': 'not_public',
    '172.31.255.255': 'not_public', '192.0.0.8': 'not_public', '192.168.0.5': 'not_public', '198.18.0.1': 'not_public', '198.19.255.255': 'not_public',
    '224.0.0.1': 'not_public', '239.255.255.250': 'not_public', '240.0.0.1': 'not_public', '255.255.255.255': 'not_public',
  };
  for (const [ip, w] of Object.entries(want)) assert.equal(publicIpWarning(ip), w, ip);
});

test('a shared (CGNAT) or not-public answer: the IP and the warning, no Away address', () => quiet(async () => {
  for (const [ip, warning] of [['100.64.1.2', 'shared'], ['192.168.0.5', 'not_public'], ['198.18.0.1', 'not_public']]) {
    const { p } = pip({ 'api.ipify.org': { body: ip } });
    const r = await p.lookup();
    assert.deepEqual([r.ip, r.warning, r.away, r.service], [ip, warning, null, 'api.ipify.org']);
  }
}));

test('one lookup at a time; the last good answer reused for 30 s; Check again (fresh) looks again once it is 5 s old', () => quiet(async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const t = pip({ 'api.ipify.org': { body: IP } }, { gate });
  const a = t.p.lookup();
  const b = t.p.lookup({ fresh: true });
  open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(t.get.calls.length, 1, 'two at once: one lookup');
  assert.deepEqual(ra, rb);
  assert.equal(ra.reused, false);
  t.tick(4000);
  let r = await t.p.lookup({ fresh: true });
  assert.deepEqual([r.reused, t.get.calls.length], [true, 1], 'Check again within 5 s: the same answer');
  r = await t.p.lookup();
  assert.deepEqual([r.reused, r.ip, r.away, r.checked_at], [true, IP, `http://${IP}:8095`, 1760000000000]);
  t.tick(1500);                                       // 5.5 s
  r = await t.p.lookup({ fresh: true });
  assert.deepEqual([r.reused, t.get.calls.length, r.checked_at], [false, 2, 1760000005500]);
  t.tick(29000);
  r = await t.p.lookup();
  assert.deepEqual([r.reused, t.get.calls.length], [true, 2], 'within 30 s');
  t.tick(1000);
  r = await t.p.lookup();
  assert.deepEqual([r.reused, t.get.calls.length], [false, 3], 'after 30 s: a new look');
}));

test('the answer is dropped once its 30 s are over: by its own timer (unref), or on the next press; nothing older is kept', () => quiet(async () => {
  // the forget timer, recorded (it never fires by itself here)
  const armed = [];
  const get = fakeGet({ 'api.ipify.org': { body: IP } });
  const timers = fakeTimers();
  let clock = 1760000000000;
  const p = new PublicIp({ cfg: { port: 8095 }, get, now: () => clock, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    setForget: (fn, ms) => { const h = { fn, ms, cleared: false, unrefd: false, unref() { this.unrefd = true; } }; armed.push(h); return h; },
    clearForget: (h) => { h.cleared = true; } });
  assert.equal(PIP_REUSE_MS, 30000);
  await p.lookup();
  assert.equal(p.last.ip, IP);
  assert.equal(armed.length, 1);
  assert.deepEqual([armed[0].ms, armed[0].unrefd], [30000, true]);
  armed[0].fn();                                          // 30 s later
  assert.equal(p.last, null, 'nothing kept after 30 s');
  // a new look re-arms it (the old timer cleared); a stale timer never drops a newer answer
  clock += 31000;
  await p.lookup();
  assert.equal(armed.length, 2);
  clock += 6000;
  await p.lookup({ fresh: true });
  assert.equal(armed.length, 3);
  assert.equal(armed[1].cleared, true, 'the older timer is cleared');
  armed[1].fn();
  assert.equal(p.last.ip, IP, 'an older timer leaves the newer answer alone');
  // the clock alone: an answer 30 s old is dropped on the next press, before anything else
  clock += 30000;
  const look = p.lookup();
  assert.equal(p.last, null, 'dropped at once, before the new look answers');
  await look;
  assert.equal(get.calls.length, 4);
}));

// ---------------------------------------------------------------- over HTTP
const ROUTE = '/admin/api/wizard/public-ip';

async function server(script, o = {}) {
  const get = fakeGet(script, o);
  const timers = fakeTimers(o.timerMs);
  const clock = { t: 1760000000000 };
  const s = await wizardServer({ ...o.server, pip: { get, now: () => clock.t, setTimer: timers.setTimer, clearTimer: timers.clearTimer } });
  return { s, get, timers, clock };
}

test('POST /admin/api/wizard/public-ip: the answer, no-store; GET and other methods are the plain 404', async () => {
  const cap = capture();
  let t;
  try {
    t = await server({ 'api.ipify.org': { body: IP } });
    const r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.j, { ip: IP, port: 8095, away: `http://${IP}:8095`, warning: null, service: 'api.ipify.org', checked_at: 1760000000000, reused: false });
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const x = await t.s.call(ROUTE, { method, headers: AUTH });
      assert.equal(x.status, 404, method);
    }
    // no body at all, or a JSON null: fine (fresh is false)
    let x = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: '', type: 'application/json' });
    assert.equal(x.status, 200, x.text);
    assert.equal(x.j.reused, true);
    x = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: 'null' });
    assert.equal(x.j.reused, true);
    // a body that isn't JSON: 400; over 1 KB: refused
    x = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: '{nope' });
    assert.equal(x.status, 400);
    assert.equal(x.j.error.code, 'bad_request');
    x = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: { fresh: true, pad: 'x'.repeat(2000) } }).catch(() => ({ status: 'dropped' }));
    assert.ok(x.status === 413 || x.status === 'dropped', String(x.status));
    assert.equal(t.get.calls.length, 1);
  } finally { cap.restore(); if (t) await t.s.close(); }
  assert.ok(!cap.text().includes('203.0.113'), cap.text());
});

test('Showcase on: 409 showcase_on before anything is contacted; off again: it works', async () => {
  const t = await server({ 'api.ipify.org': { body: IP } });
  const cap = capture();
  try {
    await t.s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    for (const body of [{}, { fresh: true }]) {
      const r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body });
      assert.equal(r.status, 409);
      assert.deepEqual(r.j, { error: { code: 'showcase_on', message: SHOWCASE } });
    }
    assert.equal(t.get.calls.length, 0, 'nothing contacted');
    await t.s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: false } });
    const r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200);
    // an answer from before Showcase came on isn't handed out while it is on
    await t.s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: true } });
    const again = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: {} });
    assert.equal(again.status, 409);
    assert.ok(!again.text.includes('203.0.113'));
  } finally { cap.restore(); await t.s.close(); }
});

test('the admin route\'s rules: 401 without the password, 403 through a proxy, from outside ADMIN_ALLOW or cross-site, 503 in setup mode; nothing contacted', async () => {
  let t = await server({ 'api.ipify.org': { body: IP } });
  try {
    let r = await t.s.call(ROUTE, { method: 'POST', body: {} });
    assert.equal(r.status, 401);
    r = await t.s.call(ROUTE, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('admin:wrong-made-up').toString('base64') }, body: {} });
    assert.equal(r.status, 401);
    for (const h of [{ 'X-Forwarded-For': '203.0.113.10' }, { Forwarded: 'for=203.0.113.10' }, { 'X-Real-IP': '203.0.113.10' }]) {
      r = await t.s.call(ROUTE, { method: 'POST', headers: { ...AUTH, ...h }, body: {} });
      assert.equal(r.status, 403, JSON.stringify(h));
      assert.equal(r.j.error.code, 'proxied');
    }
    r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: '{}', type: 'text/plain' });
    assert.equal(r.status, 403);
    assert.equal(r.j.error.code, 'cross_site');
    r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: '{}', type: null });
    assert.equal(r.status, 403);
    r = await t.s.call(ROUTE, { method: 'POST', headers: { ...AUTH, Origin: 'http://evil.example' }, body: {} });
    assert.equal(r.status, 403);
    assert.equal(r.j.error.code, 'cross_site');
    // the internet, through the port forward: the admin page and this route don't answer there
    r = await t.s.inject(ROUTE, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: {}, peer: '198.51.100.30' });
    assert.equal(r.status, 403);
    assert.equal(r.j.error.code, 'forbidden');
    assert.equal(t.get.calls.length, 0);
  } finally { await t.s.close(); }
  t = await server({ 'api.ipify.org': { body: IP } }, { server: { adminPassword: '' } });
  try {
    const r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 503);
    assert.equal(r.j.error.code, 'admin_setup');
    assert.equal(t.get.calls.length, 0);
  } finally { await t.s.close(); }
});

test('over HTTP: two at once share one lookup; reused within 30 s; Check again after 5 s looks again; a 502 when all fail', async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  let n = 0;
  // (the bridge's timer is 2 s here: the first answer is held back until both requests are in)
  const t = await server((host) => (n >= 3 ? { error: true } : host === 'api.ipify.org' ? { body: IP } : { hang: true }), { gate, timerMs: 2000 });
  const cap = capture();
  try {
    const a = t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: {} });
    const b = t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: { fresh: true } });
    await new Promise((r) => setTimeout(r, 50));
    open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status], [200, 200]);
    assert.deepEqual(ra.j, rb.j);
    assert.equal(t.get.calls.length, 1);
    t.clock.t += 2000;
    let r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: {} });
    assert.deepEqual([r.j.reused, t.get.calls.length], [true, 1]);
    r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: { fresh: true } });
    assert.deepEqual([r.j.reused, t.get.calls.length], [true, 1], 'Check again before 5 s');
    t.clock.t += 3000;
    r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: { fresh: true } });
    assert.deepEqual([r.j.reused, t.get.calls.length], [false, 2], 'Check again after 5 s');
    r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: { fresh: 'yes' } });
    assert.deepEqual([r.j.reused, t.get.calls.length], [true, 2], 'only fresh: true counts');
    // every service fails now: 502 with the guide's message (the in-memory answer is still reused without fresh)
    n = 3;
    t.clock.t += 6000;
    r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: { fresh: true } });
    assert.equal(r.status, 502);
    assert.deepEqual(r.j, { error: { code: 'public_ip_failed', message: FAILED } });
  } finally { cap.restore(); await t.s.close(); }
  const text = cap.text();
  assert.ok(!text.includes('203.0.113') && !text.includes('198.51.100'), text);
  assert.ok(!/POST \/admin\/api\/wizard\/public-ip/.test(text), 'the 502 isn\'t logged a second time by the route');
  assert.equal(cap.lines.filter((l) => /public IP check: ok \(api\.ipify\.org\)$/.test(l)).length, 2, text);
  assert.equal(cap.lines.filter((l) => /public IP check: failed \(api\.ipify\.org network, ipv4\.icanhazip\.com network, ifconfig\.me network\)$/.test(l)).length, 1, text);
});

test('never by itself: no lookup at startup, on the guide\'s or the admin status reads, or on the launcher\'s; nothing written to the data folder', async () => {
  const t = await server({ 'api.ipify.org': { body: IP } });
  const TOKEN = 'c0ffee'.repeat(10) + 'beef';
  Object.defineProperty(t.s.cfg, 'launcherToken', { value: TOKEN, enumerable: false });
  const cap = capture();
  try {
    for (let i = 0; i < 3; i++) {
      await t.s.call('/admin/api/wizard', { headers: AUTH });
      await t.s.call('/admin/api/status', { headers: AUTH });
      await t.s.call('/admin/api/setup');
      await t.s.call('/admin', { headers: AUTH });
      await t.s.call('/local/v1/status', { headers: { 'X-Encore-Launcher': TOKEN } });
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.get.calls.length, 0);
    const before = fs.readdirSync(t.s.dir).sort();
    const r = await t.s.call(ROUTE, { method: 'POST', headers: AUTH, body: {} });
    assert.equal(r.status, 200);
    assert.equal(t.get.calls.length, 1);
    assert.deepEqual(fs.readdirSync(t.s.dir).sort(), before, 'nothing new in the data folder');
    for (const f of fs.readdirSync(t.s.dir)) {
      const full = path.join(t.s.dir, f);
      if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full, 'utf8').includes('203.0.113'), f);
    }
    // the guide's answer never carries the public IP
    const w = await t.s.call('/admin/api/wizard', { headers: AUTH });
    assert.ok(!w.text.includes('203.0.113'), w.text);
    const st = await t.s.call('/admin/api/status', { headers: AUTH });
    assert.ok(!st.text.includes('203.0.113'));
  } finally { cap.restore(); await t.s.close(); }
  assert.ok(!cap.text().includes('203.0.113'), cap.text());
});

test('the real getter is https.get, and the bridge builds its PublicIp with the bridge\'s settings', () => {
  const p = new PublicIp({ cfg: { port: 18095, version: '1.1.0' } });
  assert.equal(p.get, require('https').get);
  assert.deepEqual(p.answer({ ip: IP, service: 'ifconfig.me', checked_at: 1, warning: null }, false),
    { ip: IP, port: 18095, away: `http://${IP}:18095`, warning: null, service: 'ifconfig.me', checked_at: 1, reused: false });
});
