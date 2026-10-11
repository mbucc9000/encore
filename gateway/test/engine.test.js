'use strict';
// engine.js send() returns retryAfter (Retry-After, seconds) and upstream (X-Upstream-Status), null when absent.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Engine } = require('../src/engine');

test('send(): status, json, retryAfter and upstream; nulls when the headers are absent; 204 = json null', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/jam/start') { res.writeHead(429, { 'Retry-After': '37', 'X-Upstream-Status': '429' }); return res.end(); }
    if (req.url === '/jam/join') { res.writeHead(403, { 'X-Upstream-Status': '401' }); return res.end(); }
    if (req.url === '/jam/current') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"not_found":true}'); }
    if (req.url === '/gate') { res.writeHead(429, { 'Retry-After': '5' }); return res.end(); }
    res.writeHead(204);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const e = new Engine(`http://127.0.0.1:${srv.address().port}`);
  try {
    assert.deepEqual(await e.send('POST', '/jam/start', {}), { status: 429, json: null, retryAfter: 37, upstream: 429 });
    assert.deepEqual(await e.send('POST', '/jam/join', { token: 'x' }), { status: 403, json: null, retryAfter: null, upstream: 401 });
    assert.deepEqual(await e.get('/jam/current'), { status: 200, json: { not_found: true }, retryAfter: null, upstream: null });
    assert.deepEqual(await e.send('POST', '/gate', {}), { status: 429, json: null, retryAfter: 5, upstream: null }, 'the engine gate: no upstream');
    assert.deepEqual(await e.get('/status'), { status: 204, json: null, retryAfter: null, upstream: null });
  } finally { srv.close(); }
});
