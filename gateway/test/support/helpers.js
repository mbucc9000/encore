'use strict';
// Shared bits for the 3a tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EngineModel, fakeEngine, id22 } = require('./engine-model');
const { Catalog } = require('../../src/catalog');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'testuser';

function tmp(name) {
  const d = path.join(os.tmpdir(), 'gw3a-' + name + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 7));
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// The Web API as catalog.js uses it: api(method, path, body, opts) with handlers per route.
class FakeWebApi {
  constructor() {
    this.ready = true;
    this.user = { id: ME, name: 'Alex Test' };
    this.calls = 0;
    this.log = [];
    this.routes = [];          // [regex, fn(method, path, body, opts)]
  }
  on(re, fn) { this.routes.push([re, fn]); return this; }
  blocked() { return false; }
  window() { return 0; }
  async api(method, p, body, opts = {}) {
    this.calls++;
    this.log.push({ method, path: p, quiet: !!opts.quiet });
    await sleep(1);
    for (const [re, fn] of this.routes) if (re.test(p)) return fn(method, p, body, opts);
    throw Object.assign(new Error('no route ' + p), { status: 404, code: 'not_found' });
  }
  count(re) { return this.log.filter((x) => re.test(x.path)).length; }
}

const FAST = { pollMs: 40, waitMs: 160, stallMs: 100, stallHoldMs: 400, stallLegacyMs: 200, retryMs: 100, rootGap: 300, rootFresh: 1000, rootWait: 200,
  noSession: 50, mergeDebounce: 100, likedDebounce: 20, likedSettle: 50, summaryTimeout: 2000, pageTimeout: 2000 };

function makeCatalog({ model, webapi, timing, player } = {}) {
  model = model || new EngineModel({ enumMs: 200 });
  const engine = fakeEngine(model);
  webapi = webapi || new FakeWebApi();
  const events = [];
  const bus = { push: (type, data) => events.push({ type, data }) };
  player = player || { lastPhone: Date.now(), st: { track: null }, likedMap: new Map(), noted: [],
    noteLiked(u, s) { this.likedMap.set(u, s); this.noted.push([u, s]); } };
  const images = { warmed: [], prewarm(t) { this.warmed.push(...t); }, flush: async () => {} };
  const dir = tmp('cat');
  const cat = new Catalog({ cfg: { cacheDir: dir }, engine, webapi, bus, player, images, timing: { ...FAST, ...timing } });
  return { cat, model, engine, webapi, bus, events, player, images, dir };
}

const body = (m) => JSON.parse(m.body.toString());

// Width/height from a JPEG's SOF marker.
function sof(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// n entries for a context: track uris with metadata 'ok' (to be swept) unless meta is given
const entries = (tag, n, meta = 'ok') => Array.from({ length: n }, (_, i) => ({ uri: 'spotify:track:' + id22(tag + i), meta, n: i, explicit: i % 5 === 0 }));

module.exports = { sleep, tmp, FakeWebApi, FAST, makeCatalog, body, sof, entries, ME, id22 };
