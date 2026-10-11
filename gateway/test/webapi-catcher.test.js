'use strict';
// The Spotify sign-in's redirect caught by the bridge itself (R3c, webapi.js; RELEASE-PLAN D12, on by default on
// Windows): while a sign-in is pending, the bridge listens at the redirect address on 127.0.0.1 only, so a browser on
// the same computer finishes the sign-in with no paste. Anything else gets a plain page, and the paste box keeps
// working. Spotify is a stub here; the redirect port is moved to a free one.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { WebApi, REDIRECT } = require('../src/webapi');
const { freePort } = require('./support/platform');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-catcher-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODE = 'auth-code-from-spotify-0001';
const ACCESS = 'stub-access-token';
const REFRESH = 'stub-refresh-token';

// Spotify's token endpoint and /me, as stubs
function spotify() {
  const calls = [];
  const fetch = async (url, o = {}) => {
    calls.push(url);
    if (url.endsWith('/api/token')) {
      const b = new URLSearchParams(String(o.body));
      if (b.get('code') !== CODE) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
      return { ok: true, status: 200, json: async () => ({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }) };
    }
    if (url.endsWith('/me')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 'alex.example', display_name: 'Alex Example', product: 'premium' }) };
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  return { fetch, calls };
}

function capture() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, orig) };
}

function get(port, p, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = host ? { Host: host } : {};
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text: b }));
    });
    rq.on('error', reject);
    rq.end();
  });
}

async function listening(port, want = true, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const up = await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (up === want) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(25);
  }
}

async function webapi(o = {}) {
  const sp = spotify();
  const w = new WebApi(tmp(), 'stub-client-id', { fetch: sp.fetch, catchCallback: o.catchCallback !== false });
  w.callbackPort = o.port || await freePort();
  return { w, sp, port: w.callbackPort };
}

test('Connect starts the catcher (127.0.0.1 only); the redirect finishes the sign-in with no paste, then the catcher stops', async () => {
  const cap = capture();
  try {
    const { w, port } = await webapi();
    let caught = 0;
    w.on('caught', () => { caught++; });
    assert.equal(w.catcher, null, 'nothing listens before Connect');
    const u = new URL(w.loginUrl());
    assert.equal(u.searchParams.get('redirect_uri'), REDIRECT, 'the redirect registered in the developer app is unchanged');
    assert.ok(await listening(port), 'listening after Connect');
    assert.equal(w.catcher.server.address().address, '127.0.0.1', 'this computer only');
    const r = await get(port, `/callback?code=${CODE}&state=${u.searchParams.get('state')}`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.type, /^text\/html/);
    assert.match(r.text, /Spotify account connected/);
    assert.equal(w.ready, true);
    assert.equal(w.user.product, 'premium');
    assert.equal(caught, 1, '"caught" told the bridge');
    assert.ok(fs.existsSync(w.file), 'the refresh token is kept (data/tokens.json)');
    assert.ok(await listening(port, false), 'stopped: nothing is pending any more');
    assert.equal(w.catcher, null);
    const all = cap.lines.join('\n');
    for (const secret of [CODE, ACCESS, REFRESH, 'Alex Example', 'alex.example', u.searchParams.get('state')]) assert.ok(!all.includes(secret), 'never logged: ' + secret);
  } finally { cap.restore(); }
});

test('the catcher answers only a pending sign-in: other paths, methods, hosts and old links get a plain page', async () => {
  const { w, port } = await webapi();
  try {
    const state = new URL(w.loginUrl()).searchParams.get('state');
    assert.ok(await listening(port));
    let r = await get(port, '/');
    assert.equal(r.status, 404);
    r = await get(port, `/callback?code=${CODE}&state=${state}`, { method: 'POST' });
    assert.equal(r.status, 404);
    r = await get(port, `/callback?code=${CODE}&state=${state}`, { host: 'evil.example:8888' });
    assert.equal(r.status, 404, 'a page on another site can\'t use it through DNS rebinding');
    r = await get(port, `/callback?code=${CODE}&state=not-the-state`);
    assert.equal(r.status, 400);
    assert.match(r.text, /old or from another tab/);
    r = await get(port, `/callback?code=bad-code&state=${state}`);
    assert.equal(r.status, 400, 'Spotify refused the code');
    assert.match(r.text, /Not connected/);
    assert.equal(w.ready, false);
    // a new Connect: Spotify says the user said no
    const s2 = new URL(w.loginUrl()).searchParams.get('state');
    r = await get(port, `/callback?error=access_denied&state=${s2}`);
    assert.equal(r.status, 400);
    assert.match(r.text, /Spotify said: access_denied/);
    r = await get(port, `/callback?code=<script>alert(1)</script>&state=x`);
    assert.ok(!r.text.includes('<script>'), 'nothing from the request is echoed as markup');
    // the paste box still works with the same state
    const s3 = new URL(w.loginUrl()).searchParams.get('state');
    await w.finishLogin(`http://127.0.0.1:8888/callback?code=${CODE}&state=${s3}`);
    assert.equal(w.ready, true);
  } finally { w.stopCatcher(); }
});

test('a caught sign-in that fails is kept as a code for the setup guide (never the message); Connect and a connection clear it', async () => {
  const cap = capture();
  const { w, port } = await webapi();
  try {
    // Spotify refuses the account (not under User Management): /me answers 403
    let forbid = true;
    const ok = w.fetch;
    w.fetch = async (url, o) => (forbid && url.endsWith('/me')
      ? { ok: false, status: 403, headers: { get: () => null }, text: async () => JSON.stringify({ error: { status: 403, message: 'Check settings on developer.spotify.com/dashboard, the user may not be registered.' } }) }
      : ok(url, o));
    assert.equal(w.lastCatch, null);
    let state = new URL(w.loginUrl()).searchParams.get('state');
    assert.ok(await listening(port));
    let r = await get(port, `/callback?code=${CODE}&state=${state}`);
    assert.equal(r.status, 400);
    assert.match(r.text, /Not connected/);
    assert.match(r.text, /User Management/, 'the tab says what to do');
    assert.equal(w.ready, false);
    assert.equal(w.lastCatch.code, 'spotify_forbidden');
    assert.deepEqual(Object.keys(w.lastCatch).sort(), ['at', 'code']);
    // a new Connect clears it; the user cancels on Spotify's page
    state = new URL(w.loginUrl()).searchParams.get('state');
    assert.equal(w.lastCatch, null, 'Connect starts over');
    r = await get(port, `/callback?error=access_denied&state=${state}`);
    assert.equal(r.status, 400);
    assert.equal(w.lastCatch.code, 'denied');
    // then it works: cleared
    forbid = false;
    state = new URL(w.loginUrl()).searchParams.get('state');
    r = await get(port, `/callback?code=${CODE}&state=${state}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(w.ready, true);
    assert.equal(w.lastCatch, null);
    assert.ok(!cap.lines.join('\n').includes(CODE), 'the code is never logged');
  } finally { cap.restore(); w.stopCatcher(); }
});

test('off (Docker): Connect starts nothing; a taken port only means pasting, as before', async () => {
  let { w, port } = await webapi({ catchCallback: false });
  w.loginUrl();
  await sleep(100);
  assert.equal(w.catcher, null);
  assert.equal(await listening(port, true, 200), false);
  assert.equal(w.info().catch_callback, false);

  const holder = net.createServer();
  const busy = await freePort();
  await new Promise((r) => holder.listen(busy, '127.0.0.1', r));
  const cap = capture();
  try {
    ({ w } = await webapi({ port: busy }));
    assert.equal(w.info().catch_callback, true);
    const url = w.loginUrl();
    assert.match(url, /^https:\/\/accounts\.spotify\.com\/authorize\?/);
    for (let i = 0; i < 40 && w.catcher; i++) await sleep(25);
    assert.equal(w.catcher, null, 'gave up on the taken port');
    assert.ok(cap.lines.some((l) => /paste the address on the admin page/.test(l)), cap.lines.join('\n'));
  } finally { cap.restore(); holder.close(); }
});
