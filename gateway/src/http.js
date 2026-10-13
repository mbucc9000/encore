'use strict';
// HTTP routes.
//   Phone (HMAC-signed): /v1/status, /v1/player/*, /v1/stream, /v1/events, /v1/image, /v1/img/*, /v1/diag, the catalog
//   (/v1/playlists[/<id>[/items|/added]], /v1/liked, /v1/albums/<id>, /v1/artists/<id>, /v1/search, /v1/library[/contains]),
//   Home / Your Library / profile (/v1/home, /v1/recent, /v1/me[/albums|/artists]), saved albums (0.9: GET
//   /v1/me/albums/contains, POST /v1/me/albums), "Saved in" (0.9: /v1/playlists/containing), synced lyrics (/v1/lyrics),
//   and Jams (/v1/jam, /v1/jam/<action>, GET /v1/player/queue, Up Next edits POST /v1/jam/queue/remove|move).
//   Profiles (0.10, social.js; DESIGN-PROFILES.md §2.3): GET /v1/users/<id>[/playlists|/followers|/following], GET
//   /v1/search/users, POST /v1/users/<id>/follow, POST /v1/me/playlists (follow someone else's playlist).
//   Unsigned: POST /v1/pair (needs a code; only from ADMIN_ALLOW addresses, adminauth.js).
//   Admin (ADMIN_ALLOW addresses only + the admin password, or first-run setup): /admin, /admin/api/*, /admin/listen.aac
//   Showcase (1.1.0, showcase.js; D4): GET|POST /admin/api/showcase; while it is on the admin answers are trimmed on the
//   server (names, ids, other devices) and phone diagnostics are refused. The phone API is never trimmed (D3).
//   Windows tray launcher (1.1.0, gateway/windows/CONTRACT.md §5): GET /local/v1/status, POST /local/v1/shutdown,
//   POST /local/v1/showcase, only with ENCORE_LAUNCHER_TOKEN, only from loopback, only with the token header and no
//   Origin; anything else there is the plain 404 every unknown route gets.
//   Setup guide (1.1.0, DESIGN-WIZARD.md; wizard.js, clientid.js, netcheck.js): GET|POST /admin/api/wizard, POST
//   /admin/api/wizard/client-id, GET /admin/api/wizard/network, POST /admin/api/wizard/public-ip (admin routes: the
//   network gate and the password). The public-IP route is the only thing that makes the bridge ask a public
//   IP-check service, and only when the setup guide's Find my public IP is pressed (netcheck.js's PublicIp). A signed
//   phone request from outside the home network ticks the guide's step 8 (wizard.noteAway(); the address is never
//   kept or logged).
//   Updates (DESIGN-UPDATES.md §8.2, update.js): GET /admin/api/update (also `update` in the admin status), POST
//   /admin/api/update/check (Docker / other: a manual check, throttled; Windows: a request for the tray launcher), POST
//   /admin/api/update/install (Windows installer only, only from this PC: the UAC prompt appears here) and
//   /admin/api/update/cancel. The tray launcher pushes its view to POST /local/v1/update (kept in memory only) and
//   picks the page's requests up from GET /local/v1/status (update_request).
//   Languages (1.2.0, i18n.js): GET /admin/i18n/<code>.json (the admin page's dictionary, the page's own rules). Every
//   message for the phone or the admin page is in the request's language (X-Encore-Lang, else Accept-Language): the
//   ones made here with t(lang, …), the modules' (English inside the bridge) translated on the way out with tx().
// Catalog answers are JSON with an ETag (304 on a match) and gzip above 2 KB; writes are POSTs with a JSON body.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const log = require('./log');
const { serveStream, serveListen, leadAsks } = require('./stream');
const { Diag } = require('./diag');
const { AdminAuth, isPrivate } = require('./adminauth');
const { Showcase } = require('./showcase');
const { qrPng } = require('./qr');
const { NetCheck, PublicIp, PUBLIC_IP_MSG } = require('./netcheck');
const { Wizard } = require('./wizard');
const { saveClientId } = require('./clientid');
const { makeUpdate, isLoopbackPeer, UPDATE_MSG } = require('./update');
const { langOf, t, tx, serveDict } = require('./i18n');

// a promise's value, or null once ms have passed (the promise goes on)
function within(p, ms) {
  let t = null;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(null), ms); if (t.unref) t.unref(); })]).finally(() => clearTimeout(t));
}

const COMMANDS = ['play', 'pause', 'resume', 'seek', 'next', 'prev', 'shuffle', 'repeat', 'queue'];
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

// the default ADMIN_ALLOW set: loopback, the private ranges, 100.64/10 (VPN overlays), IPv6 unique-local and link-local
const isLocal = isPrivate;

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// A catalog answer (catalog.js memo: body, etag, gzip()): 304 when the phone has it, gzip above 2 KB when it takes it.
async function sendCatalog(req, res, m) {
  const head = { 'Cache-Control': 'private, no-cache', ETag: m.etag, Vary: 'Accept-Encoding' };
  const inm = String(req.headers['if-none-match'] || '');
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === m.etag)) { res.writeHead(304, head); return res.end(); }
  head['Content-Type'] = 'application/json; charset=utf-8';
  if (m.body.length > 2048 && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
    const gz = await m.gzip();
    res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    return res.end(gz);
  }
  res.writeHead(200, { ...head, 'Content-Length': m.body.length });
  res.end(m.body);
}

function jsonBody(body) {
  try { return JSON.parse(body.toString() || '{}'); } catch (e) { throw Object.assign(new Error(t('en', 'The request body isn\'t JSON.')), { status: 400, code: 'bad_request' }); }
}

// logs show only a route's prefix for these (search terms, image tokens and people's ids stay out of the log)
const logPath = (p) => (p.startsWith('/v1/img/') ? '/v1/img' : p.startsWith('/v1/search') ? '/v1/search'
  : p.startsWith('/v1/users/') ? p.replace(/^\/v1\/users\/[^/]*/, '/v1/users/<id>') : p);
const CATALOG = /^\/v1\/(playlists|liked|albums|artists|search|library|img\/|image$|home$|recent$|me$|me\/|lyrics$|users\/)/;
// a person (0.10): the id is percent-encoded; social.js decodes and checks it
const USERS = /^\/v1\/users\/([^/]{1,192})(?:\/(playlists|followers|following|follow))?$/;
const JAM_ACTIONS = /^\/v1\/jam\/(start|join|leave|end|settings|remove)$/;
const JAM_QUEUE = /^\/v1\/jam\/queue\/(remove|move)$/;
// expected states, logged once where they start (the 429, listing off), not once per phone request
// The Jam's join link as a QR code, cached by link. Only Spotify links are ever encoded. Docker draws it with qrencode
// (in the image, D22); Windows (js) and a computer without qrencode use the bridge's own encoder (qr.js), which draws
// the same size of code.
const { execFile } = require('child_process');
const QR_LINK = /^https:\/\/(open\.spotify\.com|spotify\.link|spotify\.app\.link)\/[A-Za-z0-9/_?=&.%-]{1,200}$/;
let qrCache = { link: null, png: null };
function jamQr(res, link, { js = false, lang = 'en' } = {}) {
  if (!link || !QR_LINK.test(link)) return send(res, 404, { error: { code: 'no_jam', message: t(lang, 'There is no Jam link right now.') } });
  const reply = (png) => { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, no-store' }); res.end(png); };
  const failed = () => send(res, 502, { error: { code: 'qr_failed', message: t(lang, "Couldn't make the QR code.") } });
  if (qrCache.link === link) return reply(qrCache.png);
  const own = () => {
    let png;
    try { png = qrPng(link); } catch (e) { log.warn('jam qr:', e.message); return failed(); }
    qrCache = { link, png };
    reply(png);
  };
  if (js) return own();
  execFile('qrencode', ['-o', '-', '-t', 'PNG', '-s', '12', '-m', '2', '-l', 'M', link], { encoding: 'buffer', timeout: 5000, maxBuffer: 1 << 20, windowsHide: true }, (err, out) => {
    if (err && err.code === 'ENOENT') return own();                // no qrencode on this computer
    if (err || !out || !out.length) { log.warn('jam qr:', err ? err.message : 'empty'); return failed(); }
    qrCache = { link, png: out };
    reply(out);
  });
}

// (public_ip_failed: netcheck.js logs its own line, with the service names and codes)
const QUIET_ERRORS = new Set(['rate_limited', 'busy', 'listing_off', 'engine_no_session', 'profiles_unavailable', 'public_ip_failed']);

// (lang: the message in the request's language; the modules' messages are English, tx() translates them)
function refuse(res, r, lang = 'en') {
  const body = JSON.stringify({ error: { code: r.code, message: tx(lang, r.message), ...(r.retry_after != null ? { retry_after: r.retry_after } : {}) } });
  const head = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) };
  if (r.retry_after != null) head['Retry-After'] = String(r.retry_after);
  res.writeHead(r.status, head);
  res.end(body);
}

// The event log's notices (the modules make them in English) in the request's language; the log itself stays English
function noticesIn(events, lang) {
  if (lang === 'en' || !Array.isArray(events)) return events;
  return events.map((e) => (e && e.type === 'notice' && e.data && typeof e.data.message === 'string'
    ? { ...e, data: { ...e.data, message: tx(lang, e.data.message) } } : e));
}

// An admin write must be JSON from the admin page itself: another site's page can't send that without a CORS preflight
// (which the bridge never answers), so a browser that remembers the password can't be made to press admin buttons.
function crossSite(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return true;
  const origin = req.headers.origin;
  if (origin == null) return false;
  try { return new URL(origin).host !== String(req.headers.host || ''); } catch (e) { return true; }
}

// The engine's own Spotify sign-in, for the admin page's "Engine sign-in" card (separate from the Web API account) and
// the tray (CONTRACT.md §5 engine.signed_in, sign_in).
//   signed_in (+ same_account: the Web API account is the same one, null when unknown) · signed_out (zeroconf: pick
//   "Encore" once in a Spotify app on this network) · code (device_auth: open the url, enter the code) · unreachable.
//   An engine the bridge runs itself (Windows, supervisor.js) adds managed: true, and the supervisor's own states:
//   starting (not answering yet) · missing (no engine program) · version_mismatch (+ version, expected; CONTRACT §6) ·
//   stopped (it kept stopping right after it started).
// The device code is asked first when the engine is the bridge's own (device_auth there): the engine answers it from
// its own state, while /status waits for a player that a pending device-code sign-in doesn't have yet (the engine then
// answers 503 after 10 s and logs a warning, every time). Elsewhere /status comes first, as before, and the code is
// still looked for when /status doesn't answer (device_auth on Docker). Never the account's name.
const SPOTIFY_URL = /^https:\/\/([a-z0-9-]+\.)*spotify\.com(\/[^\s"'<>]{0,300})?$/i;
const plainVersion = (v) => (v ? String(v).replace(/^encore-/, '') : null);
async function engineSignin(engine, webapi, supervisor) {
  const sup = supervisor && supervisor.managed && typeof supervisor.info === 'function' ? supervisor.info() : null;
  const base = sup ? { managed: true } : {};
  if (sup && ['missing', 'version_mismatch', 'stopped'].includes(sup.state)) {
    return { state: sup.state, ...base, ...(sup.state === 'version_mismatch' ? { version: plainVersion(sup.version), expected: plainVersion(sup.expected) } : {}) };
  }
  if (!engine || typeof engine.get !== 'function') return { state: 'unknown', ...base };
  const starting = sup && ['starting', 'restarting'].includes(sup.state);
  let asked = false;
  const code = async () => {
    asked = true;
    let ac = null;
    try { ac = await engine.get('/auth/code', { timeoutMs: 2500 }); } catch (e) { ac = null; }
    const j = ac && ac.status === 200 && ac.json;
    if (!j || !(j.code || j.url)) return null;
    return { state: 'code', ...base, code: String(j.code || '').slice(0, 32), url: SPOTIFY_URL.test(String(j.url || '')) ? j.url : null,
      expires_at: j.expires_at || null };
  };
  let c = sup ? await code() : null;
  if (c) return c;
  let st;
  try { st = await engine.get('/status', { timeoutMs: 2500 }); } catch (e) {
    if (!asked && (c = await code())) return c;
    return { state: starting ? 'starting' : 'unreachable', ...base };
  }
  if (st.status === 200 && st.json) {
    const eu = String(st.json.username || '').toLowerCase();
    const wu = webapi && webapi.user && webapi.user.id ? String(webapi.user.id).toLowerCase() : '';
    return { state: 'signed_in', ...base, same_account: eu && wu ? eu === wu : null };
  }
  if (!asked && (c = await code())) return c;
  if (st.status !== 204) return { state: starting ? 'starting' : 'unreachable', ...base, http: st.status };
  return { state: 'signed_out', ...base };
}

// ---------------------------------------------------------------- the iPhone's Home address (R3c)
// For the admin page's Phone setup panel and the tray (CONTRACT.md §5 phone_url): this computer's IPv4 address on the
// home network = the address of the adapter its default route uses, unless that adapter is virtual (a VM host or
// container switch, WSL) or a VPN / overlay; then the best private address on a real adapter, and only when there is
// none the default route's own. Only the private ranges count (10/8, 172.16/12, 192.168/16): never 100.64/10 (Tailscale
// and other overlays) or 169.254/16. The routes come from /proc/net/route (Linux) or `route print -4` (Windows); nothing
// is sent anywhere.
const VIRTUAL_NAME = /^(v ?ethernet|virtualbox|vmware|vmnet|vbox|hyper-?v|wsl|docker|br-[0-9a-f]|veth|virbr|lxc|lxd|cni|flannel|podman|tailscale|zerotier|zt|hamachi|ham\d|wireguard|wg\d|nordlynx|proton|openvpn|mullvad|tap|tun|utun|ppp|ipsec|npcap|teredo|isatap|bluetooth|loopback)|vpn|\bvirtual\b|\*\s*\d+$/i;
// Hyper-V, VMware, Parallels, VirtualBox, Docker, Xen, QEMU/KVM, TAP-Windows
const VIRTUAL_MAC = /^(00:15:5d|00:50:56|00:0c:29|00:05:69|00:1c:14|00:1c:42|08:00:27|0a:00:27|02:42|00:16:3e|52:54:00|00:ff:|00:00:00:00:00:00)/i;
const PRIVATE_V4 = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;

function lanCandidates(ifaces) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if (!a || !(a.family === 'IPv4' || a.family === 4) || a.internal || !PRIVATE_V4.test(String(a.address))) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL_NAME.test(name) || VIRTUAL_MAC.test(String(a.mac || '')) });
    }
  }
  return out;
}

// ifaces: os.networkInterfaces(); routes: default routes [{iface | address, metric}] (lowest metric first wins)
function pickPhoneAddress(ifaces, routes = []) {
  const c = lanCandidates(ifaces);
  const routed = [];
  for (const r of [...routes].sort((a, b) => a.metric - b.metric)) {
    for (const x of c) if (((r.iface && x.name === r.iface) || (r.address && x.address === r.address)) && !routed.includes(x)) routed.push(x);
  }
  const rank = (x) => (x.address.startsWith('192.168.') ? 0 : x.address.startsWith('10.') ? 1 : 2);
  const real = c.filter((x) => !x.virtual).sort((a, b) => rank(a) - rank(b));
  const best = routed.find((x) => !x.virtual) || real[0] || routed[0] || null;
  return best ? best.address : null;
}

// /proc/net/route: the default routes (destination and mask 0) by interface name
function parseProcRoute(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 8 && f[1] === '00000000' && f[7] === '00000000') out.push({ iface: f[0], metric: Number(f[6]) || 0 });
  }
  return out;
}

// `route print -4` (any Windows language): "0.0.0.0  0.0.0.0  <gateway>  <interface address>  <metric>". The persistent
// routes section has no interface column; its gateway never matches one of this computer's own addresses.
function parseRoutePrint(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+.+?\s(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/);
    if (m) out.push({ address: m[1], metric: Number(m[2]) });
  }
  return out;
}

function defaultRoutes(platform = process.platform) {
  if (platform === 'linux') return fs.promises.readFile('/proc/net/route', 'utf8').then(parseProcRoute, () => []);
  if (platform === 'win32') {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ROUTE.EXE');
    return new Promise((resolve) => execFile(exe, ['print', '-4'], { timeout: 3000, windowsHide: true, maxBuffer: 1 << 20 },
      (err, out) => resolve(err ? [] : parseRoutePrint(String(out)))));
  }
  return Promise.resolve([]);
}

async function lanAddress() {
  let ifaces = {};
  try { ifaces = os.networkInterfaces(); } catch (e) { return null; }
  return pickPhoneAddress(ifaces, await defaultRoutes());
}

// A value looked up at most every ttl ms, one lookup at a time. get(): the current lookup (a new one once ttl is over).
// quick(): never waits on a lookup once there is an answer: the newest one while a new lookup runs (the tray polls
// every 2 s with a 3 s timeout, and an engine look can take 5 s); the very first lookup is waited for up to firstMs.
function memo(fn, ttl, fallback) {
  let cur = { at: 0, p: null, done: false };
  let last = fallback;
  let has = false;
  const get = () => {
    if (!cur.p || Date.now() - cur.at > ttl) {
      const n = { at: Date.now(), p: null, done: false };
      n.p = Promise.resolve().then(fn).catch(() => fallback).then((v) => { n.done = true; last = v; has = true; return v; });
      cur = n;
    }
    return cur.p;
  };
  const quick = (firstMs = 1500) => {
    const p = get();
    if (cur.done) return p;
    if (has) return Promise.resolve(last);
    return Promise.race([p, new Promise((r) => { const t = setTimeout(() => r(fallback), firstMs); if (t.unref) t.unref(); })]);
  };
  return { get, quick };
}

// A request from outside the home network: its peer is an IP address that isn't in the default private set (loopback,
// 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, fe80::/10). An unreadable peer never counts.
function outside(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, '');
  return net.isIP(ip) !== 0 && !isLocal(ip);
}

// ---------------------------------------------------------------- the Windows launcher's loopback routes (CONTRACT §5)
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
function launcherAllowed(req, token) {
  if (!token) return false;
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, '');
  if (ip !== '127.0.0.1' && ip !== '::1') return false;
  if (req.headers.origin != null) return false;
  return crypto.timingSafeEqual(sha256(req.headers['x-encore-launcher'] || ''), sha256(token));   // constant time, any length
}

function createServer(ctx) {
  const { cfg, player, auth, bus, encoders, engine, clock, started, webapi, catalog, images, jam, personal, lyrics, membership, social, supervisor } = ctx;
  const adminAuth = ctx.adminAuth || new AdminAuth({ cfg });
  const showcase = ctx.showcase || new Showcase({ dataDir: cfg.dataDir });     // the bridge's Showcase switch (D4)
  const diag = new Diag(cfg.dataDir);
  const signinM = memo(() => engineSignin(engine, webapi, supervisor), 3000, { state: 'unknown' });
  const signin = signinM.get;
  // this computer's address for the iPhone's Home field (looked up at most every 30 s; ctx.lanAddress for tests)
  const lanM = memo(() => (ctx.lanAddress || lanAddress)(), 30000, null);
  // null while Showcase is on (the address is personal: D4); a status never waits on a lookup once there is an answer
  const phoneSetup = async () => {
    if (showcase.isOn()) return null;
    const address = await lanM.quick();
    return address ? { address, port: cfg.port, url: `http://${address}:${cfg.port}` } : { address: null, port: cfg.port, url: null };
  };
  const supInfo = () => (supervisor && typeof supervisor.info === 'function' ? supervisor.info() : null);
  const platform = () => ({ windows: !!cfg.windows, engine: supInfo() && supInfo().managed ? 'managed' : 'separate', launcher: !!cfg.launcher });
  const platformKind = cfg.platformKind || (cfg.windows ? 'windows' : 'other');

  // the setup guide (DESIGN-WIZARD.md): the network check, the public-IP lookup (step 8) and the guide's own state
  const candidates = () => lanCandidates(os.networkInterfaces());
  const netcheck = ctx.netcheck || new NetCheck({ cfg, platform: platformKind, lanAddress: () => lanM.get(), candidates });
  const publicIp = ctx.publicIp || new PublicIp({ cfg });
  const wizard = ctx.wizard || new Wizard({ cfg, adminAuth, webapi, auth, player, encoders, showcase, netcheck,
    engineState: () => signinM.quick(), lanAddress: () => lanM.quick(), candidates: ctx.lanCandidates || candidates });
  // updates: the bridge's own checker (Docker / other), or the tray launcher's view relayed (Windows). main.js makes it
  // and starts its schedule; without one (tests) it is made here and only Check now ever runs it.
  const update = ctx.update || makeUpdate({ cfg });

  // GET /local/v1/status (CONTRACT.md §5): every field always there; no names, usernames, playlist names or paths
  const launcherStatus = async () => {
    const sup = supInfo();
    const managed = !!(sup && sup.managed);
    const [e, ph] = await Promise.all([signinM.quick(), phoneSetup()]);
    return {
      contract: 1,
      bridge: { version: cfg.version, uptime_s: Math.round((Date.now() - started) / 1000), port: cfg.port },
      engine: { state: managed ? sup.state : 'unmanaged', version: managed ? plainVersion(sup.version) : null, expected: cfg.version,
        connected: !!(engine && engine.connected), signed_in: e.state === 'signed_in' ? true : e.state === 'code' || e.state === 'signed_out' ? false : null,
        restarts: managed ? sup.restarts || 0 : 0 },
      sign_in: e.state === 'code' ? { url: e.url || null, code: e.code || null, expires_at: e.expires_at || null } : null,
      admin: { setup_needed: adminAuth.mode() === 'setup' },
      // the setup guide (DESIGN-WIZARD.md §2.4): the launcher opens it once while this is false
      setup: { complete: adminAuth.mode() === 'setup' ? false : wizard.isComplete() },
      spotify: { connected: !!(webapi && webapi.ready) },
      phones: { paired: auth.list().length, listening: encoders && typeof encoders.listening === 'function' ? encoders.listening() : 0 },
      playing: !!(player.st && player.st.status === 'playing'),
      showcase: showcase.isOn(),
      phone_url: ph ? ph.url : null,
      // the admin page's oldest pending update request (Check now / Update now / Cancel), CONTRACT.md §9
      update_request: update.mode === 'relay' ? update.pending() : null,
    };
  };

  const status = () => ({
    gateway: { name: 'Encore Bridge', version: cfg.version, min_app: cfg.minApp || null, uptime_s: Math.round((Date.now() - started) / 1000) },
    engine: { name: 'go-librespot', connected: engine.connected, active: player.st.active },
    player: player.snapshot(),
    stream: { tiers: cfg.tiers, default: cfg.defaultTier },
    catalog: catalog.counters(),
    jam: jam.statusInfo(),
    ...(social ? { profiles: social.statusInfo() } : {}),
  });

  // the Spotify card's sign-in problem (webapi.js keeps it in English) in the request's language
  const spotifyIn = (info, lang) => (info && info.auth_broken && info.auth_broken.message && lang !== 'en'
    ? { ...info, auth_broken: { ...info.auth_broken, message: tx(lang, info.auth_broken.message) } } : info);

  return http.createServer(async (req, res) => {
    // a request target that isn't a path (`//`, a bad absolute form) gets a plain 400: anyone can send one through a
    // port forward, and an exception here would leave the connection unanswered
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: { code: 'bad_request', message: 'bad request target' } }); }
    const p = url.pathname;
    const lang = langOf(req);              // the language of this request's messages (i18n.js)
    try {
      // ---------------- public
      // (the app checks that the answer starts with "Encore gateway": keep that first line)
      if (p === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Encore gateway\nEncore Bridge: the admin page is at /admin\n'); }
      // ---------------- the Windows tray launcher (loopback + the per-start token; CONTRACT.md §5)
      if (p.startsWith('/local/')) {
        if (!launcherAllowed(req, cfg.launcherToken)) return send(res, 404, { error: { code: 'not_found' } });
        if (p === '/local/v1/status' && req.method === 'GET') return send(res, 200, await launcherStatus());
        if (p === '/local/v1/showcase' && req.method === 'POST') return send(res, 200, showcase.set((jsonBody(await readBody(req, 1024)) || {}).on));
        // the launcher's update view (+ handled_request): checked, kept in memory only, never logged (400 when invalid)
        if (p === '/local/v1/update' && req.method === 'POST' && update.mode === 'relay') return send(res, 200, update.push(jsonBody(await readBody(req, 8192))));
        if (p === '/local/v1/shutdown' && req.method === 'POST') {
          await readBody(req, 1024);
          res.on('finish', () => { if (ctx.shutdown) ctx.shutdown('the launcher asked'); });     // after the answer is out
          return send(res, 202, { ok: true });
        }
        return send(res, 404, { error: { code: 'not_found' } });
      }
      if (p === '/v1/pair' && req.method === 'POST') {
        // only from ADMIN_ALLOW addresses (pair at home): the reply carries the device's secret
        const g = adminAuth.gate(req);
        if (g) return refuse(res, g.code === 'forbidden' ? { ...g, code: 'pair_forbidden', message: t(lang, 'Pairing only works on your home network. Connect this iPhone to the same Wi-Fi as your Encore Bridge and try again.') } : g, lang);
        const b = jsonBody(await readBody(req));
        return send(res, 200, auth.pair(b.code, b.device_name));
      }

      // ---------------- admin (ADMIN_ALLOW addresses only)
      if (p === '/admin' || p.startsWith('/admin/')) {
        const g = adminAuth.gate(req);
        if (g) return refuse(res, g, lang);
        const page = () => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(ADMIN_HTML); };
        // first-run setup (adminauth.js): whether it's needed, and choosing the password once
        if (p === '/admin/api/setup') {
          // (Windows: the page says where its setup code is, and that the tray's own page needs none)
          // (+ platform: the setup guide's wording, DESIGN-WIZARD.md §2.4)
          if (req.method === 'GET') return send(res, 200, { ...adminAuth.setupInfo(req), ...(cfg.windows ? { windows: true } : {}), platform: platformKind });
          if (req.method === 'POST') {
            if (crossSite(req)) return refuse(res, { status: 403, code: 'cross_site', message: t(lang, 'Use the admin page itself.') }, lang);
            return send(res, 200, await adminAuth.setup(req, jsonBody(await readBody(req, 4096))));
          }
        }
        if (adminAuth.mode() === 'setup' && p === '/admin' && req.method === 'GET') return page();     // it shows the setup card
        // the page's dictionary (i18n.js): the page's own rules, so the setup card has it too
        if (adminAuth.mode() === 'setup' && req.method === 'GET' && serveDict(res, p)) return;
        const a = await adminAuth.check(req);
        if (!a.ok) {
          if (a.status !== 401) return refuse(res, a, lang);
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Encore Bridge", charset="UTF-8"', 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
          return res.end('password required');
        }
        if (req.method === 'POST' && crossSite(req)) return refuse(res, { status: 403, code: 'cross_site', message: t(lang, 'Use the admin page itself.') }, lang);
        if (p === '/admin') return page();
        if (req.method === 'GET' && serveDict(res, p)) return;
        if (p === '/admin/listen.aac') return serveListen(req, res, url, ctx);
        if (p === '/admin/api/status') {
          // (Showcase on: trimmed on the server, showcase.js; `showcase` tells the page which way to draw)
          return send(res, 200, { ...showcase.trimStatus({ ...status(), gens: [...player.genInfo.entries()].slice(-5), pending: player.pending && { gen: player.pending.gen, reason: player.pending.reason },
            encoders: encoders.info(), clock: { sample: clock.sample, lead_ms: Math.round(clock.lead() / 44.1), lead_target_ms: clock.leadMs, lead_asks: leadAsks(),
              frozen: clock.frozen != null, pipe_kb: clock.pipeBytes / 1024, stats: clock.stats },
            heard: player.heardInfo(), connect_sync: player.syncInfo(), devices: auth.list(), spotify: spotifyIn(webapi.info(), lang),
            catalog: await catalog.info(), images: images.info(), jam: jam.info(), lyrics: lyrics.info(), membership: membership.info(),
            social: social ? social.info() : null, admin: adminAuth.info(),
            // (R3c) where the bridge runs, the engine as its child (Windows), the PCM source, and the Phone setup panel
            platform: platform(), engine_process: supInfo() && supInfo().managed ? { ...supInfo(), version: plainVersion(supInfo().version), expected: plainVersion(supInfo().expected) } : null,
            pcm: clock.src && typeof clock.src.info === 'function' ? clock.src.info() : null, phone: await phoneSetup(),
            // the setup guide's banner, and the Phone setup card's Encore repo line (public: not trimmed in Showcase)
            setup: wizard.statusInfo(), app_repo: cfg.appRepo || null,
            // the Updates section and banner (versions and codes only: the same in Showcase)
            update: update.adminView(req) }, lang), showcase: showcase.isOn() });
        }
        // updates (DESIGN-UPDATES.md §8.2)
        if (p === '/admin/api/update' && req.method === 'GET') return send(res, 200, update.adminView(req));
        if (p === '/admin/api/update/check' && req.method === 'POST') {
          jsonBody(await readBody(req, 1024));
          if (update.mode === 'relay') return send(res, 202, { queued: update.queue('check'), update: update.adminView(req) });
          // Docker / other: the check itself (throttled), waited for up to 20 s; after that the page sees "Checking…"
          const r = await within(update.checkNow(), 20000);
          return send(res, 200, { ...update.adminView(req), reused: !!(r && r.reused) });
        }
        if (p === '/admin/api/update/install' && req.method === 'POST') {
          jsonBody(await readBody(req, 1024));
          const v = update.adminView(req);
          if (update.mode !== 'relay' || (v.kind && v.kind !== 'windows-installer')) return refuse(res, { status: 409, code: 'not_installed', message: UPDATE_MSG.not_installed }, lang);
          // only from this PC (the socket's peer; the admin gate already refuses proxy headers): Windows asks here
          if (!isLoopbackPeer(req)) return refuse(res, { status: 403, code: 'update_here_only', message: UPDATE_MSG.update_here_only(v.latest && v.latest.version) }, lang);
          if (!(v.state === 'available' && v.latest)) return refuse(res, { status: 409, code: 'not_available', message: UPDATE_MSG.not_available }, lang);
          return send(res, 202, { queued: update.queue('install'), update: update.adminView(req) });
        }
        if (p === '/admin/api/update/cancel' && req.method === 'POST') {
          jsonBody(await readBody(req, 1024));
          if (update.mode !== 'relay') return refuse(res, { status: 409, code: 'not_installed', message: UPDATE_MSG.not_installed }, lang);
          return send(res, 202, { queued: update.queue('cancel'), update: update.adminView(req) });
        }
        // the setup guide (DESIGN-WIZARD.md §2-§4)
        if (p === '/admin/api/wizard') {
          if (req.method === 'GET') return send(res, 200, await wizard.answer());
          if (req.method === 'POST') {
            wizard.act(jsonBody(await readBody(req, 1024)) || {});
            return send(res, 200, await wizard.answer());
          }
        }
        if (p === '/admin/api/wizard/client-id' && req.method === 'POST') {
          const b = jsonBody(await readBody(req, 1024)) || {};
          return send(res, 200, saveClientId({ cfg, webapi, body: b, showcase: showcase.isOn(),
            onDisconnect: () => { player.remote = null; if (typeof player.publish === 'function') player.publish(); } }));
        }
        if (p === '/admin/api/wizard/network' && req.method === 'GET') {
          return send(res, 200, NetCheck.trim(await netcheck.check({ fresh: url.searchParams.get('fresh') === '1' }), showcase.isOn()));
        }
        // step 8: the home's public IP, looked up only now (a POST: never from a prefetch, a page load or another site).
        // Showcase on: refused before anything is contacted. The answer is never logged.
        if (p === '/admin/api/wizard/public-ip' && req.method === 'POST') {
          const raw = await readBody(req, 1024);
          if (showcase.isOn()) return refuse(res, { status: 409, code: 'showcase_on', message: PUBLIC_IP_MSG.showcase_on }, lang);
          const b = jsonBody(raw) || {};
          return send(res, 200, await publicIp.lookup({ fresh: b.fresh === true }));
        }
        // the Showcase switch (D4): {showcase}; POST {on: true|false} (the tray sets the same switch over loopback)
        if (p === '/admin/api/showcase') {
          if (req.method === 'GET') return send(res, 200, showcase.info());
          if (req.method === 'POST') return send(res, 200, showcase.set((jsonBody(await readBody(req, 1024)) || {}).on));
        }
        // the engine's Spotify sign-in (the Engine sign-in card)
        if (p === '/admin/api/engine/signin' && req.method === 'GET') return send(res, 200, await signin());
        // profiles (0.10): the follow / save capabilities back to unknown, after a fix
        if (p === '/admin/api/profiles/caps' && req.method === 'POST' && social) return send(res, 200, social.resetCaps(jsonBody(await readBody(req))));
        // Jam (DESIGN-4b.md §5.9): the one-time access check; the page's Advanced fold: the fake Jam, the runtime flags, the trace
        if (p === '/admin/api/jam/trace' && req.method === 'GET') return send(res, 200, jam.traceDump());
        if (p === '/admin/api/jam/check' && req.method === 'POST') { const r = await jam.check(); return send(res, 200, { ...r, reason: tx(lang, r.reason) }); }
        if (p === '/admin/api/jam/broadcast' && req.method === 'POST') return send(res, 200, await jam.broadcastRead());   // patch 4: one jam_status read
        if (p === '/admin/api/jam/fake' && req.method === 'POST') return send(res, 200, jam.setFake(jsonBody(await readBody(req))));
        if (p === '/admin/api/jam/flags' && req.method === 'POST') return send(res, 200, jam.setFlags(jsonBody(await readBody(req))));
        if (p === '/admin/api/jam/trace/reset' && req.method === 'POST') return send(res, 200, jam.resetTrace());
        if (p === '/admin/api/catalog/flush' && req.method === 'POST') return send(res, 200, await catalog.flush(jsonBody(await readBody(req)).what));
        if (p === '/admin/api/catalog/simulate' && req.method === 'POST') {
          const b = jsonBody(await readBody(req));
          return send(res, 200, { simulate: catalog.simulate(b.code, b.seconds) });
        }
        if (p === '/admin/api/spotify/login' && req.method === 'POST') return send(res, 200, { url: webapi.loginUrl() });
        if (p === '/admin/api/spotify/finish' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)).toString() || '{}');
          const info = await webapi.finishLogin(b.url);
          player.pollRemote();
          return send(res, 200, showcase.trimSpotify(spotifyIn(info, lang)));
        }
        if (p === '/admin/api/spotify/disconnect' && req.method === 'POST') { webapi.disconnect(); player.remote = null; player.publish(); return send(res, 200, showcase.trimSpotify(spotifyIn(webapi.info(), lang))); }
        if (p === '/admin/api/pair-code' && req.method === 'POST') return send(res, 200, auth.newCode());
        if (p === '/admin/api/diag') {
          // a phone's log can name anything (people, devices, playlists): not while the screen may be on camera
          if (showcase.isOn()) return refuse(res, { status: 403, code: 'showcase_on', message: t(lang, 'Showcase is on: turn it off to read phone diagnostics.') }, lang);
          return send(res, 200, { lines: diag.tail(url.searchParams.get('device'), parseInt(url.searchParams.get('n') || '200', 10)) });
        }
        if (p === '/admin/api/revoke' && req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString() || '{}'); return send(res, 200, { ok: auth.revoke(b.id) }); }
        const m = p.match(/^\/admin\/api\/player\/(\w+)$/);
        if (m && req.method === 'POST' && COMMANDS.includes(m[1])) {
          const b = JSON.parse((await readBody(req)).toString() || '{}');
          return send(res, 200, showcase.trimReply(await player[m[1]](b), lang));
        }
        return send(res, 404, { error: { code: 'not_found' } });
      }

      // ---------------- phone API (signed)
      if (p.startsWith('/v1/')) {
        // PUT/DELETE bodies too: a stray one gets a clean 404 instead of a signature failure
        const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
        const dev = auth.verify(req, body);
        if (!dev) return send(res, 401, { error: { code: 'bad_signature', message: 'unknown device or bad signature/time' } });
        // the setup guide's step 8: a paired phone got in from outside the home network (the fixed private set, not
        // ADMIN_ALLOW). Only the first one is noted; the address is never kept or logged.
        if (outside(req)) wizard.noteAway();
        const idle = Date.now() - (player.lastPhone || 0) > 90000;
        player.lastPhone = Date.now();
        // A phone is around (the open app long-polls /v1/events): every tier runs, so a generation that starts now (its
        // own command, another device, a live join) is in every tier's ring from its first sample, and an early quality
        // switch never has to skip ahead to where a tier that was cold started
        encoders.warmAll();
        if (idle) {
          if (CATALOG.test(p) || p.startsWith('/v1/jam')) player.pollRemote();         // lists, covers and Jams don't wait for it
          else await Promise.race([player.pollRemote(), new Promise((r) => setTimeout(r, 1500))]);   // fresh 'playing elsewhere' for a phone that just woke up
        }
        if (p === '/v1/status') return send(res, 200, status());
        if (p === '/v1/player/state') return send(res, 200, player.snapshot());
        if (p === '/v1/stream') return serveStream(req, res, url, ctx);
        if (p === '/v1/image') return await images.serveLegacy(req, res, url);     // awaited: a failure must reach the catch below
        // ---- catalog (methods checked explicitly)
        const q = url.searchParams;
        const fresh = q.get('fresh') === '1';
        const get = req.method === 'GET';
        const post = req.method === 'POST';
        let c;
        if (p === '/v1/playlists') {
          if (get) return await sendCatalog(req, res, await catalog.library(fresh));
          if (post) return await sendCatalog(req, res, await catalog.create(jsonBody(body), (m) => tx(lang, m)));
        }
        // which editable playlists hold a song (0.9, membership.js)
        if (get && p === '/v1/playlists/containing') return await sendCatalog(req, res, await membership.containing(q.get('uri')));
        if (get && (c = p.match(/^\/v1\/playlists\/([0-9A-Za-z]{22})$/))) return await sendCatalog(req, res, await catalog.playlist(c[1], fresh));
        // when its songs were added (0.9.x, sort by Date added; anchored: neither route shadows the other)
        if (get && (c = p.match(/^\/v1\/playlists\/([0-9A-Za-z]{22})\/added$/))) return await sendCatalog(req, res, await catalog.added(c[1]));
        if (post && (c = p.match(/^\/v1\/playlists\/([0-9A-Za-z]{22})\/items$/))) return await sendCatalog(req, res, await catalog.items(c[1], jsonBody(body)));
        if (get && p === '/v1/liked') return await sendCatalog(req, res, await catalog.liked(fresh));
        if (get && (c = p.match(/^\/v1\/albums\/([0-9A-Za-z]{22})$/))) return await sendCatalog(req, res, await catalog.album(c[1]));
        if (get && (c = p.match(/^\/v1\/artists\/([0-9A-Za-z]{22})$/))) return await sendCatalog(req, res, await catalog.artist(c[1]));
        if (get && p === '/v1/search') return await sendCatalog(req, res, await catalog.search(q.get('q'), q.get('type'), q.get('offset')));
        // ---- other people's profiles (0.10, social.js): people search, a profile, its playlists / people, follow
        if (social && get && p === '/v1/search/users') return await sendCatalog(req, res, await social.searchUsers(q.get('q'), q.get('offset')));
        if (social && (c = p.match(USERS))) {
          if (get && !c[2]) return await sendCatalog(req, res, await social.profile(c[1], fresh));
          if (get && c[2] === 'playlists') return await sendCatalog(req, res, await social.playlists(c[1], q.get('offset'), fresh));
          if (get && (c[2] === 'followers' || c[2] === 'following')) return await sendCatalog(req, res, await social.people(c[1], c[2], fresh));
          if (post && c[2] === 'follow') return send(res, 200, await social.follow(c[1], jsonBody(body)));
        }
        // following someone else's playlist (adds it to Your Library; a write: no ETag)
        if (social && post && p === '/v1/me/playlists') return send(res, 200, await social.savePlaylist(jsonBody(body)));
        // ---- Home, Your Library's albums / artists / recently played, your profile (0.7, personal.js)
        if (get && p === '/v1/home') return await sendCatalog(req, res, await personal.home(fresh));
        if (get && p === '/v1/recent') return await sendCatalog(req, res, await personal.recentList(fresh));
        if (get && p === '/v1/me') return await sendCatalog(req, res, await personal.profile(fresh));
        if (get && p === '/v1/me/albums') return await sendCatalog(req, res, await personal.albumList(fresh));
        // saving albums (0.9): the states (cached 60 s), and save / remove (a write: no ETag)
        if (get && p === '/v1/me/albums/contains') return await sendCatalog(req, res, await personal.albumsContain(q.get('uris')));
        if (post && p === '/v1/me/albums') return send(res, 200, await personal.saveAlbums(jsonBody(body)));
        if (get && p === '/v1/me/artists') return await sendCatalog(req, res, await personal.artistList(fresh));
        if (get && p === '/v1/library/contains') return await sendCatalog(req, res, await catalog.contains(q.get('uris')));
        if (post && p === '/v1/library') return await sendCatalog(req, res, await catalog.save(jsonBody(body)));
        if (get && (c = p.match(/^\/v1\/img\/([A-Za-z0-9_-]{1,600})$/))) return await images.serve(req, res, c[1], q.get('s'));
        // ---- synced lyrics (0.8, lyrics.js; DESIGN-LYRICS.md §1)
        if (get && p === '/v1/lyrics') return await sendCatalog(req, res, await lyrics.get(q, fresh));
        if (p === '/v1/diag' && req.method === 'POST') { diag.add(dev, JSON.parse(body.toString() || '{}')); return send(res, 200, { ok: true }); }
        // ---- Jam (§4.3, §4.4): the JAM object (ETag, a w=1 lease, fresh=1), the writes, Up Next and its edits
        if (get && p === '/v1/jam') return await sendCatalog(req, res, await jam.get({ w: q.get('w') === '1', fresh }));
        if (get && p === '/v1/jam/qr') return jamQr(res, jam.link(), { js: !!cfg.windows, lang });
        if (post && (c = p.match(JAM_ACTIONS))) return send(res, 200, await jam[c[1]](jsonBody(body)));
        if (post && (c = p.match(JAM_QUEUE))) return send(res, 200, await jam.queueEdit(c[1], jsonBody(body)));   // engine-local
        if (get && p === '/v1/player/queue') return await sendCatalog(req, res, await jam.queue());
        // the phone's playhead (not a command: no lock, no generation)
        if (p === '/v1/player/heard' && req.method === 'POST') return send(res, 200, player.onHeard(JSON.parse(body.toString() || '{}')));
        if (p === '/v1/events') {
          const cursor = parseInt(url.searchParams.get('cursor') || '0', 10) || 0;
          const timeout = Math.min(30000, Math.max(0, parseInt(url.searchParams.get('timeout') || '25', 10) * 1000));
          const events = await bus.wait(cursor, timeout);
          return send(res, 200, { cursor: events.length ? events[events.length - 1].id : Math.min(cursor, bus.seq), events: noticesIn(events, lang) });
        }
        const m = p.match(/^\/v1\/player\/(\w+)$/);
        if (m && req.method === 'POST' && COMMANDS.includes(m[1])) {
          const b = JSON.parse(body.toString() || '{}');
          if (m[1] === 'play') player.refuseJam(b || {});      // a Jam link: 400 in any state, nothing reaches the engine
          // a Jam guest without control (§4.4): 403/409 for the transport, a pause does nothing
          if (jam.guard(m[1]) === 'noop') return send(res, 200, player.reply(player.gen));
          return send(res, 200, await player[m[1]](b));      // (every tier was warmed above, before the new audio starts)
        }
      }
      return send(res, 404, { error: { code: 'not_found' } });
    } catch (e) {
      let st = e.status || (String(e.code || '').startsWith('engine_') ? 502 : 500);
      if (st === 401 && e.code !== 'bad_code') st = 502;          // 401 means "unpair" on the phone: signatures only
      if (st >= 500 && !QUIET_ERRORS.has(e.code)) log.warn(`${req.method} ${logPath(p)}:`, e.message);
      const err = { code: e.code || 'error', message: tx(lang, e.message) };
      if (e.retry_after != null) err.retry_after = e.retry_after;
      if (e.r) err.r = e.r;                                           // jam_active: the role Encore has in its Jam
      if (Array.isArray(e.uris)) err.uris = e.uris;
      if (!res.headersSent) send(res, st, { error: err });
      else res.end();
    }
  });
}

module.exports = { createServer, isLocal, outside, engineSignin, pickPhoneAddress, parseProcRoute, parseRoutePrint, lanCandidates, launcherAllowed, jamQr };
