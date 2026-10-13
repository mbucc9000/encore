'use strict';
// Showcase (RELEASE-PLAN D4): one switch stored on the bridge, for when the computer's screen is on camera or in a
// screenshot. Set from the admin page (POST /admin/api/showcase) or the Windows tray (the loopback routes of
// gateway/windows/CONTRACT.md §5, served by http.js). It never switches the phones: each phone has its own Anonymous
// Mode, and masking for the phones happens in the app (D3).
//
// While it is on:
//  - the admin API trims its answers on the server, so even the raw JSON (a browser's developer tools) is clean: the
//    Spotify account's name and id, the paired phones' names, ids and last-seen times ("Phone 1", "Phone 2", ...),
//    another device's name (its kind instead: "your computer"), the Jam host's name and the member who added the
//    song, the route of the last 429, and every spotify:user:<id> uri (Liked Songs' context names the account);
//  - phone diagnostics (GET /admin/api/diag) are refused: a phone's log can name anything;
//  - the admin page hides the pairing code and the engine's sign-in code (press and hold to show), the Spotify connect
//    flow (Spotify's own page shows the account) and Unpair (it needs the hidden ids).
// Songs, albums, artists and covers stay: the music is the point of a demo. The bridge's log never carries names, in
// any mode (R1b).
//
// Stored in <DATA_DIR>/showcase.json ({"on": true|false}); missing or unreadable = off.
//
// Also here, as small helpers the phones' Anonymous Mode needs from the bridge (D2, D3):
//  - deviceType(): H1, the kind of another Spotify device (the Web API's device.type) as the player snapshot's
//    remote.type, so the app can say "your computer" instead of a bare "another device";
//  - coverFlags(): whether a playlist cover is one the user uploaded (`ugc`, hidden with "Hide My Playlist Names") or a
//    Blend's (`bl`, made of people's pictures).
const fs = require('fs');
const path = require('path');
const log = require('./log');
const { t } = require('./i18n');
const { urlFor } = require('./image');

const FILE = 'showcase.json';
const HIDDEN_USER = 'spotify:user:(hidden)';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// ------------------------------------------------------------------ H1: device kinds
// The Web API's device.type values (Computer, Smartphone, Tablet, Speaker, TV, AVR, STB, AudioDongle, GameConsole,
// CastVideo, CastAudio, Automobile), lower case without separators. Anything else (Unknown, a new kind) is left out:
// the app then says "another device".
const DEVICE_TYPES = new Set(['computer', 'smartphone', 'tablet', 'speaker', 'tv', 'avr', 'stb', 'audiodongle', 'gameconsole',
  'castvideo', 'castaudio', 'automobile']);
function deviceType(t) {
  if (typeof t !== 'string') return undefined;
  const s = t.toLowerCase().replace(/[^a-z]/g, '');
  return DEVICE_TYPES.has(s) ? s : undefined;
}

// The admin page's words for another device while Showcase is on (the same ones the app uses in Anonymous Mode),
// in the page's language (lang: i18n.js; English when none is given)
function kindText(kind, lang) {
  switch (kind) {
    case 'computer': return t(lang, 'your computer');
    case 'smartphone': return t(lang, 'your phone');
    case 'tablet': return t(lang, 'your tablet');
    case 'speaker': case 'avr': case 'audiodongle': case 'castaudio': return t(lang, 'a speaker');
    case 'tv': case 'stb': case 'castvideo': return t(lang, 'your TV');
    case 'automobile': return t(lang, 'your car');
    case 'gameconsole': return t(lang, 'a game console');
    default: return t(lang, 'another device');
  }
}
function deviceLabel(type, lang = 'en') { return kindText(deviceType(type), lang); }

// ------------------------------------------------------------------ playlist covers (D2)
// A Spotify image id is a 16-hex family/size prefix + a 24-hex file id. A cover someone uploaded to a playlist is in
// the ab67706c family (i.scdn.co/image/ab67706c0000da84..., 300 px wide with the uploaded aspect, as the engine's
// image_url names it; the Web API may name the same file on an image-cdn-*.spotifycdn.com host). Everything else is
// pictures of music: album art is ab67616d, mosaics come from mosaic.scdn.co and Spotify-made covers from its own hosts
// (pickasso, lexicon, wrapped, ...), except a Blend's cover, made from its members' pictures
// (blend-playlist-covers.spotifycdn.com). src: a cover URL, or the phone's image token for it (image.js).
// (Pending: a live check of the hosts on a real library, which needs the owner's OK; RELEASE-PLAN §3.5 R2b item 4.)
const UGC_FAMILY = 'ab67706c';
const BLEND_HOST = 'blend-playlist-covers.spotifycdn.com';
function coverFlags(src) {
  let url = typeof src === 'string' ? src.trim() : '';
  if (/^[0-9a-f]{40}$/i.test(url)) url = 'https://i.scdn.co/image/' + url.toLowerCase();
  else if (/^u[A-Za-z0-9_-]{8,599}$/.test(url)) url = urlFor(url) || '';
  let u;
  try { u = new URL(url); } catch (e) { return {}; }
  if (u.protocol !== 'https:') return {};
  const host = u.hostname.toLowerCase();
  if (host === BLEND_HOST) return { bl: 1 };
  if (host === 'i.scdn.co' || /^image-cdn-[a-z0-9-]+\.spotifycdn\.com$/.test(host)) {
    const m = u.pathname.match(/^\/image\/([0-9a-f]{40})$/i);
    if (m && m[1].toLowerCase().startsWith(UGC_FAMILY)) return { ugc: 1 };
  }
  return {};
}

// ------------------------------------------------------------------ trimming (only while Showcase is on)
// A copy of plain JSON data with every spotify:user:<id> uri masked (the Liked Songs context, a profile, a user's
// collection). Depth-limited; anything that isn't an object, an array or a string is copied as it is.
function scrubUris(v, depth = 0) {
  if (typeof v === 'string') return v.includes('spotify:user:') ? v.replace(/spotify:user:[^:\s"'<>]+/g, HIDDEN_USER) : v;
  if (!v || typeof v !== 'object' || depth > 16) return v;
  if (Array.isArray(v)) return v.map((x) => scrubUris(x, depth + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = scrubUris(x, depth + 1);
  return o;
}

// A Web API route without its ids: '/users/<id>/playlists', '/playlists/<id>/tracks' (a user id can be plain words,
// so whatever follows "users" always goes)
function routeShape(p) {
  if (typeof p !== 'string' || !p) return p;
  const segs = p.split('?')[0].split('/');
  return segs.map((s, i) => (!s || (/^[a-z][a-z-]*$/.test(s) && segs[i - 1] !== 'users') ? s : '<id>')).join('/');
}

// The player snapshot (the admin page's Now playing): another device by its kind, no Jam host name, no "added by".
function trimSnapshot(p, lang = 'en') {
  if (!p || typeof p !== 'object') return p;
  const o = { ...p };
  if (p.remote && typeof p.remote === 'object') o.remote = { ...p.remote, device: deviceLabel(p.remote.type, lang) };
  if (p.jam && typeof p.jam === 'object' && 'hn' in p.jam) { o.jam = { ...p.jam }; delete o.jam.hn; }
  if (p.track && typeof p.track === 'object' && 'by' in p.track) { o.track = { ...p.track }; delete o.track.by; }
  return scrubUris(o);
}

// webapi.info(): no account name or id (the plan stays: "premium"), the last 429's route without ids
function trimSpotify(sp) {
  if (!sp || typeof sp !== 'object') return sp;
  const o = { ...sp };
  if ('user' in sp) o.user = sp.user && typeof sp.user === 'object' ? { product: sp.user.product || null } : null;
  if (sp.last429_path) o.last429_path = routeShape(sp.last429_path);
  return scrubUris(o);
}

// GET /admin/api/status (lang: the page's language for the words it puts in, i18n.js)
function trimAdminStatus(s, lang = 'en') {
  if (!s || typeof s !== 'object') return s;
  const o = scrubUris(s);
  if (o.player) o.player = trimSnapshot(o.player, lang);
  if (o.spotify) o.spotify = trimSpotify(o.spotify);
  if (Array.isArray(o.devices)) o.devices = o.devices.map((d, i) => ({ name: t(lang, 'Phone {n}', { n: i + 1 }) }));
  return o;
}

// A player command's reply ({gen, stream, state}) to the admin page
function trimReply(r, lang = 'en') {
  if (!r || typeof r !== 'object' || !r.state) return r;
  return { ...r, state: trimSnapshot(r.state, lang) };
}

// ------------------------------------------------------------------ the switch
class Showcase {
  // dataDir: where showcase.json lives (none: in memory only, for tests)
  constructor({ dataDir, file } = {}) {
    this.file = file || (dataDir ? path.join(dataDir, FILE) : null);
    this.on = false;
    this.at = 0;
    this.load();
  }

  load() {
    if (!this.file) return;
    let j;
    try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') log.warn('showcase: its setting file is unreadable, so Showcase starts off');
      return;
    }
    this.on = !!(j && j.on === true);
    this.at = j && Number.isFinite(j.at) ? j.at : 0;
  }

  save() {
    if (!this.file) return;
    const body = JSON.stringify({ on: this.on, at: this.at });
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, body);
      try { fs.renameSync(tmp, this.file); } catch (e) {
        // (Windows: a scanner may hold the old file a moment) write it in place; the switch itself already applies
        fs.writeFileSync(this.file, body);
        try { fs.unlinkSync(tmp); } catch (e2) { /* gone */ }
      }
    } catch (e) { log.warn('showcase: could not save the setting (it applies until a restart):', e.code || e.message); }
  }

  isOn() { return this.on; }

  // POST {on: true|false} (admin page or tray) -> {showcase}
  set(on) {
    if (typeof on !== 'boolean') throw fail(400, 'bad_request', 'on must be true or false');
    if (on !== this.on) {
      this.on = on;
      this.at = Date.now();
      this.save();
      log.info(`showcase ${on ? 'on' : 'off'}`);
    }
    return this.info();
  }

  info() { return { showcase: this.on }; }

  // the admin answers, trimmed only while on
  trimStatus(s, lang) { return this.on ? trimAdminStatus(s, lang) : s; }
  trimSpotify(sp) { return this.on ? trimSpotify(sp) : sp; }
  trimReply(r, lang) { return this.on ? trimReply(r, lang) : r; }
}

module.exports = { Showcase, deviceType, deviceLabel, coverFlags, trimAdminStatus, trimSnapshot, trimSpotify, trimReply, routeShape,
  scrubUris, DEVICE_TYPES, FILE };
