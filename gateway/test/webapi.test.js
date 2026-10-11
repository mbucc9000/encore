'use strict';
// webapi.js queue, 429 gate, token handling and error mapping, with a fake fetch (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { WebApi } = require('../src/webapi');
const { tmp, sleep } = require('./support/helpers');

const res = (status, json, headers = {}) => ({ status, ok: status >= 200 && status < 300,
  headers: { get: (k) => (headers[k.toLowerCase()] != null ? String(headers[k.toLowerCase()]) : null) },
  text: async () => (json == null ? '' : JSON.stringify(json)), json: async () => json });

function mk(handler, lim = {}) {
  const dir = tmp('wa');
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ refresh_token: 'R1', user: { id: 'me', name: 'Me' } }));
  const f = async (url, opts) => {
    const isTok = url.includes('/api/token');
    f.log.push({ url, opts, t: Date.now(), tok: isTok });
    if (isTok && !f.tokenHandler) return res(200, { access_token: 'A', expires_in: 3600 });
    return (isTok ? f.tokenHandler : handler)(url, opts);
  };
  f.log = [];
  const w = new WebApi(dir, 'cid', { api: 'http://api.test/v1', accounts: 'http://acc.test', fetch: f });
  Object.assign(w.lim, lim);
  w.f = f;
  w.apiCalls = () => f.log.filter((x) => !x.tok);
  w.tokCalls = () => f.log.filter((x) => x.tok);
  return w;
}

test('queue: at most 2 in flight, 100 ms between starts, player calls first, FIFO otherwise', async () => {
  let inflight = 0;
  let max = 0;
  const w = mk(async (url) => { inflight++; max = Math.max(max, inflight); await sleep(150); inflight--; return res(200, { u: url }); });
  const ps = [1, 2, 3, 4, 5].map((i) => w.api('GET', '/n' + i));
  await sleep(20);
  ps.push(w.api('GET', '/p', undefined, { prio: 'player' }));
  await Promise.all(ps);
  const starts = w.apiCalls();
  assert.equal(max, 2, 'never more than 2 in flight');
  assert.deepEqual(starts.map((x) => x.url.replace('http://api.test/v1', '')), ['/n1', '/p', '/n2', '/n3', '/n4', '/n5'], 'the player call jumps the queue, the rest in order');
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i].t - starts[i - 1].t >= 95, `start spacing ${starts[i].t - starts[i - 1].t} ms`);
  assert.equal(w.info().calls, 6);
});

test('queue: busy after the maximum wait; quiet callers turned away silently', async () => {
  const w = mk(async () => { await sleep(500); return res(200, {}); }, { maxWaitMs: 200 });
  const a = w.api('GET', '/a');
  const b = w.api('GET', '/b');
  const c = w.api('GET', '/c').catch((e) => e);
  const q = w.api('GET', '/q', undefined, { quiet: true });
  const e = await c;
  assert.equal(e.status, 503); assert.equal(e.code, 'busy'); assert.equal(e.retry_after, 5);
  assert.equal(await q, undefined, 'quiet: undefined, no error');
  await a; await b;
  assert.equal(w.apiCalls().length, 2);
  // the window: quiet callers skip while it holds >= 20 starts
  w.starts = Array.from({ length: 20 }, () => Date.now());
  assert.equal(await w.api('GET', '/quiet', undefined, { quiet: true }), undefined);
  assert.equal(w.apiCalls().length, 2, 'no request for a quiet caller over the window');
  await w.api('GET', '/normal');
  assert.equal(w.apiCalls().length, 3, 'a normal call still goes');
});

test('429 gate: nothing goes out while blocked, retry_after, fail fast, quiet dropped; short Retry-After retried once', async () => {
  const w = mk(async (url) => (new URL(url).pathname.endsWith('/x') ? res(429, null, { 'retry-after': 30 }) : res(200, {})));
  const e = await w.api('GET', '/x?q=secret').catch((x) => x);
  assert.equal(e.status, 503); assert.equal(e.code, 'rate_limited');
  assert.ok(e.retry_after >= 30 && e.retry_after <= 32, `retry_after ${e.retry_after}`);
  assert.ok(w.blocked());
  const n = w.apiCalls().length;
  const t0 = Date.now();
  const e2 = await w.api('GET', '/y').catch((x) => x);
  assert.equal(e2.code, 'rate_limited'); assert.ok(Date.now() - t0 < 20, 'fails at once');
  assert.equal(await w.api('GET', '/z', undefined, { quiet: true }), undefined);
  assert.equal(await w.api('POST', '/w', {}, { prio: 'player' }).catch((x) => x.code), 'rate_limited', 'player calls too');
  assert.equal(w.apiCalls().length, n, 'no request while blocked');
  const i = w.info();
  assert.equal(i.n429, 1); assert.equal(i.last429_path, '/x', 'the path, no query'); assert.ok(i.blocked_until > Date.now());
  // Retry-After <= 2 on a first try: wait, retry once
  let k = 0;
  const w2 = mk(async () => (k++ === 0 ? res(429, null, { 'retry-after': 1 }) : res(200, { ok: 1 })));
  const t1 = Date.now();
  assert.deepEqual(await w2.api('GET', '/s'), { ok: 1 });
  assert.ok(Date.now() - t1 >= 1000, 'waited for the Retry-After');
  assert.equal(w2.apiCalls().length, 2);
  // a quiet caller is never retried
  let m = 0;
  const w3 = mk(async () => (m++ === 0 ? res(429, null, { 'retry-after': 1 }) : res(200, {})));
  assert.equal(await w3.api('GET', '/s', undefined, { quiet: true }), undefined);
  assert.equal(w3.apiCalls().length, 1);
});

test('401: two parallel 401s cause one token refresh', async () => {
  const w = mk(async (url, o) => (o.headers.Authorization === 'Bearer B' ? res(200, { ok: 1 }) : res(401, null)), { spacingMs: 0 });
  w.access = { token: 'A0', exp: Date.now() + 3600000 };
  w.f.tokenHandler = async () => { await sleep(30); return res(200, { access_token: 'B', expires_in: 3600 }); };
  const [a, b] = await Promise.all([w.api('GET', '/1'), w.api('GET', '/2')]);
  assert.deepEqual(a, { ok: 1 }); assert.deepEqual(b, { ok: 1 });
  assert.equal(w.tokCalls().length, 1, 'one refresh');
  // a second 401 after the refresh: 502, never 401
  const w2 = mk(async () => res(401, null));
  const e = await w2.api('GET', '/x').catch((x) => x);
  assert.equal(e.status, 502); assert.equal(e.code, 'spotify_error');
});

test('token endpoint 400: 503 spotify_auth + one notice, then no token calls for 10 min', async () => {
  const w = mk(async () => res(200, {}));
  let now = Date.now();
  w.now = () => now;
  const notices = [];
  w.on('notice', (n) => notices.push(n));
  w.f.tokenHandler = async () => res(400, { error: 'invalid_grant' });
  const e = await w.api('GET', '/a').catch((x) => x);
  assert.equal(e.status, 503); assert.equal(e.code, 'spotify_auth');
  assert.equal(notices.length, 1); assert.equal(notices[0].code, 'spotify_auth');
  assert.ok(w.info().auth_broken);
  await w.api('GET', '/b').catch(() => {});
  now += 9 * 60000;
  await w.api('GET', '/c').catch(() => {});
  assert.equal(w.tokCalls().length, 1, 'no token call inside 10 min');
  now += 2 * 60000;
  const e2 = await w.api('GET', '/d').catch((x) => x);
  assert.equal(w.tokCalls().length, 2, 'tried again after 10 min');
  assert.equal(e2.code, 'spotify_auth');
  assert.equal(notices.length, 1, 'the notice is sent once');
  // a working token clears it; a rotated refresh token that can't be saved doesn't break anything
  w.f.tokenHandler = async () => res(200, { access_token: 'C', expires_in: 3600, refresh_token: 'R2' });
  now += 11 * 60000;
  w.file = '/nonexistent/dir/tokens.json';
  assert.deepEqual(await w.api('GET', '/e'), {});
  assert.equal(w.authBroken, null); assert.equal(w.refreshToken, 'R2');
});

test('errors: 403 -> 403, 404 -> 404, 400 -> 502, timeout -> 502; GET retried once, POST never', async () => {
  const w = mk(async (url, o) => {
    if (url.endsWith('/forbidden')) return res(403, { error: { message: 'nope' } });
    if (url.endsWith('/gone')) return res(404, null);
    if (url.endsWith('/bad')) return res(400, { error: { message: 'bad' } });
    if (url.endsWith('/slow')) return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason)));
    if (url.endsWith('/flaky')) return (w.flaky = (w.flaky || 0) + 1) === 1 ? res(500, null) : res(200, { ok: 1 });
    if (url.endsWith('/down')) return res(503, null);
    return res(200, {});
  }, { timeoutMs: 100 });
  let e = await w.api('GET', '/forbidden').catch((x) => x);
  assert.equal(e.status, 403); assert.equal(e.code, 'spotify_forbidden');
  e = await w.api('GET', '/gone').catch((x) => x);
  assert.equal(e.status, 404); assert.equal(e.code, 'not_found');
  e = await w.api('GET', '/bad').catch((x) => x);
  assert.equal(e.status, 502); assert.equal(e.spotifyStatus, 400);
  let n = w.apiCalls().length;
  const keep = setInterval(() => {}, 1000);                   // AbortSignal.timeout doesn't hold the loop (a socket would)
  e = await w.api('GET', '/slow').catch((x) => x);
  assert.equal(e.status, 502); assert.equal(e.code, 'spotify_error');
  assert.equal(w.apiCalls().length - n, 2, 'a GET that timed out is retried once');
  n = w.apiCalls().length;
  e = await w.api('POST', '/slow', {}).catch((x) => x);
  clearInterval(keep);
  assert.equal(e.status, 502); assert.equal(w.apiCalls().length - n, 1, 'a POST never');
  n = w.apiCalls().length;
  assert.deepEqual(await w.api('GET', '/flaky'), { ok: 1 });
  assert.equal(w.apiCalls().length - n, 2, '5xx GET: one retry');
  n = w.apiCalls().length;
  e = await w.api('POST', '/down', {}).catch((x) => x);
  assert.equal(e.status, 502); assert.equal(w.apiCalls().length - n, 1, '5xx POST: no retry');
  w.refreshToken = null;
  e = await w.api('GET', '/x').catch((x) => x);
  assert.equal(e.status, 503); assert.equal(e.code, 'spotify_not_connected');
});

test('429 gate: a retry (5xx or network error on a GET, a 401) never goes out once another request closed the gate', async () => {
  const path0 = (url) => new URL(url).pathname;
  // a GET answered 500 waits 300-800 ms to retry; meanwhile another request gets a 429
  const w = mk(async (url) => {
    if (path0(url).endsWith('/flaky')) { await sleep(20); return res(500, null); }
    if (path0(url).endsWith('/limit')) return res(429, null, { 'retry-after': 30 });
    return res(200, {});
  }, { inflight: 3 });
  const a = w.api('GET', '/flaky').catch((x) => x);
  const q = w.api('GET', '/flaky', undefined, { quiet: true });
  await sleep(250);
  assert.equal((await w.api('GET', '/limit').catch((x) => x)).code, 'rate_limited');
  const e = await a;
  assert.equal(e.status, 503); assert.equal(e.code, 'rate_limited', 'the retry found the gate closed');
  assert.equal(await q, undefined, 'a quiet caller: undefined');
  assert.equal(w.apiCalls().filter((x) => x.url.endsWith('/flaky')).length, 2, 'one try each, no retry went out');
  // a network error on a GET, the same
  const w1 = mk(async (url) => {
    if (path0(url).endsWith('/net')) { await sleep(20); throw new TypeError('fetch failed'); }
    return res(429, null, { 'retry-after': 30 });
  });
  const b = w1.api('GET', '/net').catch((x) => x);
  await sleep(150);
  await w1.api('GET', '/limit').catch(() => {});
  assert.equal((await b).code, 'rate_limited');
  assert.equal(w1.apiCalls().filter((x) => x.url.endsWith('/net')).length, 1);
  // a 401: the token is refreshed, but the retry stays home when a request already out got a 429 meanwhile
  const w2 = mk(async (url) => {
    if (path0(url).endsWith('/auth')) return res(401, null);
    await sleep(100);
    return res(429, null, { 'retry-after': 30 });
  }, { spacingMs: 0 });
  w2.access = { token: 'A0', exp: Date.now() + 3600000 };
  w2.f.tokenHandler = async () => { await sleep(200); return res(200, { access_token: 'B', expires_in: 3600 }); };
  const lim = w2.api('GET', '/limit').catch((x) => x);
  const c = w2.api('GET', '/auth').catch((x) => x);
  assert.equal((await lim).code, 'rate_limited');
  const e2 = await c;
  assert.equal(e2.code, 'rate_limited');
  assert.equal(w2.apiCalls().filter((x) => x.url.endsWith('/auth')).length, 1, 'the 401 retry did not go out');
  assert.equal(w2.tokCalls().length, 1);
  // with the gate open, the retries still happen (as before)
  let k = 0;
  const w3 = mk(async () => (k++ === 0 ? res(502, null) : res(200, { ok: 1 })));
  assert.deepEqual(await w3.api('GET', '/x'), { ok: 1 });
  assert.equal(w3.apiCalls().length, 2);
});
