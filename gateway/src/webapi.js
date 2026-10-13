'use strict';
// Spotify Web API under the user's own Spotify developer app (OAuth PKCE, no client secret).
// Login happens once from the admin page: the redirect goes to http://127.0.0.1:8888/callback (registered in the dev
// app). On Docker nothing listens there, so the admin page asks for that address-bar URL to be pasted back. On Windows
// (D12, catchCallback) the bridge listens there itself while a sign-in is pending, on this computer only, so a browser
// on the bridge's own computer finishes the sign-in with no paste; pasting still works from any other browser. Only
// the refresh token is stored (data/tokens.json, 0600). Tokens and the callback address are never logged.
//
// Every Web API request goes through api(): one queue (at most 2 in flight, 100 ms between starts, player calls
// first), a 429 gate (nothing reaches Spotify until its Retry-After is over) and a rolling 30 s count of starts.
// Background callers pass quiet: they get undefined instead of an error when the queue or the gate stops them.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const log = require('./log');
const { t, tx, langOf } = require('./i18n');
const { renameRetrySync } = require('./fsutil');

const AUTH = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-private', 'playlist-modify-public',
  'user-library-read', 'user-library-modify', 'user-follow-read', 'user-read-playback-state', 'user-modify-playback-state',
  'user-read-currently-playing', 'user-read-recently-played', 'user-top-read', 'user-read-private'].join(' ');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fail = (status, code, message, extra) => Object.assign(new Error(message), { status, code }, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTH_RETRY_MS = 10 * 60000;     // a broken sign-in: the token endpoint is tried again at most this often
const PENDING_MS = 15 * 60000;        // a started sign-in (its PKCE verifier) is kept this long
const CALLBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class WebApi extends EventEmitter {
  // catchCallback (Windows, D12): listen at the redirect address while a sign-in is pending (see startCatcher())
  constructor(dataDir, clientId, { api = API, accounts = AUTH, fetch: f, catchCallback = false } = {}) {
    super();
    this.file = path.join(dataDir, 'tokens.json');
    this.clientId = clientId;
    this.apiBase = api.replace(/\/$/, '');
    this.authBase = accounts.replace(/\/$/, '');
    this.fetch = f || ((...a) => fetch(...a));
    this.now = () => Date.now();     // the gate, the window and the auth retry (tests move it); spacing is real time
    this.refreshToken = null;
    this.access = null;            // { token, exp }
    this.pending = new Map();      // state -> { verifier, t }
    this.user = null;
    this.authBroken = null;        // { at, message, tried }: the refresh token was refused
    this.catchCallback = !!catchCallback;
    this.callbackPort = Number(new URL(REDIRECT).port);      // tests move it
    this.catcher = null;           // { server, until, timer } while the bridge listens for the redirect
    this.lastCatch = null;         // { code, at }: why the caught redirect didn't connect (an error code only; the setup guide)
    // queue + gate (tests shrink the numbers)
    this.lim = { inflight: 2, spacingMs: 100, windowMs: 30000, quietMax: 20, maxWaitMs: 8000, timeoutMs: 10000, tokenTimeoutMs: 8000 };
    this.waiting = [];             // jobs: { prio, quiet, grant(bool), fail(err), timer }
    this.inflight = 0;
    this.lastStart = 0;
    this.starts = [];              // start times inside the rolling window
    this.calls = 0;                // requests started since boot
    this.n429 = 0;
    this.blockedUntil = 0;
    this.last429Path = null;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.refreshToken = j.refresh_token || null;
      this.user = j.user || null;
    } catch (e) { /* not connected yet */ }
  }

  get ready() { return !!(this.clientId && this.refreshToken); }
  blocked() { return this.now() < this.blockedUntil; }
  window() {
    const t = this.now() - this.lim.windowMs;
    while (this.starts.length && this.starts[0] <= t) this.starts.shift();
    return this.starts.length;
  }

  info() {
    return { configured: !!this.clientId, connected: this.ready, user: this.user,
      window: this.window(), inflight: this.inflight, queued: this.waiting.length, calls: this.calls, n429: this.n429,
      blocked_until: this.blocked() ? this.blockedUntil : 0, last429_path: this.last429Path,
      auth_broken: this.authBroken ? { at: this.authBroken.at, message: this.authBroken.message } : null,
      catch_callback: this.catchCallback };
  }

  save(extra = {}) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ refresh_token: this.refreshToken, user: this.user, saved: new Date().toISOString(), ...extra }), { mode: 0o600 });
    renameRetrySync(tmp, this.file);          // (Windows: retried while a scanner holds the old file a moment)
  }

  // ------------------------------------------------------------------ login
  loginUrl() {
    if (!this.clientId) throw fail(503, 'no_client_id', t('en', 'Add your Spotify Client ID in the setup guide (step 2) first.'));
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(12));
    for (const [k, v] of this.pending) if (Date.now() - v.t > PENDING_MS) this.pending.delete(k);
    this.pending.set(state, { verifier, t: Date.now() });
    this.lastCatch = null;
    const q = new URLSearchParams({ client_id: this.clientId, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), state });
    if (this.catchCallback) this.startCatcher();
    return `${this.authBase}/authorize?${q}`;
  }

  // ---- the redirect catcher (Windows, D12)
  // Listens on 127.0.0.1 at the redirect's port while a sign-in is pending (until PENDING_MS after the last Connect),
  // so Windows Firewall never asks about it and no other computer can reach it. It answers only GET /callback with a
  // pending state; everything else gets a plain page. If the port is taken, the paste box is the way, as on Docker.
  startCatcher() {
    if (this.catcher) { this.catcher.until = Date.now() + PENDING_MS; return; }
    const server = http.createServer((req, res) => { this.onCallback(req, res).catch(() => { try { res.destroy(); } catch (e) { /* gone */ } }); });
    const c = { server, until: Date.now() + PENDING_MS, timer: null };
    this.catcher = c;
    server.on('error', (e) => {
      this.stopCatcher(c);
      log.info(`the Spotify sign-in can't come back to this computer by itself (port ${this.callbackPort}: ${e.code || 'error'}): paste the address on the admin page`);
    });
    server.listen(this.callbackPort, '127.0.0.1');
    server.unref();
    c.timer = setInterval(() => { if (Date.now() > c.until || !this.pending.size) this.stopCatcher(c); }, 30000);
    c.timer.unref();
  }

  stopCatcher(c = this.catcher) {
    if (!c) return;
    clearInterval(c.timer);
    try { c.server.close(); } catch (e) { /* not listening */ }
    if (this.catcher === c) this.catcher = null;
  }

  async onCallback(req, res) {
    const lang = langOf(req);                // the browser's language (Accept-Language), i18n.js
    const page = (status, title, text) => {
      const body = `<!doctype html><html lang="${lang === 'zh_CN' ? 'zh-CN' : lang}"><head>` + '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Encore Bridge</title></head><body style="font:15px/1.5 system-ui,sans-serif;margin:40px auto;max-width:560px;padding:0 16px">' +
        `<h1 style="font-size:20px">${escHtml(title)}</h1><p>${escHtml(text)}</p></body></html>`;
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    let u = null;
    try { u = new URL(req.url, REDIRECT); } catch (e) { u = null; }
    if (req.method !== 'GET' || !u || u.pathname !== '/callback' || !CALLBACK_HOST.test(String(req.headers.host || ''))) {
      return page(404, 'Encore Bridge', t(lang, 'This address only finishes a Spotify sign-in started on the Encore Bridge admin page.'));
    }
    if (!u.searchParams.get('error') && !this.pending.has(u.searchParams.get('state') || '')) {
      return page(400, t(lang, 'Not connected'), t(lang, 'This sign-in link is old or from another tab. Go back to the Encore Bridge admin page and press Connect again.'));
    }
    try {
      await this.finishLogin(u.href);
    } catch (e) {
      // the setup guide is waiting for this sign-in: it reads the code (never the message) and stops waiting
      this.lastCatch = { code: /^[a-z_]{1,40}$/.test(String(e.code || '')) ? e.code : 'error', at: Date.now() };
      const error = tx(lang, e.message);
      const text = e.code === 'spotify_forbidden'
        ? t(lang, '{error} Add your Spotify account under User Management in your developer app (step 2 of the setup guide), then press Connect again on the Encore Bridge admin page.', { error })
        : t(lang, '{error} Go back to the Encore Bridge admin page to try again.', { error });
      return page(e.status && e.status < 500 ? 400 : 502, t(lang, 'Not connected'), text);
    }
    page(200, t(lang, 'Spotify account connected'), t(lang, 'You can close this tab and go back to the Encore Bridge admin page.'));
    if (!this.pending.size) this.stopCatcher();
    this.emit('caught');
  }

  async finishLogin(pasted) {
    let u;
    try { u = new URL(String(pasted || '').trim()); } catch (e) { throw fail(400, 'bad_url', t('en', 'paste the whole address from the browser (it starts with http://127.0.0.1:8888/callback)')); }
    if (u.searchParams.get('error')) throw fail(400, 'denied', t('en', 'Spotify said: {error}', { error: u.searchParams.get('error') }));
    const code = u.searchParams.get('code');
    const p = this.pending.get(u.searchParams.get('state') || '');
    if (!code || !p) throw fail(400, 'bad_state', t('en', 'that login link is old or from another tab; press Connect again'));
    this.pending.delete(u.searchParams.get('state'));
    const tok = await this.tokenCall({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: this.clientId, code_verifier: p.verifier });
    // The new sign-in counts only once GET /me answers: Spotify refuses it (403) for an account that isn't under the
    // developer app's User Management. Until then the previous state is kept, and a refusal puts it back, so the admin
    // page shows "Not connected" (or the old account) with its Connect button, never a half-connected bridge.
    const before = { refreshToken: this.refreshToken, access: this.access, user: this.user, authBroken: this.authBroken };
    this.refreshToken = tok.refresh_token;
    this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
    this.authBroken = null;
    let me;
    try {
      me = await this.api('GET', '/me', undefined, { prio: 'player' });
      if (!me || !me.id) throw fail(502, 'spotify_error', t('en', 'Spotify didn\'t say which account signed in. Try again in a moment.'));
    } catch (e) {
      if (this.refreshToken === tok.refresh_token) Object.assign(this, before);       // (unless a newer sign-in won meanwhile)
      throw e;
    }
    this.user = { id: me.id, name: me.display_name || me.id, product: me.product };
    this.lastCatch = null;
    this.save();
    log.info('Spotify account connected');                  // never the account's name
    return this.info();
  }

  disconnect() {
    this.refreshToken = null;
    this.access = null;
    this.user = null;
    this.authBroken = null;
    try { fs.unlinkSync(this.file); } catch (e) { /* already gone */ }
  }

  // The setup guide saved another Client ID (DESIGN-WIZARD.md §3.4): it applies at once, no restart. Sign-ins started
  // under the old one are dropped, the redirect catcher stops, and a connected account is disconnected (its refresh
  // token belongs to the old developer app). -> { changed, disconnected }
  setClientId(id) {
    const next = id ? String(id) : '';
    if (next === (this.clientId || '')) return { changed: false, disconnected: false };
    this.clientId = next;
    this.pending.clear();
    this.lastCatch = null;
    this.stopCatcher();
    let disconnected = false;
    if (this.refreshToken) { this.disconnect(); disconnected = true; }
    this.access = null;
    return { changed: true, disconnected };
  }

  // refresh: a refresh-token grant (a refusal there means the stored sign-in is dead, not a bad paste)
  async tokenCall(params, refresh = false) {
    let r;
    let j;
    try {
      r = await this.fetch(`${this.authBase}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params), signal: AbortSignal.timeout(this.lim.tokenTimeoutMs) });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      throw fail(502, 'spotify_error', t('en', 'Spotify sign-in didn\'t answer. Try again in a moment.'));
    }
    if (r.ok) return j;
    const why = j.error_description || j.error || r.status;
    if ((r.status === 400 || r.status === 401) && refresh) {
      const message = t('en', 'Spotify sign-in expired: reconnect on the Encore Bridge admin page');
      if (!this.authBroken) {
        log.error(`Spotify refused the stored sign-in (${why}): reconnect the account on the admin page`);
        this.emit('notice', { code: 'spotify_auth', message });
      }
      const now = this.now();
      this.authBroken = { at: this.authBroken ? this.authBroken.at : now, message, tried: now };
      throw fail(503, 'spotify_auth', message);
    }
    if (r.status === 400 || r.status === 401) throw fail(400, 'spotify_auth', t('en', 'Spotify login: {why}', { why }));
    throw fail(502, 'spotify_error', t('en', 'Spotify sign-in failed ({status}). Try again in a moment.', { status: r.status }));
  }

  async token() {
    if (this.access && Date.now() < this.access.exp) return this.access.token;
    if (!this.ready) throw fail(503, 'spotify_not_connected', t('en', 'Connect your Spotify account on the Encore Bridge admin page first'));
    if (this.authBroken && this.now() - this.authBroken.tried < AUTH_RETRY_MS) throw fail(503, 'spotify_auth', this.authBroken.message);
    if (!this.refreshing) {
      this.refreshing = this.tokenCall({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.clientId }, true)
        .then((t) => {
          this.access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
          this.authBroken = null;
          if (t.refresh_token && t.refresh_token !== this.refreshToken) {
            this.refreshToken = t.refresh_token;
            // Spotify rotated the refresh token: losing it means a new login after the next restart
            try { this.save(); } catch (e) { log.error('COULD NOT SAVE the rotated Spotify refresh token (reconnect after a restart):', e.message); }
          }
        })
        .finally(() => { this.refreshing = null; });
    }
    await this.refreshing;
    return this.access.token;
  }

  // ------------------------------------------------------------------ queue + gate
  gateError() {
    const s = Math.max(1, Math.ceil((this.blockedUntil - this.now()) / 1000));
    return fail(503, 'rate_limited', t('en', 'Spotify is limiting requests. Try again in {s} s.', { s }), { retry_after: s });
  }

  // a retry that finds the gate closed (another request hit a 429 meanwhile) doesn't go out
  gated(quiet) {
    if (quiet) return undefined;
    throw this.gateError();
  }

  // Resolves true with a slot, false when a quiet caller is turned away; rejects (busy, rate_limited) otherwise.
  acquire(prio, quiet) {
    return new Promise((resolve, reject) => {
      const job = { prio, quiet, grant: resolve, fail: reject };
      job.timer = setTimeout(() => {
        const i = this.waiting.indexOf(job);
        if (i < 0) return;
        this.waiting.splice(i, 1);
        if (quiet) resolve(false);
        else reject(fail(503, 'busy', t('en', 'Spotify is busy. Try again in a moment.'), { retry_after: 5 }));
      }, this.lim.maxWaitMs);
      if (prio === 'player') {                         // ahead of everything waiting, behind earlier player calls
        let i = 0;
        while (i < this.waiting.length && this.waiting[i].prio === 'player') i++;
        this.waiting.splice(i, 0, job);
      } else this.waiting.push(job);
      this.pump();
    });
  }

  pump() {
    while (this.waiting.length && this.inflight < this.lim.inflight) {
      const gap = this.lastStart + this.lim.spacingMs - Date.now();
      if (gap > 0) {
        if (!this.pumpTimer) this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, gap);
        return;
      }
      const job = this.waiting.shift();
      clearTimeout(job.timer);
      if (this.blocked()) { if (job.quiet) job.grant(false); else job.fail(this.gateError()); continue; }
      if (job.quiet && this.window() >= this.lim.quietMax) { job.grant(false); continue; }   // skips its turn
      this.inflight++;
      this.lastStart = Date.now();
      job.grant(true);
    }
  }

  release() { this.inflight--; this.pump(); }

  noteStart() {
    this.calls++;
    this.lastStart = Date.now();
    this.window();
    this.starts.push(this.now());
  }

  // ------------------------------------------------------------------ calls
  // opts.prio 'player': takeOver, transfer, lastPlayed, playback inside a command. opts.quiet: background callers
  // (resolve undefined instead of throwing when the queue or the gate stops them).
  async api(method, p, body, { prio, quiet } = {}) {
    if (this.blocked()) { if (quiet) return undefined; throw this.gateError(); }
    if (quiet && (!this.ready || this.window() >= this.lim.quietMax)) return undefined;
    if (!this.ready) throw fail(503, 'spotify_not_connected', t('en', 'Connect your Spotify account on the Encore Bridge admin page first'));
    if (!(await this.acquire(prio, quiet))) return undefined;
    try { return await this.attempts(method, p, body, quiet); }
    finally { this.release(); }
  }

  async attempts(method, p, body, quiet) {
    const route = p.split('?')[0];                      // logs and messages never carry the query
    let tok = await this.token();
    let retried401 = false;
    let retried = false;                                // the one automatic retry of a GET
    for (let first = true; ; first = false) {
      const o = { method, headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(this.lim.timeoutMs) };
      if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
      this.noteStart();
      let r;
      let text;
      try {
        r = await this.fetch(this.apiBase + p, o);
        text = await r.text();
      } catch (e) {
        if (method === 'GET' && !retried) {
          retried = true;
          await sleep(300 + Math.random() * 500);
          if (this.blocked()) return this.gated(quiet);
          continue;
        }
        const late = e.name === 'TimeoutError' || e.name === 'AbortError';
        throw fail(502, 'spotify_error', late ? t('en', 'Spotify didn\'t answer in time.') : t('en', 'Spotify isn\'t reachable right now.'));
      }
      if (r.status === 401 && !retried401) {
        retried401 = true;
        if (this.access && tok === this.access.token) this.access = null;      // parallel 401s refresh once
        tok = await this.token();
        if (this.blocked()) return this.gated(quiet);
        continue;
      }
      if (r.status === 429) {
        const ra = Math.max(1, Number(r.headers.get('retry-after')) || 1);
        this.n429++;
        this.last429Path = route;
        const was = this.blocked();
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + ra * 1000 + Math.random() * 1000);
        if (!was) log.warn(`Spotify answered 429 on ${method} ${route}: no Web API requests for ${ra} s`);
        for (const job of this.waiting.splice(0)) {        // nothing waiting goes out either
          clearTimeout(job.timer);
          if (job.quiet) job.grant(false); else job.fail(this.gateError());
        }
        if (first && !quiet && ra <= 2) { await sleep(Math.max(0, this.blockedUntil - this.now())); continue; }
        if (quiet) return undefined;
        throw this.gateError();
      }
      if (r.status >= 500 && method === 'GET' && !retried) {
        retried = true;
        await sleep(300 + Math.random() * 500);
        if (this.blocked()) return this.gated(quiet);
        continue;
      }
      let j = null;
      try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
      if (r.ok) return j;
      const msg = (j && j.error && (j.error.message || j.error.reason)) || String(r.status);
      const extra = { spotifyStatus: r.status };
      if (r.status === 403) throw fail(403, 'spotify_forbidden', t('en', 'Spotify refused this ({method} {route}: {msg}).', { method, route, msg }), extra);
      if (r.status === 404) throw fail(404, 'not_found', t('en', "Spotify doesn't have this ({method} {route}).", { method, route }), extra);
      // never a 401 to the phone: that means "unpair" there
      throw fail(502, 'spotify_error', `Spotify ${method} ${route}: ${msg}`, extra);
    }
  }

  // What the account is playing right now on any device, in the gateway's track shape. null = nothing,
  // undefined = a quiet call that was turned away.
  async playback(prio, quiet) {
    const j = await this.api('GET', '/me/player?additional_types=track', undefined, { prio, quiet });
    if (j === undefined) return undefined;
    if (!j || !j.device) return null;
    const it = j.item;
    const cover = it && it.album && it.album.images && it.album.images[0] && it.album.images[0].url;
    return {
      device: { id: j.device.id, name: j.device.name, type: j.device.type },
      is_playing: !!j.is_playing,
      position_ms: j.progress_ms || 0,
      at: Date.now(),
      context_uri: j.context && j.context.uri,
      track: it && it.type === 'track' ? {
        uri: it.uri, name: it.name, artists: (it.artists || []).map((a) => a.name), album: it.album && it.album.name,
        cover, duration_ms: it.duration_ms, album_uri: (it.album && it.album.uri) || undefined,
        artist_uris: (it.artists || []).map((a) => a.uri).filter(Boolean),
      } : null,
    };
  }

  transfer(deviceId, play) { return this.api('PUT', '/me/player', { device_ids: [deviceId], play: !!play }, { prio: 'player' }); }

  async lastPlayed() {
    const j = await this.api('GET', '/me/player/recently-played?limit=1', undefined, { prio: 'player' });
    const it = j && j.items && j.items[0];
    return it ? { uri: it.track.uri, context_uri: it.context && it.context.uri } : null;
  }
}

module.exports = { WebApi, REDIRECT };
