'use strict';
// webapi.js finishLogin (1.1.0): a sign-in counts only once GET /me answers. Spotify refuses /me (403) for an account
// that isn't under the developer app's User Management; the bridge must then stay "Not connected" (or keep the account
// it had), with nothing saved, so the admin page offers Connect again. Offline: a stubbed fetch, no Spotify.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebApi } = require('../src/webapi');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-webapi-login-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// the token endpoint always answers; /me answers `me` (an object = 200, a number = that status)
function fakeSpotify(state) {
  return async (url) => {
    if (url.endsWith('/api/token')) {
      state.tokens++;
      return { ok: true, status: 200, json: async () => ({ access_token: 'acc' + state.tokens, refresh_token: 'ref' + state.tokens, expires_in: 3600 }) };
    }
    if (url.endsWith('/me')) {
      if (typeof state.me === 'number') {
        return { ok: false, status: state.me, headers: { get: () => null },
          text: async () => JSON.stringify({ error: { status: state.me, message: 'User not registered in the Developer Dashboard' } }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(state.me) };
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}' };
  };
}

async function login(w) {
  const state = new URL(w.loginUrl()).searchParams.get('state');
  return w.finishLogin(`http://127.0.0.1:8888/callback?code=x&state=${state}`);
}

test('GET /me refused (not under User Management): not connected, nothing saved, Connect works again', async () => {
  const dir = tmp();
  const st = { tokens: 0, me: 403 };
  const w = new WebApi(dir, 'cid', { fetch: fakeSpotify(st) });
  w.lim.spacingMs = 0;
  await assert.rejects(login(w), (e) => e.status === 403 || /403|registered/i.test(e.message));
  const i = w.info();
  assert.equal(i.connected, false, 'not half-connected');
  assert.equal(i.user, null);
  assert.equal(w.refreshToken, null);
  assert.equal(w.access, null);
  assert.equal(fs.existsSync(path.join(dir, 'tokens.json')), false, 'tokens.json not written');
  // the user adds the account under User Management and presses Connect again
  st.me = { id: 'alex', display_name: 'Alex Example', product: 'premium' };
  const ok = await login(w);
  assert.equal(ok.connected, true);
  assert.equal(w.user.id, 'alex');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')).refresh_token, 'ref2');
});

test('a refused re-sign-in keeps the account that was connected before', async () => {
  const dir = tmp();
  const st = { tokens: 0, me: { id: 'alex', display_name: 'Alex Example', product: 'premium' } };
  const w = new WebApi(dir, 'cid', { fetch: fakeSpotify(st) });
  w.lim.spacingMs = 0;
  await login(w);
  assert.equal(w.info().connected, true);
  st.me = 403;
  await assert.rejects(login(w));
  assert.equal(w.info().connected, true);
  assert.equal(w.user.id, 'alex');
  assert.equal(w.refreshToken, 'ref1', 'the earlier sign-in, as saved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')).refresh_token, 'ref1');
});
