'use strict';
// A stand-in for gateway/src/main.js that speaks the launcher side of CONTRACT.md (stdin quit, exit codes, the
// loopback routes) with no Spotify, engine or ffmpeg. wine-smoke.sh puts it in place of main.js to test the launcher;
// it is never part of a bundle. Every line it logs goes through the launcher into logs\bridge.log.
//   FAKE_EXIT=<n>          exit with code n right away (10/11/12: the launcher must wait for Restart bridge)
//   FAKE_IGNORE_QUIT=1     ignore the stdin quit line (the launcher must fall back to POST /local/v1/shutdown)
//   FAKE_STUBBORN=1        ignore quit and shutdown (the launcher must end the job)
//   FAKE_CHILD=1           start a child process that runs forever (the job must end it with the launcher)
//   FAKE_LISTENING=<n>     phones listening, as reported in the status (default 1)
//   FAKE_SIGNED_IN=1       the engine is signed in (no sign-in code in the status)
//   FAKE_SETUP=<state>     the setup guide in the status: complete (default), incomplete, or absent (an older bridge)
//   FAKE_VERSION=<v>       the bridge version in the status (default: config.js's next to this file, else 1.1.0)
//   FAKE_UPDATE_REQUEST=<action>  an admin-page update request (check, install, cancel) in the status until the
//                          launcher acknowledges it (CONTRACT.md §9)
//   FAKE_NO_UPDATE_ROUTE=1 answer POST /local/v1/update with 404 (an older bridge)
// Pushed update views (POST /local/v1/update) are logged as "update view pushed: state=… kind=… latest=… install=…".
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const t = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(t(), 'I', '[fake]', ...a);
const env = process.env;

if (env.FAKE_EXIT) {
  console.error(t(), 'E', '[fake] exiting with code', env.FAKE_EXIT);
  process.exit(Number(env.FAKE_EXIT));
}

const token = env.ENCORE_LAUNCHER_TOKEN || '';
const port = Number(env.PORT || 8095);
const started = Date.now();
let showcase = false;
let polls = 0;
let updateRequest = env.FAKE_UPDATE_REQUEST ? { id: '0123456789abcdef', action: env.FAKE_UPDATE_REQUEST } : null;
let lastPushed = '';

// the version the bridge would report: FAKE_VERSION, else the config.js this file replaced main.js next to
function bridgeVersion() {
  if (env.FAKE_VERSION) return env.FAKE_VERSION;
  try {
    const m = /^\s*version:\s*'([^']+)'/m.exec(fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8'));
    if (m) return m[1];
  } catch (e) { /* no config.js: the default */ }
  return '1.1.0';
}
const VERSION = bridgeVersion();

// the launcher replaces the user-profile path in log lines with %USERPROFILE%
log('starting; profile path check:', (env.USERPROFILE || 'C:\\Users\\someone') + '\\AppData\\Local\\Encore');
log('environment:', ['ENCORE_HOME', 'ENCORE_APP_DIR', 'ENCORE_LAUNCHER', 'ENCORE_LAUNCHER_TOKEN', 'FFMPEG', 'ENGINE_EXE', 'ENGINE_CONFIG_TEMPLATE', 'NODE_ENV']
  .map((k) => `${k}=${env[k] ? 'set' : 'MISSING'}`).join(' '), `NODE_OPTIONS=${env.NODE_OPTIONS ? 'LEAKED' : 'removed'}`);

let child = null;
if (env.FAKE_CHILD) {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  log('child process started, pid', child.pid);
}

function allowed(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!token || (ip !== '127.0.0.1' && ip !== '::1') || req.headers.origin) return false;
  const a = Buffer.from(String(req.headers['x-encore-launcher'] || ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function stop(why) {
  if (env.FAKE_STUBBORN) { log('ignoring', why); return; }
  log('stopping:', why);
  server.close();
  setTimeout(() => process.exit(0), 100);
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
  if (!req.url.startsWith('/local/')) return send(404, {});
  if (!allowed(req)) { log('refused a loopback route request'); return send(404, {}); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/local/v1/status') {
      if (++polls === 1 || polls % 10 === 0) log('status polled', polls, 'time(s)');
      return send(200, {
        contract: 1,
        bridge: { version: VERSION, uptime_s: Math.round((Date.now() - started) / 1000), port },
        engine: { state: 'running', version: '1.1.0', expected: '1.1.0', connected: true, signed_in: !!env.FAKE_SIGNED_IN, restarts: 0 },
        sign_in: env.FAKE_SIGNED_IN ? null : { url: 'https://www.spotify.com/pair?code=TESTCODE', code: 'TEST-CODE', expires_at: new Date(Date.now() + 600000).toISOString() },
        admin: { setup_needed: false },
        spotify: { connected: true },
        phones: { paired: 1, listening: Number(env.FAKE_LISTENING || 1) },
        playing: true,
        showcase,
        phone_url: showcase ? null : `http://192.0.2.10:${port}`,   // a documentation address
        ...(env.FAKE_SETUP === 'absent' ? {} : { setup: { complete: env.FAKE_SETUP !== 'incomplete' } }),
        update_request: updateRequest,
      });
    }
    if (req.method === 'POST' && req.url === '/local/v1/update') {
      if (env.FAKE_NO_UPDATE_ROUTE) return send(404, {});
      let v;
      try { v = JSON.parse(body || '{}'); } catch (e) { return send(400, {}); }
      const states = ['never', 'checking', 'up_to_date', 'available', 'error'];
      if (!v || v.v !== 1 || v.source !== 'launcher' || !states.includes(v.state) || Buffer.byteLength(body) > 8192) {
        log('update view refused');
        return send(400, {});
      }
      const line = `state=${v.state} kind=${v.kind} latest=${v.latest ? v.latest.version : 'none'} install=${v.install ? v.install.phase : 'none'}`;
      if (line !== lastPushed) { log('update view pushed:', line); lastPushed = line; }
      if (v.handled_request && updateRequest && v.handled_request === updateRequest.id) {
        log('update request handled:', updateRequest.action);
        updateRequest = null;
      }
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/local/v1/showcase') {
      try { showcase = !!JSON.parse(body || '{}').on; } catch (e) { return send(400, {}); }
      log('showcase', showcase ? 'on' : 'off');
      return send(200, { showcase });
    }
    if (req.method === 'POST' && req.url === '/local/v1/shutdown') {
      send(202, { ok: true });
      return stop('shutdown route');
    }
    send(404, {});
  });
});
server.on('error', (e) => {
  console.error(t(), 'E', '[fake] listen:', e.code);
  process.exit(e.code === 'EADDRINUSE' ? 10 : e.code === 'EACCES' ? 11 : 1);
});
server.listen(port, '127.0.0.1', () => log('listening on 127.0.0.1:' + port));

if (env.ENCORE_LAUNCHER === '1') {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'quit') {
        if (env.FAKE_IGNORE_QUIT) log('ignoring the quit line');
        else stop('quit line');
      }
    }
  });
  process.stdin.on('end', () => stop('stdin closed'));
}
