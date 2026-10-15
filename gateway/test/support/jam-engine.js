'use strict';
// A model of go-librespot + Encore patches 1–3 as the gateway's Jam code sees it (DESIGN-4b.md §3): /status with
// jam_mode, jam_routes, social and queue_edit; the /jam/* routes (with 4b-c's /jam/remove, C0's kick) over a scripted
// social-connect "Spotify" with the engine's gate emulated (one call in flight, ≥ spacingMs between sends, ≤ waitMs in
// line, cap sends per 5 min, a 429 hold) and its status mapping (403 + X-Upstream-Status for 401/403, 404/410, 409, 429
// with Retry-After, 502); /player/queue with item 11's rev, and /player/queue/remove|move (engine-local edits: 409 for
// a stale rev, 400 for autoplay rows, cross-section moves and context edits while shuffled); enough of /player/* for
// the player; helpers that emit the Jam events in the orders of §5.6's table, and C0-shaped session_update pushes.
// Sessions are in C0's 2026 shape (probes/jam-c0/c0.json) with synthetic values; the keys C0 masked use stand-in names.
// Patch 4 (DESIGN-JAM-WAIT §3.2), only when o.routes lists 'broadcast' (the default ROUTES stays a patch-3 engine):
// GET/POST /jam/broadcast over Spotify's jam_status / set_broadcast_status for Encore (bc, C0's reply shape, the
// engine's {broadcast_status, self} answer), broadcast_status_update pushes for Encore, o.handOver (when "Spotify"
// hands a started Jam to Encore: never | always | broadcast | transition), o.standby (SESSION_DELETED on end, then a
// standby NEW_SESSION hosted on Encore while bc is ON, deleted again by an OFF), and the patch-4 engine events.
// Patch 5 (DESIGN-JAM-SELF §3.11), only when o.routes lists 'activate': POST /jam/activate, engine-local like
// /jam/forget (never a send): 409 while not the active device (st.inactive), with nothing loaded, or over a Jam's list or
// a social-connect origin; {changed:false} when the mode is on already; else the mode goes "on", the `jam` event
// (o.dropJamEvent: lost; o.activateEvAfter: ms after the reply instead of before it) and Spotify's cluster echo
// (o.clusterEcho false: none). m.activations counts the requests; m.answer.activate overrides the answer.
// Patch 9 (DESIGN-QUEUE §3, §4.5), only with o.queueOps (default [] = today's engine: no queue_ops in /status, 404 for
// the new routes): /status queue_ops; edits of shuffled context rows when 'shuffled' is listed; POST /player/queue/top
// {rev, uid} -> {rev, uid} ('top': the 204/400/409 rules of remove; a queue row moves to the head of the queue with its
// uid, already first = 200 with nothing changed; a context or autoplay row leaves its place and becomes a queued row
// q<n> at the head, its metadata kept, is_queued set, the autoplay flag dropped); POST /player/queue/jump {uid} ->
// {rev} ('jump': the uid exactly among the next rows, else 409, the current row too; a queued target drops the queued
// rows above it, any other target drops the context and autoplay rows above it and keeps the queue; then it loads the
// target, whose uid is the current row's). The window stays next.slice(0, 32), so it refills from the rest of next.
// m.tops / m.jumps count the requests; m.answer.jump overrides the jump's answer (after the 400 check).
// Nothing here talks to any network: it is the "Spotify" of the offline tests.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex32 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function id22(s) {
  const h = crypto.createHash('sha256').update(String(s)).digest();
  let out = '';
  for (let i = 0; i < 22; i++) out += B62[h[i] % 62];
  return out;
}
const T = (n) => 'spotify:track:' + id22('t' + n);
const JAM_LIST = 'spotify:list:jam-list:';
const JAM = (n) => JAM_LIST + hex32('jam' + n);
const BC_ENUM = /^[A-Z][A-Z_]{2,39}$/;
const SOCIAL = 'social-connect-' + hex32('sc');
const ROUTES = ['current', 'start', 'info', 'join', 'leave', 'end', 'remove', 'forget'];
const DEV = 'encoredev0001';                     // Encore's device id in the model's /status
const PC = hex32('pc') + 'a1b2c3d4';             // another device of the account (40 hex)
const LINK = id22('link-encore');                // Encore's link_token and social_radar_token at "Spotify" (C0: 22 and 20 base62)
const RADAR = id22('radar-encore').slice(0, 20);
const ME = 'alex';
const sid32 = (u) => hex32('user:' + u);         // a member's Spotify `id` (32 hex); MEM ids stay the usernames
const pic = (u, size) => 'https://i.scdn.co/image/' + (size === 'large' ? 'ab6775700000ee85' : 'ab67757000003b82') + hex32('pic' + u).slice(0, 24);
// FNV-1a 64 over the current uid and each upcoming uid (uri when empty), \n-separated: the engine's queue rev (item 11)
function fnv(parts) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(parts.join('\n'))) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}

function track(uri, o = {}) {
  return { uri, name: o.name || 'Song ' + uri.slice(-4), artist_names: ['Artist A'], artist_uris: ['spotify:artist:' + id22('a')], album_name: 'Album',
    album_uri: 'spotify:album:' + id22('al'), album_cover_url: 'https://i.scdn.co/image/ab67616d00001e02' + hex32('c').slice(0, 24), position: o.position || 0,
    duration: o.duration || 200000, explicit: false, context_track_uri: uri };
}

// A member in C0's shape (synthetic values): `id` 32 hex, username, display_name, both pictures, the flags and the
// playback-control enum under a stand-in name (C0 masked it whole: one camelCase word).
function member(u, { me = u === ME, listening = me, names = {} } = {}) {
  const m = { joined_timestamp: String(1760000000000 + u.length), id: sid32(u), username: u, display_name: u[0].toUpperCase() + u.slice(1),
    image_url: pic(u, 'small'), large_image_url: pic(u, 'large'), is_listening: listening, is_controlling: true };
  m[names.control || 'playbackControl'] = listening ? 'LISTEN_AND_CONTROL' : 'CONTROL';
  if (me) m.is_current_user = true;
  return m;
}

// A session in C0's 2026 shape (probes/jam-c0/c0.json), synthetic values. owner: is_session_owner (this account's view);
// hostId: the host's username (session_owner_id = its Spotify id); hostDev: host_device_info.device_id (Encore's by
// default); names: other stand-ins for the masked keys (caps, remove, control, limit).
function session({ sid = hex32('s1'), token = id22('t1'), owner = true, members = [ME], hostId, gc = true, hostDev = DEV, names = {}, url } = {}) {
  const host = hostId || members[0];
  const s = { timestamp: '1760000000000', session_id: sid, join_session_token: token,
    join_session_url: url !== undefined ? url : 'open.spotify.com/socialsession/' + token, session_owner_id: sid32(host),
    session_members: members.map((u) => member(u, { names })), join_session_uri: 'spotify:socialsession:' + token,
    is_session_owner: owner, is_listening: true, is_controlling: true, active: true, queue_only_mode: !gc, wifi_broadcast: false,
    host_device_info: { device_id: hostDev, device_name: hostDev === DEV ? 'Encore' : 'Living Room PC', device_type: hostDev === DEV ? 'SMARTPHONE' : 'COMPUTER', is_group: false },
    is_paused: false, session_config: {}, requires_jam_lens: true };
  s[names.limit || 'maxMemberCount'] = 32;
  s[names.caps || 'user_capabilities'] = { invite: true, [names.remove || 'remove_participants']: owner, manage_participant_settings: owner };
  return s;
}

class JamEngine extends EventEmitter {
  constructor(o = {}) {
    super();
    this.o = { username: ME, routes: ROUTES, patch3: true, queueEdit: true, queueOps: [], spacingMs: 1000, waitMs: 5000, cap: 30, handOver: 'never', handOverMs: 50, ...o };
    this.username = this.o.username;
    // patch 4's "Spotify" side: Encore's (DEV's) Jam broadcast, whether an OFF -> ON happened since the last
    // current_or_new, every status set (in order), the standby session after an end, the sessions made so far
    this.bc = this.o.bc || 'BROADCAST_OFF';
    this.bcRise = false;
    this.bcSets = [];
    this.standby = null;
    this.made = 0;
    this.standbys = 0;
    // inactive (patch 5's model): the engine isn't the active device (only /jam/activate looks at it)
    // curUid: the current row's uid when a jump (patch 9) loaded it (else one made from the track)
    this.st = { track: null, ctx: '', paused: false, stopped: true, mode: '', origin: null, ctxName: null, shuffle: false, inactive: false, curUid: null };
    this.queueId = 100;              // the q<n> uids of patch 9's top
    this.activations = 0;            // POST /jam/activate requests (patch 5)
    this.next = [];                  // queue entries {uri, uid, provider, metadata, track?}
    this.spotify = null;             // the account's current session (Spotify's side)
    this.answer = {};                // op -> (args) => {status, json?, retryAfter?} overrides
    this.calls = [];                 // social-connect sends {op, t}
    this.log = [];                   // every request {method, path, body}
    this.gate = { busy: false, q: [], last: 0, sends: [], renewals: 0, holdUntil: 0 };
    this.noSession = false;
    this.delay = {};                 // op -> ms the "Spotify" answer takes
  }

  count(re) { return this.log.filter((x) => re.test(x.path)).length; }
  sends(op) { return this.calls.filter((c) => !op || c.op === op).length; }

  // ---------------------------------------------------------------- events
  ev(type, data = {}) { this.emit('event', { type, data }); }
  jamEv() { this.ev('jam', { mode: this.st.mode, origin: this.st.origin || '', context_uri: this.st.ctx }); }
  setJam(mode, origin, ctx) {
    Object.assign(this.st, { mode, origin, ctx });
    this.jamEv();
  }
  // a load the engine makes (a transfer that doesn't continue, a skip, ...)
  load(uri, { ctx, origin, position = 0, playing = true, uid = null } = {}) {
    this.ev('active', {});
    if (ctx !== undefined) this.st.ctx = ctx;
    if (origin !== undefined) this.st.origin = origin;
    this.st.track = track(uri, { position });
    this.st.curUid = uid;
    this.st.stopped = false;
    this.st.paused = !playing;
    this.ev('metadata', { ...this.st.track, context_uri: this.st.ctx });
    if (playing) this.ev('playing', {});
  }
  // Jam starts on the speaker: set_options on, then social-connect's transfer of the Jam list (ctx: another jam-list
  // uri, e.g. one whose id is the session id)
  jamStarts(n = 1, first = T(100), ctx = JAM(n)) {
    this.st.mode = 'on';
    this.jamEv();
    this.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: false });
    this.load(first, { ctx, origin: SOCIAL });
    this.jamEv();
  }
  // patch 4: a transfer the engine could not apply (its `command` event with continues:false and error)
  failedTransfer(error = 'unmarshal') { this.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: false, error }); }
  // patch 4: the connect-state cluster's summary, as the engine emits it on change (kinds, a count, booleans; no ids)
  cluster(d = {}) { this.ev('cluster', { active: 'self', social_devices: 0, jam_context: false, jam_mode: '', social_origin: false, ...d }); }
  // a guest's add: a continuing transfer, the queue changes, no song change
  guestAdd(uri, by) {
    this.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: true });
    this.next.unshift({ uri, uid: 'q' + hex32(uri + Date.now() + Math.random()).slice(0, 8), provider: 'queue', metadata: by ? { added_by: 'spotify:user:' + by } : {}, track: track(uri) });
    this.ev('queue', {});
  }
  // social-connect's whole-Jam transfer that continues the song: the list rebuilt from Spotify's copy (next), which
  // undoes any local edit it doesn't carry (DESIGN-4b.md §3 item 11 "What undoes an edit")
  rebuild(next) {
    this.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: true });
    this.next = next.map((e) => ({ ...e }));
    this.ev('queue', {});
  }
  // a session_update push (C0: no hm:// scheme, a JSON payload {session, reason, update_session_members?})
  push(reason, sess = this.spotify, upd) {
    const payload = { session: JSON.parse(JSON.stringify(sess)), reason };
    if (upd) payload.update_session_members = upd;
    this.ev('social_connect', { uri: 'social-connect/v2/session_update', payload });
  }
  // the devices' broadcast state (C0: keyed by a device id), counted and recorded only
  broadcast(status = 'BROADCAST_ON') {
    this.ev('social_connect', { uri: 'social-connect/v2/broadcast_status_update', payload: { [PC]: { timestamp: '1760000000000', broadcast_status: status, device_id: PC,
      link_token: { token: id22('lt') }, device_type: 'COMPUTER', device_name: 'Living Room PC' } } });
  }
  // Encore's own broadcast state as C0's dealer[1..4] carried it (keyed by the device id; ON adds social_radar_token)
  encoreBroadcast(status = this.bc) {
    this.ev('social_connect', { uri: 'social-connect/v2/broadcast_status_update', payload: { [DEV]: this.bcObject(status) } });
  }
  bcObject(status = this.bc) {
    const o = { timestamp: String(Date.now()), broadcast_status: status, device_id: DEV };
    if (status === 'BROADCAST_ON') o.social_radar_token = { token: RADAR };
    o.link_token = { token: LINK };
    o.device_type = 'SMARTPHONE';
    o.device_name = 'Encore';
    return o;
  }
  // the session_update Spotify pushed when a Jam ended (seen live 2026-10-07)
  pushDeleted(sess) { this.push('SESSION_DELETED', sess); }
  // a guest's skip: a transfer that doesn't continue, then the load
  guestSkip(uri) {
    this.ev('command', { endpoint: 'transfer', from: SOCIAL, continues: false });
    this.ev('active', {});
    this.load(uri, { origin: SOCIAL });
  }
  // a Jam's end: set_options off (optional), then the list-only transfer. item10: idle; else the list from the top.
  jamEnds({ setOptionsOff = true, item10 = true, first = T(100) } = {}) {
    if (setOptionsOff) { this.st.mode = 'off'; this.jamEv(); }
    this.ev('command', { endpoint: 'transfer', from: SOCIAL, jam_end: item10 ? true : undefined });
    if (item10) {
      if (this.st.mode === 'on') this.st.mode = 'off';
      this.st.ctx = '';
      this.st.stopped = true;
      this.jamEv();
      this.ev('stopped', {});
    } else {
      this.st.mode = '';               // the transfer's (empty) options replace them wholesale
      this.jamEv();
      this.load(first);
    }
  }

  // ---------------------------------------------------------------- /status, /player/queue
  status() {
    if (this.noSession) return { status: 204 };
    const s = this.st;
    const j = { username: this.username, device_id: 'encoredev0001', device_type: 'SMARTPHONE', device_name: 'Encore', play_origin: null,
      play_origin_device_id: s.origin, context_uri: s.ctx || null, context_name: s.ctxName, stopped: s.stopped || !s.track, paused: s.paused, buffering: false,
      volume: 100, volume_steps: 100, repeat_context: false, repeat_track: false, shuffle_context: !!s.shuffle,
      track: s.track && !s.stopped ? { ...s.track } : null };
    if (this.o.patch3) {
      if (s.mode) j.jam_mode = s.mode;
      j.jam_routes = this.o.routes;
      const now = Date.now();
      j.social = { sends: this.gate.sends.length, sends5m: this.gate.sends.filter((t) => now - t < 300000).length, renewals: this.gate.renewals };
      if (this.o.queueEdit) j.queue_edit = true;
      if (this.o.queueOps && this.o.queueOps.length) j.queue_ops = [...this.o.queueOps];
    }
    return { status: 200, json: j };
  }

  // item 11's revision: the current uid and each upcoming uid (uri when empty)
  cur() { return this.st.track ? { uri: this.st.track.context_track_uri, uid: this.st.curUid || 'cur' + hex32(this.st.track.uri).slice(0, 6) } : null; }
  ops() { return new Set(this.o.queueOps || []); }
  rev() {
    const c = this.cur();
    return fnv([c ? c.uid : '', ...this.next.slice(0, 32).map((e) => e.uid || e.uri)]);
  }

  // POST /player/queue/remove {rev, uid} and /move {rev, uid, before}: as patch 3 item 11 answers them; /top {rev, uid}:
  // patch 9 item 2
  async edit(op, b) {
    if (op === 'top') this.tops = (this.tops || 0) + 1;
    else this.edits = (this.edits || 0) + 1;
    const bad = (v) => typeof v !== 'string' || !v || Buffer.byteLength(v) > 128;
    if (bad(b.uid) || typeof b.rev !== 'string' || (op === 'move' && (typeof b.before !== 'string' || Buffer.byteLength(b.before) > 128))) return { status: 400 };
    if (this.noSession || !this.st.track) return { status: 204 };
    if (this.editDelay) await sleep(this.editDelay);                      // a slow Run loop
    if (b.rev !== this.rev()) return { status: 409 };
    const i = this.next.findIndex((e) => e.uid === b.uid);
    if (i < 0) return { status: 409 };
    const e = this.next[i];
    const sec = (x) => (x.provider === 'queue' ? 'queue' : x.provider === 'autoplay' ? 'autoplay' : 'context');
    if (sec(e) === 'autoplay' && op !== 'top') return { status: 400 };
    if (sec(e) === 'context' && this.st.shuffle && !this.ops().has('shuffled')) return { status: 400 };
    if (op === 'top') {
      const h = this.next.findIndex((x) => sec(x) === 'queue');   // the head of the queue (none: the head of next)
      let uid = e.uid;
      if (sec(e) === 'queue') {
        if (h === i) return { status: 200, json: { rev: this.rev(), uid } };   // already first: nothing changes or is published
        this.next.splice(i, 1);
        this.next.splice(h, 0, e);
      } else {
        uid = 'q' + ++this.queueId;
        const metadata = { ...(e.metadata || {}), is_queued: 'true' };
        delete metadata['autoplay.is_autoplay'];
        this.next.splice(i, 1);
        this.next.splice(h >= 0 ? h : 0, 0, { ...e, uid, provider: 'queue', metadata });
      }
      setTimeout(() => this.ev('queue', {}), 5);
      return { status: 200, json: { rev: this.rev(), uid } };
    }
    if (op === 'remove') this.next.splice(i, 1);
    else {
      if (b.before === b.uid) return { status: 400 };
      let j = -1;
      if (b.before) {
        j = this.next.findIndex((x) => x.uid === b.before);
        if (j < 0) return { status: 409 };
        if (sec(this.next[j]) !== sec(e)) return { status: 400 };
      }
      this.next.splice(i, 1);
      let k;
      if (b.before) k = this.next.findIndex((x) => x.uid === b.before);
      else {                                          // the end of its own section (where it was, if it is alone)
        let last = -1;
        this.next.forEach((x, n) => { if (sec(x) === sec(e)) last = n; });
        k = last >= 0 ? last + 1 : i;
      }
      this.next.splice(k, 0, e);
    }
    setTimeout(() => this.ev('queue', {}), 5);
    return { status: 200, json: { rev: this.rev() } };
  }

  // POST /player/queue/jump {uid}: patch 9 item 3 (no rev: the uid names the row)
  async jump(b) {
    this.jumps = (this.jumps || 0) + 1;
    if (typeof b.uid !== 'string' || !b.uid || Buffer.byteLength(b.uid) > 128) return { status: 400 };
    if (this.answer.jump) return this.answer.jump(b);
    if (this.noSession || !this.st.track || this.st.stopped) return { status: 204 };
    if (this.jumpDelay) await sleep(this.jumpDelay);
    const i = this.next.findIndex((e) => e.uid === b.uid);
    if (i < 0) return { status: 409 };                                // not upcoming (the current row included)
    const e = this.next[i];
    const queued = e.provider === 'queue';
    // a queued target: the queued rows above it go, the context position stays; else the rows above it go, the queue stays
    this.next = this.next.filter((x, k) => k > i || (queued ? x.provider !== 'queue' : x.provider === 'queue'));
    const playing = !this.st.paused;
    this.st.track = track(e.uri);
    this.st.curUid = e.uid;
    this.st.stopped = false;
    setTimeout(() => {                                                // the load lands after the answer (one track load)
      this.ev('active', {});
      this.ev('metadata', { ...this.st.track, context_uri: this.st.ctx });
      if (playing) this.ev('playing', {});
      this.ev('queue', {});
    }, 10);
    return { status: 200, json: { rev: this.rev() } };
  }

  queue() {
    if (!this.o.patch3) return { status: 404 };
    if (this.noSession) return { status: 204 };
    const s = this.st;
    const c = this.cur();
    const cur = c ? { ...c, provider: 'context', metadata: this.curMeta || {}, track: { ...s.track } } : undefined;
    const j = { context_uri: s.ctx || '', context_name: s.ctxName || '', current: cur, next: this.next.slice(0, 32) };
    if (this.o.queueEdit) j.rev = this.rev();
    return { status: 200, json: j };
  }

  // ---------------------------------------------------------------- the gate (spclient.SocialGate)
  async take() {
    const g = this.gate;
    const now = Date.now();
    if (now < g.holdUntil) return { refuse: Math.ceil((g.holdUntil - now) / 1000) };
    if (g.sends.filter((t) => now - t < 300000).length >= this.o.cap) return { refuse: 60 };
    const t0 = Date.now();
    while (g.busy || Date.now() - g.last < this.o.spacingMs) {
      if (Date.now() - t0 > this.o.waitMs) return { refuse: 5 };
      await sleep(20);
    }
    g.busy = true;
    return {};
  }
  give() { this.gate.busy = false; }
  noteSend(op) { const now = Date.now(); this.gate.sends.push(now); this.gate.last = now; this.calls.push({ op, t: now }); }

  // Spotify's answer for one send (scripted, else the default behaviour of a session service)
  async spotifyAnswer(op, a) {
    if (this.delay[op]) await sleep(this.delay[op]);
    if (this.answer[op]) return this.answer[op](a);
    const sp = this.spotify;
    const me = this.username;
    switch (op) {
      case 'current': return sp && sp.session_members.some((m) => m.username === me) ? { status: 200, json: sp } : { status: 204 };
      case 'start': {
        // current_or_new: the account's session (Encore's standby too: activated, no longer a standby), else a new one
        // (the first one as before: s1/t1; later ones get their own ids)
        if (!sp) {
          this.made++;
          this.spotify = session(this.made === 1 ? { members: [me] } : { sid: hex32('s' + this.made), token: id22('t' + this.made), members: [me] });
        }
        if (this.standby && this.spotify === this.standby) this.standby = null;
        const s = this.spotify;
        // patch 4's hypotheses: when (if ever) "Spotify" hands the Jam to its host, Encore
        const ho = this.o.handOver;
        const rise = this.bcRise;
        this.bcRise = false;
        const encore = s.host_device_info && s.host_device_info.device_id === DEV;
        if (encore && (ho === 'always' || (ho === 'broadcast' && this.bc === 'BROADCAST_ON') || (ho === 'transition' && rise))) {
          const ctx = this.o.handOverSid ? JAM_LIST + s.session_id : JAM(this.o.handOverN || 1);
          setTimeout(() => this.jamStarts(this.o.handOverN || 1, T(100), ctx), this.o.handOverMs);
        }
        return { status: 200, json: s };
      }
      case 'broadcast': {
        // set_broadcast_status for Encore: the new status, a push when it changed (C0's dealer[1..4]); an OFF deletes
        // the standby session (with o.standby)
        const st = a.status === 'on' ? 'BROADCAST_ON' : 'BROADCAST_OFF';
        const was = this.bc;
        this.bc = st;
        this.bcSets.push(st);
        if (was !== st) {
          if (st === 'BROADCAST_ON') this.bcRise = true;
          this.encoreBroadcast(st);
        }
        if (st === 'BROADCAST_OFF' && this.o.standby && this.standby) {
          const sb = this.standby;
          this.standby = null;
          if (this.spotify === sb) this.spotify = null;
          this.pushDeleted(sb);
        }
        return { status: 200, json: { device_broadcast_status: this.bcObject(st) } };
      }
      case 'jam_status': return { status: 200, json: { device_broadcast_status: this.bcObject() } };
      case 'info': return sp && sp.join_session_token === a.token ? { status: 200, json: sp } : { status: 404 };
      case 'join':
        if (!sp || sp.join_session_token !== a.token) return { status: 404 };
        if (!sp.session_members.some((m) => m.username === me)) sp.session_members.push(member(me, { listening: true }));
        return { status: 200, json: { ...sp, is_session_owner: false } };
      case 'remove': {                                // C0's kick: the session without the member (by its Spotify id)
        if (!sp || sp.session_id !== a.sid) return { status: 404 };
        const n = sp.session_members.length;
        sp.session_members = sp.session_members.filter((m) => m.id !== a.member);
        return sp.session_members.length < n ? { status: 200, json: sp } : { status: 404 };
      }
      case 'leave':
        if (!sp || sp.session_id !== a.sid) return { status: 404 };
        sp.session_members = sp.session_members.filter((m) => m.username !== me);
        return { status: 200, json: {} };
      case 'end':
        if (!sp || sp.session_id !== a.sid) return { status: 404 };
        this.spotify = null;
        if (this.standby === sp) this.standby = null;
        if (this.o.standby) {
          // seen live 2026-10-07: SESSION_DELETED, and in the same second a new empty session hosted on Encore
          this.pushDeleted(sp);
          if (this.bc === 'BROADCAST_ON') {
            this.standbys++;
            const sb = session({ sid: hex32('standby' + this.standbys), token: id22('sb' + this.standbys), members: [me] });
            this.standby = sb;
            this.spotify = sb;
            this.push('NEW_SESSION', sb);
          }
        }
        return { status: 200, json: {} };
      default: return { status: 404 };
    }
  }

  // RequestSocial: one send; a 401 renews once and sends once more; the answer mapped as api_server.go does
  async social(op, a) {
    const g = await this.take();
    if (g.refuse) return { status: 429, headers: { 'retry-after': String(g.refuse) } };
    let r;
    try {
      this.noteSend(op);
      r = await this.spotifyAnswer(op, a);
      if (r.status === 401) {
        this.gate.renewals++;
        await sleep(Math.min(this.o.spacingMs, 50));
        this.noteSend(op);
        r = await this.spotifyAnswer(op, a);
      }
    } finally { this.give(); }
    const up = { 'x-upstream-status': String(r.status) };
    const bcOp = op === 'broadcast' || op === 'jam_status';
    // patch 4's broadcastOf: the status (an enum) and whether the answer names this device; tokens never leave the engine
    const bcAnswer = (raw) => {
      const d = raw && typeof raw === 'object' ? raw.device_broadcast_status : null;
      const st = d && typeof d === 'object' && typeof d.broadcast_status === 'string' && BC_ENUM.test(d.broadcast_status) ? d.broadcast_status : '';
      return st ? { broadcast_status: st, self: d.device_id === DEV } : { broadcast_status: '', self: false };
    };
    if (bcOp && (r.status === 200 || r.status === 204)) return { status: 200, json: bcAnswer(r.status === 200 ? r.json : null) };
    if (r.status === 200) {
      if (op === 'leave' || op === 'end') return { status: 200, json: {} };
      // as the engine: a JSON object body is passed on as the session; no body is `{}`, and so is Spotify's `{}` on current
      const none = !r.json || typeof r.json !== 'object' || (op === 'current' && !Object.keys(r.json).length);
      return { status: 200, json: none ? {} : { session: r.json } };
    }
    if (r.status === 204) return { status: 200, json: {} };
    if (r.status === 401 || r.status === 403) return { status: 403, headers: up };
    if (r.status === 404 || r.status === 410) return op === 'current' ? { status: 200, json: { not_found: true } } : { status: 404, headers: up };
    if (r.status === 409) return { status: 409, headers: up };
    if (r.status === 429) {
      const ra = r.retryAfter || 0;
      this.gate.holdUntil = Date.now() + Math.max(ra, 60) * 1000;
      return { status: 429, headers: { ...up, 'retry-after': String(ra || 60) } };
    }
    return { status: 502, headers: up };
  }

  // ---------------------------------------------------------------- the API
  // -> { status, json?, headers? }
  async handle(method, pathq, body = {}) {
    const u = new URL(pathq, 'http://engine');
    const p = u.pathname;
    this.log.push({ method, path: pathq, body });
    if (method === 'GET' && p === '/status') return this.status();
    if (method === 'GET' && p === '/player/queue') return this.queue();
    if (p.startsWith('/jam/')) {
      const op = p.slice(5);
      if (!this.o.patch3 || !(this.o.serve || this.o.routes).includes(op)) return { status: 404 };   // serve: a route listed but missing
      // patch 4: POST /jam/broadcast {status: on|off} (anything else 400, before any request), GET = jam_status
      const bst = op === 'broadcast' && method === 'POST' ? (body && typeof body === 'object' ? body.status : undefined) : null;
      if (bst !== null && bst !== 'on' && bst !== 'off') return { status: 400 };
      if (this.noSession) return { status: 204 };
      if (op === 'broadcast') return method === 'GET' ? this.social('jam_status', {}) : this.social('broadcast', { status: bst });
      if (op === 'forget') {
        const changed = this.st.mode === 'on';
        if (changed) { this.st.mode = 'off'; this.jamEv(); }
        return { status: 200, json: { changed } };
      }
      if (op === 'activate') {
        // patch 5: setModes({"jam":"on"}) on a device that is active with a context of its own, never over a Jam's
        // list or a social-connect playback; local (no gate, no send), as /jam/forget
        if (method !== 'POST') return { status: 405 };
        this.activations++;
        if (this.answer.activate) return this.answer.activate();
        const s = this.st;
        if (s.inactive || s.stopped || !s.track || !s.ctx) return { status: 409 };
        if (s.ctx.startsWith(JAM_LIST) || String(s.origin || '').startsWith('social-connect-')) return { status: 409 };
        if (s.mode === 'on') return { status: 200, json: { changed: false } };
        s.mode = 'on';
        const emit = () => {
          if (!this.o.dropJamEvent) this.jamEv();
          if (this.o.clusterEcho !== false) this.cluster({ active: 'self', jam_mode: 'on' });   // Spotify's echo
        };
        if (this.o.activateEvAfter) setTimeout(emit, this.o.activateEvAfter); else emit();
        return { status: 200, json: { changed: true } };
      }
      const a = { token: u.searchParams.get('token') || body.token, sid: body.session_id, member: body.member_id };
      const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
      if ((op === 'info' && !a.token) || ((op === 'leave' || op === 'end') && !a.sid) || (op === 'remove' && !(idOk(a.sid) && idOk(a.member)))) return { status: 400 };
      return this.social(op === 'start' ? 'start' : op, a);
    }
    if (this.noSession) return { status: 204 };
    if (method === 'POST' && p === '/player/output_delay') { this.delays = (this.delays || []).concat(body.delay_ms); return { status: 200, json: { delay_ms: body.delay_ms } }; }
    if (method === 'POST' && p === '/player/play') {
      const first = body.skip_to_uri || (body.uri.startsWith('spotify:track:') ? body.uri : T('first:' + body.uri));
      this.st.origin = null;
      this.st.ctx = body.uri.startsWith('spotify:track:') ? body.uri : body.uri;
      this.st.track = track(first, { position: body.position || 0 });
      this.st.stopped = false;
      this.st.paused = !!body.paused;
      setTimeout(() => { this.ev('metadata', { ...this.st.track, context_uri: this.st.ctx }); if (this.o.patch3 && this.st.mode) this.jamEv(); }, 10);
      return { status: 200 };
    }
    if (method === 'POST' && p === '/player/pause') { this.st.paused = true; setTimeout(() => this.ev('paused', {}), 5); return { status: 200 }; }
    if (method === 'POST' && p === '/player/resume') { this.st.paused = false; setTimeout(() => this.ev('playing', {}), 5); return { status: 200 }; }
    if (method === 'POST' && p === '/player/seek') {
      if (this.st.track) this.st.track.position = body.position;
      setTimeout(() => this.ev('seek', { position: body.position }), 5);
      return { status: 200 };
    }
    if (method === 'POST' && (p === '/player/next' || p === '/player/prev')) {
      const n = T((p === '/player/next' ? 'n' : 'p') + this.log.length);
      setTimeout(() => this.load(n, { playing: !this.st.paused }), 10);
      return { status: 200 };
    }
    if (method === 'POST' && (p === '/player/queue/remove' || p === '/player/queue/move')) {
      if (!this.o.patch3 || !this.o.queueEdit) return { status: 404 };
      return this.edit(p.slice(14), body || {});
    }
    if (method === 'POST' && p === '/player/queue/top') {
      if (!this.o.patch3 || !this.o.queueEdit || !this.ops().has('top')) return { status: 404 };
      return this.edit('top', body || {});
    }
    if (method === 'POST' && p === '/player/queue/jump') {
      if (!this.o.patch3 || !this.ops().has('jump')) return { status: 404 };
      return this.jump(body || {});
    }
    if (method === 'POST' && p === '/player/shuffle_context') { this.st.shuffle = !!body.shuffle_context; return { status: 200 }; }
    if (method === 'POST' && p === '/player/add_to_queue') {
      this.next.unshift({ uri: body.uri, uid: 'q' + hex32(body.uri + this.log.length).slice(0, 8), provider: 'queue', metadata: { is_queued: 'true' }, track: track(body.uri) });
      setTimeout(() => this.ev('queue', {}), 5);
      return { status: 200 };
    }
    if (method === 'POST' && p.startsWith('/player/')) return { status: 200 };
    return { status: 404 };
  }
}

// engine.js over the model, in process
function fakeJamEngine(m) {
  const e = new EventEmitter();
  e.setMaxListeners(50);
  e.connected = true;
  e.status = null;
  const num = (h, k) => (h && h[k] != null ? Number(h[k]) : null);
  e.send = async (method, p, b) => {
    await new Promise((r) => setImmediate(r));
    if (m.down) throw Object.assign(new Error('Encore\'s player isn\'t reachable.'), { status: 502, code: 'engine_error' });
    const r = await m.handle(method, p, b);
    return { status: r.status, json: r.json === undefined ? null : r.json, retryAfter: num(r.headers, 'retry-after'), upstream: num(r.headers, 'x-upstream-status') };
  };
  e.get = (p, o) => e.send('GET', p, undefined, o);
  e.call = async (p, b, method = 'POST') => {
    const r = await m.handle(method, p, b || {});
    if (r.status >= 400) throw Object.assign(new Error('engine ' + p + ' -> ' + r.status), { code: 'engine_' + r.status });
    return r.json === undefined ? null : r.json;
  };
  e.refresh = async () => {                          // asynchronous like the HTTP one: the state when it answers
    await new Promise((r) => setImmediate(r));
    const r = m.status();
    e.status = r.status === 200 ? r.json : null;
    e.emit('status', e.status);
    return e.status;
  };
  m.on('event', (ev) => e.emit('event', ev.type, ev.data));
  return e;
}

module.exports = { JamEngine, fakeJamEngine, session, member, track, T, JAM, JAM_LIST, SOCIAL, ROUTES, DEV, PC, ME, LINK, RADAR, sid32, pic, fnv, hex32, id22 };
