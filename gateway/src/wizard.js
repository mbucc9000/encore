'use strict';
// The setup guide's state (DESIGN-WIZARD.md §1-§2): the admin page's step-by-step "Setup guide" reads
// GET /admin/api/wizard and ticks each step by itself.
//
// Steps: password, client_id, spotify, engine, network, app, pair, away, play. Each step's "done" comes from the
// bridge's own state (the admin password, the Client ID, the Spotify account, the engine's sign-in, the last network
// check, the paired phones, a paired phone reaching the bridge from outside the home network, music reaching a phone);
// the guide's own state is data/wizard.json: {v, complete, complete_how, completed_at, dismissed, skipped,
// away_seen_at, played_at}. No names, addresses or codes ever go in it, or in an answer; the home's public IP never
// does either (only POST /admin/api/wizard/public-ip answers it, netcheck.js's PublicIp).
//
// The app comes from the Encore repo in Cydia (cfg.appRepo): the bridge can't see Cydia, so step 6 ticks with a paired
// phone. Step 8 (Listen away from home) ticks the first time a signed phone request arrives from an address outside
// the default private set (http.js calls noteAway()).
//
// An install that is already set up is never pushed through the guide: when an admin password exists, a Client ID is
// set, the Spotify account is connected and a phone is paired, setup is complete ("auto"), at startup or at any later
// read, and a complete setup never becomes incomplete again (unpairing every phone later doesn't reopen it).
const fs = require('fs');
const path = require('path');
const log = require('./log');
const { renameRetrySync } = require('./fsutil');
const { hint } = require('./clientid');

const STEPS = ['password', 'client_id', 'spotify', 'engine', 'network', 'app', 'pair', 'away', 'play'];
const FILE = 'wizard.json';
const PLAY_FRESH_MS = 15000;          // a playhead report this recent ...
const PLAY_FRAMES = 43;               // ... at least this far into the song (about 1 s of AAC frames)
const PLAY_LISTEN_MS = 5000;          // or a phone listening this long while playing

const fresh = () => ({ v: 1, complete: false, complete_how: null, completed_at: null, dismissed: false, skipped: [],
  away_seen_at: null, played_at: null });
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);

class Wizard {
  // engineState(): the engine sign-in (http.js's memo, quick); lanAddress(): this computer's address (memo, quick);
  // candidates(): lanCandidates() of this computer's adapters (step 8's "other addresses")
  constructor({ cfg = {}, adminAuth = null, webapi = null, auth = null, player = null, encoders = null, showcase = null,
    netcheck = null, engineState = async () => ({ state: 'unknown' }), lanAddress = async () => null, candidates = () => [], now = Date.now } = {}) {
    Object.assign(this, { cfg, adminAuth, webapi, auth, player, encoders, showcase, netcheck, engineState, lanAddress, candidates, now });
    this.file = cfg.dataDir ? path.join(cfg.dataDir, FILE) : null;
    this.st = fresh();
    this.listenSince = 0;
    this.saveWarned = false;
    this.load();
    this.autoCheck();
  }

  load() {
    if (!this.file) return;
    let j;
    try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') log.warn('data/wizard.json is unreadable, so the setup guide starts over');
      return;
    }
    if (!j || typeof j !== 'object') { log.warn('data/wizard.json is unreadable, so the setup guide starts over'); return; }
    const st = fresh();
    st.complete = j.complete === true;
    st.complete_how = st.complete && (j.complete_how === 'auto' || j.complete_how === 'finished') ? j.complete_how : st.complete ? 'finished' : null;
    st.completed_at = st.complete ? num(j.completed_at) : null;
    st.dismissed = j.dismissed === true;
    st.skipped = Array.isArray(j.skipped) ? [...new Set(j.skipped.filter((s) => STEPS.includes(s) && s !== 'password'))] : [];
    st.away_seen_at = num(j.away_seen_at);           // (an older file's downloaded_at is ignored)
    st.played_at = num(j.played_at);
    this.st = st;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 });
      renameRetrySync(tmp, this.file);
      this.saveWarned = false;
    } catch (e) {
      if (!this.saveWarned) log.warn(`the setup guide's progress couldn't be saved (${e.code || 'error'})`);
      this.saveWarned = true;
    }
  }

  // ---- the facts the steps tick from
  passwordSet() { return !!(this.adminAuth && typeof this.adminAuth.mode === 'function' && this.adminAuth.mode() !== 'setup'); }
  clientId() { return (this.webapi && this.webapi.clientId) || ''; }
  connected() { return !!(this.webapi && this.webapi.ready); }
  devices() { try { return (this.auth && typeof this.auth.list === 'function' && this.auth.list()) || []; } catch (e) { return []; } }

  // an install that is already set up: complete ("auto"), once and for good
  autoCheck() {
    if (this.st.complete) return true;
    if (this.passwordSet() && this.clientId() && this.connected() && this.devices().length > 0) {
      Object.assign(this.st, { complete: true, complete_how: 'auto', completed_at: this.now() });
      this.save();
      log.info('setup guide: this bridge is already set up');
      return true;
    }
    return false;
  }

  isComplete() { return this.autoCheck(); }

  // for the admin status (the dashboard's banner)
  statusInfo() { this.autoCheck(); return { complete: this.st.complete, dismissed: this.st.dismissed }; }

  // a paired phone's signed request came from outside the home network (http.js; DESIGN-WIZARD.md §5.3): the first
  // one ticks step 8 and is kept; afterwards nothing (no write per request). The address is never passed, kept or logged.
  noteAway() {
    if (this.st.away_seen_at) return false;
    this.st.away_seen_at = this.now();
    this.save();
    log.info('setup guide: a phone reached the bridge from outside the home network');
    return true;
  }

  // step 8's list of this computer's home-network addresses: the chosen one first, then the other private IPv4
  // addresses on real (not virtual) adapters, no duplicates
  addresses(address) {
    let list = [];
    try { list = (this.candidates() || []).filter((c) => c && !c.virtual && c.address).map((c) => String(c.address)); } catch (e) { list = []; }
    return [...new Set([...(address ? [address] : []), ...list])];
  }

  // music reached a phone: the player is playing a song and a phone reported hearing it (a fresh report, about 1 s in,
  // not stalled), or a phone has been listening for 5 s while it plays
  checkPlay() {
    if (this.st.played_at) return;
    const p = this.player;
    const playing = !!(p && p.st && p.st.status === 'playing' && p.st.track);
    if (!playing) { this.listenSince = 0; return; }
    let heard = null;
    try { heard = typeof p.heardInfo === 'function' ? p.heardInfo() : null; } catch (e) { heard = null; }
    const now = this.now();
    let ok = !!(heard && heard.age_ms < PLAY_FRESH_MS && !heard.stalled && heard.frame >= PLAY_FRAMES);
    let listening = 0;
    try { listening = this.encoders && typeof this.encoders.listening === 'function' ? this.encoders.listening() : 0; } catch (e) { listening = 0; }
    if (listening > 0) {
      if (!this.listenSince) this.listenSince = now;
      else if (now - this.listenSince >= PLAY_LISTEN_MS) ok = true;
    } else this.listenSince = 0;
    if (ok) {
      this.st.played_at = now;
      this.save();
    }
  }

  // GET /admin/api/wizard (§2.1)
  async answer() {
    this.autoCheck();
    const sc = !!(this.showcase && this.showcase.isOn());
    const cfg = this.cfg;
    const [eng, address] = await Promise.all([
      Promise.resolve().then(() => this.engineState()).catch(() => ({ state: 'unknown' })),
      Promise.resolve().then(() => this.lanAddress()).catch(() => null),
    ]);
    const devs = this.devices();
    let newest = null;
    for (const d of devs) { const t = Date.parse(d && d.created); if (Number.isFinite(t) && (newest == null || t > newest)) newest = t; }
    this.checkPlay();
    const id = this.clientId();
    const source = cfg.spotifyClientIdSource || null;
    const net = this.netcheck ? this.netcheck.summary() : { ok: null, checked_at: null };
    const port = cfg.port || 8095;
    const paired = devs.length;
    const st = this.st;
    const engineState = eng && typeof eng.state === 'string' ? eng.state : 'unknown';
    const ready = this.connected();
    const broken = !!(this.webapi && this.webapi.authBroken);
    // Windows: the sign-in came back to this computer and didn't connect (an error code only, never its message)
    const caught = !ready && this.webapi && this.webapi.lastCatch && typeof this.webapi.lastCatch.code === 'string' ? this.webapi.lastCatch.code : null;
    return {
      v: 1, now: this.now(), platform: cfg.platformKind || (cfg.windows ? 'windows' : 'other'), showcase: sc,
      show: !st.complete && !st.dismissed, complete: st.complete, complete_how: st.complete_how, dismissed: st.dismissed, skipped: [...st.skipped],
      steps: {
        password: { done: this.passwordSet(), how: this.adminAuth && typeof this.adminAuth.mode === 'function' ? this.adminAuth.mode() : null },
        client_id: { done: !!id, source, editable: source !== 'env', hint: id && !sc ? hint(id) : null },
        spotify: { done: ready && !broken, configured: !!id, catch_callback: !!(this.webapi && this.webapi.catchCallback), auth_broken: broken,
          error: caught },
        engine: { done: engineState === 'signed_in', state: engineState, managed: !!(eng && eng.managed) },
        network: { done: net.ok === true || paired > 0, ok: net.ok, checked_at: net.checked_at },
        // the Encore repo address is public (not personal): also in Showcase
        app: { done: paired > 0, repo_url: cfg.appRepo || null },
        pair: { done: paired > 0, paired, newest_at: newest, address: sc ? null : address || null, port },
        // never the public IP here (only the public-IP route answers it)
        away: { done: st.away_seen_at != null, seen_at: st.away_seen_at, address: sc ? null : address || null,
          addresses: sc ? null : this.addresses(address), port },
        play: { done: st.played_at != null, played_at: st.played_at },
      },
    };
  }

  // POST /admin/api/wizard {action, step?} (§2.2)
  act(b = {}) {
    const a = b && b.action;
    if (a === 'skip') {
      if (!STEPS.includes(b.step) || b.step === 'password') throw fail(400, 'bad_request', 'That step can\'t be skipped.');
      if (!this.st.skipped.includes(b.step)) { this.st.skipped.push(b.step); this.save(); }
    } else if (a === 'dismiss') {
      if (!this.st.dismissed) { this.st.dismissed = true; this.save(); }
    } else if (a === 'complete') {
      if (!this.st.complete) {
        Object.assign(this.st, { complete: true, complete_how: 'finished', completed_at: this.now() });
        this.save();
        log.info('setup guide: finished');
      }
    } else throw fail(400, 'bad_request', 'Unknown action.');
  }
}

module.exports = { Wizard, STEPS, FILE };
