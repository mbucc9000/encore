'use strict';
// Jam (DESIGN-4b.md §4, §5): Spotify's group sessions with Encore as the speaker.
//  - Detection. Spotify drives a Jam's speaker with ordinary Connect commands (origin social-connect-…, context
//    spotify:list:jam-list:…). The engine's `jam` events and /status (Encore patch 3) feed a latch. It sets only on
//    something new (the mode turning "on", or a social origin with a jam-list we haven't seen end) and remembers the
//    jam-list it saw end, because the mode can fall from "off" back to "" (a transfer replaces the options) or stay "on"
//    after an end. An engine without patch 3: origin + context only, shown as `lim`.
//  - Sessions. social-connect (Spotify's private API) only through the engine's /jam/* routes: at most 2 HTTP sends per
//    call, under the engine's gate (one call at a time, ≥ 1 s apart, 30 sends per 5 min). The gateway reads only on the
//    triggers of §5.3, never while x.sc isn't 1 (the admin's one-time check, L0, decides), and nothing at all while no
//    Jam plays on Encore. Writes are never retried, nothing ends a Jam on its own, and the only automatic write is a
//    guest's Leave (idle, or Spotify refusing to play).
//  - Who added a song: queue entries' metadata values matched against member ids; the key that matches is learned.
//  - Idle safety: a Jam never streams for nobody for long (guest: Leave at 10 min; host alone: pause; any role: 3 h).
//  - Trace: the last 200 Jam-related engine events and calls (admin), for the capture and the live tests.
//  - The admin's fake Jam (`fake: 1`) drives the app's UI without Spotify; it never calls the engine's /jam/* and the
//    playback rules ignore it (real() is false).
//  - 4b-c (after C0, §11): the 2026 session shape (owner by Spotify id, me by is_current_user, pictures, capabilities,
//    host device, the session's own share link and code URI); social-connect/v2/session_update pushes applied like
//    reads (never a read of their own, never sc); Remove = the captured kick; Up Next remove/move as engine-local edits
//    (no Spotify request), with the edits Spotify's copy of the Jam undid counted for L1 (edit_lost).
//  - Jam wait (DESIGN-JAM-WAIT.md, engine patch 4): Start sets Encore's Jam broadcast on before current_or_new (C0's
//    desktop step) and always sends current_or_new for a session hosted on Encore (no more 0.8.2 adopt shortcut); our
//    End of an Encore-hosted Jam sets it off. SESSION_DELETED ends the shown session; Spotify's standby NEW_SESSION
//    after an end is recorded only; a read naming another session ends the one shown (unless the engine plays a Jam).
//    The broadcast state, the engine's cluster summary and failed transfers go to the trace (kinds and enums only).
//  - Jam self (DESIGN-JAM-SELF, engine patch 5): after our own Start of a session hosted on Encore, if Spotify hasn't
//    handed it over within 2 s, the engine's /jam/activate switches Encore into Jam mode (its own options, in its Connect
//    state), once. When that Jam ends, /jam/forget switches it off.
// Never logged: join tokens, links, code tokens, session ids, member ids, device ids, names, session JSON values,
// queue uids/uris, link_token / social_radar_token.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const log = require('./log');
const { tokenFor } = require('./image');
const jamlink = require('./jamlink');
const { renameRetry } = require('./fsutil');

const TIMING = {
  leaseMs: 25000,            // a w=1 lease lasts this long
  pollMs: 20000,             // lease poll interval (the tick, and the gap for a lease's first pollMidAt)
  pollMidAt: 120000,         // the taper: pollMidMs from this far into a lease (or after the last other read or action)
  pollMidMs: 60000,
  pollSlowAt: 600000,        // and pollSlowMs from this far
  pollSlowMs: 120000,
  leaseStartAge: 30000,      // a new lease reads only when the last read is older
  freshGap: 10000,           // fresh=1 minimum gap
  setDebounce: 2000,         // the latch set with no session known
  inactiveDebounce: 3000,    // the engine went inactive while on: away or ended?
  awayRetryMs: 60000,        // that read didn't answer: one more after this (never more)
  idleGrace: 500,            // the context emptied: an `inactive` may follow right after (another device took it)
  unknownByGap: 60000,       // the read for an unknown "added by"
  ownConfirmMs: 15000,       // our start/join counts as on before the engine confirms it
  selfJamMs: 2000,           // our Start's reply -> Encore switches itself into Jam mode (unless the latch set first)
  selfCheckMs: 1500,         // no `jam` event after that switch changed the mode: one /status
  endedPushMs: 60000,        // a push of the session that just went off is never taken for a new Jam's this long
  standbyMs: 5000,           // a NEW_SESSION for Encore this soon after a SESSION_DELETED or our End: Spotify's standby
  startPrecheckFresh: 10000, // Start's pre-check is skipped after a read this recent that showed no session
  infoCacheMs: 60000,        // `info` reuse inside Join
  endSettleMs: 6000,
  endWatchMs: 30000,         // after our End: a late end transfer (item 10) still restarts the song this long
  leaveSettleMs: 3000,
  actionDeadlineMs: 50000,
  engineCallMs: 25000,
  joinGenWaitMs: 10000,
  quiet5m: 15,               // quiet triggers stop at this 5-min count of the gateway's own calls
  scRefusedHold: 1800000,    // after a refusal, x.sc stays 0 this long, then it is unknown again
  idleGuestMs: 600000,
  idleHostMs: 600000,
  idleRecheckMs: 1800000,
  idleCapMs: 10800000,
  noSession: 1500,           // the engine answered 204 (session swap): wait, try once more
  connectRead: 2000,         // the read after the engine's events socket connects (after its /status)
  queueDebounce: 300,
  queueRetry: 1500,          // rows without metadata: fetched once more after this (and the phone's retry_ms)
  queueTimeout: 5000,
  queueEditTimeout: 5000,    // an engine Up Next edit (remove/move)
  editMemoMs: 1800000,       // Encore's own edits are checked against Spotify's copy of the Jam this long (edit_lost)
  editMemoMax: 20,
  addGapMs: 50,              // End re-adds the remembered rows this far apart
  fakeInMs: 20000,           // the fake Jam's synthetic joins while a lease is live
  fakeMaxMs: 1800000,        // a fake Jam ends by itself
};
// startBroadcast: Start sets Encore's Jam broadcast on before current_or_new; endBroadcastOff: our End of an
// Encore-hosted Jam sets it off (DESIGN-JAM-WAIT §2.3; both need engine patch 4's /jam/broadcast, else skipped);
// selfJam: after our own Start of a session hosted on Encore, Encore switches itself into Jam mode when Spotify hasn't
// handed the Jam over within selfJamMs (DESIGN-JAM-SELF; needs engine patch 5's /jam/activate, else skipped)
const FLAGS = { hostAdd: 'local', guestTransport: false, hostJump: 'pause', jamEdit: true, selfJam: true, startBroadcast: true, endBroadcastOff: true };
const HOST_ADD = ['local', 'webapi', 'command', 'off'];
const HOST_JUMP = ['pause', 'cut'];
const JAM_LIST = 'spotify:list:jam-list:';
const SOCIAL = 'social-connect-';
const SOCIAL_ROUTES = ['current', 'start', 'info', 'join', 'leave', 'end'];
// ('broadcast', patch 4, is deliberately not in SOCIAL_ROUTES: canSocial() stays the same on a patch-3 engine)
const WRITES = new Set(['start', 'join', 'leave', 'end', 'remove', 'settings', 'queue', 'broadcast']);   // social-connect writes (never retried)
// engine-local Jam routes: nothing goes to Spotify (not in calls5m, no gate refresh; 'activate' is patch 5's)
const LOCAL_OPS = new Set(['forget', 'activate']);
const NO_CONTROL = new Set(['next', 'prev', 'seek', 'shuffle', 'repeat', 'resume']);
// reads that leave the lease poll's taper where it is: the lease's own, and the idle safety's timer. Every other read
// (an engine event's, an action's) starts it over. Pushes aren't reads: they leave it too.
const TAPER_KEEP = new Set(['poll', 'lease', 'idle']);
const FAKE_TOKEN = 'EncoreFakeJam0000';
const FAKE_NAMES = ['Jake', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Mia', 'Lucas', 'Zoe', 'Ethan', 'Ella', 'Leo', 'Ivy', 'Max'];
// the Spotify Code of a session's join_session_uri (spotify:socialsession:<t>), green with white bars (§4.7)
const CODE_URL = (u) => `https://scannables.scdn.co/uri/plain/png/2F9A2B/white/640/${encodeURIComponent(u)}`;
const SESSION_UPDATE = 'social-connect/v2/session_update';
// C0's, and SESSION_DELETED seen live 2026-10-07
const REASONS = new Set(['NEW_SESSION', 'USER_JOINED', 'USER_KICKED', 'SESSION_MEMBER_PAUSE_CHANGED', 'SESSION_DELETED']);
const BROADCAST_UPDATE = 'social-connect/v2/broadcast_status_update';

const MSG = {
  unavailable: 'Encore can’t start or join Jams yet. Start a Jam in Spotify on your computer with Encore selected.',
  limited: 'End or leave this Jam in Spotify on your computer.',
  active: 'You’re already in a Jam.',
  limActive: 'A Jam is playing on Encore. End it in Spotify on your computer first.',
  elsewhere: 'You’re already in a Jam on another device. End or leave it in Spotify first.',
  notActive: 'Play something on Encore first.',
  refusedStart: 'Spotify didn’t let Encore start a Jam. Start it in Spotify on your computer with Encore selected.',
  refusedJoin: 'Spotify didn’t let Encore join this Jam. It may be full, or the host may have turned joining off.',
  refused: 'Spotify refused. Try it in Spotify on your phone or computer.',
  notFound: 'This Jam has ended, or the link is wrong.',
  badLink: 'That isn’t a Jam link. Paste the link a friend sent you.',
  isHost: 'End the Jam instead.',
  notHost: 'Only the Jam’s host can do this.',
  notInJam: 'Encore isn’t in a Jam.',
  unsupported: 'Encore can’t change this yet.',
  addUnsupported: 'Adding songs to this Jam from Encore isn’t possible yet.',
  noRoute: 'Encore’s player can’t do this. Update the Encore player.',
  spotify: 'Spotify didn’t answer. Try again in a moment.',
  late: 'Spotify took too long. Check the Jam again in a moment.',
  shape: 'Spotify answered in a way Encore doesn’t understand. If a Jam started, end it in Spotify on your computer.',
  noSession: 'Encore’s player is reconnecting to Spotify. Try again in a moment.',
  busy: 'Encore is still waiting on another Jam request. Try again in a moment.',
  gone: 'They aren’t in the Jam any more.',
  noKick: 'Encore can’t remove this person. Remove them in Spotify on your phone or computer.',
  badEdit: 'That Up Next change isn’t valid.',
  queueChanged: 'Up Next changed, so it was refreshed.',
  autoplay: 'Autoplay songs can’t be moved or removed.',
  notEditable: 'This song can’t be moved or removed.',
  section: 'Songs can only move within their own section.',
  shuffled: 'Turn shuffle off to change these songs.',
  editHost: 'Only the Jam’s host can change its queue.',
  editOff: 'Encore can’t change the Jam’s queue right now.',
  editLost: 'Encore’s player didn’t answer. Up Next will refresh.',
};

const fail = (status, code, message, extra) => Object.assign(new Error(message), { status, code }, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isJamList = (u) => typeof u === 'string' && u.startsWith(JAM_LIST);
const isSocial = (o) => typeof o === 'string' && o.startsWith(SOCIAL);
// ids in dealer URIs: every path segment that isn't a plain word (or v1, v2, …), or holds a run of 12+ letters/digits,
// becomes *, as extract.py's mask_path (a run-of-12 rule alone would keep most of a UUID's dash-separated groups)
const WORD = /^(?:[a-z][a-z_-]{0,39}|v\d{1,2})$/;
const mask = (s) => {
  const m = String(s || '').match(/^([a-z][a-z0-9+.-]{0,15}:(?:\/\/)?)?([^]*)$/);
  return (m[1] || '') + m[2].split('/').map((seg) => (seg === '' || (WORD.test(seg) && !/[A-Za-z0-9]{12,}/.test(seg)) ? seg : '*')).join('/');
};
// a payload's top-level key name, as extract.py masks keys: one with a run of 12+ letters/digits (a device id) is *
const maskKey = (k) => (/[A-Za-z0-9]{12,}/.test(k) ? '*' : k);
// a command's sender: its prefix only ("social-connect-*", "webapi-*"), or "*" for a plain device id
const maskFrom = (s) => { if (!s) return ''; const m = String(s).match(/^([A-Za-z][A-Za-z_]*(?:-[A-Za-z_]+)*-)[A-Za-z0-9]/); return m ? m[1] + '*' : '*'; };
const ctxType = (u) => (!u ? 'none' : isJamList(u) ? 'jam-list' : String(u).split(':')[1] || 'other');
const sec = (ms) => Math.floor(ms / 1000);
// a queue entry's section: q (the queue), cq (the context's own rows), ap (autoplay)
const part = (e) => (e.provider === 'queue' ? 'q' : e.provider === 'autoplay' ? 'ap' : 'cq');
// the length of the longest increasing run (in order, not necessarily adjacent)
function lis(a) {
  const t = [];
  for (const x of a) {
    let lo = 0;
    let hi = t.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; }
    t[lo] = x;
  }
  return t.length;
}

// Response memo (as catalog.js's): the serialized body, its ETag and, once asked for, its gzip.
function makeMemo(obj, json = JSON.stringify(obj)) {
  const body = Buffer.from(json);
  const m = { obj, body, etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 20) + '"', gz: null };
  m.gzip = () => m.gz || (m.gz = new Promise((resolve, reject) => zlib.gzip(body, (e, b) => (e ? reject(e) : resolve(b)))));
  return m;
}

// TR keys of DESIGN-3 §3.2 from an engine ApiTrack; u is the queue entry's own uri.
function row(u, t) {
  const r = { u, n: t.name, a: (t.artist_names || []).join(', '), ar: (t.artist_uris || [])[0], al: t.album_name, alu: t.album_uri,
    i: tokenFor(t.album_cover_url), d: t.duration };
  if (t.explicit) r.e = 1;
  for (const k of Object.keys(r)) if (r[k] === undefined || r[k] === null || r[k] === '') delete r[k];
  return r;
}

// a session in an engine reply: {} (Spotify's 200 with an empty object, passed on as it came) is no session
const hasSession = (j) => !!(j && j.session && typeof j.session === 'object' && Object.keys(j.session).length);
const unmatched = { logged: false };           // "this account isn't among the member ids", logged once per process

// The key names C0 masked (§11.1), found by pattern and value, plus which owner rule matched and the share link's kind.
// Each is logged once per process at info, by name only (never a value), and shown on the admin page.
const names = { caps: '', remove: '', control: '', limit: '', owner: '', share: '' };
const namesLogged = new Set();
const KEY_NAME = /^[A-Za-z][A-Za-z_]{0,39}$/;          // a word, never an id (ids carry digits)
function named(kind, value, line) {
  if (!value) return;
  names[kind] = value;
  const k = kind + ':' + value;
  if (namesLogged.has(k) || namesLogged.size > 40) return;
  namesLogged.add(k);
  log.info('jam: ' + line);
}
const MEMBER_KEYS = new Set(['joined_timestamp', 'id', 'username', 'display_name', 'image_url', 'large_image_url', 'image', 'is_listening',
  'is_controlling', 'is_current_user', 'is_session_owner', 'is_host']);
const SESSION_KEYS = new Set(['timestamp', 'session_id', 'join_session_token', 'join_session_url', 'join_session_uri', 'session_owner_id',
  'session_members', 'is_session_owner', 'is_listening', 'is_controlling', 'active', 'queue_only_mode', 'wifi_broadcast', 'host_device_info',
  'is_paused', 'is_jam_paused', 'session_config', 'requires_jam_lens']);
const ENUM = /^[A-Z][A-Z_]{2,39}$/;
const CODE_URI = /^spotify:socialsession:([A-Za-z0-9_-]{1,128})$/;
const str = (v) => (typeof v === 'string' ? v : '');

// All Spotify field knowledge (§5.4): C0's 2026 names, with the 2021–22 fallbacks (t1mlange) where they cost nothing.
// -> null when it isn't a session. me: the engine's username (only where is_current_user says nothing).
//  - members: MEM id = username (else the Spotify id), sp = the Spotify `id` (32 hex: Remove and the owner match; never
//    sent to the phone), pic = large_image_url, else image_url, the first one the image proxy takes.
//  - meId: the member marked is_current_user (C0: only this account's entry carries it).
//  - ownerKnown: the session says who owns it (is_session_owner, or an owner match while this account is found).
//  - caps {invite, remove, manage}: true, false or null (unknown); hostDev {id, name} | null; active: false = no session.
//  - share: join_session_url normalised (§4.7), '' = build it; uri: join_session_uri for the Spotify Code.
//  - listening/controlling: counts for the trace; mkeys: the first member's key names (logged, never values).
const shape = { logged: false };
function parseSession(obj, me) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.session_id !== 'string' || !obj.session_id) {
    if (!shape.logged && obj && typeof obj === 'object') {
      shape.logged = true;
      log.warn(`jam: unexpected session shape: keys ${Object.keys(obj).slice(0, 30).join(',') || '(none)'}`);
    }
    return null;
  }
  const members = [];
  const seen = new Set();
  let mkeys = '';
  let meId = '';
  let listening = 0;
  let controlling = 0;
  for (const x of Array.isArray(obj.session_members) ? obj.session_members : []) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    if (!mkeys) mkeys = Object.keys(x).slice(0, 20).join(',');
    if (!names.control) {
      // the playback-control enum (C0: LISTEN_AND_CONTROL, CONTROL) under a key the capture masked whole
      const ck = Object.keys(x).find((k) => !MEMBER_KEYS.has(k) && KEY_NAME.test(k) && typeof x[k] === 'string' && ENUM.test(x[k]));
      if (ck) named('control', ck, `the members' playback-control key is "${ck}"`);
    }
    const user = str(x.username);
    const sp = str(x.id);
    const id = user || sp;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (x.is_listening === true) listening++;
    if (x.is_controlling === true) controlling++;
    if (x.is_current_user === true && !meId) meId = id;
    const pic = [x.large_image_url, x.image_url, x.image].find((u) => typeof u === 'string' && /^https:\/\/\S+$/.test(u) && tokenFor(u)) || '';
    members.push({ id, sp, n: str(x.display_name).trim() || id, pic, flagged: x.is_session_owner === true || x.is_host === true });
  }
  // the host: the member whose Spotify id is session_owner_id (C0), else whose username is (2021–22), else a member's
  // own owner flag (2021–22), else this account when the session says we own it, else (unsure) the first member
  const owner = str(obj.session_owner_id);
  let host = null;
  let rule = '';
  if (owner) {
    host = members.find((m) => m.sp === owner) || null;
    if (host) rule = 'id';
    else if ((host = members.find((m) => m.id === owner) || null)) rule = 'username';
  }
  if (!host && (host = members.find((m) => m.flagged) || null)) rule = 'member flag';
  if (!host && obj.is_session_owner === true && meId && (host = members.find((m) => m.id === meId) || null)) rule = 'current user';
  const hostSure = !!host;
  if (!host && members.length) { host = members[0]; rule = 'first member'; }
  if (rule) named('owner', rule, `session owner match: ${rule}`);
  const isMe = (m) => !!m && (meId ? m.id === meId : !!me && (m.id === me || m.sp === me));
  const meKnown = !!meId || members.some(isMe);
  const ownerFlag = typeof obj.is_session_owner === 'boolean' ? obj.is_session_owner : null;
  const role = ownerFlag != null ? (ownerFlag ? 'host' : 'guest') : isMe(host) ? 'host' : 'guest';
  const ownerKnown = ownerFlag != null || (hostSure && meKnown);
  // capabilities: C0's `user_<word>` object holding `invite`, `remove_<word>` and manage_participant_settings
  const caps = { invite: null, remove: null, manage: null };
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (/^user_[A-Za-z]+$/.test(k) && v && typeof v === 'object' && !Array.isArray(v) && typeof v.invite === 'boolean') {
      caps.invite = v.invite;
      const rk = Object.keys(v).find((x) => /^remove_[A-Za-z]+$/.test(x) && typeof v[x] === 'boolean');
      if (rk) { caps.remove = v[rk]; named('remove', rk, `the session's remove capability is "${rk}"`); }
      if (typeof v.manage_participant_settings === 'boolean') caps.manage = v.manage_participant_settings;
      named('caps', k, `the session's capabilities key is "${k}"`);
      break;
    }
  }
  if (!names.limit) {
    const lk = Object.keys(obj).find((k) => !SESSION_KEYS.has(k) && KEY_NAME.test(k) && typeof obj[k] === 'number');
    if (lk) named('limit', lk, `the session's number key (likely the member limit) is "${lk}"`);
  }
  const hd = obj.host_device_info;
  const hostDev = hd && typeof hd === 'object' && str(hd.device_id) ? { id: hd.device_id, name: str(hd.device_name).trim().slice(0, 64) } : null;
  const um = CODE_URI.exec(str(obj.join_session_uri));
  let token = /^[A-Za-z0-9_-]{1,128}$/.test(str(obj.join_session_token)) ? obj.join_session_token : '';
  if (!token && um) token = um[1];
  const sl = jamlink.shareLink(obj.join_session_url);
  if (sl) named('share', `${sl.kind}, ${sl.host}`, `share link from join_session_url (${sl.kind}, ${sl.host})`);
  else if (token) named('share', obj.join_session_url == null ? 'built (none)' : 'built (not usable)', `share link built from the token (join_session_url ${obj.join_session_url == null ? 'absent' : 'not usable'})`);
  return { sid: obj.session_id, token, role, ownerKnown, members: members.map(({ id, sp, n, pic }) => ({ id, sp, n, pic })),
    hostId: host ? host.id : '', meId, gc: typeof obj.queue_only_mode === 'boolean' ? !obj.queue_only_mode : null,
    share: sl ? sl.url : '', uri: um ? um[0] : '', caps, hostDev, active: typeof obj.active === 'boolean' ? obj.active : null,
    listening, controlling, mkeys };
}

class Jam {
  constructor({ cfg, engine, player, bus, webapi, encoders, timing, fetch: f }) {
    Object.assign(this, { cfg, engine, player, bus, webapi, encoders });
    this.T = { ...TIMING, ...timing };
    this.now = () => Date.now();                         // tests move it
    this.fetch = f || ((...a) => fetch(...a));            // spotify.link expansion only
    this.flags = { ...FLAGS, ...((cfg && cfg.jam) || {}) };
    this.file = cfg && cfg.dataDir ? path.join(cfg.dataDir, 'jam.json') : null;
    const j = this.load();
    this.sc = j.sc === 1 || j.sc === 0 ? j.sc : undefined;   // social-connect usable: 1, refused: 0, unknown (before L0)
    this.scAt = Number(j.scAt) || 0;
    this.byKey = typeof j.byKey === 'string' ? j.byKey : '';
    this.okStart = !!j.okStart;
    this.hint = typeof j.sid === 'string' && j.sid ? { sid: j.sid, since: Number(j.since) || 0, role: j.role === 'guest' || j.role === 'host' ? j.role : '' } : null;   // confirmed by a read
    this.latch = { set: false, fed: false, mode: '', social: false, ctx: '', lastJam: '', endedCtx: typeof j.endedCtx === 'string' ? j.endedCtx : '' };
    this.sess = null;              // parseSession's: { sid, token, role, members [{id, sp, n, pic}], hostId, meId, gc, share, uri, caps, hostDev, … }
    this.meIds = new Set();        // this account's member ids (username, Spotify id), learned from is_current_user
    this.pushFed = '';             // the session id a session_update push was applied for (the lease poll slows to 120 s)
    this.lastPushAt = 0;           // a push applied counts as a fresh read for the lease poll's gap
    this.lastPushSid = '';         // ... and its session id: a read sent before it is older than it (applyRead)
    this.heldPush = null;          // a NEW_SESSION push for Encore that came just before the engine showed the Jam
    this.endedSid = null;          // { sid, at }: the session off() just ended (its trailing pushes are no new Jam's)
    this.reasons = new Set();      // unseen session_update reasons, logged once
    this.since = 0;
    this.pendingOwnAt = 0;         // our start/join succeeded: on until the engine confirms (ownConfirmMs)
    this.confirming = '';          // 'start' | 'join' while the confirmation read runs
    this.wait = false;
    this.away = false;
    this.awayCheck = false;
    this.endedPending = '';        // the jam-list of a Jam that may have moved away (ended once a read says so)
    this.routes = null;            // the engine's jam_routes (null: an engine without patch 3)
    this.routesKey = null;
    this.engineEdits = false;      // the engine's /status queue_edit (patch 3 item 11): Up Next remove/move
    this.qlock = Promise.resolve();   // Up Next edits, one at a time (apart from the Jam writes' lock)
    this.lastQ = null;             // the last QUEUE served: uid -> {part: 'q'|'cq'|'ap'|'now', u}, for the edit checks
    this.qprev = null;             // the last fetch's upcoming uids (the trace's queue diff)
    this.edits = [];               // Encore's own edits while on: {op, u, next?, at, lost} (edit_lost)
    this.lastEd = null;
    this.gate = null;              // the engine gate's counters (/status social)
    this.username = '';
    this.deviceId = '';
    this.lastRead = null;          // { at, none }: the last read that answered
    this.lastSent = 0;             // the last read sent (lease polls count from it)
    this.lastUnknownBy = 0;
    this.lastJamEvAt = 0;
    this.flight = null;
    this.callTimes = [];           // the gateway's own social-connect calls, rolling 5 min
    this.holdUntil = 0;            // a 429: quiet triggers wait
    this.reads = {};               // trigger -> count (admin)
    this.leaseUntil = 0;
    this.taperAt = 0;              // the lease poll's taper runs from here: the lease's start, another read, a user action
    this.pollTimer = null;
    this.timers = new Map();
    this.lock = Promise.resolve();
    this.ownAdds = new Map();      // uri -> at
    this.byUid = new Map();        // queue entry uid -> member id
    this.cur = null;               // { uri, by } of the current queue entry
    this.infoCache = new Map();    // token -> { at, s }
    this.dealer = { n: 0, uris: new Map(), updates: 0, applied: 0 };
    this.ring = [];
    this.counts = { cmd: 0, natural: 0, foreign: [], redirects: { gets: 0 }, edits: 0, lost: 0 };
    this.lastErr = null;
    this.idle = null;
    this.offAt = 0;
    this.lastCmdAt = 0;
    this.endWatch = null;          // after our End: { song, playing, rows, until } for a late end transfer
    this.lastJamEndAt = 0;
    this.unknownTried = new Set(); // "added by" values that matched no member and already had their read (this Jam)
    this.fake = null;
    this.memoJson = '';
    this.memoObj = null;
    this.pushed = '';
    this.lastSum = '';
    // DESIGN-JAM-WAIT
    this.bc = null;                // Encore's last known Jam broadcast: { status (enum), src: reply|push|read, at }
    this.bcOnSent = false;         // this Start's broadcast step set it on
    this.starting = false;         // our Start's broadcast / current_or_new are out (a NEW_SESSION then is no standby)
    this.endingSid = '';           // the session our own End is ending right now (its SESSION_DELETED is ours)
    this.ownEndAt = 0;             // our last End of a Jam (Spotify's standby NEW_SESSION may follow)
    this.lastDeletedAt = 0;        // the last SESSION_DELETED push
    this.jamListNoted = '';        // the jam-list whose sid_match is in the trace (never logged)
    // DESIGN-JAM-SELF: the Jam on now is one Encore switched itself into ({ sid, at }; jam.json keeps it over a restart,
    // its `at` then from the Jam's since). Nothing from Spotify switches that mode off: off(), End and Join's replace do.
    this.selfJam = j.self === 1 && typeof j.sid === 'string' && j.sid ? { sid: j.sid, at: (Number(j.since) || 0) * 1000 || this.now() } : null;
    if (engine) {
      engine.on('event', (type, d) => this.onEngine(type, d || {}));
      engine.on('status', (s) => this.fromStatus(s));
      engine.on('connected', () => this.engineConnected());
    }
    if (player && player.on) {
      player.on('genStart', (g) => this.onGen(g));
      player.on('track', (t) => this.onTrack(t));
    }
    this.ticker = setInterval(() => this.idleTick(), 5000);
    this.ticker.unref();
  }

  close() {
    clearInterval(this.ticker);
    this.stopPoll();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.fake) clearTimeout(this.fake.timer);
  }

  // ------------------------------------------------------------------ state
  get on() { return this.latch.set || this.owning() || !!this.confirming || this.wait || this.away || this.awayCheck; }
  owning() { return !!this.pendingOwnAt && this.now() - this.pendingOwnAt < this.T.ownConfirmMs; }
  real() { return this.on; }                                 // the fake Jam lives apart (this.fake)
  // main.js's 45 s idle pause gives way to rule 7 only with patch 3: an engine without it can't show a Jam's end (it
  // replays the Jam's list from the top), so the latch would keep a finished Jam on for up to idleCapMs
  idleOwn() { return this.real() && !!this.routes; }
  shown() { return !!this.fake || this.on; }
  role() { return this.on && this.sess ? this.sess.role : ''; }
  // the session as shown: none while it can't be read (refused), though its role still counts (role(), above)
  seen() { return this.sess && !this.sess.refused ? this.sess : null; }

  // The Jam's invite link right now (the same `l` the phone gets), or null.
  link() {
    if (this.fake) return jamlink.linkFor(FAKE_TOKEN);
    const s = this.on ? this.seen() : null;
    return s && s.token ? s.share || jamlink.linkFor(s.token) : null;
  }
  lim() { return this.on && !this.seen(); }
  hosting() { return this.on && (!this.sess || this.sess.role === 'host'); }   // host, or lim with no session (plan B: the user's own Jam)
  hostJump() { return this.flags.hostJump; }
  me() { return this.username || (this.engine && this.engine.status && this.engine.status.username) || (this.webapi && this.webapi.user && this.webapi.user.id) || ''; }
  hasRoute(r) { return !!(this.routes && this.routes.has(r)); }
  canSocial() { return this.scNow() === 1 && SOCIAL_ROUTES.every((r) => this.hasRoute(r)); }

  scNow() {
    if (this.sc === 0 && this.now() - this.scAt > this.T.scRefusedHold) {
      this.sc = undefined;
      this.save();
      log.info('jam: the social-connect refusal hold is over: access is unknown again (admin Check tests it)');
    }
    return this.sc;
  }

  setSc(v) {
    if (this.sc === v) return;
    this.sc = v;
    this.scAt = this.now();
    this.save();
    if (v === 1) log.info('jam: social-connect reads work: Start, Join, Leave and End are offered');
    else log.warn('jam: Spotify refused social-connect: plan B only (Jams started in Spotify) for 30 min');
    this.changed();
  }

  hostName(fallback = 'the host') {
    const s = this.fake ? null : this.sess;
    const h = s && s.members.find((m) => m.id === s.hostId);
    return h ? h.n : fallback;
  }

  // the host's member id (the same id as in the JAM object's m[]); undefined when unknown
  hostId() {
    const s = this.fake ? null : this.sess;
    const h = s && s.members.find((m) => m.id === s.hostId);
    return h ? h.id : undefined;
  }

  ctl() {
    if (!this.on) return false;
    const r = this.role();
    if (r !== 'guest') return true;                          // host, and lim
    return !!(this.sess && this.sess.gc) && !!this.flags.guestTransport;
  }

  hostAddOk() {
    const h = this.flags.hostAdd;
    return h === 'local' || h === 'webapi' || (h === 'command' && this.canSocial() && this.hasRoute('queue'));
  }

  caps() {
    const x = {};
    const social = this.canSocial();
    if (social) x.sc = 1;
    if (this.on) {
      const r = this.role();
      const s = this.seen();
      if (social && r === 'host' && this.hasRoute('settings')) x.gc = 1;
      // Remove (the captured kick): host, sc, the engine's route, a known session that doesn't deny it
      if (social && r === 'host' && this.hasRoute('remove') && s && s.sid && !(s.caps && s.caps.remove === false)) x.kick = 1;
      if (r === 'guest' ? social && this.hasRoute('queue') : this.hostAddOk()) x.add = 1;
      if (s && (s.token || s.uri)) x.code = 1;
    }
    return x;
  }

  // this account's member ids: learned from is_current_user, plus the engine's username
  myIds() { const ids = new Set(this.meIds); const me = this.me(); if (me) ids.add(me); return ids; }
  learnMe(s) {
    const m = s && s.meId && s.members.find((x) => x.id === s.meId);
    if (!m) return;
    if (this.meIds.size > 8) this.meIds.clear();
    this.meIds.add(m.id);
    if (m.sp) this.meIds.add(m.sp);
  }
  // this account's MEM id in a session ('' when it can't be told)
  myMemberId(s) {
    if (!s) return '';
    if (s.meId) return s.meId;
    const ids = this.myIds();
    const m = s.members.find((x) => ids.has(x.id) || (x.sp && ids.has(x.sp)));
    return m ? m.id : '';
  }

  mem(m, hostId, mine) {
    const o = { id: m.id, n: m.n };
    const i = m.pic ? tokenFor(m.pic) : '';
    if (i) o.i = i;
    if (m.id === hostId) o.h = 1;
    if (mine && m.id === mine) o.me = 1;
    return o;
  }

  // The JAM object (§4.2): GET /v1/jam, the `jam` event, `jam` in every write's reply.
  body() {
    if (this.fake) return this.fakeBody();
    const x = this.caps();
    if (!this.on) return { x };
    const s = this.seen();
    const o = { on: 1 };
    if (s) o.r = s.role; else o.lim = 1;
    if (this.wait) o.wait = 1;
    if (this.away) o.away = 1;
    if (s) {
      // the invite: the session's own share link (else built from the token), and the Spotify Code of its URI
      if (s.token) {
        o.t = s.token;
        o.l = s.share || jamlink.linkFor(s.token);
      }
      if (s.token || s.uri) {
        const ci = tokenFor(CODE_URL(s.uri || 'spotify:socialsession:' + s.token));
        if (ci) o.ci = ci;
      }
      const host = s.members.find((m) => m.id === s.hostId);
      if (host) { o.h = host.id; o.hn = host.n; }
      const mine = this.myMemberId(s);
      o.m = s.members.map((m) => this.mem(m, s.hostId, mine));
      if (s.gc) o.gc = 1;
    }
    o.cnt = s ? s.members.length : 0;
    if (this.ctl()) o.ctl = 1;
    if (this.since) o.since = this.since;
    o.x = x;
    return o;
  }

  // The snapshot's `jam` (§4.3): {r?, hn?, cnt, lim?, away?, wait?} while on (or the fake), else undefined.
  summary() {
    const b = this.fake ? this.fakeBody() : this.on ? this.body() : null;
    if (!b || !b.on) return undefined;
    const o = {};
    if (b.r) o.r = b.r;
    if (b.hn) o.hn = b.hn;
    o.cnt = b.cnt;
    if (b.lim) o.lim = 1;
    if (b.away) o.away = 1;
    if (b.wait) o.wait = 1;
    return o;
  }

  // st.track.by: the member who added the playing song (a real Jam only).
  trackBy(t) {
    if (!this.on || !t || !this.cur || !this.cur.by) return undefined;
    return this.cur.uri === t.context_track_uri || this.cur.uri === t.uri ? this.cur.by : undefined;
  }

  memo() {
    const obj = this.body();
    const json = JSON.stringify(obj);
    if (json !== this.memoJson) { this.memoJson = json; this.memoObj = makeMemo(obj, json); }
    return this.memoObj;
  }

  // Push `jam` when the body changed (or something happened: ev), and the player's snapshot when its summary did.
  // ev = {k: start|join|in|out|leave|end|kicked, n?: a member's name, id?: that member's id (1.1.0, H2: the same id as in
  // m[], so the app's Anonymous Mode gives the HUD the same made-up name as the member rows), why?}
  changed(ev) {
    if (ev) for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
    const m = this.memo();
    if (ev || m.etag !== this.pushed) {
      this.pushed = m.etag;
      this.bus.push('jam', ev ? { ...m.obj, ev } : m.obj);
    }
    const sum = JSON.stringify([this.summary() || null, this.on && this.cur ? this.cur.by || null : null]);
    if (sum !== this.lastSum) {
      this.lastSum = sum;
      if (this.player && this.player.publish) this.player.publish();
    }
    // Up Next's `ed` follows the role, the Jam and the flag: an open Up Next refetches (a guest's Jam began mid-edit)
    const ed = this.editable();
    if (this.lastEd !== null && ed !== this.lastEd) this.bus.push('queue', {});
    this.lastEd = ed;
  }

  load() {
    if (!this.file) return {};
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; }
  }

  // data/jam.json (tmp + rename, in order). The session part is only a hint: the first read after a connect confirms it.
  save() {
    if (!this.file) return;
    const s = this.on ? this.sess : null;
    const j = { sid: s && s.sid ? s.sid : undefined, token: s && s.token ? s.token : undefined, role: s ? s.role : undefined,
      since: s ? this.since : undefined, byKey: this.byKey || undefined, sc: this.sc, scAt: this.sc != null ? this.scAt : undefined,
      okStart: this.okStart ? 1 : undefined, endedCtx: this.latch.endedCtx || undefined, self: s && this.selfJam ? 1 : undefined };
    const text = JSON.stringify(j);
    if (text === this.savedText) return;
    this.savedText = text;
    const file = this.file;
    this.saveChain = (this.saveChain || Promise.resolve()).then(async () => {
      const tmp = file + '.tmp';
      try { await fsp.writeFile(tmp, text, { mode: 0o600 }); await renameRetry(tmp, file); } catch (e) { log.warn('jam.json:', e.code || e.message); }
    });
  }

  // A one-shot timer per key: a trigger that is already waiting isn't moved.
  later(key, ms, fn) {
    if (this.timers.has(key)) return;
    const t = setTimeout(() => { this.timers.delete(key); fn(); }, ms);
    t.unref();
    this.timers.set(key, t);
  }

  cancel(key) { const t = this.timers.get(key); if (t) { clearTimeout(t); this.timers.delete(key); } }

  // ------------------------------------------------------------------ the engine
  fromStatus(s) {
    if (!s || typeof s !== 'object') return;
    const routes = Array.isArray(s.jam_routes) ? new Set(s.jam_routes.filter((x) => typeof x === 'string')) : null;
    const key = routes ? [...routes].sort().join(',') : '';
    if (key !== this.routesKey) {
      this.routesKey = key;
      this.routes = routes;
      if (routes) log.info(`jam: the engine serves the Jam routes ${key}`);
      else log.info('jam: the engine has no Jam routes (no patch 3): Jams are seen from origin + context only');
      this.changed();
    }
    this.gate = s.social && typeof s.social === 'object' ? s.social : null;
    if (typeof s.username === 'string' && s.username) this.username = s.username;
    if (typeof s.device_id === 'string') this.deviceId = s.device_id;
    const qe = s.queue_edit === true;
    if (qe !== this.engineEdits) { this.engineEdits = qe; this.changed(); }
    // a `jam` event is fresher than a /status that may have been asked for before it
    if (this.now() - this.lastJamEvAt < 2000) return;
    const ctx = s.context_uri || '';
    if (!ctx && this.player && this.player.pending) return;        // a load in progress reports no context for a moment
    this.feed(typeof s.jam_mode === 'string' ? s.jam_mode : '', isSocial(s.play_origin_device_id), ctx, 'status');
  }

  // The events socket (re)connected, maybe to a restarted engine (a deploy) that isn't playing our Jam any more: the
  // latch clearing then waits for a read (away or ended), as after `inactive`.
  engineConnected() {
    if (this.on && this.sess) this.reconnectedAt = this.now();
    this.cancel('connect');
    this.later('connect', this.T.connectRead, () => { if (this.hint || this.latch.set) this.read('connect'); });
  }

  onEngine(type, d) {
    const now = this.now();
    switch (type) {
      case 'jam':
        this.lastJamEvAt = now;
        this.addTrace({ k: 'jam', mode: d.mode || '', social: isSocial(d.origin) ? 1 : 0, ctx: ctxType(d.context_uri) });
        this.feed(typeof d.mode === 'string' ? d.mode : '', isSocial(d.origin), d.context_uri || '', 'event');
        break;
      case 'command':
        // every one, whatever the state: L1 reads from these which path Spotify itself uses (a controller's set_queue,
        // a transfer from social-connect-*, …) and whether one undoes Encore's own Up Next edits (edit_lost)
        this.lastCmdAt = now;
        // error (patch 4): a transfer the engine could not apply ("unmarshal", "nothing_to_play")
        this.addTrace({ k: 'command', ep: String(d.endpoint || '').slice(0, 40), from: maskFrom(d.from), continues: d.continues === true ? 1 : d.continues === false ? 0 : undefined,
          jam_end: d.jam_end ? 1 : undefined, error: d.error ? String(d.error).slice(0, 20) : undefined });
        if (d.jam_end) { this.lastJamEndAt = now; this.onJamEnd(); }
        break;
      case 'cluster':
        // patch 4: the connect-state cluster's summary (kinds, a count, booleans), emitted on change only: always traced
        this.addTrace({ k: 'cluster', active: String(d.active || '').slice(0, 8), sd: Number(d.social_devices) || 0,
          jam_ctx: d.jam_context ? 1 : 0, mode: String(d.jam_mode || '').slice(0, 8), social: d.social_origin ? 1 : 0 });
        break;
      case 'social_connect': this.onDealer(d); break;
      case 'queue':
        this.later('queue', this.T.queueDebounce, () => {
          this.bus.push('queue', {});
          // fetched while on (attribution, edit_lost), and within 15 s of a command (the trace's queue diff, L1)
          if (this.on || this.now() - this.lastCmdAt < 15000) this.refetchQueue();
        });
        break;
      case 'inactive':
        if (this.tracing()) this.addTrace({ k: 'inactive' });
        if (this.on && this.sess && this.canSocial()) this.later('inactive', this.T.inactiveDebounce, () => this.awayRead());
        break;
      case 'active': case 'stopped':
        if (this.tracing()) this.addTrace({ k: type });
        break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ the latch (§5.2)
  feed(mode, social, ctx, from) {
    const L = this.latch;
    const first = !L.fed;
    const prevMode = L.mode;
    const prevSocial = L.social;
    const prevCtx = L.ctx;
    Object.assign(L, { fed: true, mode, social, ctx });
    if (isJamList(ctx)) L.lastJam = ctx;
    // the jam-list often comes after the latch set (set_options jam:on first, then the list's transfer) while our
    // Start's session is already known: noteJamList here too, not only in latchSet and useSession
    if (L.set && isJamList(ctx)) this.noteJamList();
    if (!L.set) {
      // only something new sets it: the mode turning "on", or a social origin on a jam-list that isn't the one that ended
      const set = first
        ? (mode === 'on' || (social && isJamList(ctx))) && mode !== 'off' && !(ctx && ctx === L.endedCtx)
        : (mode === 'on' && prevMode !== 'on') || (social && isJamList(ctx) && ctx !== L.endedCtx && mode !== 'off');
      if (set) this.latchSet(from, first);
      return;
    }
    if (mode === 'off' && prevMode !== 'off') this.latchClear('mode off', from);
    else if (prevSocial && !social && mode !== 'on') this.latchClear('origin', from);
    else if (!ctx && prevCtx) this.latchClear('idle', from);
  }

  latchSet(from, boot) {
    const L = this.latch;
    const was = this.on;
    L.set = true;
    this.wait = false;
    this.away = false;
    this.awayCheck = false;
    this.endedPending = '';
    this.endWatch = null;
    this.cancel('inactive');
    if (!was) this.since = (boot && this.hint && this.hint.since) || sec(this.now());
    log.info(`jam: a Jam plays on Encore (${from}: mode "${L.mode}", ${L.social ? 'social-connect origin' : 'other origin'}, ${ctxType(L.ctx)})`);
    this.addTrace({ k: 'latch', set: 1, from });
    // a NEW_SESSION push for a Jam hosted on Encore that came a moment before the engine showed it (pushes and the
    // engine's commands race): it is this Jam's (onDealer holds no other push, and none of the Jam that just went off)
    const h = this.heldPush;
    this.heldPush = null;
    if (h && !this.sess && this.now() - h.at < this.T.ownConfirmMs) {
      log.info('jam: a session_update for Encore came just before the Jam: applied');
      this.applyPush(h);
    }
    if (!this.sess && this.canSocial()) this.later('set', this.T.setDebounce, () => { if (this.on && !this.sess) this.read('set'); });
    this.save();
    this.changed(!was && !boot && !this.owning() && !this.confirming ? { k: 'start' } : undefined);
    this.noteJamList();
  }

  // The engine stopped showing the Jam. If it also lost playback (another device took it) one read decides between
  // away and ended; otherwise it ended now.
  latchClear(why, from) {
    const L = this.latch;
    L.set = false;
    const ended = isJamList(L.ctx) ? L.ctx : L.lastJam || L.endedCtx;
    log.info(`jam: the engine's Jam ended (${why}, ${from})`);
    this.addTrace({ k: 'latch', set: 0, why });
    // (a restarted engine answers 204 until its Spotify session is up: its first context-less /status may come late)
    const lost = (this.player && this.player.st && !this.player.st.active) || this.now() - (this.reconnectedAt || 0) < 60000;
    const readable = !!(this.sess && this.sess.sid && this.canSocial());
    if (readable && (lost || why === 'idle')) {
      // the Jam may go on elsewhere and come back to Encore with the same list: not "ended" unless a read says so
      this.endedPending = ended;
      this.awayCheck = true;
      if (lost) this.later('inactive', this.T.inactiveDebounce, () => this.awayRead());
      else this.later('idle', this.T.idleGrace, () => this.idleClear());
      this.save();
      this.changed();
      return;
    }
    L.endedCtx = ended;
    if (this.owning() || this.confirming || this.wait || this.away) { this.save(); this.changed(); return; }
    this.off({ k: 'end', n: this.foreignName(), id: this.foreignId() });
  }

  // The context emptied (item 10's idle, or another device taking playback) and no `inactive` followed: it ended.
  idleClear() {
    if (!this.awayCheck || this.latch.set) return;
    if (this.player && !this.player.st.active) { this.later('inactive', this.T.inactiveDebounce, () => this.awayRead()); return; }
    this.awayCheck = false;
    this.off({ k: 'end', n: this.foreignName(), id: this.foreignId() });
  }

  // n of a foreign end: the host's name when we were a guest (and didn't leave); id: that host's member id
  foreignName() { return this.sess && this.sess.role === 'guest' ? this.hostName('The host') : undefined; }
  foreignId() { return this.sess && this.sess.role === 'guest' ? this.hostId() : undefined; }

  // Off: the session state goes, the latch is cleared (remembering the jam-list that ended), jam.json keeps sc etc.
  off(ev) {
    const L = this.latch;
    if (L.set) { L.set = false; L.endedCtx = isJamList(L.ctx) ? L.ctx : L.lastJam || L.endedCtx; }
    else if (this.endedPending) L.endedCtx = this.endedPending;
    this.endedPending = '';
    // a push of this session may still be on its way (C0: a pause change came after the kick): it is no new Jam's
    if (this.sess && this.sess.sid) this.endedSid = { sid: this.sess.sid, at: this.now() };
    this.sess = null;
    this.since = 0;
    this.pendingOwnAt = 0;
    this.confirming = '';
    this.wait = false;
    this.away = false;
    this.awayCheck = false;
    this.hint = null;
    this.idle = null;
    this.cur = null;
    this.pushFed = '';
    this.heldPush = null;
    this.edits = [];
    this.byUid.clear();
    this.unknownTried.clear();
    for (const k of ['set', 'inactive', 'idle', 'confirm', 'away', 'self', 'selfcheck']) this.cancel(k);
    // a Jam Encore switched itself into (DESIGN-JAM-SELF G4): its mode goes off once, after the current action (never
    // inside it). End and Join's replace switch it off themselves (dropSelf first, so nothing is left for here). Not
    // once a Jam is on again by then: a read or push that ended this one while Join's replace was out runs this after
    // that Join, and the forget would switch the joined Jam's mode off (Join forgets before its info: wasSelf).
    if (this.dropSelf()) this.after(() => (this.on ? undefined : this.forget()));
    this.offAt = this.now();
    this.save();
    log.info(`jam: off (${ev ? ev.k + (ev.why ? ', ' + ev.why : '') : 'quietly'})`);
    this.addTrace({ k: 'off', ev: ev ? ev.k : undefined });
    this.changed(ev || undefined);
  }

  // ------------------------------------------------------------------ social-connect calls (through the engine)
  noteCall() { this.callTimes.push(this.now()); this.calls5m(); }
  calls5m() {
    const t = this.now() - 300000;
    while (this.callTimes.length && this.callTimes[0] <= t) this.callTimes.shift();
    return this.callTimes.length;
  }

  // One engine call of a Jam route within the action's deadline (engineCallMs at most). A 204 (the engine is swapping
  // its Spotify session: nothing was sent) is tried once more after 1.5 s; nothing else is ever repeated.
  async jcall(method, p, body, deadline, op) {
    for (let i = 0; ; i++) {
      const left = deadline - this.now();
      if (left < 1000) throw fail(502, 'spotify_error', MSG.late);
      if (!LOCAL_OPS.has(op)) this.noteCall();
      const t0 = Date.now();
      let r;
      try { r = await this.engine.send(method, p, body, { timeoutMs: Math.min(this.T.engineCallMs, left) }); }
      catch (e) {
        this.traceCall(op, 'error', null, Date.now() - t0);
        this.lastErr = { code: e.code || 'engine_error', op, at: this.now() };
        throw e;
      }
      this.traceCall(op, r.status, r.upstream, Date.now() - t0);
      if (r.status === 204 && i === 0) { await sleep(this.T.noSession); continue; }
      // the engine gate's counters (/status `social`, shown in /v1/status and admin) move with every send
      if (!LOCAL_OPS.has(op) && this.engine.refresh) this.later('gate', 300, () => this.engine.refresh());
      return r;
    }
  }

  traceCall(op, status, up, ms) {
    this.addTrace({ k: 'call', op, status, up: up || undefined, ms });
  }

  // An engine answer other than 200 -> the phone's error (§5.8). A refusal of the account (a 401 anywhere, a 403 on
  // current, a 403 on a first-ever Start) turns x.sc off for scRefusedHold.
  mapErr(r, op) {
    const up = r.upstream;
    let e;
    if (r.status === 429) {
      const ra = r.retryAfter > 0 ? Math.ceil(r.retryAfter) : 60;
      this.holdUntil = Math.max(this.holdUntil, this.now() + ra * 1000);
      // Spotify's own 429 carries X-Upstream-Status; the engine's gate (its line, its 5-min cap, its hold after a 429)
      // sent nothing to Spotify
      if (up === 429) e = fail(503, 'rate_limited', `Spotify is limiting Jam requests. Try again in ${ra} s.`, { retry_after: ra });
      else e = fail(503, 'busy', ra <= 5 ? MSG.busy : `Encore is holding back its Jam requests to Spotify. Try again in ${ra} s.`, { retry_after: ra });
    } else if (r.status === 403) {
      if (up === 401 || op === 'current' || (op === 'start' && !this.okStart)) this.refused(op, up);
      e = fail(403, 'jam_refused', op === 'start' || op === 'current' || op === 'broadcast' ? MSG.refusedStart : op === 'join' || op === 'info' ? MSG.refusedJoin : MSG.refused);
    } else if (r.status === 404 && up == null) {
      e = fail(503, 'jam_unavailable', MSG.noRoute);                 // a route this engine doesn't have
    } else if (r.status === 404) {
      e = fail(404, 'jam_not_found', MSG.notFound);
    } else if (r.status === 400) {
      e = op === 'info' || op === 'join' ? fail(400, 'bad_link', MSG.badLink) : fail(400, 'bad_request', 'Encore’s player refused the request.');
    } else if (r.status === 204) {
      e = fail(503, 'engine_no_session', MSG.noSession, { retry_after: 5 });
    } else if (up != null && up >= 400 && up < 500 && WRITES.has(op)) {
      // Spotify answered a write and refused it (a 409, or a 400 the engine passes on as 502; 401, 403, 404 and 429 are
      // above): never "try again", since a second tap would only send the same write (L1 step 12 records a kick's 400)
      e = fail(403, 'jam_refused', op === 'start' ? MSG.refusedStart : op === 'join' ? MSG.refusedJoin : MSG.refused);
    } else {
      e = fail(502, 'spotify_error', MSG.spotify);
    }
    this.lastErr = { code: e.code, op, status: r.status, upstream: up || undefined, at: this.now() };
    log.warn(`jam: ${op} failed: engine ${r.status}${up ? ', Spotify ' + up : ''} -> ${e.code}`);
    return e;
  }

  refused(op, up) {
    this.setSc(0);
    log.warn(`jam: social-connect refused on ${op}${up ? ' (Spotify ' + up + ')' : ''}`);
    // wait, away (and a pending away check or confirmation) stand on reads, which can't be made any more: nothing could
    // confirm or clear them, and they would keep the Jam "on" (no 45 s idle pause, takeOver's fallbacks closed). Off.
    // Not recorded as ended: if the same Jam list comes back to Encore, that is a Jam again.
    if (this.on && !this.latch.set && !this.owning()) {
      this.endedPending = '';
      log.info('jam: the Jam isn\'t on Encore and its session can\'t be read any more: off');
      this.off(null);
      return;
    }
    // nothing to show any more (lim), but the role stays: a guest keeps the guest rules (§4.4 guard, rule 7's local
    // pause, rule 10)
    if (this.sess && !this.sess.refused) { this.sess = { ...this.sess, refused: true }; this.changed(); }
  }

  // ------------------------------------------------------------------ reads (§5.3)
  count(why) { this.reads[why] = (this.reads[why] || 0) + 1; }

  // One session read (engine GET /jam/current). Joins the read in flight. Quiet triggers are dropped at the gateway's
  // 5-min count or during a 429 hold. -> { ok, s } | { error, … } | null (nothing sent)
  read(why, { quiet = true, check = false } = {}) {
    if (this.flight) return this.flight;
    if (!this.hasRoute('current')) return Promise.resolve(null);
    if (!check && this.scNow() !== 1) return Promise.resolve(null);
    const now = this.now();
    if (quiet && (this.calls5m() >= this.T.quiet5m || this.holdUntil > now)) { this.count('dropped'); return Promise.resolve(null); }
    this.count(why);
    this.lastSent = now;
    if (!TAPER_KEEP.has(why)) this.taperAt = now;                         // an event's or an action's read: lively again
    this.flight = (async () => {
      let r;
      try { r = await this.jcall('GET', '/jam/current', undefined, now + this.T.engineCallMs + 2000, 'current'); }
      catch (e) { return { error: e.code || 'engine_error', e }; }
      return this.applyRead(r, check, now);
    })().finally(() => { this.flight = null; });
    return this.flight;
  }

  // sentAt: when the read went out. A push of the same session applied since then is fresher than its answer.
  applyRead(r, check, sentAt) {
    if (r.status !== 200) {
      const e = this.mapErr(r, 'current');
      return { error: e.code, e, status: r.status, upstream: r.upstream, refused: r.status === 403 };
    }
    const j = r.json && typeof r.json === 'object' ? r.json : {};
    if (hasSession(j)) {
      const s = parseSession(j.session, this.me());
      if (!s) return { error: 'shape', keys: j.session && typeof j.session === 'object' ? Object.keys(j.session).slice(0, 30) : [] };   // state unchanged
      // a session marked inactive (C0: `active` true throughout) is no session (§5.4); in L0 that is inconclusive, as {}.
      // The account still has a session all the same, so it never lets Start skip its pre-check (none: false).
      if (s.active === false) {
        if (check) {
          if (!this.latch.set && (this.wait || this.away)) { this.lastRead = { at: this.now(), none: false }; this.noSession(); }
          return { error: 'inactive' };
        }
        this.lastRead = { at: this.now(), none: false };
        log.info('jam: the session read says it is no longer active: no session');
        this.noSession();
        return { ok: true, s: null };
      }
      // `current` names another session than the one shown while the engine plays no Jam (wait, away, a pending
      // Start/Join): the shown one ended, and the other (Spotify's standby after an end, or a Jam elsewhere) is not
      // adopted (DESIGN-JAM-WAIT G5). While the engine plays a Jam, the read is applied as before.
      if (!check && this.on && this.sess && this.sess.sid && s.sid !== this.sess.sid && !this.latch.set) {
        this.setSc(1);
        this.lastRead = { at: this.now(), none: false };   // the account still has a session: Start keeps its pre-check
        log.info('jam: the session read names another session than the one shown: that one ended');
        this.addTrace({ k: 'session', src: 'read', other: 1, host_dev: this.hostDevKind(s) });
        this.noSession();
        return { ok: true, s: null, other: true };
      }
      this.setSc(1);
      this.lastRead = { at: this.now(), none: false };
      // A push of this session applied after the read went out is the fresher of the two: a read Spotify answered just
      // before a member joined would take them out again (ev out), and the next push or read put them back (ev in)
      if (sentAt != null && this.lastPushAt > sentAt && this.lastPushSid === s.sid && this.sess && this.sess.sid === s.sid) {
        log.info('jam: a session read answered after a fresher push of that session: the push\'s members kept');
        this.addTrace({ k: 'session', src: 'read', stale: 1 });
        return { ok: true, s: this.sess };
      }
      this.useSession(s, { src: 'read' });
      return { ok: true, s };
    }
    if (check) {
      // L0: inconclusive. A wait or away still goes: each stood only on an earlier read that showed the session.
      if (!this.latch.set && (this.wait || this.away)) { this.lastRead = { at: this.now(), none: true }; this.noSession(); }
      return { error: j.not_found ? 'not_found' : 'none' };
    }
    if (j.not_found && this.sc !== 1) return { error: 'not_found' };
    this.lastRead = { at: this.now(), none: true };
    this.noSession();
    return { ok: true, s: null };
  }

  // A read found no session: whatever we showed has ended.
  noSession() {
    if (this.confirming === 'start') {
      this.off(null);
      this.bus.push('notice', { code: 'jam_not_started', message: 'Spotify didn’t start the Jam.' });
      log.warn('jam: Spotify never sent our Jam to Encore and has no session for it: off');
      return;
    }
    if (this.on) { this.off({ k: 'end', n: this.foreignName(), id: this.foreignId() }); return; }
    // (a self Jam jam.json kept is over too; the engine shows no Jam mode, or the latch would be set)
    if (this.hint || this.selfJam) { this.hint = null; this.dropSelf(); this.save(); }
  }

  // A session from a read, a write's reply or a push (o.src): shown only while a Jam plays on Encore (or after a
  // restart, when it is the one jam.json had). o.kickedMe: a USER_KICKED push named this account.
  useSession(s, o = {}) {
    const prev = this.sess;
    if (!this.on) {
      // (`current` answers the account's own session: no member check, the member ids may not be usernames)
      if (!(this.hint && this.hint.sid === s.sid)) { if (this.hint || this.selfJam) { this.hint = null; this.dropSelf(); this.save(); } return; }
      this.away = true;                                                     // the Jam goes on, but not on Encore
      this.since = this.hint.since || sec(this.now());
      log.info('jam: the account is still in the Jam Encore was in, but Encore isn\'t playing it: away');
      // A push says so only while sc is 1 (pushPlan), and no push marks a Jam's end (C0): one read confirms it, as the
      // away check after `inactive` does (the connect read may already have gone, with the hint)
      if (o.src === 'push') this.later('inactive', this.T.inactiveDebounce, () => this.awayRead());
    }
    // a session that doesn't say who owns it keeps the role we had (our Start or Join, jam.json); else it is ours: a
    // Jam reaches Encore as a guest only through our own Join
    if (!s.ownerKnown) s.role = (prev && prev.role) || (this.hint && this.hint.sid === s.sid && this.hint.role) || 'host';
    this.hint = null;
    this.learnMe(s);
    const mine = this.meIn(s);
    if (mine === false || (o.kickedMe && mine !== true)) {
      // removed only when the last read or push of this session listed us (an id that isn't the username isn't a
      // removal), or when a USER_KICKED push named this account
      if (o.kickedMe || (prev && prev.sid === s.sid && this.meIn(prev) === true)) {
        this.sess = s;
        this.off({ k: 'kicked', n: this.hostName('The host'), id: this.hostId() });
        return;
      }
      if (!unmatched.logged) {
        unmatched.logged = true;
        log.warn(`jam: this account isn't among the session's member ids (member keys ${s.mkeys || '(none)'}): not taken as a removal`);
      }
    }
    let ev;
    if (prev && prev.sid === s.sid && prev.members.length) {
      const before = new Set(prev.members.map((m) => m.id));
      const after = new Set(s.members.map((m) => m.id));
      const added = s.members.find((m) => !before.has(m.id));
      const gone = prev.members.find((m) => !after.has(m.id));
      if (added && s.role === 'host') ev = { k: 'in', n: added.n, id: added.id };
      else if (gone) ev = { k: 'out', n: gone.n, id: gone.id };
    }
    this.sess = s;
    this.traceSession(s, o.src || 'read');
    this.save();
    this.changed(ev);
    if (this.lastQueue) this.takeQueue(this.lastQueue, { noRead: o.src === 'push' });   // new members: attribution again
    this.noteJamList();
  }

  // the trace's `session` entry: counts and the host device's kind only
  traceSession(s, src) {
    this.addTrace({ k: 'session', src, n: s.members.length, listening: s.listening, controlling: s.controlling, host_dev: this.hostDevKind(s) });
  }

  // the session's host device against Encore's own (/status device_id): encore | other | absent | unknown
  hostDevKind(s) { return !s || !s.hostDev ? 'absent' : !this.deviceId ? 'unknown' : s.hostDev.id === this.deviceId ? 'encore' : 'other'; }

  // this account among a session's members: true, false, or null when that can't be told (no is_current_user, no
  // username or learned id, no members)
  meIn(s) {
    if (!s || !s.members.length) return null;
    if (s.meId) return true;
    const ids = this.myIds();
    if (!ids.size) return null;
    return s.members.some((m) => ids.has(m.id) || (!!m.sp && ids.has(m.sp)));
  }

  // engine `inactive` (or the latch clearing with no playback): the account's Jam goes on elsewhere, or it ended
  // retry: the one more read after a read that didn't answer
  async awayRead(retry = false) {
    if (!this.on || this.latch.set) { this.awayCheck = false; this.changed(); return; }
    const t = this.now();
    const res = await this.read(retry ? 'away_retry' : 'inactive');
    if (res && res.ok && !res.s) return;                                   // ended (off already)
    if (!this.on && !this.awayCheck) return;
    this.awayCheck = false;
    if (!this.latch.set) {
      this.away = true;                                                    // shown, or unknown: the next read decides
      log.info('jam: Encore lost playback but the Jam goes on: away');
      // No answer (dropped at the quiet cap or in a 429 hold, a 502, a timeout): with the Jam screen closed no other
      // read may come, so one more a minute on (after the hold), unless another read answers first. Never more.
      if (!retry && !(res && res.ok)) {
        this.later('away', Math.max(this.T.awayRetryMs, this.holdUntil - this.now() + 1000), () => {
          if (this.away && !this.latch.set && !(this.lastRead && this.lastRead.at > t)) this.awayRead(true);
        });
      }
    }
    this.save();
    this.changed();
  }

  // GET /v1/jam [w=1: the Jam screen's lease] [fresh=1: pull to refresh]
  async get({ w, fresh } = {}) {
    if (w) this.watch();
    if (fresh) this.lively();                                              // a pull to refresh, read or not
    if (fresh && !this.fake && this.on && this.scNow() === 1 && this.now() - this.lastSent >= this.T.freshGap) await this.read('fresh', { quiet: false });
    return this.memo();
  }

  watch() {
    const now = this.now();
    const live = this.leaseUntil > now;
    this.leaseUntil = now + this.T.leaseMs;
    if (live) return;
    this.taperAt = now;
    if (this.on && this.scNow() === 1 && now - this.lastSent >= this.T.leaseStartAge) this.read('lease');
    this.startPoll();
  }

  // The lease poll's gap, tapered (§5.3): pollMs for the first pollMidAt of a lease, then pollMidMs, then pollSlowMs
  // from pollSlowAt. A read of any other trigger and a user action start it over. About 39 reads in an hour with the
  // Jam screen open and nothing happening; never closer than pollMs, so the design's caps hold. While the session is
  // push-fed (a session_update of it was applied: pushes carry joins and removals) the poll is only a safety net:
  // pollSlowMs at once.
  pollGap(now) {
    if (this.pushFed && this.sess && this.sess.sid === this.pushFed) return this.T.pollSlowMs;
    const age = now - this.taperAt;
    return age < this.T.pollMidAt ? this.T.pollMs : age < this.T.pollSlowAt ? this.T.pollMidMs : this.T.pollSlowMs;
  }

  // a user action (or a read of another trigger, in read()): the lease poll goes back to pollMs
  lively() { this.taperAt = this.now(); }

  startPoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollTick(), this.T.pollMs);
    this.pollTimer.unref();
  }

  stopPoll() { if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; } }

  pollTick() {
    const now = this.now();
    if (this.leaseUntil <= now) { this.stopPoll(); return; }
    if (this.fake) { this.fakeTick(); return; }
    // skipped when a read went out, or a push was applied, within the tapered gap (100 ms of slack: the interval's own
    // read sets lastSent a moment late)
    if (this.on && this.scNow() === 1 && now - Math.max(this.lastSent, this.lastPushAt) >= this.pollGap(now) - 100) this.read('poll');
  }

  // ------------------------------------------------------------------ actions (§5.7)
  // Serialized (one at a time, apart from the player's lock), each within actionDeadlineMs from when it was asked for.
  // Each one restarts the lease poll's taper (a guest's automatic Leave too, which ends the lease's reads anyway).
  act(name, fn) {
    this.lively();
    const deadline = this.now() + this.T.actionDeadlineMs;
    const job = this.lock.then(() => fn(deadline));
    this.lock = job.catch(() => {});
    return job;
  }

  // follow-up work after a reply has gone (the next action waits for it)
  after(fn) { this.lock = this.lock.then(fn).catch((e) => log.warn('jam:', e.message)); }

  needSocial() {
    if (!this.canSocial()) throw fail(503, 'jam_unavailable', MSG.unavailable);
  }

  // the session from a write's reply (or nothing: a read follows)
  sessionOf(r) { return hasSession(r.json) ? parseSession(r.json.session, this.me()) : null; }

  start() {
    return this.act('start', async (dl) => {
      if (this.fake) throw fail(409, 'jam_active', MSG.active);
      this.needSocial();
      if (this.on) throw fail(409, 'jam_active', MSG.active, this.role() ? { r: this.role() } : undefined);
      if (!this.player.loaded()) throw fail(409, 'not_active', MSG.notActive);
      // current_or_new returns an existing session: never adopt (and later end) a Jam the user hosts elsewhere
      const fresh = this.lastRead && this.lastRead.none && this.now() - this.lastRead.at < this.T.startPrecheckFresh;
      let pre = null;                                                      // the pre-check's session hosted on Encore
      if (!fresh) {
        this.count('precheck');
        this.lastSent = this.now();
        const r = await this.jcall('GET', '/jam/current', undefined, dl, 'current');
        if (r.status !== 200) throw this.mapErr(r, 'current');
        const s = hasSession(r.json) ? this.sessionOf(r) : null;
        if (hasSession(r.json) && !s) throw fail(502, 'spotify_error', MSG.shape);
        if (s) {
          this.lastRead = { at: this.now(), none: false };
          const here = s.role === 'host' && !!s.hostDev && !!this.deviceId && s.hostDev.id === this.deviceId;
          if (!here) {
            // unchanged rule: never adopt (and later end) a Jam hosted elsewhere, or someone else's. An inactive one too
            // (§5.7 step 2): current_or_new?activate=true would hand it back, and plausibly revive it. C0 never saw
            // active:false.
            log.info(`jam: Start: the account already has a session${s.active === false ? ' (marked inactive)' : ''}: nothing started`);
            throw fail(409, 'jam_elsewhere', MSG.elsewhere);
          }
          // Encore's own: Spotify's standby after an end (seen live 2026-10-07) or a Jam the gateway forgot.
          // current_or_new activates it, as the desktop's Start does; adopting it without that call (0.8.2) left every
          // such Start in wait (DESIGN-JAM-WAIT C1).
          pre = s;
          log.info(`jam: Start: the account's session is hosted here, by Encore${s.active === false ? ' (marked inactive)' : ''}: activating it`);
        } else this.lastRead = { at: this.now(), none: true };
      }
      // while the broadcast and current_or_new go out, a NEW_SESSION for Encore is this Start's own (Spotify may replace
      // the standby with a fresh session), never the standby an end leaves (onDealer)
      this.starting = true;
      let r;
      try {
        await this.broadcastStep(dl);
        r = await this.jcall('POST', '/jam/start', {}, dl, 'start');
      } finally { this.starting = false; }
      if (r.status !== 200) throw this.mapErr(r, 'start');
      const s = this.sessionOf(r);
      if (!s) throw fail(502, 'spotify_error', MSG.shape);
      if (pre) {
        // the live test's evidence: did current_or_new activate the standby, or make another session?
        const same = s.sid === pre.sid;
        log.info(`jam: Start: current_or_new answered ${same ? 'the session the pre-check saw' : 'another session'}`);
        this.addTrace({ k: 'start', same: same ? 1 : 0 });
      }
      if (s.role !== 'host') {
        if (s.ownerKnown) {
          // someone else's session: Encore hosts nothing, so its broadcast goes back off (after the reply; never retried)
          if (this.bcOnSent) this.after(() => this.broadcastSet('off', 'Start (someone else\'s session)'));
          throw fail(409, 'jam_elsewhere', MSG.elsewhere);
        }
        // the session doesn't say who owns it: current_or_new right after a read that showed no session made it ours
        s.role = 'host';
        log.info('jam: the started session doesn\'t say who owns it: taken as ours (no session a moment before)');
      }
      this.okStart = true;
      // (no creation-time check: C0's session has no creation field, and the pre-check above already keeps Encore
      // from adopting an older Jam)
      if (s.hostDev && this.deviceId && s.hostDev.id !== this.deviceId) {
        // the account's active device wasn't Encore, so Spotify started the Jam there: away (End works), no step 5
        this.adoptAway(s);
        log.info('jam: Start: the session\'s host device isn\'t Encore: away');
        this.bus.push('notice', { code: 'jam_away', message: `Spotify started the Jam on ${s.hostDev.name || 'another device'}. Play it on Encore from there, or end it.` });
        // Encore hosts nothing: its broadcast goes back off (after the reply; never retried)
        if (this.bcOnSent) this.after(() => this.broadcastSet('off', 'Start (hosted elsewhere)'));
      } else {
        this.adopt(s, 'start');
        log.info(`jam: started (${s.members.length} member${s.members.length === 1 ? '' : 's'})`);
        // DESIGN-JAM-SELF: our own Start of a session hosted on Encore. If Spotify doesn't hand it over within
        // selfJamMs, Encore switches itself into Jam mode (once)
        if (this.hostDevKind(s) === 'encore') this.armSelf(s.sid);
      }
      this.changed({ k: 'start' });
      return { jam: this.body() };
    });
  }

  // C0's step: set_broadcast_status ON for Encore 1 s before current_or_new (the engine's gate spaces the two sends).
  // Skipped by the flag, or on an engine without patch 4. The engine always names its own device: no id from here.
  async broadcastStep(dl) {
    this.bcOnSent = false;
    if (!this.flags.startBroadcast || !this.hasRoute('broadcast')) return;
    const r = await this.jcall('POST', '/jam/broadcast', { status: 'on' }, dl, 'broadcast');
    if (r.status === 200) {
      this.bcOnSent = true;
      const st = r.json && typeof r.json.broadcast_status === 'string' ? r.json.broadcast_status : '';
      this.noteBroadcast(st, 'reply');
      log.info(`jam: Start: Encore's Jam broadcast set on (${ENUM.test(st) ? st : 'no status'})`);
      return;
    }
    // what would stop current_or_new too stops Start: a 429 (gate or Spotify), the token refused, no engine session
    if (r.status === 429 || r.status === 204 || (r.status === 403 && r.upstream === 401)) throw this.mapErr(r, 'broadcast');
    this.lastErr = { code: 'broadcast_failed', op: 'broadcast', status: r.status, upstream: r.upstream || undefined, at: this.now() };
    log.warn(`jam: Start: the broadcast step failed (engine ${r.status}${r.upstream ? ', Spotify ' + r.upstream : ''}): starting without it`);
  }

  // A best-effort broadcast write after a user's End (or a Start that landed elsewhere): never retried, never thrown.
  async broadcastSet(status, why) {
    if (!this.hasRoute('broadcast')) return;
    try {
      const r = await this.jcall('POST', '/jam/broadcast', { status }, this.now() + this.T.engineCallMs, 'broadcast');
      if (r.status === 200) {
        this.noteBroadcast(r.json && r.json.broadcast_status, 'reply');
        log.info(`jam: ${why}: Encore's Jam broadcast set ${status}`);
      } else this.mapErr(r, 'broadcast');            // logs; a 429 holds the quiet reads; a 401 refusal turns sc off
    } catch (e) { log.warn(`jam: ${why}: Encore's Jam broadcast ${status}: ${e.code || e.message}`); }
  }

  // Encore's broadcast as Spotify last said it (a reply, a push or the admin read): an enum only, logged on change
  noteBroadcast(status, src) {
    if (typeof status !== 'string' || !ENUM.test(status)) return;
    const prev = this.bc ? this.bc.status : '';
    this.bc = { status, src, at: this.now() };
    if (status !== prev) log.info(`jam: Encore's Jam broadcast is ${status} (${src})`);
  }

  // POST /admin/api/jam/broadcast: one jam_status read of Encore's broadcast (on the admin's tap) -> enum and self only
  async broadcastRead() {
    if (!this.hasRoute('broadcast')) return { ok: false, reason: 'the engine has no broadcast route (patch 4 missing)' };
    let r;
    try { r = await this.jcall('GET', '/jam/broadcast', undefined, this.now() + this.T.engineCallMs, 'jam_status'); }
    catch (e) { return { ok: false, code: e.code || 'engine_error' }; }
    if (r.status !== 200) {
      const e = this.mapErr(r, 'jam_status');
      return { ok: false, code: e.code, status: r.status, upstream: r.upstream || undefined };
    }
    const st = r.json && typeof r.json.broadcast_status === 'string' && ENUM.test(r.json.broadcast_status) ? r.json.broadcast_status : null;
    this.noteBroadcast(st, 'read');
    log.info(`jam: admin broadcast read: ${st || 'no status'}`);
    return { ok: true, broadcast_status: st, self: !!(r.json && r.json.self) };
  }

  // Evidence for a later self-activation decision (DESIGN-JAM-WAIT G7): whether the engine's jam-list id is the shown
  // session's id. A boolean in the trace, once per list; neither id is ever logged.
  noteJamList() {
    const L = this.latch;
    const s = this.sess;
    if (!this.on || !s || !s.sid || !isJamList(L.ctx) || this.jamListNoted === L.ctx) return;
    this.jamListNoted = L.ctx;
    this.addTrace({ k: 'jamlist', sid_match: L.ctx.slice(JAM_LIST.length).toLowerCase() === String(s.sid).toLowerCase() ? 1 : 0 });
  }

  // our start/join succeeded: on now; the engine should confirm within ownConfirmMs, else one read decides
  adopt(s, kind) {
    const was = this.on;
    this.sess = s;
    this.pendingOwnAt = this.now();
    this.wait = false;
    this.away = false;
    this.awayCheck = false;
    this.hint = null;
    this.endWatch = null;
    this.dropSelf();                                   // a new session of ours: no earlier self Jam is on (jam.json's)
    if (!was || !this.since) this.since = sec(this.now());
    this.learnMe(s);
    this.traceSession(s, kind);
    this.save();
    this.cancel('confirm');
    this.later('confirm', this.T.ownConfirmMs + 100, () => this.confirm(kind));
  }

  // Start's twin when the session names another host device: on, host, away; nothing to confirm
  adoptAway(s) {
    const was = this.on;
    this.sess = s;
    this.pendingOwnAt = 0;
    this.wait = false;
    this.away = true;
    this.awayCheck = false;
    this.hint = null;
    this.endWatch = null;
    this.dropSelf();
    if (!was || !this.since) this.since = sec(this.now());
    this.learnMe(s);
    this.traceSession(s, 'start');
    this.cancel('confirm');
    this.save();
  }

  // Start step 5 (and Join's twin): the engine never showed the Jam. One read, never an End.
  async confirm(kind) {
    if (this.latch.set || !this.sess || !this.pendingOwnAt) return;
    if (this.sess.refused || this.scNow() !== 1) {                          // refused meanwhile: nothing can confirm it
      this.pendingOwnAt = 0;
      log.warn(`jam: Spotify hasn't sent the Jam to Encore after our ${kind}, and its session can't be read: off`);
      this.off(null);
      return;
    }
    this.confirming = kind;
    log.warn(`jam: Spotify hasn't sent the Jam to Encore ${Math.round(this.T.ownConfirmMs / 1000)} s after our ${kind}: one read`);
    let res = null;
    try { res = await this.read('confirm', { quiet: false }); } finally { this.confirming = ''; }
    this.pendingOwnAt = 0;
    if (res && res.ok && !res.s) return;                                   // no session: off (noSession)
    if (this.latch.set || !this.sess) { this.changed(); return; }
    if (kind === 'start') {
      // the same wait either way; the log tells a confirmed one (the read showed the session) from an unconfirmed one
      this.wait = true;
      if (res && res.ok) log.warn('jam: Spotify has our Jam but isn\'t sending it to Encore: wait');
      else log.warn(`jam: Spotify hasn't sent the Jam to Encore and the check read didn't answer (${res ? res.error : 'not sent'}): wait`);
      this.addTrace({ k: 'wait', read: res && res.ok ? 1 : 0 });
    } else { this.away = true; log.warn('jam: joined, but Spotify isn\'t sending the Jam to Encore: away'); }
    this.save();
    this.changed();
  }

  // DESIGN-JAM-SELF G1: armed after our own Start of a session hosted on Encore (an engine with patch 5, the flag on).
  // off() cancels the timer, so an End tapped before it goes leaves no call behind.
  armSelf(sid) {
    if (!this.flags.selfJam || !this.hasRoute('activate')) return;
    this.cancel('self');
    // through the action lock: never in the middle of an End, a Join or another Start
    this.later('self', this.T.selfJamMs, () => this.after(() => this.selfActivate(sid)));
  }

  // DESIGN-JAM-SELF G2: the device that starts a Jam switches itself into Jam mode (its own options modes.jam "on", in
  // its Connect state); Spotify never sends the host that set_options. One engine call per Start: local (no
  // social-connect send, not in calls5m), only for our own Start's session, hosted on Encore, while the engine shows no
  // Jam yet. Never thrown, never retried; the confirm read and wait stay the fallback. No mapErr: it would label the
  // engine's own 409 a Spotify error.
  async selfActivate(sid) {
    const s = this.sess;
    if (this.latch.set || !this.pendingOwnAt || this.wait || this.away || this.fake || !s || s.sid !== sid ||
      s.role !== 'host' || this.hostDevKind(s) !== 'encore' || !this.flags.selfJam || !this.hasRoute('activate')) return;
    log.info(`jam: Start: no hand-over from Spotify ${sec(this.T.selfJamMs)} s after our start: Encore switches itself into Jam mode`);
    let r;
    try { r = await this.jcall('POST', '/jam/activate', {}, this.now() + this.T.engineCallMs, 'activate'); }
    catch (e) {
      this.addTrace({ k: 'self', status: 'error' });
      log.warn(`jam: Encore couldn't switch itself into Jam mode (${e.code || 'engine_error'}): waiting for Spotify`);
      return;
    }
    if (r.status !== 200) {
      // (a 204 here is the second one: jcall tried once more after the first)
      this.addTrace({ k: 'self', status: r.status });
      this.lastErr = { code: 'self_failed', op: 'activate', status: r.status, at: this.now() };
      log.warn(`jam: Encore didn't switch itself into Jam mode (engine ${r.status}${r.status === 409 ?
        ': not the active device, nothing loaded, or a Jam\'s playback already' : ''}): waiting for Spotify`);
      return;
    }
    const changed = !!(r.json && r.json.changed);
    this.addTrace({ k: 'self', status: 200, changed: changed ? 1 : 0 });
    if (!this.on || !this.sess || this.sess.sid !== sid) {
      // the Jam went off while the call ran (a push or a read with no session): nothing is hosted, so the mode this
      // call switched on goes off again
      log.info('jam: the Jam ended while Encore switched itself into Jam mode: switching it off again');
      if (changed) await this.forget();
      return;
    }
    this.selfJam = { sid, at: this.now() };            // set even when the event came first: End must switch it off
    this.save();
    log.info(`jam: Encore is in Jam mode (${changed ? 'switched on' : 'already on'}); its Connect state says so`);
    if (this.latch.set) return;
    if (!changed) {
      // the mode was on already: no jam event will come (the engine just said what its mode is)
      this.latch.mode = 'on';
      this.latchSet('activate', false);
      return;
    }
    // the engine's `jam` event sets the latch (onEngine -> feed); had it been lost, one /status does (fromStatus feeds
    // it: no jam event in the last 2 s)
    this.later('selfcheck', this.T.selfCheckMs, () => {
      if (!this.selfJam || this.latch.set || !this.on) return;
      log.warn('jam: no jam event after Encore switched itself into Jam mode: reading the engine\'s /status');
      if (this.engine && this.engine.refresh) this.engine.refresh();
    });
  }

  // the Jam Encore switched itself into is over (or never was): nothing from Spotify will switch its mode off
  // (DESIGN-JAM-SELF §2.5). -> whether one was on: the caller then makes the one /jam/forget
  dropSelf() { const was = !!this.selfJam; this.selfJam = null; this.cancel('selfcheck'); return was; }

  join(b = {}) {
    return this.act('join', async (dl) => {
      const p = jamlink.parseLink(b.link);
      if (!p) throw fail(400, 'bad_link', MSG.badLink);
      if (this.fake) return this.fakeJoin(b.replace === true);
      this.needSocial();
      // lim: nothing Encore could leave or end, so no link expansion either
      if (this.on && !this.role()) throw fail(409, 'jam_active', MSG.limActive);
      let token = p.token;
      if (p.short) {
        token = await jamlink.expand(p.short, { fetch: this.fetch, stats: this.counts.redirects });
        if (!token) throw fail(400, 'bad_link', MSG.badLink);
      }
      if (this.on) {
        const r = this.role();
        if (!r) throw fail(409, 'jam_active', MSG.limActive);
        if (r === 'guest' && this.sess.token === token) return { jam: this.body() };
        if (r === 'host' && b.replace !== true) throw fail(409, 'jam_active', MSG.active, { r: 'host' });
        if (!this.sess.sid) throw fail(503, 'jam_unavailable', MSG.limited);
        // (a read or push answering "no session" while the End is out drops selfJam itself: off())
        const wasSelf = !!this.selfJam;
        await this.leaveOrEnd(r === 'host' ? 'end' : 'leave', dl);
        const self = this.dropSelf() || wasSelf;
        this.off(null);                                                      // the join's ev follows
        // a Jam Encore switched itself into: its mode off before the Join (after it, the forget would switch the
        // joined Jam's mode off and clear its latch)
        if (self) await this.forget();
      }
      let info = this.infoCache.get(token);
      if (!info || this.now() - info.at > this.T.infoCacheMs) {
        const r = await this.jcall('GET', '/jam/info?token=' + encodeURIComponent(token), undefined, dl, 'info');
        if (r.status !== 200) throw this.mapErr(r, 'info');
        if (!hasSession(r.json)) throw fail(404, 'jam_not_found', MSG.notFound);
        info = { at: this.now(), s: this.sessionOf(r) };
        this.infoCache.set(token, info);
        if (this.infoCache.size > 20) this.infoCache.delete(this.infoCache.keys().next().value);
      }
      // join straight away: the engine's gate lines it up ≥ 1 s after info
      const gens = this.watchGens();
      let r;
      try { r = await this.jcall('POST', '/jam/join', { token }, dl, 'join'); } catch (e) { gens.stop(); throw e; }
      if (r.status !== 200) {
        gens.stop();
        if (r.status === 409) { this.mapErr(r, 'join'); throw fail(403, 'jam_refused', MSG.refusedJoin); }
        throw this.mapErr(r, 'join');
      }
      this.infoCache.delete(token);
      let s = this.sessionOf(r);
      const readAfter = !s;
      if (!s) s = info.s ? { ...info.s } : { sid: '', token, role: 'guest', members: [], hostId: '', gc: null, share: '' };
      s.role = 'guest';
      if (!s.token) s.token = token;
      this.adopt(s, 'join');
      const host = s.members.find((m) => m.id === s.hostId);
      log.info(`jam: joined (${s.members.length} members)`);
      this.changed(host ? { k: 'join', n: host.n, id: host.id } : { k: 'join' });
      if (readAfter) this.read('join', { quiet: false });
      const gen = await gens.wait(Math.max(0, Math.min(this.T.joinGenWaitMs, dl - this.now())));
      const out = { jam: this.body() };
      if (gen) out.gen = gen;
      return out;
    });
  }

  // the first generation that starts from now on (the Jam's audio arriving as a foreign transfer)
  watchGens() {
    let first = null;
    let done = null;
    let timer = null;
    const on = (g) => { if (first == null) { first = g; if (done) done(g); } };
    const stop = () => { if (this.player.off) this.player.off('genStart', on); clearTimeout(timer); };
    if (this.player.on) this.player.on('genStart', on);
    return {
      stop,
      wait: (ms) => new Promise((resolve) => {
        if (first != null || !(ms > 0)) { stop(); return resolve(first); }
        done = (g) => { stop(); resolve(g); };
        timer = setTimeout(() => { stop(); resolve(null); }, ms);
      }),
    };
  }

  // /jam/leave or /jam/end of our session: a Spotify 404 counts as done. While our /jam/end runs, that session's
  // SESSION_DELETED push is our own End's (end() and Join's replace turn it off themselves): endingSid.
  async leaveOrEnd(op, dl) {
    if (op === 'end') this.endingSid = this.sess.sid;
    try {
      const r = await this.jcall('POST', '/jam/' + op, { session_id: this.sess.sid }, dl, op);
      if (r.status === 200 || (r.status === 404 && r.upstream != null)) return;
      throw this.mapErr(r, op);
    } finally { if (op === 'end') this.endingSid = ''; }
  }

  // b: the phone's body (unused); why: 'idle' | 'refusing' when the gateway leaves on its own (§5.6 rules 7, 10)
  leave(b, why) {
    return this.act('leave', async (dl) => {
      if (this.fake) return this.fakeLeave();
      if (!this.on) throw fail(409, 'not_in_jam', MSG.notInJam);
      const r = this.role();
      if (r === 'host') throw fail(409, 'is_host', MSG.isHost);
      if (!r || !this.sess.sid || !this.canSocial()) throw fail(503, 'jam_unavailable', MSG.limited);
      await this.leaveOrEnd('leave', dl);
      this.off(why ? { k: 'leave', why } : { k: 'leave' });
      this.after(() => this.settleLeave());
      return { jam: this.body() };
    });
  }

  // Leave step 3: Encore isn't in the Jam any more; if it still plays it, that is local playback now
  async settleLeave() {
    await sleep(this.T.leaveSettleMs);
    const s = await this.engine.refresh();
    if (s && s.track && !s.stopped && !s.paused && (isJamList(s.context_uri) || isSocial(s.play_origin_device_id))) {
      log.info('jam: still playing the Jam after leaving it: pausing');
      await this.player.pause({}).catch((e) => log.warn('jam: pause after leaving:', e.message));
    }
    if (s && s.jam_mode === 'on') await this.forget();
  }

  // engine /jam/forget: its own "jam on" mode off, after our End or Leave (local, no social-connect call)
  async forget() {
    try {
      const r = await this.jcall('POST', '/jam/forget', {}, this.now() + 10000, 'forget');
      if (r.status === 200) log.info(`jam: the engine's Jam mode ${r.json && r.json.changed ? 'switched off' : 'was off already'}`);
    } catch (e) { log.warn('jam: forget:', e.message); }
  }

  // An automatic Leave (idle, Spotify refusing). Without social-connect only the local pause is possible.
  autoLeave(why) {
    if (this.role() === 'guest' && this.sess.sid && this.canSocial()) {
      log.info(`jam: leaving the Jam on our own (${why})`);
      return this.leave({}, why).catch((e) => {
        log.warn(`jam: leaving (${why}) failed: ${e.code || e.message}: pausing Encore only`);
        return this.player.pause({}).catch(() => {});
      });
    }
    log.info(`jam: can't leave the Jam (${why}): pausing Encore only`);
    return this.player.pause({}).catch(() => {});
  }

  // End (host, only ever on the user's tap): engine /jam/end = DELETE v3/sessions/<sid>, the 2021–22 call. Uncaptured: C0
  // didn't show the desktop's End (its native core sent it), so L1 step 13 is its first test.
  end() {
    return this.act('end', async (dl) => {
      if (this.fake) return this.fakeEnd();
      if (!this.on) throw fail(409, 'not_in_jam', MSG.notInJam);
      const r = this.role();
      if (r === 'guest') throw fail(409, 'not_host', MSG.notHost);
      if (!r || !this.sess.sid || !this.canSocial()) throw fail(503, 'jam_unavailable', MSG.limited);
      // 1. what keeps playing afterwards: the song where the listener is, and the Jam's upcoming rows
      const pl = this.player;
      const t = pl.st.track;
      const song = t ? t.context_track_uri || t.uri : '';
      const playing = pl.st.status === 'playing';
      const pos = Math.max(0, Math.round(playing ? pl.posNow() - pl.connectDelay() : pl.posNow()));
      const rows = await this.upcoming();
      // 2. (and, for a Jam hosted on Encore, its Jam broadcast off after the reply: DESIGN-JAM-WAIT G2)
      const t0 = this.now();
      const encoreHosted = this.hostDevKind(this.sess) === 'encore';
      const wasSelf = !!this.selfJam;                  // (a read or push during the End may drop it first: off())
      await this.leaveOrEnd('end', dl);
      this.ownEndAt = this.now();
      const self = this.dropSelf() || wasSelf;
      this.off({ k: 'end' });
      // a Jam Encore switched itself into (DESIGN-JAM-SELF G4): its mode off at once, before the broadcast off and the
      // settle (whose /status then says "off": the backstop below makes no second call)
      if (self) await this.forget();
      if (encoreHosted && this.flags.endBroadcastOff) this.after(() => this.broadcastSet('off', 'ended'));
      // 3. item 10 leaves the engine idle (or it keeps the song): keep the music going, at most 1 load
      const st = await this.settle(song, Math.max(0, Math.min(this.T.endSettleMs, dl - this.now() - 15000)));
      let reply = null;
      if (song && !st.same) reply = await this.keepGoing(song, playing, pos, rows);
      else if (song) {
        // "kept" may only mean the end transfer hasn't arrived yet (a slow push): when item 10 takes it later, the
        // engine goes idle with nothing restarting the song. Watch for its `command` (jam_end) a while, once.
        log.info('jam: ended; the engine kept the song (a late end transfer would restart it once)');
        this.endWatch = { song, playing, rows, until: this.now() + this.T.endWatchMs };
        if (this.lastJamEndAt >= t0) this.onJamEnd();
      } else log.info('jam: ended; nothing was playing');
      if (st.mode === 'on') await this.forget();
      return { jam: this.body(), ...(reply || { state: pl.snapshot() }) };
    });
  }

  // End step 3's restart: the song at the listener's position (a generation if it was playing, else loaded paused),
  // then the remembered rows queued again (engine-local). -> the play's reply, or null
  async keepGoing(song, playing, pos, rows) {
    const pl = this.player;
    try {
      let reply = null;
      if (playing) reply = await pl.play({ uri: song, position_ms: pos });
      else await pl.loadPaused({ uri: song, position: pos });
      this.counts.cmd++;
      let n = 0;
      for (const u of rows) {
        if (await this.engine.call('/player/add_to_queue', { uri: u }).then(() => true, () => false)) n++;
        await sleep(this.T.addGapMs);
      }
      log.info(`jam: ended; the song goes on (${playing ? 'playing' : 'paused'}), ${n} of ${rows.length} upcoming rows queued again`);
      return reply;
    } catch (e) { log.warn('jam: keeping the music going after the end:', e.message); return null; }
  }

  // engine `command` with jam_end (item 10 took a Jam's end transfer). After our End said the engine kept the song,
  // the song is restarted once, if Encore is still on it and no Jam has started since.
  onJamEnd() {
    const w = this.endWatch;
    if (!w) return;
    this.endWatch = null;
    if (this.now() > w.until || this.on) return;
    const pl = this.player;
    if (!pl.st.track || !pl.isSong(w.song, pl.st.track)) { log.info('jam: the Jam\'s end transfer came late, with Encore on another song: nothing restarted'); return; }
    // as End step 1, now: playing (or just stopped by this end, after playing on since End) or paused by the user since
    const playing = pl.st.status === 'playing' || (pl.st.status === 'stopped' && w.playing);
    const pos = Math.max(0, Math.round(playing ? pl.posNow() - pl.connectDelay() : pl.posNow()));
    log.info('jam: the Jam\'s end transfer came after our End: the song goes on');
    this.after(() => this.keepGoing(w.song, playing, pos, w.rows));
  }

  // the uris of the upcoming queue rows, then the Jam list's (≤ 20): End adds them back
  async upcoming() {
    try {
      const r = await this.engine.get('/player/queue', { timeoutMs: this.T.queueTimeout });
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.next)) return [];
      const q = r.json.next.filter((e) => e && e.provider === 'queue');
      const c = r.json.next.filter((e) => e && e.provider !== 'queue' && e.provider !== 'autoplay');
      return [...q, ...c].map((e) => e.uri).filter((u) => typeof u === 'string' && /^spotify:(track|episode):/.test(u)).slice(0, 20);
    } catch (e) { return []; }
  }

  // End step 3: wait (≤ ms) for the engine to leave the song (idle, stopped, another song); same: it kept it
  async settle(song, ms) {
    const t0 = Date.now();
    for (;;) {
      const s = await this.engine.refresh();
      const tr = s && s.track;
      const same = !!(song && tr && !s.stopped && (tr.context_track_uri === song || tr.uri === song ||
        this.player.isSong(song, { uri: tr.uri, name: tr.name, duration_ms: tr.duration })));
      if (!same || Date.now() - t0 >= ms) return { same, mode: s && s.jam_mode };
      await sleep(500);
    }
  }

  settings(b = {}) {
    return this.act('settings', async (dl) => {
      if (this.fake) return this.fakeSettings(b);
      if (!this.on) throw fail(409, 'not_in_jam', MSG.notInJam);
      if (this.role() !== 'host') throw fail(409, 'not_host', MSG.notHost);
      if (!this.canSocial() || !this.hasRoute('settings') || !this.sess.sid) throw fail(409, 'unsupported', MSG.unsupported);
      const r = await this.jcall('POST', '/jam/settings', { session_id: this.sess.sid, guests_can_control: b.gc === true }, dl, 'settings');
      if (r.status === 404 && r.upstream != null) { this.read('settings', { quiet: false }); throw fail(404, 'jam_not_found', MSG.notFound); }
      if (r.status !== 200) throw this.mapErr(r, 'settings');
      this.fromReply(r, 'settings');
      return { jam: this.body() };
    });
  }

  // Remove (§5.7; C0's kick, only ever on the user's tap): POST v3/sessions/<sid>/member/<the member's Spotify id>/kick.
  // Never retried. The kick answers the session without the member, applied as a read (ev out: the app's echo).
  remove(b = {}) {
    return this.act('remove', async (dl) => {
      if (this.fake) return this.fakeRemove(b);
      if (!this.on) throw fail(409, 'not_in_jam', MSG.notInJam);
      if (this.role() !== 'host') throw fail(409, 'not_host', MSG.notHost);
      if (!this.caps().kick) throw fail(409, 'unsupported', MSG.unsupported);
      const s = this.sess;
      const mine = this.myMemberId(s) || this.me();
      const m = typeof b.id === 'string' && s.members.find((x) => x.id === b.id && x.id !== mine);
      if (!m) throw fail(404, 'not_found', MSG.gone);
      if (!m.sp || !/^[A-Za-z0-9_-]{1,128}$/.test(m.sp)) {
        log.warn('jam: Remove: that member has no Spotify id in the session: not sent');
        throw fail(409, 'unsupported', MSG.noKick);
      }
      const r = await this.jcall('POST', '/jam/remove', { session_id: s.sid, member_id: m.sp }, dl, 'remove');
      if (r.status === 404 && r.upstream != null) {
        this.read('remove', { quiet: false });                             // gone already, or the session: one read
        throw fail(404, 'not_found', MSG.gone);
      }
      if (r.status !== 200) throw this.mapErr(r, 'remove');
      this.fromReply(r, 'remove');
      return { jam: this.body() };
    });
  }

  // a write's reply: its session when it has one (applied like a read; an inactive one is no session), else one read
  fromReply(r, why) {
    const s = this.sessionOf(r);
    if (!s) { this.read(why, { quiet: false }); return; }
    if (s.active === false) { this.noSession(); return; }
    s.role = this.sess ? this.sess.role : s.role;
    this.useSession(s, { src: why });
  }

  // Add to Jam (POST /v1/player/queue while on). The player replies as for any add.
  async add(uri) {
    this.lively();                                                         // a host's local add isn't an act()
    if (this.fake) {
      if (!this.fake.x.add) throw fail(409, 'unsupported', MSG.addUnsupported);
      return;
    }
    const r = this.role();
    if (r === 'guest') {
      if (!this.canSocial() || !this.hasRoute('queue') || !this.sess.sid) throw fail(409, 'unsupported', MSG.addUnsupported);
      await this.jamQueue(uri);
    } else {
      const how = this.flags.hostAdd;
      if (how === 'off' || !this.hostAddOk()) throw fail(409, 'unsupported', MSG.addUnsupported);
      if (how === 'command') {
        if (!this.sess || !this.sess.sid) throw fail(409, 'unsupported', MSG.addUnsupported);
        await this.jamQueue(uri);
      } else if (how === 'webapi') {
        const dev = this.deviceId || (this.engine.status && this.engine.status.device_id) || '';
        await this.webapi.api('POST', `/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${encodeURIComponent(dev)}`, undefined, { prio: 'player' });
      } else {
        if (!this.player.loaded()) throw fail(409, 'not_active', 'Nothing is playing on Encore.');
        await this.engine.call('/player/add_to_queue', { uri });
      }
    }
    this.ownAdds.delete(uri);
    this.ownAdds.set(uri, this.now());
    if (this.ownAdds.size > 50) this.ownAdds.delete(this.ownAdds.keys().next().value);
  }

  jamQueue(uri) {
    return this.act('queue', async (dl) => {
      const r = await this.jcall('POST', '/jam/queue', { session_id: this.sess.sid, uri }, dl, 'queue');
      if (r.status === 404 && r.upstream != null) { this.read('queue', { quiet: false }); throw fail(404, 'jam_not_found', MSG.notFound); }
      if (r.status !== 200) throw this.mapErr(r, 'queue');
    });
  }

  // §4.4: a guest's transport while it may not control the Jam. -> 'noop' (pause) | null; throws for the others
  guard(cmd) {
    if (!this.on || this.role() !== 'guest' || this.ctl()) return null;
    if (cmd === 'pause') return 'noop';
    const hn = this.hostName();
    if (cmd === 'play') throw fail(409, 'in_jam', `Leave ${hn}’s Jam to play something else.`);
    if (NO_CONTROL.has(cmd)) throw fail(403, 'jam_no_control', `Only ${hn} can control the Jam’s playback. You can still add songs.`);
    return null;
  }

  // ------------------------------------------------------------------ Up Next and who added what (§4.3, §5.5)
  // GET /v1/player/queue: engine-local (its window prefetch describes the rows).
  async queue() {
    const r = await this.engine.get('/player/queue', { timeoutMs: this.T.queueTimeout });
    if (r.status === 404) throw fail(404, 'not_found', 'Up Next needs the updated Encore player.');
    const q = r.status === 200 && r.json && typeof r.json === 'object' ? r.json : null;
    if (q) this.fetched(q);
    return makeMemo(this.serveQueue(q));
  }

  async refetchQueue(again = true) {
    let r;
    try { r = await this.engine.get('/player/queue', { timeoutMs: this.T.queueTimeout }); } catch (e) { return; }
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') return;
    const missing = this.fetched(r.json);
    if (missing && again) setTimeout(() => { if (this.on) this.refetchQueue(false); }, this.T.queueRetry).unref();
  }

  // Every engine /player/queue answer: the trace's diff, then (while on) attribution and the edit_lost check.
  // -> whether some row had no metadata yet (while on)
  fetched(q) {
    this.traceQueue(q);
    if (!this.on) return false;
    const missing = this.takeQueue(q);
    this.checkEdits(q);
    return missing;
  }

  // The trace's `queue` entry (while on, or within 15 s of a command): rows per section, and against the previous
  // fetch how many rows are new, gone and moved (uids compared, none logged; moved = the fewest rows that moved). Only
  // when the rows changed, so the ring keeps the commands around them.
  traceQueue(q) {
    if (!(this.on || this.now() - this.lastCmdAt < 15000)) { this.qprev = null; return; }
    const next = (Array.isArray(q.next) ? q.next : []).slice(0, 32).filter((e) => e && typeof e.uri === 'string');
    const ids = next.map((e) => (typeof e.uid === 'string' && e.uid) || e.uri);
    const prev = this.qprev;
    this.qprev = ids;
    if (prev && prev.length === ids.length && prev.every((x, i) => x === ids[i])) return;
    const n = { q: 0, cq: 0, ap: 0 };
    for (const e of next) n[part(e)]++;
    const was = new Map((prev || []).map((x, i) => [x, i]));
    const now = new Set(ids);
    const common = ids.filter((x) => was.has(x));
    this.addTrace({ k: 'queue', q: n.q, cq: n.cq, ap: n.ap, new: ids.length - common.length, gone: (prev || []).filter((x) => !now.has(x)).length,
      moved: common.length - lis(common.map((x) => was.get(x))) });
  }

  // Attribute every entry; -> whether some row had no metadata yet. noRead: a push's apply (pushes never read).
  takeQueue(q, { noRead = false } = {}) {
    this.lastQueue = q;
    const next = Array.isArray(q.next) ? q.next.slice(0, 32) : [];
    const by = new Map();
    const unknown = new Set();
    let missing = false;
    for (const e of [q.current, ...next]) {
      if (!e || typeof e.uri !== 'string') continue;
      if (!e.track) missing = true;
      const a = this.attribute(e);
      if (a.by && e.uid) by.set(e.uid, a.by);
      if (a.unknown) unknown.add(a.unknown);
    }
    this.byUid = by;
    const c = q.current && typeof q.current.uri === 'string' ? { uri: q.current.uri, by: (q.current.uid && by.get(q.current.uid)) || this.attribute(q.current).by } : null;
    const was = this.cur ? this.cur.uri + '|' + this.cur.by : '';
    this.cur = c;
    if ((c ? c.uri + '|' + c.by : '') !== was) this.changed();
    // one read per unknown value and Jam (≥ 60 s apart): an ex-member's add, or ids that never match, read nothing more
    if (!noRead && [...unknown].some((v) => !this.unknownTried.has(v)) && this.canSocial() && this.now() - this.lastUnknownBy >= this.T.unknownByGap) {
      this.lastUnknownBy = this.now();
      for (const v of unknown) if (this.unknownTried.size < 64) this.unknownTried.add(v);
      this.read('unknown_by');
    }
    return missing;
  }

  // -> { by?: member id, unknown?: a spotify:user: value that matches no member }. A value matches a member's username
  // or Spotify id (C0's 32 hex), exactly or as spotify:user:<it>; by is that member's MEM id.
  attribute(e) {
    const md = e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
    const s = this.seen();
    const ids = new Map();
    for (const m of s ? s.members : []) { ids.set(m.id, m.id); if (m.sp && !ids.has(m.sp)) ids.set(m.sp, m.id); }
    let keys = Object.keys(md);
    if (this.byKey && keys.includes(this.byKey)) keys = [this.byKey, ...keys.filter((k) => k !== this.byKey)];
    let unknown;
    for (const k of keys) {
      const v = md[k];
      if (typeof v !== 'string' || !v) continue;
      const user = v.startsWith('spotify:user:') ? v.slice(13) : '';
      const id = ids.get(v) || (user && ids.get(user)) || '';
      if (id) {
        if (!this.byKey) { this.byKey = k; this.save(); log.info(`jam: "added by" is the queue metadata key "${k}"`); }
        return { by: id };
      }
      if (user && !unknown) unknown = v;
    }
    const at = this.ownAdds.get(e.uri);
    if (at != null && this.now() - at < 1800000) return { by: this.myId(), unknown };
    return { unknown };
  }

  myId() { return (this.sess && this.myMemberId(this.sess)) || this.me() || undefined; }

  // The QUEUE a phone gets, remembered (uid -> section and uri) for the edit checks against what it showed.
  serveQueue(q) {
    const o = this.queueBody(q);
    const rows = new Map();
    for (const [k, list] of [['q', o.q], ['cq', o.cq], ['ap', o.ap]]) for (const r of list) if (r.uid && !rows.has(r.uid)) rows.set(r.uid, { part: k, u: r.u });
    this.lastQ = { rows, now: o.now && o.now.uid ? o.now.uid : '' };
    return o;
  }

  queueBody(q) {
    const o = {};
    if (!q) return { q: [], cq: [], ap: [] };
    const qr = (e) => {
      if (!e.track) { const r = { u: e.uri }; if (e.uid) r.uid = e.uid; r.x = 1; return r; }
      const r = row(e.uri, e.track);
      if (e.uid) r.uid = e.uid;
      const by = this.on ? (e.uid && this.byUid.get(e.uid)) || this.attribute(e).by : undefined;
      if (by) r.by = by;
      return r;
    };
    if (q.current && typeof q.current.uri === 'string') o.now = qr(q.current);
    const s = { q: [], cq: [], ap: [] };
    let x = false;
    for (const e of (Array.isArray(q.next) ? q.next : []).slice(0, 32)) {
      if (!e || typeof e.uri !== 'string') continue;
      const r = qr(e);
      if (r.x) x = true;
      s[part(e)].push(r);
    }
    o.q = s.q;
    o.cq = s.cq;
    o.ap = s.ap;
    const ctx = {};
    const hn = this.fake ? this.fakeBody().hn : this.on ? this.hostName('') : '';
    if (this.shown() && hn) ctx.n = `${hn}’s Jam`;
    else if (typeof q.context_name === 'string' && q.context_name) ctx.n = q.context_name;
    if (typeof q.context_uri === 'string' && q.context_uri) ctx.u = q.context_uri;
    if (ctx.n || ctx.u) o.ctx = ctx;
    if (this.shown()) o.jam = 1;
    if (x) o.retry_ms = this.T.queueRetry;
    if (typeof q.rev === 'string' && q.rev) o.rev = q.rev;              // the engine's queue revision (item 11)
    if (this.editable()) o.ed = 1;
    return o;
  }

  // ------------------------------------------------------------------ Up Next edits (§4.4, §5.7; 4b-c)
  // ed: this phone may remove and move q/cq rows now. The engine edits its own list (patch 3 item 11, the commit of a
  // controller's set_queue; no Spotify request of its own). In a Jam only while hosting it (hosting(): the host, also
  // one whose reads are refused now, and plan B's lim with no session at all, the Jam the user started in Spotify with
  // Encore playing it, as Add to Jam and the transport already treat it) and with the flag jamEdit. Never as a guest,
  // a refused one included (lim, its role kept): a guest's local list isn't the Jam's, the host's device plays it.
  editable() {
    if (!this.engineEdits) return false;
    if (this.fake) return this.fake.role === 'host' && !!this.flags.jamEdit;
    if (!this.on) return true;
    return this.hosting() && !!this.flags.jamEdit;
  }

  // POST /v1/jam/queue/remove {uid, rev} and /v1/jam/queue/move {uid, before, rev} -> {queue: QUEUE}. Rows by uid,
  // never by uri; rev is the one of the QUEUE the phone shows, so a stale edit is refused, never applied.
  async queueEdit(op, b) {
    b = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    const long = (v) => Buffer.byteLength(v) > 128;
    if (typeof b.uid !== 'string' || !b.uid || long(b.uid) || typeof b.rev !== 'string' || !b.rev || long(b.rev) ||
      (op === 'move' && (typeof b.before !== 'string' || long(b.before)))) throw fail(400, 'bad_request', MSG.badEdit);
    if (!this.engineEdits) throw fail(503, 'jam_unavailable', MSG.noRoute);
    if (this.fake || this.on) {
      if (!(this.fake ? this.fake.role === 'host' : this.hosting())) throw fail(409, 'not_host', MSG.editHost);
      if (!this.flags.jamEdit) throw fail(409, 'unsupported', MSG.editOff);
    }
    // against the last QUEUE (the engine's 400 is the backstop)
    const L = this.lastQ;
    const at = (uid) => (!L ? '' : L.rows.has(uid) ? L.rows.get(uid).part : L.now === uid ? 'now' : '');
    const p = at(b.uid);
    if (p === 'ap') throw fail(409, 'not_editable', MSG.autoplay);
    if (p === 'now') throw fail(409, 'not_editable', MSG.notEditable);
    if (op === 'move' && b.before) {
      if (b.before === b.uid) throw fail(409, 'not_editable', MSG.notEditable);
      const o = at(b.before);
      if (p && o && o !== p) throw fail(409, 'not_editable', MSG.section);
    }
    if (p === 'cq' && this.player && this.player.st && this.player.st.shuffle) throw fail(409, 'not_editable', MSG.shuffled);
    const uri = L && L.rows.has(b.uid) ? L.rows.get(b.uid).u : '';
    const job = this.qlock.then(() => this.runEdit(op, b, p || '?', uri));
    this.qlock = job.catch(() => {});
    return job;
  }

  // one edit: the engine route as received, then the fresh QUEUE. No Spotify call, no generation, no track load.
  async runEdit(op, b, p, uri) {
    const t0 = Date.now();
    const body = op === 'move' ? { rev: b.rev, uid: b.uid, before: b.before } : { rev: b.rev, uid: b.uid };
    let r;
    try { r = await this.engine.send('POST', '/player/queue/' + op, body, { timeoutMs: this.T.queueEditTimeout }); }
    catch (e) { this.editDone(op, p, 'error', t0); throw fail(502, 'engine_error', MSG.editLost); }
    this.editDone(op, p, r.status, t0);
    if (r.status === 409) throw fail(409, 'queue_changed', MSG.queueChanged);       // a stale rev, the row gone, a transfer first
    if (r.status === 400) throw fail(409, 'not_editable', MSG.notEditable);
    if (r.status === 204) throw fail(409, 'not_active', MSG.notActive);
    if (r.status === 404) throw fail(503, 'jam_unavailable', MSG.noRoute);
    if (r.status !== 200) throw fail(502, 'engine_error', MSG.editLost);             // it may have happened: the app reloads
    this.counts.edits++;
    this.lively();                                                         // a user action: the lease poll's taper starts over
    // the fresh QUEUE (engine-local), attributed as usual; the engine's `queue` event that follows reaches other phones
    let q = null;
    try {
      const g = await this.engine.get('/player/queue', { timeoutMs: this.T.queueTimeout });
      if (g.status === 200 && g.json && typeof g.json === 'object') q = g.json;
    } catch (e) { q = null; }
    if (!q) throw fail(502, 'engine_error', MSG.editLost);
    this.fetched(q);
    const out = this.serveQueue(q);
    this.rememberEdit(op, b, uri, out);
    return { queue: out };
  }

  editDone(op, p, status, t0) {
    const ms = Date.now() - t0;
    this.addTrace({ k: 'edit', op, section: p, status, ms });
    log.info(`jam: queue edit ${op} ${p} -> ${status} in ${ms} ms`);
  }

  // While a real Jam is on, Encore's own edit is remembered for the edit_lost check, from the fresh QUEUE (its q and cq
  // rows, by uri: Spotify's copy of the Jam brings new uids):
  //  - a removal: the removed row's uri and how many rows of that uri are still upcoming (another copy of the song);
  //  - a move: the moved row's uri and those of the rows right before and after it in its own section ('' at an end;
  //    never the neighbouring section's first or last row).
  rememberEdit(op, b, uri, out) {
    if (!this.on) return;
    const now = this.now();
    let e = null;
    if (op === 'remove' && uri) e = { op, u: uri, n: [...out.q, ...out.cq].filter((r) => r.u === uri).length, at: now, lost: false };
    else if (op === 'move') {
      for (const list of [out.q, out.cq]) {
        const i = list.findIndex((r) => r.uid === b.uid);
        if (i < 0) continue;
        const u = list[i].u;
        const prev = i > 0 && list[i - 1].u !== u ? list[i - 1].u : '';
        const next = i + 1 < list.length && list[i + 1].u !== u ? list[i + 1].u : '';
        if (prev || next) e = { op, u, prev, next, at: now, lost: false };
        break;
      }
    }
    if (!e) return;
    this.edits.push(e);
    while (this.edits.length > this.T.editMemoMax) this.edits.shift();
  }

  // edit_lost (§5.7 step 5): on a fetch after a command from another device (a transfer from social-connect-*, a
  // controller's set_queue, …), an edit of Encore's that the list no longer shows counts once. Only the q and cq rows
  // count (an autoplay row is a suggestion, not the Jam's list), and rows new since the edit never do:
  //  - a removal: more rows of the removed uri upcoming than right after the edit (another copy of the song that was
  //    already there isn't a loss). A guest adding the song again counts too; our own add of it doesn't.
  //  - a move: the moved row is no longer after its old previous row and before its old next row (an order inversion
  //    among the three; a guest's row landing between them is no loss). A neighbour that is gone isn't judged, and
  //    neither is the move once the moved row itself is.
  checkEdits(q) {
    if (!this.edits.length) return;
    const now = this.now();
    this.edits = this.edits.filter((e) => now - e.at < this.T.editMemoMs);
    const ups = (Array.isArray(q.next) ? q.next : []).slice(0, 32).filter((e) => e && typeof e.uri === 'string' && part(e) !== 'ap').map((e) => e.uri);
    const at = (u) => ups.reduce((a, x, i) => (x === u ? a.concat(i) : a), []);
    for (const e of this.edits) {
      if (e.lost || !(this.lastCmdAt > e.at)) continue;
      let lost;
      if (e.op === 'remove') {
        const own = this.ownAdds.get(e.u);
        lost = at(e.u).length > e.n + (own != null && own > e.at ? 1 : 0);
      } else {
        const mine = at(e.u);
        const p = e.prev ? at(e.prev) : [];
        const x = e.next ? at(e.next) : [];
        if (!mine.length || (!p.length && !x.length)) continue;
        // held while some copy of the moved row stands after a copy of the previous row and before one of the next
        lost = !mine.some((k) => (!p.length || p[0] < k) && (!x.length || x[x.length - 1] > k));
      }
      if (!lost) continue;
      e.lost = true;
      this.counts.lost++;
      this.addTrace({ k: 'edit_lost', op: e.op });
      log.info(`jam: Spotify's copy of the Jam undid an Up Next ${e.op} of Encore's (edit_lost)`);
    }
  }

  // ------------------------------------------------------------------ idle safety (§5.6 rule 7)
  // Nobody listens (no stream open) while the engine plays a Jam. Nothing here ever ends a Jam.
  idleTick() {
    const now = this.now();
    if (!this.on || !this.player || this.player.st.status !== 'playing' || !this.encoders || this.encoders.listening() > 0) { this.idle = null; return; }
    if (!this.idle) { this.idle = { since: now, next: 0, done: false, busy: false }; return; }
    const I = this.idle;
    if (I.done || I.busy) return;
    const quiet = now - I.since;
    const guest = this.role() === 'guest';
    const mins = Math.round(quiet / 60000);
    if (quiet >= this.T.idleCapMs) {
      I.done = true;
      log.info(`jam: nobody listening for ${mins} min in a Jam: ${guest ? 'leaving it' : 'pausing'} (the cap)`);
      if (guest) this.autoLeave('idle'); else this.idlePause();
      return;
    }
    if (guest) {
      if (quiet >= this.T.idleGuestMs) {
        I.done = true;
        log.info(`jam: nobody listening for ${mins} min in a Jam as a guest: leaving it`);
        this.autoLeave('idle');
      }
      return;
    }
    if (quiet < this.T.idleHostMs || now < I.next) return;
    I.next = now + this.T.idleRecheckMs;
    if (!(this.sess && this.sess.sid && this.canSocial())) {
      log.info(`jam: nobody listening for ${mins} min in a Jam; no session to check: carrying on`);
      return;
    }
    I.busy = true;
    this.read('idle').then((res) => {
      I.busy = false;
      if (this.idle !== I || !this.on) return;
      const s = res && res.ok ? res.s : null;
      const mine = s ? this.myMemberId(s) : '';
      // (ids that aren't usernames: one of them is us all the same, `current` being our own session)
      const others = s ? Math.max(0, s.members.filter((m) => m.id !== mine).length - (this.meIn(s) === false ? 1 : 0)) : -1;
      if (others === 0) {
        I.done = true;
        log.info(`jam: nobody listening for ${mins} min and nobody else in the Jam: pausing`);
        this.idlePause('alone');
      } else log.info(`jam: nobody listening for ${mins} min in a Jam${others > 0 ? ' with ' + others + ' others' : ''}: carrying on`);
    });
  }

  idlePause(why) {
    this.player.pause({}).catch((e) => log.warn('jam: idle pause:', e.message));
    if (why === 'alone') this.bus.push('notice', { code: 'jam_idle', message: 'Nobody was listening to your Jam on Encore, so it’s paused.' });
  }

  // ------------------------------------------------------------------ dealer pushes, trace, counters
  // A social_connect event (patch 3 item 4): counted and recorded (masked URI, size, top-level key names with any id
  // masked). social-connect/v2/session_update (C0's push) is parsed and, when it is this Jam's, applied like a read
  // (§5.4): never a read of its own, never sc. Others (broadcast_status_update, …) are only counted and recorded.
  onDealer(d) {
    this.dealer.n++;
    const uri = mask(d.uri);
    let u = this.dealer.uris.get(uri);
    if (!u && this.dealer.uris.size < 20) { u = { n: 0, keys: '' }; this.dealer.uris.set(uri, u); }
    const p = d.payload;
    const keys = p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p).slice(0, 20).map(maskKey).join(',') : '';
    if (u) { u.n++; if (keys) u.keys = keys; }
    const size = p !== undefined ? JSON.stringify(p).length : Number(d.payload_bytes) || 0;
    const bare = uri.replace(/^hm:\/\//, '');
    const obj = p && typeof p === 'object' && !Array.isArray(p);
    const update = bare === SESSION_UPDATE && obj && p.session && typeof p.session === 'object' && !Array.isArray(p.session);
    const plan = update ? this.pushPlan(p) : null;
    // a device's Jam broadcast (C0: keyed by a masked key, maybe the device id): the inner object found by its shape,
    // Encore's preferred when the push names several; only the enum and whose it is are kept
    let bc;
    let bcDev;
    if (bare === BROADCAST_UPDATE && obj) {
      const shaped = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.broadcast_status === 'string';
      const all = shaped(p) ? [p] : Object.values(p).filter(shaped);
      const o = all.find((v) => !!this.deviceId && v.device_id === this.deviceId) || all[0];
      if (o) {
        const st = ENUM.test(o.broadcast_status) ? o.broadcast_status : '';
        bc = st || 'OTHER';
        bcDev = typeof o.device_id !== 'string' || !o.device_id ? 'absent' : !this.deviceId ? 'unknown' : o.device_id === this.deviceId ? 'encore' : 'other';
        if (bcDev === 'encore') this.noteBroadcast(st, 'push');
      }
    }
    // Spotify's standby: a NEW_SESSION hosted on Encore during or right after our own End, or right after a
    // SESSION_DELETED (seen live 2026-10-07). Recorded only: never held for the next latch, which would show it as that
    // Jam's session. Not while our own Start is sending: that one is the Start's (held as any new Jam's first push).
    const standby = !!(plan && plan.s && plan.encore && plan.reason === 'NEW_SESSION' && !plan.apply && !this.starting &&
      (!!this.endingSid || this.now() - Math.max(this.lastDeletedAt, this.ownEndAt) < this.T.standbyMs));
    const ps = plan && plan.s;
    this.addTrace({ k: 'social_connect', uri, size, keys: keys || undefined, reason: plan ? plan.reason || undefined : undefined,
      applied: plan ? (plan.apply ? 1 : 0) : undefined, bc, bc_dev: bcDev,
      host: ps ? this.hostDevKind(ps) : undefined, n: ps ? ps.members.length : undefined, active: ps ? (ps.active === false ? 0 : 1) : undefined,
      standby: standby ? 1 : undefined });
    if (!plan) return;
    this.dealer.updates++;
    if (standby) log.info('jam: a NEW_SESSION hosted on Encore right after an end: Spotify\'s standby session, recorded only');
    if (plan.apply) this.applyPush(plan);
    // a new Jam's first push for Encore may beat the engine's own commands: kept for a moment (latchSet). Only a
    // NEW_SESSION, and never the Jam that just went off or Spotify's standby: any other push of a session not shown yet
    // is an older Jam's (a trailing pause change, the one jam.json had), and would stand in for the new Jam's session
    else if (plan.s && plan.encore && plan.s.active !== false && plan.reason === 'NEW_SESSION' && !plan.ended && !standby) this.heldPush = { ...plan, at: this.now() };
    // a held push whose session Spotify deleted is no new Jam's any more
    else if (plan.deleted && plan.s && this.heldPush && this.heldPush.s && this.heldPush.s.sid === plan.s.sid) this.heldPush = null;
  }

  // A session_update: whose is it? Applied when it is the known session's (or, with no session id known, the one our
  // Join named by its token, or one hosted on Encore while the engine shows a Jam or our Start/Join is pending, or the
  // one jam.json had: while the engine shows a Jam, or while sc is 1 so that a read confirms the away it makes). Never
  // the session that just went off (endedPushMs) as a new one. Any other is the account's Jam on another device, or an
  // older Jam's: recorded only.
  pushPlan(p) {
    const reason = typeof p.reason === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(p.reason) ? p.reason : p.reason == null ? '' : 'OTHER';
    if (reason && !REASONS.has(reason) && !this.reasons.has(reason) && this.reasons.size < 20) {
      this.reasons.add(reason);
      log.info(`jam: a session_update with a reason not seen in C0: ${reason} (applied like the others)`);
    }
    if (reason === 'SESSION_DELETED') this.lastDeletedAt = this.now();
    const s = parseSession(p.session, this.me());
    if (!s) return { reason, apply: false };
    const encore = !!(s.hostDev && this.deviceId && s.hostDev.id === this.deviceId);
    const k = this.sess;
    if (reason === 'SESSION_DELETED') {
      // the shown session deleted: over, unless the engine still shows the Jam (then its own end signals decide: item
      // 10, set_options off), and never during our own End of it (end() turns it off itself). Any other: recorded only.
      const mine = !!(k && k.sid && s.sid === k.sid) && s.sid !== this.endingSid;
      // ... and while the engine shows only the Jam Encore switched itself into (no social-connect origin, no jam-list):
      // Spotify sends no end signal for that one (DESIGN-JAM-SELF G5)
      const selfOnly = !!this.selfJam && !this.latch.social && !isJamList(this.latch.ctx);
      return { reason, s, apply: mine && (!this.latch.set || selfOnly), deleted: true, encore, ended: false, upd: p.update_session_members };
    }
    let apply;
    let ended = false;
    if (k && k.sid) apply = s.sid === k.sid;
    else if (k && k.token && s.token === k.token) apply = true;
    else if ((ended = !!(this.endedSid && this.endedSid.sid === s.sid && this.now() - this.endedSid.at < this.T.endedPushMs))) apply = false;
    else {
      // the jam.json session after a restart: shown while the engine plays a Jam; else only as `away`, which a read
      // must be able to confirm or clear (no push marks a Jam's end, C0), so not before L0
      const hinted = !!(this.hint && this.hint.sid === s.sid) && (this.on || this.scNow() === 1);
      apply = (encore && (this.latch.set || this.owning() || !!this.confirming)) || hinted;
    }
    return { reason, s, apply, encore, ended, upd: p.update_session_members };
  }

  applyPush(plan) {
    const s = plan.s;
    this.lastPushAt = this.now();
    this.dealer.applied++;
    if (plan.deleted) {
      log.info('jam: Spotify deleted the shown session (push): no session');
      this.noSession();
      return;
    }
    this.lastPushSid = s.sid;
    if (s.active === false) {
      log.info('jam: a pushed session says it is no longer active: no session');
      this.noSession();
      return;
    }
    this.pushFed = s.sid;
    // update_session_members counts only for a USER_KICKED that names this account; the session carries the members
    const kickedMe = plan.reason === 'USER_KICKED' && this.namesMe(plan.upd);
    this.useSession(s, { src: 'push', kickedMe });
  }

  // a members list (update_session_members) naming this account
  namesMe(list) {
    if (!Array.isArray(list)) return false;
    const ids = this.myIds();
    return list.some((x) => x && typeof x === 'object' && (x.is_current_user === true || ids.has(x.username) || ids.has(x.id)));
  }

  tracing() { const now = this.now(); return this.on || now - this.offAt < 60000 || now - this.lastCmdAt < 15000; }

  addTrace(e) {
    const ent = { t: this.now(), ...e };
    for (const k of Object.keys(ent)) if (ent[k] === undefined) delete ent[k];
    this.ring.push(ent);
    if (this.ring.length > 200) this.ring.shift();
    log.info('jam trace:', Object.entries(ent).filter(([k]) => k !== 't').map(([k, v]) => `${k}=${v}`).join(' '));
  }

  onGen(g) {
    if (!this.tracing()) return;
    const i = this.player.genInfo && this.player.genInfo.get(g);
    this.addTrace({ k: 'gen', gen: g, reason: i ? i.reason : undefined, how: i ? i.how : undefined });
  }

  // a song change the player saw: {natural, foreign, cut}
  onTrack(t) {
    const now = this.now();
    if (t.natural) this.counts.natural++;
    else {
      this.counts.cmd++;
      if (t.foreign) this.counts.foreign.push(now);
    }
    while (this.counts.foreign.length && now - this.counts.foreign[0] > 600000) this.counts.foreign.shift();
    if (this.tracing()) this.addTrace({ k: 'metadata', how: t.natural ? 'natural' : t.foreign ? 'foreign' : t.cut ? 'cut' : 'own' });
  }

  resetTrace() {
    this.ring = [];
    this.counts = { cmd: 0, natural: 0, foreign: [], redirects: { gets: 0 }, edits: 0, lost: 0 };
    this.reads = {};
    log.info('jam: trace and counters reset');
    return { ok: true };
  }

  traceDump() { return { trace: this.ring, info: this.info() }; }

  // admin (§5.9): counts and states only, no token, link, session id or member id
  info() {
    const g = this.gate || {};
    const sc = this.scNow();
    return {
      on: this.on, role: this.role() || null, lim: this.lim(), away: this.away, wait: this.wait, sc: sc == null ? null : sc,
      latch: { set: this.latch.set, ended: !!this.latch.endedCtx, mode: this.latch.mode, social: this.latch.social, ctx: ctxType(this.latch.ctx) },
      members: this.seen() ? this.sess.members.length : 0, by_key: !!this.byKey,
      engine: { patch3: !!this.routes, routes: this.routes ? [...this.routes].sort() : [], sends: g.sends || 0, sends5m: g.sends5m || 0,
        renewals: g.renewals || 0, held_until: g.held_until || 0 },
      calls5m: this.calls5m(), hold_s: Math.max(0, Math.ceil((this.holdUntil - this.now()) / 1000)), reads: { ...this.reads },
      lease_poll_s: this.leaseUntil > this.now() ? this.pollGap(this.now()) / 1000 : 0,          // the lease poll's gap now
      dealer: { n: this.dealer.n, updates: this.dealer.updates, applied: this.dealer.applied, push_fed: !!(this.pushFed && this.sess && this.sess.sid === this.pushFed),
        uris: [...this.dealer.uris].map(([uri, u]) => ({ uri, n: u.n, keys: u.keys })) },
      // 4b-c: the session as C0 named it (kinds and key names only), and Up Next edits since the last trace reset
      session: { host_dev: this.seen() ? this.hostDevKind(this.sess) : null, caps: this.seen() ? { ...this.sess.caps } : null, owner_match: names.owner || null,
        share: names.share || null, keys: { caps: names.caps || null, remove: names.remove || null, control: names.control || null, limit: names.limit || null } },
      queue_edit: this.engineEdits, edits: { n: this.counts.edits, lost: this.counts.lost },
      last_error: this.lastErr ? this.lastErr.code : null, foreign_loads_10m: this.counts.foreign.length,
      loads: { commands: this.counts.cmd, natural: this.counts.natural }, redirect_gets: this.counts.redirects.gets || 0,
      flags: { ...this.flags }, fake: this.fake ? { role: this.fake.role, members: this.fake.members.length } : null, trace: this.ring.length,
      // DESIGN-JAM-WAIT: Encore's Jam broadcast as Spotify last said it (the enum only)
      broadcast: this.bc ? { encore: this.bc.status, src: this.bc.src, age_s: sec(Math.max(0, this.now() - this.bc.at)) } : null,
      // DESIGN-JAM-SELF: the Jam on now is one Encore switched itself into (how long ago)
      self: this.selfJam ? { age_s: sec(Math.max(0, this.now() - this.selfJam.at)) } : null,
    };
  }

  // /v1/status `jam`
  statusInfo() {
    const g = this.gate || {};
    const o = {};
    const sc = this.scNow();
    if (sc === 1 || sc === 0) o.sc = sc;
    o.calls = g.sends || 0;
    o.calls5m = g.sends5m || 0;
    o.renewals = g.renewals || 0;
    o.dealer = this.dealer.n;
    if (this.byKey) o.by_key = 1;
    return o;
  }

  // POST /admin/api/jam/check: L0's single read (§2.2) -> its verdict
  async check() {
    if (!this.hasRoute('current')) return { verdict: 'inconclusive', reason: 'the engine has no Jam routes (patch 3 missing)' };
    if (this.flight) await this.flight;
    const res = await this.read('check', { quiet: false, check: true });
    const out = { on: this.on };
    if (!res) Object.assign(out, { verdict: 'inconclusive', reason: 'nothing was sent' });
    else if (res.ok) Object.assign(out, { verdict: 'accepted', reason: 'Spotify answered with a session Encore can read', members: res.s.members.length });
    else if (res.refused) Object.assign(out, { verdict: 'refused', reason: `Spotify refused (${res.upstream || res.status})`, status: res.status, upstream: res.upstream || undefined });
    else {
      const why = { shape: 'Spotify answered with a session shape Encore doesn\'t know (key names logged)', none: 'Spotify says there is no session, although a Jam should be on',
        inactive: 'Spotify answered with a session marked no longer active, although a Jam should be on',
        not_found: 'Spotify answered 404: the 2021–22 path may be retired', rate_limited: 'rate limited by Spotify',
        busy: 'held back by the engine\'s own pacing (nothing was sent)', engine_no_session: 'the engine has no Spotify session right now' }[res.error];
      Object.assign(out, { verdict: 'inconclusive', reason: why || `failed: ${res.error}`, status: res.status, upstream: res.upstream || undefined, keys: res.keys });
    }
    log.info(`jam: access check: ${out.verdict} (${out.reason})`);
    return out;
  }

  // POST /admin/api/jam/flags: in memory only (a restart returns to config.js)
  setFlags(b = {}) {
    if (b.hostAdd !== undefined) {
      if (!HOST_ADD.includes(b.hostAdd)) throw fail(400, 'bad_request', 'hostAdd must be one of ' + HOST_ADD.join(', '));
      this.flags.hostAdd = b.hostAdd;
    }
    if (b.guestTransport !== undefined) {
      if (typeof b.guestTransport !== 'boolean') throw fail(400, 'bad_request', 'guestTransport must be true or false');
      this.flags.guestTransport = b.guestTransport;
    }
    if (b.hostJump !== undefined) {
      if (!HOST_JUMP.includes(b.hostJump)) throw fail(400, 'bad_request', 'hostJump must be one of ' + HOST_JUMP.join(', '));
      this.flags.hostJump = b.hostJump;
    }
    if (b.jamEdit !== undefined) {
      // false: Up Next edits hidden while a Jam is on (ed absent), still on outside Jams (§5.9; L1 step 4c's fallback)
      if (typeof b.jamEdit !== 'boolean') throw fail(400, 'bad_request', 'jamEdit must be true or false');
      this.flags.jamEdit = b.jamEdit;
    }
    // DESIGN-JAM-WAIT: Start's broadcast-on step and End's broadcast off (the live test's decision table);
    // DESIGN-JAM-SELF: Encore switching itself into Jam mode after its own Start
    for (const k of ['selfJam', 'startBroadcast', 'endBroadcastOff']) {
      if (b[k] !== undefined && typeof b[k] !== 'boolean') throw fail(400, 'bad_request', `${k} must be true or false`);
    }
    if (b.selfJam !== undefined) this.flags.selfJam = b.selfJam;
    if (b.startBroadcast !== undefined) this.flags.startBroadcast = b.startBroadcast;
    if (b.endBroadcastOff !== undefined) this.flags.endBroadcastOff = b.endBroadcastOff;
    log.info(`jam: flags now hostAdd=${this.flags.hostAdd} guestTransport=${this.flags.guestTransport} hostJump=${this.flags.hostJump} jamEdit=${this.flags.jamEdit} ` +
      `selfJam=${this.flags.selfJam} startBroadcast=${this.flags.startBroadcast} endBroadcastOff=${this.flags.endBroadcastOff} (in memory)`);
    this.changed();
    return { flags: { ...this.flags } };
  }

  // ------------------------------------------------------------------ the admin's fake Jam (§5.9)
  // POST /admin/api/jam/fake {role: "host"|"guest"|null, members: 1..12, x?, wait?, away?}
  setFake(b = {}) {
    if (b.role == null) {
      if (this.fake) { clearTimeout(this.fake.timer); this.fake = null; log.info('jam: fake Jam off'); this.changed({ k: 'end' }); }
      return { fake: null };
    }
    if (b.role !== 'host' && b.role !== 'guest') throw fail(400, 'bad_request', 'role must be host, guest or null');
    const n = Math.max(1, Math.min(12, Math.round(Number(b.members) || 1)));
    const x = { sc: 1, gc: 1, kick: 1, add: 1 };
    if (b.x && typeof b.x === 'object') for (const [k, v] of Object.entries(b.x)) { if (['sc', 'gc', 'kick', 'add'].includes(k)) { if (v) x[k] = 1; else delete x[k]; } }
    if (this.fake) clearTimeout(this.fake.timer);
    this.fake = { role: b.role, members: this.fakeMembers(b.role, n), gc: false, x, wait: !!b.wait, away: !!b.away, since: sec(this.now()), next: n,
      timer: setTimeout(() => { this.fake = null; log.info('jam: fake Jam ended by itself (30 min)'); this.changed({ k: 'end' }); }, this.T.fakeMaxMs) };
    this.fake.timer.unref();
    this.fake.lastIn = this.now();
    log.info(`jam: fake Jam on (${b.role}, ${n} members)`);
    const f = this.fake;
    this.changed(f.role === 'host' ? { k: 'start' } : { k: 'join', n: f.members[0].n, id: f.members[0].id });
    return { fake: { role: f.role, members: n } };
  }

  fakeMembers(role, n) {
    // you: the signed-in account's name, or "You" (never a fixed name; the app's Anonymous Mode masks it anyway)
    const myName = this.webapi && this.webapi.user && typeof this.webapi.user.name === 'string' && this.webapi.user.name.trim();
    const me = { id: 'fake-me', n: myName || 'You', me: true };
    const others = [];
    for (let i = 0; others.length < n - 1; i++) others.push({ id: 'fake-' + i, n: FAKE_NAMES[i % FAKE_NAMES.length] });
    return role === 'host' ? [me, ...others] : others.length ? [others[0], me, ...others.slice(1)] : [{ id: 'fake-0', n: FAKE_NAMES[0] }, me];
  }

  fakeBody() {
    const f = this.fake;
    const hostId = f.members[0].id;
    const o = { on: 1, r: f.role };
    if (f.wait) o.wait = 1;
    if (f.away) o.away = 1;
    o.t = FAKE_TOKEN;
    o.l = jamlink.linkFor(FAKE_TOKEN);
    o.h = hostId;
    o.hn = f.members[0].n;
    o.m = f.members.map((m) => { const x = { id: m.id, n: m.n }; if (m.id === hostId) x.h = 1; if (m.me) x.me = 1; return x; });
    o.cnt = f.members.length;
    if (f.gc) o.gc = 1;
    if (f.role === 'host' || (f.gc && this.flags.guestTransport)) o.ctl = 1;
    o.since = f.since;
    o.x = { ...f.x };                                                       // never `code`: the fake has no Spotify Code
    o.fake = 1;
    return o;
  }

  // a lease is live: a synthetic join every 20 s
  fakeTick() {
    const f = this.fake;
    if (!f || this.now() - f.lastIn < this.T.fakeInMs - 1000) return;
    f.lastIn = this.now();
    if (f.members.length >= 12) f.members.splice(f.role === 'host' ? 1 : 2, 1);
    const m = { id: 'fake-' + f.next, n: FAKE_NAMES[f.next % FAKE_NAMES.length] };
    f.next++;
    f.members.push(m);
    this.changed(f.role === 'host' ? { k: 'in', n: m.n, id: m.id } : undefined);
  }

  fakeJoin(replace) {
    const f = this.fake;
    if (f.role === 'host' && !replace) throw fail(409, 'jam_active', MSG.active, { r: 'host' });
    f.role = 'guest';
    f.members = this.fakeMembers('guest', f.members.length);
    f.gc = false;
    this.changed({ k: 'join', n: f.members[0].n, id: f.members[0].id });
    return { jam: this.body() };
  }

  fakeLeave() {
    if (this.fake.role === 'host') throw fail(409, 'is_host', MSG.isHost);
    clearTimeout(this.fake.timer);
    this.fake = null;
    this.changed({ k: 'leave' });
    return { jam: this.body() };
  }

  fakeEnd() {
    if (this.fake.role !== 'host') throw fail(409, 'not_host', MSG.notHost);
    clearTimeout(this.fake.timer);
    this.fake = null;
    this.changed({ k: 'end' });
    return { jam: this.body(), state: this.player.snapshot() };
  }

  fakeSettings(b) {
    const f = this.fake;
    if (f.role !== 'host') throw fail(409, 'not_host', MSG.notHost);
    if (!f.x.gc) throw fail(409, 'unsupported', MSG.unsupported);
    f.gc = b.gc === true;
    this.changed();
    return { jam: this.body() };
  }

  fakeRemove(b) {
    const f = this.fake;
    if (f.role !== 'host') throw fail(409, 'not_host', MSG.notHost);
    if (!f.x.kick) throw fail(409, 'unsupported', MSG.unsupported);
    const i = f.members.findIndex((m) => m.id === b.id && !m.me);
    if (i < 0) throw fail(404, 'not_found', 'They aren’t in the Jam any more.');
    f.members.splice(i, 1);
    this.changed();
    return { jam: this.body() };
  }
}

module.exports = { Jam, parseSession, shape, names, TIMING, isJamList, mask, maskFrom, JAM_LIST };
