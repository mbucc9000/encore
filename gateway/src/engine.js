'use strict';
// go-librespot (the Spotify Connect player) over its local API: HTTP commands + /events websocket.
const { EventEmitter } = require('events');
const log = require('./log');

class Engine extends EventEmitter {
  constructor(url) {
    super();
    this.url = url.replace(/\/$/, '');
    this.connected = false;
    this.status = null;
  }

  // opts.timeoutMs bounds the whole request (the engine's own library calls take up to 30 s)
  async call(path, body, method = 'POST', opts = {}) {
    const o = { method, headers: {} };
    if (method === 'POST') { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body || {}); }
    if (opts.timeoutMs) o.signal = AbortSignal.timeout(opts.timeoutMs);
    const r = await fetch(this.url + path, o);
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`player ${path} -> ${r.status} ${text.slice(0, 200)}`);
      err.code = 'engine_' + r.status;
      throw err;
    }
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  }

  // Any status comes back as {status, json, retryAfter, upstream} (204 = no session: json null); only a network error or
  // the timeout throws. retryAfter: seconds from Retry-After; upstream: Spotify's status from X-Upstream-Status (the
  // patch-3 Jam routes, so a 401 can be told from a 403 and a Spotify 404 from a missing route); each null when absent.
  get(path, opts = {}) { return this.send('GET', path, undefined, opts); }

  async send(method, path, body, { timeoutMs } = {}) {
    const o = { method, headers: {} };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    if (timeoutMs) o.signal = AbortSignal.timeout(timeoutMs);
    let r;
    let text;
    try {
      r = await fetch(this.url + path, o);
      text = await r.text();
    } catch (e) {
      const t = e.name === 'TimeoutError' || e.name === 'AbortError';
      throw Object.assign(new Error(t ? 'Encore\'s player didn\'t answer in time.' : 'Encore\'s player isn\'t reachable.'), { status: 502, code: 'engine_error' });
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    const num = (h) => { const v = r.headers && r.headers.get ? r.headers.get(h) : null; return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null; };
    return { status: r.status, json, retryAfter: num('retry-after'), upstream: num('x-upstream-status') };
  }

  connect() {
    // A watchdog retries every 3 s whenever there is no live socket (a failed first attempt may never fire 'close').
    if (!this.watchdog) this.watchdog = setInterval(() => { if (!this.ws) this.connect(); }, 3000);
    if (this.ws) return;
    let ws;
    try { ws = new WebSocket(this.url.replace(/^http/, 'ws') + '/events'); } catch (e) { return; }
    this.ws = ws;
    const drop = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connected) { log.warn('player events disconnected'); this.connected = false; this.emit('disconnected'); }
      try { ws.close(); } catch (e) { /* ignore */ }
    };
    ws.onopen = () => { this.connected = true; log.info('player events connected'); this.emit('connected'); this.refresh(); };
    ws.onmessage = (m) => {
      try { const ev = JSON.parse(m.data); this.emit('event', ev.type, ev.data || {}); }
      catch (e) { log.warn('player event parse:', e.message); }
    };
    ws.onclose = drop;
    ws.onerror = drop;
  }

  async refresh() {
    try { this.status = await this.call('/status', undefined, 'GET'); this.emit('status', this.status); }
    catch (e) { this.status = null; }
    return this.status;
  }
}

module.exports = { Engine };
