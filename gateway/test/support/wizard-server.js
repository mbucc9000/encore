'use strict';
// A local bridge (http.js createServer) with stubs, for the setup guide's HTTP tests: a real AdminAuth (ADMIN_PASSWORD,
// or first-run setup), a real WebApi when asked (no network: its fetch is never reached), a pairing stub, a player stub.
// No engine, no Spotify. Every name in it is made up. inject() hands the server a request with a made-up peer address
// (a documentation-range "public" one, say), which a real connection to 127.0.0.1 can't have.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('../../src/http');
const { AdminAuth } = require('../../src/adminauth');
const { Readable } = require('stream');
const { WebApi } = require('../../src/webapi');
const { DEFAULT_APP_REPO } = require('../../src/config');
const { PublicIp } = require('../../src/netcheck');

const PW = 'pw-admin-wizard';
const AUTH = { Authorization: 'Basic ' + Buffer.from('admin:' + PW).toString('base64') };
const NAMES = { phone: 'Sam Sample’s iPhone', account: 'alexexample42', accountName: 'Alex Example', dev: 'dev_0123456789abcdef' };

const dirs = [];
function tmp(prefix = 'encore-wizard-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function cleanup() { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); }

// console capture: the bridge's log lines (log.js writes through console.log / console.warn / console.error)
function capture() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  return { lines, text: () => lines.join('\n'), restore: () => Object.assign(console, orig) };
}

// o: cfg (extra cfg), adminPassword ('' = first-run setup), devices ([{...}]), webapi ('real' | an object | null: a
// plain stub), clientId (the real WebApi's), tokens (write data/tokens.json first), lanAddress, verify (auth.verify:
// (req, body) => a device or null; default: nothing is signed), pip (options for the public-IP lookup, netcheck.js's
// PublicIp: get, now, setTimer, clearTimer; its default get never reaches the network: every service fails), ctx
// (extra ctx)
async function wizardServer(o = {}) {
  const dir = o.dir || tmp();
  const cfg = { dataDir: dir, version: '1.1.0', minApp: '1.0.0', tiers: { high: 256 }, defaultTier: 'high', port: 8095,
    adminPassword: o.adminPassword === undefined ? PW : o.adminPassword, platformKind: 'other', appRepo: DEFAULT_APP_REPO, ...o.cfg };
  if (o.tokens) fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ refresh_token: 'rt-made-up', user: { id: NAMES.account, name: NAMES.accountName } }));
  let webapi = o.webapi;
  if (webapi === 'real' || webapi === undefined) {
    webapi = new WebApi(dir, o.clientId || '', { fetch: async () => { throw new Error('no network in tests'); } });
  }
  const devices = o.devices || [];
  const codes = [];
  const player = { lastPhone: Date.now(), pollRemote: async () => {}, snapshot: () => ({ status: 'stopped' }), st: { active: false, status: 'stopped', track: null },
    genInfo: new Map(), pending: null, heardInfo: () => null, syncInfo: () => ({}), publish() {}, remote: null, ...(o.player || {}) };
  const ctx = {
    cfg, adminAuth: new AdminAuth({ cfg, scrypt: { N: 1024 } }),
    player,
    auth: { verify: o.verify || (() => null), list: () => devices.map((d) => ({ ...d })), revoke: () => true,
      newCode: () => { const c = { code: String(100000 + codes.length), expires_in: 300 }; codes.push(c.code); return c; },
      pair: () => ({ device_id: 'dev_x', secret: 'S', secret_hex: '00' }) },
    bus: { wait: async () => [] },
    encoders: { warmAll() {}, info: () => [], listening: () => 0 },
    engine: { connected: false, get: async () => ({ status: 204, json: null }) },
    clock: { sample: 0, lead: () => 0, leadMs: 10000, frozen: null, pipeBytes: 0, stats: { real: 0, silence: 0 } },
    started: Date.now(),
    webapi,
    catalog: { counters: () => ({}), info: async () => ({}) },
    images: { info: () => ({}) }, lyrics: { info: () => ({}) }, membership: { info: () => ({}) },
    jam: { statusInfo: () => ({}), info: () => ({}) }, personal: {}, social: null,
    lanAddress: o.lanAddress || (async () => '192.168.1.20'),
    lanCandidates: o.lanCandidates || (() => [{ name: 'Wi-Fi', address: '192.168.1.20', virtual: false }]),
    publicIp: new PublicIp({ cfg, get: () => { throw new Error('no network in tests'); }, ...(o.pip || {}) }),
    ...(o.ctx || {}),
  };
  const srv = createServer(ctx);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  // opts: method, headers, body (an object is sent as JSON), type (Content-Type; null: none), raw (keep the body as a Buffer)
  const call = (p, { method = 'GET', headers = {}, body, type = 'application/json' } = {}) => new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null && type) h['Content-Type'] = type;
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: h, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        const text = buf.toString();
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        resolve({ status: res.statusCode, headers: res.headers, buf, text, j });
      });
    });
    rq.on('error', reject);
    if (body != null) rq.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    rq.end();
  });
  // a request from a made-up peer address (no socket at all): the server's own request handler with a fake req / res
  const inject = (p, { method = 'GET', headers = {}, body = null, peer = '203.0.113.9' } = {}) => new Promise((resolve) => {
    const req = Readable.from(body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    const h = { host: `127.0.0.1:${port}` };
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;           // (as Node hands them over)
    Object.assign(req, { url: p, method, headers: h, socket: { remoteAddress: peer } });
    const chunks = [];
    const res = {
      statusCode: 0, headersSent: false, head: {},
      writeHead(st, h) { this.statusCode = st; this.headersSent = true; Object.assign(this.head, h || {}); return this; },
      setHeader(k, v) { this.head[k] = v; },
      write(c) { chunks.push(Buffer.from(c)); return true; },
      end(c) {
        if (c) chunks.push(Buffer.from(c));
        const text = Buffer.concat(chunks).toString();
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        resolve({ status: this.statusCode, headers: this.head, text, j });
      },
      on() { return this; }, once() { return this; },
    };
    srv.emit('request', req, res);
  });
  return { call, inject, ctx, cfg, dir, port, codes, devices, srv,
    close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) };
}

module.exports = { wizardServer, capture, tmp, cleanup, PW, AUTH, NAMES, DEFAULT_APP_REPO };
