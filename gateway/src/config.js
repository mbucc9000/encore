'use strict';
// The bridge's settings: the environment first, then settings.env (when there is one), then the built-in defaults.
//
// Platforms (D19-D25, gateway/windows/CONTRACT.md):
//  - Linux / Docker: nothing here changes. The defaults are /data, the FIFO /pipe/encore.pcm and an engine that runs
//    in its own container (not managed by the bridge). Docker sets none of the variables that switch the rest on.
//  - Windows: the data root is %LOCALAPPDATA%\Encore (ENCORE_HOME overrides it) with settings.env, data\ and engine\
//    in it; PCM arrives over a named pipe the bridge serves (a new random name every run); the bridge starts and
//    watches the engine itself (supervisor.js); ffmpeg is the bundled ffmpeg\ffmpeg.exe.
//  - ENCORE_HOME on any platform: <ENCORE_HOME>/settings.env, <ENCORE_HOME>/data and <ENCORE_HOME>/engine.
//
// settings.env (CONTRACT.md §4): KEY=VALUE lines, UTF-8 (a BOM is skipped), LF or CRLF, '#' lines and blank lines
// ignored, KEY and VALUE trimmed, one pair of matching surrounding quotes removed, no escapes, no expansion, no inline
// notes; a later line for the same key wins. An empty value counts as unset, here and in the environment. A bad line
// is reported by its number only, never its content (the file holds the admin password).
//
// The Spotify Client ID (DESIGN-WIZARD.md §3.2): the process environment (non-empty) > settings.env >
// <DATA_DIR>/settings.json (what the setup guide saves where there is no settings.env) > unset; which one won is
// spotifyClientIdSource ("env" | "settings" | "data" | null). platformKind ("windows" | "docker" | "other") is for the
// setup guide's wording.
//
// The Encore repo (DESIGN-WIZARD.md §3.2): the Cydia repo the app is installed from. One constant, DEFAULT_APP_REPO
// below (the release's selftest reads that line and checks the docs against it); ENCORE_APP_REPO overrides it (an
// advanced setting, for forks) when it is an http(s) address with a host and no credentials, query or fragment.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readDataClientId } = require('./clientid');

const DEFAULT_APP_REPO = 'https://mbucc9000.github.io/slopkit/';
const KEY = /^[A-Z_][A-Z0-9_]*$/;
const PCM_SOURCES = ['fifo', 'pipe-server'];
const WIN_PIPE = /^\\\\\.\\pipe\\[^\\]+$/i;
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const falsy = (v) => /^(0|false|no|off)$/i.test(String(v || ''));

function parseSettings(text) {
  const values = {};
  const warnings = [];
  String(text).replace(/^﻿/, '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) { warnings.push(`settings.env line ${i + 1} has no "=" and is ignored`); return; }
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) { warnings.push(`settings.env line ${i + 1} doesn't start with a setting name and is ignored`); return; }
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) val = val.slice(1, -1);
    values[key] = val;
  });
  return { values, warnings };
}

// "windows", "docker" (a container: /.dockerenv or /run/.containerenv exists) or "other"
function platformKindOf(platform, exists = (f) => fs.existsSync(f)) {
  if (platform === 'win32') return 'windows';
  try { if (exists('/.dockerenv') || exists('/run/.containerenv')) return 'docker'; } catch (e) { /* other */ }
  return 'other';
}

// ENCORE_APP_REPO when it is a usable repo address (a final '/' added), else DEFAULT_APP_REPO and a warning without the
// value. Usable: an http: or https: URL with a host, and no user name, password, query or fragment.
function appRepoOf(value, warnings) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return DEFAULT_APP_REPO;
  let u = null;
  try { u = new URL(v); } catch (e) { u = null; }
  if (!u || !(u.protocol === 'http:' || u.protocol === 'https:') || !u.hostname || u.username || u.password || u.search || u.hash
    || v.includes('?') || v.includes('#') || /\s/.test(v)) {
    warnings.push('ENCORE_APP_REPO isn\'t an http(s) address, so the default Encore repo is used');
    return DEFAULT_APP_REPO;
  }
  return u.href.endsWith('/') ? u.href : u.href + '/';
}

// The update check's test-only settings (DESIGN-UPDATES.md §9): UPDATE_API_BASE, UPDATE_DOWNLOAD_BASE and
// UPDATE_TEST_KEYS (comma-separated base64 Ed25519 public keys) point the check at a local fake GitHub. Honoured only
// when both bases are http://127.0.0.1:<port>, http://[::1]:<port> or http://localhost:<port>; otherwise ignored with a
// warning that never repeats the value. Never documented for users: with the real GitHub only the embedded keys count.
const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):([1-9][0-9]{0,4})\/?$/;
function updateTestOf(env, warnings) {
  const none = { api: null, download: null, keys: null };
  const api = env.UPDATE_API_BASE;
  const dl = env.UPDATE_DOWNLOAD_BASE;
  const keys = env.UPDATE_TEST_KEYS;
  if (!api && !dl && !keys) return none;
  const base = (v) => {
    const m = LOOPBACK_BASE.exec(String(v || ''));
    return m && Number(m[2]) <= 65535 ? String(v).replace(/\/$/, '') : null;
  };
  if (!base(api) || !base(dl)) {
    warnings.push('UPDATE_API_BASE, UPDATE_DOWNLOAD_BASE and UPDATE_TEST_KEYS are test-only settings for a local test server: ignored');
    return none;
  }
  let list = null;
  if (keys) {
    list = String(keys).split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.length > 3 || !list.every((k) => /^[A-Za-z0-9+/]{43}=$/.test(k))) {
      warnings.push('UPDATE_TEST_KEYS isn\'t a list of base64 Ed25519 public keys: ignored');
      list = null;
    }
  }
  return { api: base(api), download: base(dl), keys: list };
}

// procEnv / platform are parameters so the tests can build the Windows defaults on Linux and the other way round
// (exists: the container check, for tests).
function load(procEnv = process.env, { platform = process.platform, exists } = {}) {
  const isWin = platform === 'win32';
  const P = isWin ? path.win32 : path.posix;
  const errors = [];          // the bridge refuses to start (exit code 12) and says why
  const warnings = [];
  const set = (v) => v != null && v !== '';
  const pre = (k) => (set(procEnv[k]) ? String(procEnv[k]) : undefined);

  const appDir = pre('ENCORE_APP_DIR') || (isWin ? P.resolve(__dirname, '..', '..') : null);
  const localAppData = () => pre('LOCALAPPDATA') || P.join(os.homedir(), 'AppData', 'Local');
  const home = pre('ENCORE_HOME') || (isWin ? P.join(localAppData(), 'Encore') : null);
  const settingsFile = pre('ENCORE_SETTINGS') || (home ? P.join(home, 'settings.env') : null);

  // settings.env sits under the environment: env = file values, then every non-empty environment value on top
  const env = {};
  const fromFile = {};
  if (settingsFile) {
    let text = null;
    try { text = fs.readFileSync(settingsFile, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') errors.push(`settings.env can't be read (${e.code || 'error'})`);
    }
    if (text != null) {
      const s = parseSettings(text);
      warnings.push(...s.warnings);
      for (const [k, v] of Object.entries(s.values)) if (v !== '') { env[k] = v; fromFile[k] = v; }
    }
  }
  for (const [k, v] of Object.entries(procEnv)) if (set(v)) env[k] = String(v);

  let port = 8095;
  if (env.PORT) {
    port = Number(env.PORT);
    if (!/^\d{1,5}$/.test(env.PORT) || port < 1 || port > 65535) { errors.push('PORT must be a port number from 1 to 65535'); port = 8095; }
  }

  const dataDir = env.DATA_DIR || (home ? P.join(home, 'data') : '/data');

  // the Spotify Client ID: environment > settings.env > data/settings.json (the setup guide's, where there is no
  // settings.env) > unset
  let spotifyClientId = '';
  let spotifyClientIdSource = null;
  if (pre('SPOTIFY_CLIENT_ID')) { spotifyClientId = pre('SPOTIFY_CLIENT_ID'); spotifyClientIdSource = 'env'; }
  else if (fromFile.SPOTIFY_CLIENT_ID) { spotifyClientId = fromFile.SPOTIFY_CLIENT_ID; spotifyClientIdSource = 'settings'; }
  else {
    const d = readDataClientId(dataDir);
    if (d.warning) warnings.push(d.warning);
    if (d.id) { spotifyClientId = d.id; spotifyClientIdSource = 'data'; }
  }

  const pcmSource = env.PCM_SOURCE || (isWin ? 'pipe-server' : 'fifo');
  if (!PCM_SOURCES.includes(pcmSource)) errors.push(`PCM_SOURCE must be one of: ${PCM_SOURCES.join(', ')}`);
  // a new random name every run: two bridges can't clash, and nothing can take the name before the bridge does
  const rand = crypto.randomBytes(8).toString('hex');
  const pcmPipe = env.PCM_PIPE || (isWin ? `\\\\.\\pipe\\encore-pcm-${rand}` : P.join(os.tmpdir(), `encore-pcm-${rand}.sock`));
  if (isWin && pcmSource === 'pipe-server' && !WIN_PIPE.test(pcmPipe)) errors.push('PCM_PIPE must be a local named pipe: \\\\.\\pipe\\<name>');
  let pcmPipeBytes = 65536;     // what the named pipe holds while the bridge isn't reading (measured in T3)
  if (env.PCM_PIPE_BYTES) {
    pcmPipeBytes = Number(env.PCM_PIPE_BYTES);
    if (!Number.isInteger(pcmPipeBytes) || pcmPipeBytes < 0 || pcmPipeBytes > 16 << 20) { errors.push('PCM_PIPE_BYTES must be a byte count'); pcmPipeBytes = 65536; }
  }

  // The engine as the bridge's own child process (Windows), or a separate service (Docker: its own container).
  const engineManaged = env.ENGINE_MANAGED ? truthy(env.ENGINE_MANAGED) : (!!env.ENGINE_EXE || isWin);
  let engineExe = env.ENGINE_EXE || null;
  if (!engineExe && isWin && appDir) {
    const names = ['encore-engine.exe', 'go-librespot.exe'].map((n) => P.join(appDir, 'engine', n));
    engineExe = names.find((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } }) || names[0];
  }
  const engineConfigDir = env.ENGINE_CONFIG_DIR || (home ? P.join(home, 'engine') : P.join(dataDir, 'engine'));
  const engineConfigTemplate = env.ENGINE_CONFIG_TEMPLATE || (appDir ? P.join(appDir, 'engine', 'config.template.yml') : null);

  let ffmpeg = env.FFMPEG || 'ffmpeg';
  if (!env.FFMPEG && isWin && appDir) {
    const f = P.join(appDir, 'ffmpeg', 'ffmpeg.exe');
    try { if (fs.statSync(f).isFile()) ffmpeg = f; } catch (e) { /* not bundled: ffmpeg from PATH */ }
  }

  const updTest = updateTestOf(env, warnings);

  const cfg = {
    version: '1.2.1',         // one version for the app and the bridge from 1.1.0 on
    minApp: '1.0.0',          // the oldest app this bridge serves (in /v1/status; the app compares its own minimum bridge)
    port,
    dataDir,
    fifo: env.PCM_FIFO || '/pipe/encore.pcm',
    engineUrl: env.ENGINE_URL || 'http://127.0.0.1:3678',
    adminPassword: env.ADMIN_PASSWORD || '',          // unset: the admin page asks for one at first use (adminauth.js)
    adminAllow: env.ADMIN_ALLOW || '',                 // who may use the admin page and pairing; empty = private ranges
    adminTrustProxy: truthy(env.ADMIN_TRUST_PROXY),   // believe proxy headers (unsupported in 1.x)
    // D27 on Windows: the tray opens the admin page on this computer (loopback), which may then choose the first
    // password without the setup code from the log; from any other address the code is still needed. Off on Docker,
    // where loopback can be anything on the host. ADMIN_SETUP_LOOPBACK=1/0 overrides it.
    adminSetupLoopback: env.ADMIN_SETUP_LOOPBACK ? truthy(env.ADMIN_SETUP_LOOPBACK) : isWin,
    spotifyClientId,                                   // your Spotify dev app (Web API, PKCE: no secret needed)
    spotifyClientIdSource,                             // 'env' | 'settings' | 'data' | null (the setup guide may change all but 'env')
    // D12 on Windows: while a Spotify sign-in is pending, catch its redirect on 127.0.0.1:8888 (no paste step when the
    // browser is on this computer). Off on Docker, where the browser is on another computer. SPOTIFY_CALLBACK_CATCHER=1/0.
    spotifyCallbackCatcher: env.SPOTIFY_CALLBACK_CATCHER ? truthy(env.SPOTIFY_CALLBACK_CATCHER) : isWin,
    // the real hosts; tests point these at stub servers
    spotifyApi: env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1',
    spotifyAccounts: env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com',
    ffmpeg,
    cacheDir: P.join(dataDir, 'cache'),                // catalog JSON + resized covers (not part of a backup)
    imageDiskMB: 512,
    // Spotify's names; AAC-LC bitrates for the phone stream
    tiers: { very_high: 320, high: 256, normal: 160, low: 96 },
    defaultTier: 'very_high',
    ringSeconds: 75,          // how much encoded audio each tier keeps for reconnects (> lead + a long stall)
    leadMs: 10000,            // how far ahead of the listener the player may run = the phone's buffer (a phone may ask 5..30 s)
    gapMs: 120,               // no audio for this long = silence (paused / loading)
    behindSec: 60,            // a phone this far behind the newest audio is dropped (it reconnects)
    idlePauseSec: 45,         // playing with nobody listening for this long: pause the player
    batchMs: 180,             // steady-state send interval to the phone (frames are batched, see stream.js)
    // Jam variants the live tests pick (DESIGN-4b.md §5.12); the admin page overrides them in memory (§5.9).
    //   hostAdd: how the host's Add to Jam reaches the Jam: 'local' (engine queue) | 'webapi' | 'command' (engine
    //   /jam/queue) | 'off'; guestTransport: a guest's transport works when the host allows it; hostJump: 'pause' (exact
    //   boundaries, the guests hear the pause) | 'cut' (no engine pause while hosting); jamEdit: Up Next remove/move while
    //   hosting a Jam (false: only outside Jams; L1 step 4c decides).
    jam: { hostAdd: 'local', guestTransport: false, hostJump: 'pause', jamEdit: true },
    // Other people's profiles (0.10, social.js; DESIGN-PROFILES.md §2): Spotify's private profile / search APIs with the
    // engine's token. The bases are here so tests can point them at stubs; the persisted-query hashes are the defaults
    // (data/cache/social/hashes.json overrides them after a refresh).
    profiles: {
      spclient: env.SPOTIFY_SPCLIENT_BASE || 'https://spclient.wg.spotify.com',
      pathfinder: env.SPOTIFY_PATHFINDER_BASE || 'https://api-partner.spotify.com',
      web: env.SPOTIFY_WEB_PLAYER_BASE || 'https://open.spotify.com',               // hash refresh only (public files)
      cdn: env.SPOTIFY_WEB_CDN_BASE || 'https://open.spotifycdn.com/cdn/build/web-player/',
      spUA: 'Spotify/127700358 Linux/0 (PC desktop)',
      pfPlatform: 'Win32_x86_64', pfVersion: '1.2.77.358', pfUA: 'Spotify/127700358 Win32_x86_64/0 (PC desktop)',
      hashes: {
        searchUsers: '8f358dd82e62f61dd4ceaa9f8cd0889e644c9b707f1b724fbfb356a757cb7e5a',
        isFollowingUsers: 'c00e0cb6c7766e7230fc256cf4fe07aec63b53d1160a323940fce7b664e95596',
        followUsers: 'c00e0cb6c7766e7230fc256cf4fe07aec63b53d1160a323940fce7b664e95596',
        unfollowUsers: 'c00e0cb6c7766e7230fc256cf4fe07aec63b53d1160a323940fce7b664e95596',
      },
    },

    // ---- platform (R3g). Linux / Docker: windows false, pcmSource 'fifo', engineManaged false, dataRoot null.
    windows: isWin,
    dataRoot: home,                 // ENCORE_HOME, or %LOCALAPPDATA%\Encore on Windows; null on Docker
    appDir,                         // the install folder on Windows (…\gateway\src\..\..), else ENCORE_APP_DIR or null
    settingsFile,                   // the settings.env that was looked for (it may not exist)
    pcmSource,                      // 'fifo' (read cfg.fifo) | 'pipe-server' (serve cfg.pcmPipe, the engine connects)
    pcmPipe,
    pcmPipeBytes,
    engineManaged,                  // the bridge starts, watches and stops the engine (supervisor.js)
    engineExe,
    engineConfigDir,                // the engine's --config_dir: config.yml, state.json, lockfile
    engineConfigTemplate,           // copied to <engineConfigDir>/config.yml once, never over an existing one
    engineVersionCheck: !falsy(env.ENGINE_VERSION_CHECK),     // CONTRACT.md §6; ENGINE_VERSION_CHECK=0 skips it
    launcher: env.ENCORE_LAUNCHER === '1',                     // started by the Windows tray launcher (stdin "quit")
    platformKind: platformKindOf(platform, exists),            // 'windows' | 'docker' | 'other' (the setup guide's wording)
    // the Encore repo: the Cydia repo the app comes from (the setup guide's step 6, the Phone setup card)
    appRepo: appRepoOf(env.ENCORE_APP_REPO, warnings),
    // the update check (DESIGN-UPDATES.md §9): UPDATE_CHECK=0 (false, no, off) turns the daily automatic check off;
    // the admin page's Check now always works. Read at start. Docker / other: the bridge checks (update.js); Windows
    // with the tray launcher: the launcher checks and the bridge only shows what it pushes.
    updateCheck: !falsy(env.UPDATE_CHECK),
    updateCheckSource: pre('UPDATE_CHECK') ? 'env' : fromFile.UPDATE_CHECK ? 'settings' : null,
    // test-only (loopback bases; null = the real GitHub and the embedded keys)
    updateApiBase: updTest.api,
    updateDownloadBase: updTest.download,
    updateTestKeys: updTest.keys,
    settingsErrors: errors,
    settingsWarnings: warnings,
  };
  // the launcher's per-run secret for the loopback routes (CONTRACT.md §5): kept out of any listing of the settings
  Object.defineProperty(cfg, 'launcherToken', { value: env.ENCORE_LAUNCHER_TOKEN || '', enumerable: false });
  return cfg;
}

const cfg = load();
Object.defineProperty(cfg, 'load', { value: load, enumerable: false });
Object.defineProperty(cfg, 'parseSettings', { value: parseSettings, enumerable: false });
Object.defineProperty(cfg, 'DEFAULT_APP_REPO', { value: DEFAULT_APP_REPO, enumerable: false });
Object.defineProperty(cfg, 'updateTestOf', { value: updateTestOf, enumerable: false });
module.exports = cfg;
