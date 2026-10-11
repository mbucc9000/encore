'use strict';
// The setup guide's network check (DESIGN-WIZARD.md §4): can a phone on the home network reach this bridge?
//  - the address: this computer's address on the home network (http.js's lanAddress(), as the Phone setup panel);
//  - listening: a TCP connect from the bridge to <address>:<port> (1.5 s). Windows Firewall doesn't filter this, so it
//    only proves the bridge listens on that address;
//  - Windows only, one read-only PowerShell run (no elevation): the Windows Firewall rules for this node.exe (Block
//    rules, an Allow rule for TCP <port> on Private / Any, as the tray's Fix firewall… checks), the installer's
//    "Encore Bridge (phone)" rule, and the network profile (Public / Private / Domain) of the adapter that holds the
//    address. The script is one constant string: its inputs come only from environment variables (ENCORE_NC_NODE,
//    ENCORE_NC_PORT, ENCORE_NC_ADDR), it never reads the profile's Name (that is the Wi-Fi network's name) or the
//    adapter's alias, and it prints one compressed JSON object with fixed keys. Its output is never logged.
//  - Docker / other: no PowerShell; the private IPv4 addresses on real adapters, the chosen one first.
// Only the tray's Troubleshooting → Fix firewall… changes anything (it needs administrator permission).
// One check at a time; a result is reused for 15 s (fresh: a new one once it is older than 3 s). One log line per
// check, with the problem codes only.
//
// The home's public IP for the setup guide's step 8, Listen away from home (DESIGN-WIZARD.md §5.2; PublicIp below):
// asked of a public IP-check service ONLY when the user presses Find my public IP (POST /admin/api/wizard/public-ip),
// never at startup, on a timer or on a read. The services are a fixed list tried one after another over HTTPS, IPv4
// only, 4 s each, no redirects, at most 64 bytes, a strict dotted IPv4 answer, and a generic User-Agent (never the
// bridge's name: the services see the home's IP, and needn't learn that an Encore Bridge listens there). The answer is
// kept in memory only, for 30 s (Check again: a new look once it is 5 s old), then dropped, and is never written
// anywhere or logged, at any level: the log line has the service names and failure codes only.
const os = require('os');
const net = require('net');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const log = require('./log');

const REUSE_MS = 15000;
const FRESH_MS = 3000;
const CONNECT_MS = 1500;
const PS_TIMEOUT_MS = 30000;
const RULE_NAME = 'Encore Bridge (phone)';

// The read-only check. Constant: nothing is ever put into it; Get-NetFirewall* get the rule they read named
// explicitly (an empty pipeline into them could mean every rule).
const PS_SCRIPT = [
  "$ErrorActionPreference='Stop';$node=[string]$env:ENCORE_NC_NODE;$port=[string]$env:ENCORE_NC_PORT;$addr=[string]$env:ENCORE_NC_ADDR;",
  "$r=[ordered]@{block=0;allow=$false;rule=$false;profile='';error=''};",
  'try{$m=@();foreach($f in @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore|Where-Object{$_.Program -and ([Environment]::ExpandEnvironmentVariables($_.Program) -ieq $node)})){',
  "foreach($x in @(Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $f)){if([string]$x.Direction -eq 'Inbound' -and [string]$x.Enabled -eq 'True'){$m+=$x}}};",
  "$r.block=@($m|Where-Object{[string]$_.Action -eq 'Block'}).Count;",
  "foreach($x in @($m|Where-Object{[string]$_.Action -eq 'Allow'})){foreach($p in @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $x)){$lp=@($p.LocalPort);",
  "if((@('TCP','Any') -contains [string]$p.Protocol) -and ($lp -contains 'Any' -or $lp -contains $port) -and ([string]$x.Profile -match 'Private|Any')){$r.allow=$true}}};",
  `foreach($x in @(Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName '${RULE_NAME}' -ErrorAction SilentlyContinue)){`,
  "if([string]$x.Enabled -eq 'True' -and [string]$x.Direction -eq 'Inbound' -and [string]$x.Action -eq 'Allow'){",
  'foreach($p in @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $x)){if(@($p.LocalPort) -contains $port){$r.rule=$true}}}}',
  "}catch{$r.error='firewall'};",
  'try{$c=$null;if($addr){$i=@(Get-NetIPAddress -IPAddress $addr -ErrorAction SilentlyContinue)[0];',
  'if($i){$c=@(Get-NetConnectionProfile -InterfaceIndex $i.InterfaceIndex -ErrorAction SilentlyContinue)[0]}};',
  "if(-not $c){$all=@(Get-NetConnectionProfile);$c=@($all|Where-Object{[string]$_.NetworkCategory -eq 'Public'})[0];if(-not $c){$c=$all[0]}};",
  "if($c){$r.profile=[string]$c.NetworkCategory}}catch{if(-not $r.error){$r.error='profile'}};",
  '$r|ConvertTo-Json -Compress',
].join('');

// The problems and the texts the setup guide shows (DESIGN-WIZARD.md §4.3; the page has the same texts)
const PROBLEMS = ['no_address', 'not_listening', 'public_network', 'firewall_block', 'firewall_missing', 'check_failed'];

const profileWord = (c) => {
  const s = String(c || '').toLowerCase();
  return s === 'public' ? 'public' : s === 'private' ? 'private' : s.startsWith('domain') ? 'domain' : 'unknown';
};

// the last {...} line of PowerShell's output, with only the expected keys and types
function parsePs(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  if (!lines.length) return null;
  let j;
  try { j = JSON.parse(lines[lines.length - 1]); } catch (e) { return null; }
  if (!j || typeof j !== 'object') return null;
  const block = Number.isInteger(j.block) && j.block >= 0 ? j.block : 0;
  const err = j.error === 'firewall' || j.error === 'profile' ? j.error : j.error ? 'firewall' : '';
  return { block, allow: j.allow === true, rule: j.rule === true, profile: profileWord(j.profile), error: err };
}

function powershellExe(env = process.env) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// the child's environment: the bridge's, minus its secrets, plus the three inputs
function psEnv({ node, port, address }, env = process.env) {
  const e = { ...env };
  for (const k of ['ENCORE_LAUNCHER_TOKEN', 'ADMIN_PASSWORD', 'SPOTIFY_CLIENT_ID', 'NODE_OPTIONS']) delete e[k];
  e.ENCORE_NC_NODE = String(node || '');
  e.ENCORE_NC_PORT = String(port || '');
  e.ENCORE_NC_ADDR = address ? String(address) : '';
  return e;
}

function tcpConnect(host, port, timeoutMs = CONNECT_MS) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const end = (ok) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve(ok); };
    const t = setTimeout(() => end(false), timeoutMs);
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

class NetCheck {
  // platform: 'windows' | 'docker' | 'other' (cfg.platformKind). lanAddress(): the chosen address (http.js's memo,
  // asked directly: the check needs it even while Showcase hides it). candidates(): lanCandidates() of this computer.
  // exec, connect: injected in tests.
  constructor({ cfg = {}, platform, lanAddress = async () => null, candidates = () => [], exec = execFile, connect = tcpConnect,
    nodePath = process.execPath, env = process.env, now = Date.now } = {}) {
    this.cfg = cfg;
    this.platform = platform || cfg.platformKind || (process.platform === 'win32' ? 'windows' : 'other');
    this.lanAddress = lanAddress;
    this.candidates = candidates;
    this.exec = exec;
    this.connect = connect;
    this.nodePath = nodePath;
    this.env = env;
    this.now = now;
    this.last = null;          // the newest result (kept in memory only)
    this.running = null;
  }

  // the setup guide's step 5 summary: {ok, checked_at}
  summary() { return this.last ? { ok: this.last.ok, checked_at: this.last.checked_at } : { ok: null, checked_at: null }; }

  async check({ fresh = false } = {}) {
    if (this.running) return this.running;
    const age = this.last ? this.now() - this.last.checked_at : Infinity;
    if (this.last && (age < (fresh ? FRESH_MS : REUSE_MS))) return this.last;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  ps(address, port) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.exec(powershellExe(this.env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
          { windowsHide: true, timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024, env: psEnv({ node: this.nodePath, port, address }, this.env) },
          (err, stdout) => resolve(err ? null : parsePs(stdout)));        // (stdout and stderr are never logged)
      } catch (e) { resolve(null); }
      if (child && child.stdin) { try { child.stdin.end(); } catch (e) { /* closed */ } }
    });
  }

  async run() {
    const port = this.cfg.port || 8095;
    let address = null;
    try { address = await this.lanAddress(); } catch (e) { address = null; }
    const problems = [];
    let listening = false;
    if (!address) problems.push('no_address');
    else {
      try { listening = !!(await this.connect(address, port)); } catch (e) { listening = false; }
      if (!listening) problems.push('not_listening');
    }
    const r = { platform: this.platform, checked_at: this.now(), address, addresses: null, port, listening, profile: null, firewall: null, problems, ok: false };
    if (this.platform === 'windows') {
      const ps = await this.ps(address, port);
      if (!ps) {
        r.profile = 'unknown';
        problems.push('check_failed');
      } else {
        r.profile = ps.error === 'profile' ? 'unknown' : ps.profile;
        if (ps.error !== 'firewall') r.firewall = { allow: ps.allow, block: ps.block, rule: ps.rule };
        if (r.profile === 'public') problems.push('public_network');
        if (r.firewall && r.firewall.block > 0) problems.push('firewall_block');
        if (r.firewall && !r.firewall.allow) problems.push('firewall_missing');
        if (ps.error) problems.push('check_failed');
      }
    } else {
      let list = [];
      try { list = (this.candidates() || []).filter((c) => !c.virtual).map((c) => c.address); } catch (e) { list = []; }
      r.addresses = [...new Set([...(address ? [address] : []), ...list])];
    }
    r.ok = problems.length === 0;
    this.last = r;
    log.info(`network check: ${r.ok ? 'ok' : problems.join(', ')}`);
    return r;
  }

  // the answer for the page: no addresses while Showcase is on
  static trim(r, showcase) {
    if (!r || !showcase) return r;
    return { ...r, address: null, addresses: null };
  }
}

// ---------------------------------------------------------------- the home's public IP (step 8; DESIGN-WIZARD.md §5.2)
// The IP-check services, tried in this order; the first valid answer wins. Each answers the caller's IP as plain text.
const PUBLIC_IP_SERVICES = Object.freeze([
  Object.freeze({ host: 'api.ipify.org', url: 'https://api.ipify.org/' }),
  Object.freeze({ host: 'ipv4.icanhazip.com', url: 'https://ipv4.icanhazip.com/' }),
  Object.freeze({ host: 'ifconfig.me', url: 'https://ifconfig.me/ip' }),
]);
const PIP_TIMEOUT_MS = 4000;          // the whole exchange with one service: connect, TLS, answer
const PIP_MAX_BYTES = 64;             // an answer longer than this isn't an IP
const PIP_REUSE_MS = 30000;           // the last good answer is reused this long ...
const PIP_FRESH_MS = 5000;            // ... and Check again looks again once it is this old
const PIP_USER_AGENT = 'Mozilla/5.0';   // generic: the services needn't learn that this IP runs Encore Bridge

// The user-visible messages (DESIGN-WIZARD.md §1.7; the page has the warning texts)
const PUBLIC_IP_MSG = {
  public_ip_failed: 'Couldn\'t find your public IP: no IP-check service answered. Check that this computer is online and press Find my public IP again, or look it up in your router\'s admin page (its Internet or WAN address).',
  showcase_on: 'Showcase is on, so your public IP stays hidden. Turn Showcase off to find it.',
};

// a strict dotted IPv4: four numbers 0-255, no leading zeros, nothing else
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_STRICT = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const isStrictIpv4 = (s) => typeof s === 'string' && IPV4_STRICT.test(s);

// "shared": carrier-grade NAT (100.64.0.0/10); "not_public": private, loopback, link-local, reserved, benchmark,
// multicast and the rest up to 255.255.255.255; else null. (The documentation ranges count as public.)
const SHARED_V4 = new net.BlockList();
SHARED_V4.addSubnet('100.64.0.0', 10, 'ipv4');
const NOT_PUBLIC_V4 = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) NOT_PUBLIC_V4.addSubnet(a, bits, 'ipv4');
function publicIpWarning(ip) {
  if (!isStrictIpv4(ip)) return 'not_public';
  return SHARED_V4.check(ip, 'ipv4') ? 'shared' : NOT_PUBLIC_V4.check(ip, 'ipv4') ? 'not_public' : null;
}

class PublicIp {
  // get: https.get (injected in tests); services: the fixed list; setTimer / clearTimer: the per-request 4 s timer;
  // setForget / clearForget: the timer that drops the answer once it can't be reused (30 s)
  constructor({ cfg = {}, get = https.get, services = PUBLIC_IP_SERVICES, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    setForget = setTimeout, clearForget = clearTimeout } = {}) {
    Object.assign(this, { cfg, get, services, now, setTimer, clearTimer, setForget, clearForget });
    this.last = null;            // {ip, service, checked_at, warning}: in memory only, for 30 s; never written or logged
    this.forgetTimer = null;
    this.running = null;
  }

  // drops the answer (its 30 s are over): nothing keeps the home's public IP longer than it can be reused
  forget() {
    if (this.forgetTimer != null) { try { this.clearForget(this.forgetTimer); } catch (e) { /* gone */ } }
    this.forgetTimer = null;
    this.last = null;
  }

  // the route's answer (§5.2)
  answer(r, reused) {
    const port = this.cfg.port || 8095;
    return { ip: r.ip, port, away: r.warning ? null : `http://${r.ip}:${port}`, warning: r.warning, service: r.service, checked_at: r.checked_at, reused };
  }

  // POST /admin/api/wizard/public-ip: one lookup at a time (a request while one runs gets its result); the last good
  // answer is reused for 30 s, or 5 s with fresh (Check again). Throws {status: 502, code: 'public_ip_failed'}.
  lookup({ fresh = false } = {}) {
    if (this.running) return this.running;
    if (this.last) {
      const age = this.now() - this.last.checked_at;
      if (age < 0 || age >= PIP_REUSE_MS) this.forget();              // too old to reuse: not kept either
      else if (age < (fresh ? PIP_FRESH_MS : PIP_REUSE_MS)) return Promise.resolve(this.answer(this.last, true));
    }
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    const failed = [];
    for (const s of this.services) {
      const r = await this.ask(s);
      if (r.ip) {
        this.forget();
        const last = this.last = { ip: r.ip, service: s.host, checked_at: this.now(), warning: publicIpWarning(r.ip) };
        // dropped after 30 s even when nobody asks again (unref'd: it never keeps the bridge running)
        try {
          this.forgetTimer = this.setForget(() => { if (this.last === last) { this.last = null; this.forgetTimer = null; } }, PIP_REUSE_MS);
          if (this.forgetTimer && typeof this.forgetTimer.unref === 'function') this.forgetTimer.unref();
        } catch (e) { this.forgetTimer = null; }
        log.info(`public IP check: ok (${s.host})${failed.length ? ` after ${failed.join(', ')}` : ''}`);     // (never the IP)
        return this.answer(this.last, false);
      }
      failed.push(`${s.host} ${r.code}`);
    }
    log.info(`public IP check: failed (${failed.join(', ')})`);
    throw Object.assign(new Error(PUBLIC_IP_MSG.public_ip_failed), { status: 502, code: 'public_ip_failed' });
  }

  // one service: {ip} or {code: 'timeout' | 'http_<status>' | 'bad_answer' | 'network'} (never an exception's text:
  // Node's messages carry addresses)
  ask(s) {
    return new Promise((resolve) => {
      let done = false;
      let req = null;
      let timer = null;
      const end = (r) => {
        if (done) return;
        done = true;
        if (timer != null) this.clearTimer(timer);
        if (req) { try { req.destroy(); } catch (e) { /* gone */ } }
        resolve(r);
      };
      timer = this.setTimer(() => end({ code: 'timeout' }), PIP_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        // IPv4 only (a port forward is an IPv4 thing); certificates checked as always; redirects are never followed
        req = this.get(s.url, { family: 4, headers: { 'User-Agent': PIP_USER_AGENT, Accept: 'text/plain' } }, (res) => {
          if (res.statusCode !== 200) { try { res.resume(); } catch (e) { /* gone */ } end({ code: `http_${res.statusCode}` }); return; }
          const parts = [];
          let n = 0;
          res.on('data', (c) => {
            if (done) return;
            n += c.length;
            if (n > PIP_MAX_BYTES) end({ code: 'bad_answer' });
            else parts.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8').trim();
            end(isStrictIpv4(text) ? { ip: text } : { code: 'bad_answer' });
          });
          res.on('error', () => end({ code: 'network' }));
          res.on('close', () => end({ code: 'network' }));       // (closed before its end: after 'end' this does nothing)
        });
        // (always listened to: destroying a request that has no answer yet emits an error)
        if (req && typeof req.on === 'function') req.on('error', () => end({ code: 'network' }));
        if (done && req) { try { req.destroy(); } catch (e) { /* gone */ } }
      } catch (e) { end({ code: 'network' }); }
    });
  }
}

module.exports = { NetCheck, PS_SCRIPT, PROBLEMS, parsePs, psEnv, powershellExe, tcpConnect, RULE_NAME,
  PublicIp, PUBLIC_IP_SERVICES, PUBLIC_IP_MSG, publicIpWarning, isStrictIpv4, PIP_TIMEOUT_MS, PIP_MAX_BYTES, PIP_REUSE_MS, PIP_USER_AGENT };
