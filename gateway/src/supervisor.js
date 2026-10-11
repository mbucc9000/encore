'use strict';
// The engine (go-librespot with Encore's patches) as the bridge's own child process: Windows, or any setup with
// ENGINE_EXE (gateway/windows/CONTRACT.md §5-§7). On Docker the engine is a separate container and this does nothing
// (state 'unmanaged').
//  - Before the first start: <engineConfigDir>/config.yml is made from the template once (never overwritten, so the
//    user's edits stay), and the engine's version is checked (`--version`, which creates and locks nothing): it must
//    be encore-<the bridge's version>, else the engine is not started (state 'version_mismatch').
//  - Every start passes what the bridge needs on the command line: the PCM pipe (a new random name every run), the
//    pipe format, and the engine's API on loopback at ENGINE_URL's port. Without a device_name in config.yml it also
//    passes "Encore", so the computer's name never shows up in Spotify's device list.
//  - No console window, and stdout + stderr are always drained (a full pipe would stall the engine). Its log lines
//    become bridge log lines with the user-profile path replaced, quoted names masked, the sign-in code and link
//    removed, and only the error field kept.
//  - A stopped engine is restarted after 1, 2, 5, 10, 30 s; a run of a minute resets that. After 8 quick failures in
//    a row it stays stopped (state 'stopped') until the bridge is restarted.
//  - stop() ends it: TerminateProcess on Windows (a console-less child can't be sent Ctrl+C; its state.json is
//    written with tmp + rename, so that is safe), SIGTERM and then SIGKILL elsewhere.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const log = require('./log');

const BACKOFF_S = [1, 2, 5, 10, 30];
const STABLE_MS = 60000;          // a run this long resets the backoff and the failure count
const QUICK_MS = 20000;           // a run shorter than this is a quick failure
const GIVE_UP = 8;                // quick failures in a row before the supervisor stops trying
const RUNNING_AFTER_MS = 3000;    // alive this long (or its API is up): 'running'
const VERSION_LINES = 50;         // the startup line that names the version comes within these
const VERSION_MS = 10000;
const LINE_MAX = 500;
const SPOTIFY_URL = /^https:\/\/([a-z0-9-]+\.)*spotify\.com(\/[^\s"'<>]{0,300})?$/i;

// Used when there is no config.yml and no template to make one from: the same choices as the Windows template.
const DEFAULT_CONFIG = `# Encore Bridge wrote this file because the engine's config template was missing.
device_name: Encore
device_type: smartphone
bitrate: 320
audio_backend: pipe
audio_output_pipe_format: s16le
zeroconf_enabled: false
credentials:
  type: device_auth
server:
  enabled: true
  address: 127.0.0.1
  port: 3678
volume_steps: 100
initial_volume: 100
metadata:
  enabled: true
  max_tracks: 5000
cache:
  enabled: false
`;

// ---------------------------------------------------------------- log lines
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replaces the user's profile folder (and with it every per-user path: AppData, the data root) in any form it can take
// in a log line: C:\Users\x, C:\\Users\\x (quoted by the engine's logger), C:/Users/x. Then a bare \Users\<name>\.
function makeRedactor(env = process.env) {
  const homes = new Set();
  for (const h of [env.USERPROFILE, env.HOME, (() => { try { return os.homedir(); } catch (e) { return ''; } })()]) {
    if (h && h.replace(/[\\/]+$/, '').length >= 4) homes.add(h.replace(/[\\/]+$/, ''));
  }
  const res = [];
  for (const h of [...homes].sort((a, b) => b.length - a.length)) {
    for (const v of new Set([h, h.replace(/\\/g, '\\\\'), h.replace(/\\/g, '/')])) res.push(new RegExp(escapeRe(v), 'gi'));
  }
  const users = /([\\/]Users[\\/]{1,2})[^\\/"'\s:*?<>|]+/gi;
  return (s) => {
    for (const re of res) s = s.replace(re, '%USERPROFILE%');
    return s.replace(users, '$1%USERNAME%');
  };
}

// A Go-quoted string (logrus uses strconv.Quote) back to text; good enough for log lines.
function unquote(q) {
  if (!q.startsWith('"')) return q;
  try { return JSON.parse(q); } catch (e) { return q.slice(1, -1).replace(/\\(["\\])/g, '$1'); }
}

// logrus's text format: time="…" level=info msg="…" key=value key="…"
function parseLogrus(line) {
  const f = {};
  const re = /([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S*)/g;
  let m;
  while ((m = re.exec(line))) f[m[1]] = unquote(m[2]);
  return f.level && 'msg' in f ? f : null;
}

const REWRITES = [
  [/^to complete authentication visit .*/i, 'waiting for the Spotify sign-in (the code is on the admin page and in the Encore Bridge menu)'],
  [/^generated new device id: .*/i, 'generated a new device id'],
  [/^playback was transferred to .*/i, 'playback was transferred to another device'],
  [/^swept metadata for (\d+\/\d+) tracks in .*/i, 'swept metadata for $1 tracks'],
  [/^reopened output device on .*/i, 'reopened the output device'],
  [/^advertising on network interface .*/i, 'advertising on a network interface'],
];
const maskQuoted = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, '"…"');

// One engine output line -> { level: 'info'|'warn'|'error', text } for the bridge log, or null to leave it out.
function cleanLine(line, redact) {
  line = String(line).replace(/\r$/, '');
  if (!line.trim()) return null;
  const f = parseLogrus(line);
  if (!f) return { level: 'warn', text: redact(maskQuoted(line)).slice(0, LINE_MAX) };      // a panic, "could not start: …"
  const lv = String(f.level).toLowerCase();
  const level = /^(error|fatal|panic)/.test(lv) ? 'error' : /^warn/.test(lv) ? 'warn' : 'info';
  let msg = String(f.msg);
  for (const [re, to] of REWRITES) if (re.test(msg)) { msg = msg.replace(re, to); break; }
  msg = maskQuoted(msg);
  if (f.error) msg += ` (error: ${maskQuoted(String(f.error))})`;
  return { level, text: redact(msg).slice(0, LINE_MAX) };
}

// The version an engine names: "encore-engine 1.1.0 (go-librespot …)" (--version and the startup line of R3e's
// build) or "go-librespot encore-1.1.0" (an engine stamped through go-librespot's own version). null: neither.
function engineVersionOf(text) {
  const s = String(text || '');
  let m = s.match(/\bencore-engine (\d[\w.+-]*)/);
  if (m) return 'encore-' + m[1];
  m = s.match(/\bgo-librespot encore-(\d[\w.+-]*)/);
  return m ? 'encore-' + m[1] : null;
}

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };

// ---------------------------------------------------------------- the supervisor
class Supervisor extends EventEmitter {
  // command: [file, ...args] to run instead of cfg.engineExe (tests run a fake engine through node this way).
  constructor({ cfg, command = null, env = process.env } = {}) {
    super();
    this.cfg = cfg;
    this.managed = !!cfg.engineManaged;
    this.command = command;
    this.env = env;
    this.redact = makeRedactor(env);
    this.state = this.managed ? 'stopped' : 'unmanaged';
    this.expected = 'encore-' + cfg.version;
    this.version = null;
    this.restarts = 0;
    this.failures = 0;            // quick failures in a row
    this.child = null;
    this.timer = null;
    this.stopping = false;
    this.mismatch = false;          // the engine named another version at startup
    this.namesDevice = false;       // config.yml sets device_name
    this.signInMemo = { at: 0, p: null };
  }

  info() {
    return { state: this.state, version: this.version, expected: this.expected, restarts: this.restarts, managed: this.managed };
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  get file() { return this.command ? this.command[0] : this.cfg.engineExe; }
  get preArgs() { return this.command ? this.command.slice(1) : []; }

  // The engine's environment: the bridge's, minus its secrets (the engine needs none of them).
  childEnv() {
    const e = { ...this.env };
    for (const k of ['ENCORE_LAUNCHER_TOKEN', 'ADMIN_PASSWORD', 'SPOTIFY_CLIENT_ID', 'NODE_OPTIONS']) delete e[k];
    return e;
  }

  async start() {
    if (!this.managed || this.child || this.timer) return;
    this.stopping = false;
    if (!this.file || !isFile(this.file)) {
      this.setState('missing');
      log.error('the engine program is missing: reinstall Encore Bridge');
      return;
    }
    try { this.prepareConfig(); } catch (e) {
      this.setState('stopped');
      log.error("the engine's settings folder can't be used:", e.code || e.message);
      return;
    }
    if (this.cfg.engineVersionCheck) {
      this.setState('starting');
      const v = await this.probeVersion();
      if (this.stopping) return;
      this.version = v;
      if (v !== this.expected) {
        this.setState('version_mismatch');
        log.error(`the engine is ${v || 'an unknown version'} but this bridge needs ${this.expected}: reinstall Encore Bridge so both parts match`);
        return;
      }
    }
    this.spawnEngine();
  }

  // config.yml from the template the first time (never over an existing file); and whether it names the device.
  prepareConfig() {
    const dir = this.cfg.engineConfigDir;
    fs.mkdirSync(dir, { recursive: true });
    const yml = path.join(dir, 'config.yml');
    const yaml = path.join(dir, 'config.yaml');          // the engine prefers this one when it exists
    let conf = isFile(yaml) ? yaml : yml;
    if (!isFile(conf)) {
      conf = yml;
      const tpl = this.cfg.engineConfigTemplate;
      if (tpl && isFile(tpl)) {
        fs.copyFileSync(tpl, yml, fs.constants.COPYFILE_EXCL);
        log.info("made the engine's config.yml from the template");
      } else {
        fs.writeFileSync(yml, DEFAULT_CONFIG, { flag: 'wx', mode: 0o600 });
        log.warn("the engine's config template is missing: wrote a config.yml with the default settings");
      }
    }
    let text = '';
    try { text = fs.readFileSync(conf, 'utf8'); } catch (e) { /* the engine reports it */ }
    this.namesDevice = /^device_name:[ \t]*['"]?[^\s'"#]/m.test(text);
  }

  probeVersion() {
    return new Promise((resolve) => {
      execFile(this.file, [...this.preArgs, '--version'], { timeout: 10000, windowsHide: true, env: this.childEnv(), maxBuffer: 64 * 1024 },
        (err, stdout) => resolve(err ? null : engineVersionOf(String(stdout).split('\n')[0])));
    });
  }

  // The PCM pipe the engine writes to: the named pipe the bridge serves, or the FIFO.
  pipeArg() { return this.cfg.pcmSource === 'pipe-server' ? this.cfg.pcmPipe : this.cfg.fifo; }

  args() {
    let port = '3678';
    try {
      const u = new URL(this.cfg.engineUrl);
      port = u.port || '80';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) log.warn("ENGINE_URL isn't on this computer; the engine the bridge starts listens on 127.0.0.1 only");
    } catch (e) { /* the default port */ }
    const a = [...this.preArgs, '--config_dir', this.cfg.engineConfigDir,
      '-c', 'audio_backend=pipe', '-c', `audio_output_pipe=${this.pipeArg()}`, '-c', 'audio_output_pipe_format=s16le',
      '-c', 'server.enabled=true', '-c', 'server.address=127.0.0.1', '-c', `server.port=${port}`];
    if (!this.namesDevice) a.push('-c', 'device_name=Encore');
    return a;
  }

  spawnEngine() {
    this.timer = null;
    if (this.stopping) return;
    this.setState('starting');
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(this.file, this.args(), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.childEnv() });
    } catch (e) {
      this.onExit(null, startedAt, e);
      return;
    }
    this.child = child;
    let lines = 0;
    let seenVersion = false;
    const onLine = (line) => {
      lines++;
      const f = parseLogrus(line);
      const msg = f ? String(f.msg) : '';
      if (!seenVersion && /^running /.test(msg) && lines <= VERSION_LINES && Date.now() - startedAt < VERSION_MS) {
        const v = engineVersionOf(msg);
        if (v) {
          seenVersion = true;
          this.version = v;
          if (this.cfg.engineVersionCheck && v !== this.expected) {
            log.error(`the engine says it is ${v} but this bridge needs ${this.expected}: stopping it (reinstall Encore Bridge)`);
            this.mismatch = true;
            try { child.kill(); } catch (e) { /* gone */ }
          }
        }
      }
      if (/^api server listening/.test(msg) && this.child === child && this.state === 'starting') this.setState('running');
      const c = cleanLine(line, this.redact);
      if (c) log[c.level]('engine:', c.text);
    };
    for (const s of [child.stdout, child.stderr]) {
      s.setEncoding('utf8');
      readline.createInterface({ input: s, crlfDelay: Infinity }).on('line', onLine);
    }
    const alive = setTimeout(() => { if (this.child === child && this.state === 'starting') this.setState('running'); }, RUNNING_AFTER_MS);
    alive.unref();
    child.on('error', (e) => {
      if (child.pid) { log.warn('engine process:', e.code || e.message); return; }
      clearTimeout(alive);
      if (this.child === child) this.onExit(null, startedAt, e);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(alive);
      if (this.child === child) this.onExit(code == null ? signal : code, startedAt, null);
      this.emit('exit', code, signal);
    });
  }

  onExit(code, startedAt, err) {
    this.child = null;
    if (this.stopping) { this.setState('stopped'); return; }
    if (this.mismatch) { this.setState('version_mismatch'); return; }
    if (err && err.code === 'ENOENT') { this.setState('missing'); log.error('the engine program is missing: reinstall Encore Bridge'); return; }
    const ran = Date.now() - startedAt;
    if (ran >= STABLE_MS) this.failures = 0;
    if (ran < QUICK_MS) this.failures++;
    if (err) log.warn(`the engine couldn't start (${err.code || err.message})`);
    else log.warn(`the engine stopped (exit ${code}) after ${Math.round(ran / 1000)} s`);
    if (this.failures >= GIVE_UP) {
      this.setState('stopped');
      log.error('the engine keeps stopping right after it starts: giving up until the bridge restarts');
      return;
    }
    const delay = BACKOFF_S[Math.min(Math.max(this.failures - 1, 0), BACKOFF_S.length - 1)];
    this.restarts++;
    this.setState('restarting');
    log.info(`restarting the engine in ${delay} s`);
    this.timer = setTimeout(() => this.spawnEngine(), delay * 1000);
    this.timer.unref();
  }

  // Ends the engine (and any pending restart). Resolves when it has exited, or after timeoutMs in any case.
  stop(timeoutMs = 3000) {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const child = this.child;
    if (!child) {
      if (this.managed && ['starting', 'running', 'restarting'].includes(this.state)) this.setState('stopped');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let t = null;
      const done = () => { clearTimeout(t); resolve(); };
      child.once('exit', done);
      try { child.kill(); } catch (e) { /* gone */ }     // Windows: TerminateProcess; elsewhere SIGTERM
      t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } resolve(); }, timeoutMs);
      t.unref();
    });
  }

  // For process.on('exit'): no waiting possible there.
  killNow() {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.child) { try { this.child.kill(); } catch (e) { /* gone */ } }
  }

  // The engine's pending device-code sign-in ({url, code, expires_at}, passed through from its GET /auth/code), or
  // null. The url is kept only when it is an https page on spotify.com. Asked at most every 1.5 s.
  signIn() {
    if (this.signInMemo.p && Date.now() - this.signInMemo.at < 1500) return this.signInMemo.p;
    const p = (async () => {
      if (this.managed && this.state !== 'running' && this.state !== 'starting') return null;
      try {
        const r = await fetch(this.cfg.engineUrl.replace(/\/$/, '') + '/auth/code', { signal: AbortSignal.timeout(2000) });
        if (r.status !== 200) return null;
        const j = await r.json();
        if (!j || !j.code) return null;
        const url = SPOTIFY_URL.test(String(j.url || '')) ? String(j.url) : null;
        return { url, code: String(j.code).slice(0, 32), expires_at: j.expires_at || null };
      } catch (e) { return null; }
    })();
    this.signInMemo = { at: Date.now(), p };
    return p;
  }
}

module.exports = { Supervisor, cleanLine, makeRedactor, engineVersionOf, parseLogrus, DEFAULT_CONFIG };
