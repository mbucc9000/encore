'use strict';
// The admin page (src/admin.html) with the setup guide (DESIGN-WIZARD.md §1): its inline script parses; it loads
// nothing from outside (no external script, style, font or image); its only https:// link is the Spotify developer
// dashboard (the engine's sign-in link is built at run time from the bridge's answer); no /repo/ address and no
// public IP-check service address (the bridge asks them, never the page); no IP address other than the examples; the
// ten steps; and the user-visible strings the docs quote (§1.3 step 8, §1.7, §4.3) are there exactly. The guide's
// script is also run against a stub page (no browser) for step 7's code renewal rules, Showcase on step 5 and step 2,
// step 3's caught sign-in errors, step 6's Encore repo, and step 8: Find my public IP (only on the button), the Away
// address, the warnings, an error, Showcase dropping the answer, leaving the step, the live tick and the summary note;
// step 10 (Turn on Jam): the Jam card's check, its tick, the 30-minute wait after a refusal, a check in flight while
// the step is left and opened again, Skip Jam (finishing only when no other step is left) and Finish.
// The Updates section and banner (DESIGN-UPDATES.md §5.9, §6, §7.2, §8): the texts exactly, the Docker commands with
// placeholders only, and each kind's card drawn from a view (the stub page again): links only from checked versions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin.html'), 'utf8');
const scripts = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const styles = [...HTML.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
const JS = scripts.map((m) => m[2]).join('\n');

test('one inline script, and it parses', () => {
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1].trim(), '', 'no src or other attributes');
  assert.doesNotThrow(() => new vm.Script(JS, { filename: 'admin.html <script>' }));
});

test('nothing loaded from outside the bridge', () => {
  assert.ok(!/<script\b[^>]*\bsrc\s*=/i.test(HTML), 'no external script');
  assert.ok(!/<link\b/i.test(HTML), 'no stylesheet, font or icon links');
  assert.ok(!/@import|@font-face/i.test(styles), 'no imported styles or web fonts');
  assert.ok(!/url\(\s*['"]?(https?:)?\/\//i.test(styles), 'no outside images in the styles');
  assert.ok(!/<(img|iframe|video|audio|source|embed|object)\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\//i.test(HTML), 'no outside media');
  assert.ok(!/\bfetch\(\s*['"`]https?:/i.test(JS) && !/new\s+(WebSocket|EventSource)\(/.test(JS), 'the page talks to its own bridge only');
});

test('no built-in Cydia source address, no public IP-check service address (the bridge asks them, not the page)', () => {
  assert.ok(!HTML.includes('/repo/') && !/\/repo\b/.test(JS), 'no /repo/');
  for (const host of ['api.ipify.org', 'icanhazip.com', 'ifconfig.me']) {
    assert.ok(!new RegExp(`https?://[^\\s"'\`<>]*${host.replace(/\./g, '\\.')}`).test(HTML), `no ${host} address`);
  }
  assert.ok(!/fetch\(\s*['"`]https?:/.test(JS));
  // the page only names the first service in a sentence (DESIGN-WIZARD.md §1.3 step 8), never as a link
  assert.ok(!/<a\b[^>]*ipify/i.test(HTML));
});

test('no IP address in the page other than 192.168.1.20, 127.0.0.1 and the documentation ranges', () => {
  const ips = [...new Set([...HTML.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g)].map((m) => m[0]))];
  const ok = (ip) => ip === '192.168.1.20' || ip === '127.0.0.1' || /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(ip);
  assert.deepEqual(ips.filter((ip) => !ok(ip)), []);
});

test('the ten steps, in order, with their titles (DESIGN-WIZARD.md §1.2)', () => {
  const ctx = vm.createContext({ T: (s) => s });                // (English: T gives the text back)
  vm.runInContext(JS.slice(JS.indexOf('const WZ_STEPS = ['), JS.indexOf('const WZ_KEYS')) + ';this.WZ_STEPS = WZ_STEPS;', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.WZ_STEPS)), [
    { k: 'password', t: 'Protect this page' },
    { k: 'client_id', t: 'Your Spotify developer app', skip: 'Skip for now' },
    { k: 'spotify', t: 'Connect your Spotify account', skip: 'Skip for now' },
    { k: 'engine', t: 'Sign in the Encore engine', skip: 'Skip for now' },
    { k: 'network', t: 'Check your network', skip: 'Skip for now' },
    { k: 'app', t: 'Put Encore on your phone', skip: 'I\'ve installed it' },
    { k: 'pair', t: 'Pair your phone', skip: 'Skip for now' },
    { k: 'away', t: 'Listen away from home', skip: 'Skip for now' },
    { k: 'play', t: 'Play a song' },
    { k: 'jam', t: 'Turn on Jam', skip: 'Skip Jam' },
  ]);
});

test('the only https:// links: the Spotify developer dashboard and Encore\'s release pages (built at run time from a checked version), opened safely', () => {
  const links = [...new Set([...HTML.matchAll(/https:\/\/[^\s"'`<>)\\]+/g)].map((m) => m[0]))].sort();
  assert.deepEqual(links, ['https://developer.spotify.com/dashboard', 'https://github.com/mbucc9000/encore/releases/download/v',
    'https://github.com/mbucc9000/encore/releases/tag/v']);
  assert.match(JS, /const UPD_RELEASES = 'https:\/\/github\.com\/mbucc9000\/encore\/releases\/tag\/v';/);
  assert.match(JS, /const UPD_DOWNLOAD = 'https:\/\/github\.com\/mbucc9000\/encore\/releases\/download\/v';/);
  assert.match(HTML, /'<a class="btn" href="https:\/\/developer\.spotify\.com\/dashboard" target="_blank" rel="noopener noreferrer">' \+ T\('Open the Spotify developer dashboard'\) \+ '<\/a>'/);
  // every new-tab link has rel=noopener
  for (const m of HTML.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) assert.match(m[0], /rel="noopener/, m[0]);
});

test('the setup guide\'s strings (DESIGN-WIZARD.md §1.7, §4.3) as the docs quote them', () => {
  // HTML entities and JS string escapes as the page writes them (texts in the script are T('English') calls)
  const text = HTML.replace(/\\'/g, '\'').replace(/&amp;/g, '&');
  const want = [
    // the steps (§1.2)
    'Protect this page', 'Your Spotify developer app', 'Connect your Spotify account', 'Sign in the Encore engine', 'Check your network',
    'Put Encore on your phone', 'Pair your phone', 'Listen away from home', 'Play a song', 'Turn on Jam', 'Setup complete',
    // header, banner, label, close
    '>Setup guide<', "Setup isn't finished.", 'Continue setup', 'Close the guide', "T('Step {n} of {total}', { n: i + 1, total: WZ_STEPS.length })",
    // buttons
    '>Back<', '>Next<', 'Skip for now', "I've installed it", "T('Copy')", "'Copied'", 'Open the Spotify developer dashboard', 'Save Client ID',
    "T('Change')", '>Connect<', 'Use this address', 'Check again', 'New code', '>Finish<', 'Open the admin page', 'Save password',
    'Find my public IP', "T('Listen away from home')", 'Skip Jam', "T('Check Jam access')",
    // waiting lines
    'Waiting for Spotify…', 'Waiting for you to approve the sign-in…', 'Waiting for Encore to be picked in a Spotify app…',
    'Waiting for your phone…', 'Finding your public IP…', 'Waiting for your phone to connect from outside your home network…',
    'Waiting for music on your phone…',
    // done lines (new)
    'Your phone reached Encore Bridge from outside your home network.',
    // messages
    "That isn't a Client ID. It is 32 letters (a-f) and digits, under Settings → Basic Information in your developer app. (Not the client secret.)",
    "Changing the Client ID disconnects your Spotify account. You'll connect it again in the next step. Change it?",
    'Add your account under User Management in your developer app (step 2), then press Connect again.',
    'If Spotify shows INVALID_CLIENT: Invalid redirect URI, the Redirect URI in your developer app isn\'t exactly http://127.0.0.1:8888/callback.',
    'If Spotify shows INVALID_CLIENT: Invalid client, the Client ID saved in step 2 is wrong (often the client secret was pasted, which looks just like it): go to step 2, press Change and paste the Client ID.',
    'Spotify refused your account.', 'Spotify\'s page was cancelled, so nothing was connected. Press Connect again.',
    'Your Spotify account wasn\'t connected: the tab Spotify opened says why. Press Connect again.',
    // step 6 (the Encore repo)
    'Encore comes from the Encore repo in Cydia. Its address:',
    'On the phone, open <b>Cydia</b> → <b>Sources</b> → <b>Edit</b> → <b>Add</b>.',
    'Type the address exactly (with <code>{scheme}</code> and the <code>/</code> at the end) → <b>Add Source</b>.',
    'Tap the new source → <b>All Packages</b> → <b>Encore</b> → <b>Install</b> → <b>Confirm</b>.',
    'When Cydia is done, tap <b>Return to Cydia</b>.',
    'Updates come from the same repo: open Cydia → <b>Changes</b> → <b>Refresh</b>. Keep Encore and Encore Bridge on the same version.',
    'Then press <b>I\'ve installed it</b>.',
    // step 7's new sentence
    '<b>Away</b>: leave it empty for now (the next step finds that address).',
    // step 8 (§1.3)
    'To play music away from home (on mobile data or someone else\'s Wi-Fi), your router has to pass Encore\'s port on to this computer. ',
    'This is called <b>port forwarding</b>. You set it up once, in your router\'s settings.',
    "'<h3>' + T('1. Forward the port on your router') + '</h3>", "'<h3>' + T('2. Find your Away address') + '</h3>", "'<h3>' + T('3. Test it') + '</h3>'",
    "T('Is this safe?') + '</h3>'",
    'Open your router\'s admin page in a browser and sign in. Its address and password are often printed on the router itself. {gateway}',
    'If not, its address is this computer\'s <b>Default Gateway</b>: run <code>ipconfig</code> in Command Prompt to see it.',
    'If not, its address is this computer\'s default gateway: run <code>ip route</code> and use the address after <code>default via</code>.',
    'Find <b>Port forwarding</b> (some routers call it <b>Virtual server</b>, <b>NAT</b> or <b>Applications & gaming</b>) and add a rule:',
    "<span>' + T('Protocol') + '</span>","<span>${T('External port')}</span>", "<span>${T('Forward to (internal address)')}</span>", "<span>${T('Internal port')}</span>",
    'Save it. Forward this one port only, never anything else.',
    'Give this computer a fixed address, so the rule keeps pointing at it: in the router, look for <b>DHCP reservation</b> (or <b>Address reservation</b>, <b>Static lease</b>) and reserve ',
    ' for this computer.',
    'Windows Firewall already lets these connections in (the rule <b>Encore Bridge (phone)</b>), as long as this network is set to <b>Private</b> (step 5).',
    'If this computer runs its own firewall (ufw, firewalld), allow TCP port {port} from anywhere, not only from your home network (for example <code>sudo ufw allow {port}/tcp</code>).',
    'Other addresses of this computer: ', 'Use the one your router lists for this computer.',
    'Your Away address is your home\'s public IP plus Encore\'s port. Press the button and Encore Bridge looks it up.',
    'Your Away address:', 'On the phone, open Encore → <b>Settings</b> → <b>Away Address</b>, type this address and tap <b>Save</b>. (On Encore\'s setup screen it goes in the <b>Away</b> field.)',
    'Your public IP: ',
    'Your home\'s public IP can change, for example when the router restarts. If Encore stops connecting away from home, come back here, ',
    'press <b>Find my public IP</b> and update the Away Address. A dynamic DNS name (many routers offer one) avoids this: then type ',
    'Port forwarding needs a public IP of your own. To check, find your router\'s <b>Internet</b> (WAN) address in its admin page. ',
    'If it isn\'t the IP above and this computer runs a VPN app, turn the VPN app off and press <b>Check again</b>: the IP-check service saw the VPN\'s address. ',
    'If it still isn\'t the IP above, or it starts with 10., 100.64 to 100.127, 172.16 to 172.31 or 192.168., your internet provider shares one public IP ',
    'between many homes (CGNAT), or another router sits in front of yours. Another router: forward the port on that router too. ',
    'CGNAT: remove the port forward you added (it would only let your provider\'s other customers in) and ask your provider for a public IPv4 ',
    'address.\') + \'</p>\' +',
    'Encore Bridge asks a public IP-check service (api.ipify.org, or a backup) only when you press the button. It keeps the answer for 30 seconds, in memory only.',
    'On the phone, turn Wi-Fi off so it uses mobile data, then open Encore → <b>Settings</b>: <b>Status</b> should say <b>Away</b>. ',
    '(iPod touch: join another Wi-Fi instead, for example your phone\'s hotspot.) ',
    'Testing on your own Wi-Fi proves nothing: many routers can\'t reach their own public IP from inside.',
    'Only Encore\'s phone connection is reachable, and every request from a phone must be signed with the key it got when you paired it. ',
    'The admin page and pairing still answer only on your home network, even with the port open. Use a strong admin password (step 1), ',
    'unpair a lost phone on the admin page right away, and forward only port ',
    '. The music itself travels unencrypted (plain HTTP).',
    'Check it once, from outside your home network (as in <b>Test it</b>): in Safari, open your Away address with <code>/admin</code> at the end. ',
    'It must say <b>Not from this address.</b> If it asks for a password instead, your router hides where connections come from: ',
    'your router hides where connections come from: remove the port forward.\') + \'</p>\';',
    'Showcase is on, so your public IP stays hidden. Turn Showcase off to find it.',
    'This IP (100.64 to 100.127) is a shared address of your internet provider (carrier-grade NAT), so a port forward can\'t reach your home through it. Remove the port forward you added: here it would only let your provider\'s other customers in. Ask your provider for a public IPv4 address.\'',
    'This isn\'t a public IP, so a port forward can\'t reach your home through it. Check your router\'s Internet (WAN) address.\'',
    '<b>Listen away from home</b> isn\'t set up yet: ', 'until it is, Encore plays only on your home Wi-Fi.',
    'without a port forward, Encore plays only on your home Wi-Fi.',
    // step 8's Open your router (the bridge found this computer's default gateway)
    'Open your router\'s admin page and sign in:', "T('Open your router')", 'The router\'s password is usually printed on the router itself.',
    // the dashboard's Phone setup card
    'Encore\'s Cydia repo: <code>', 'Away from home: step 8 of the setup guide finds the address to type into Encore.',
    'This code has run out. Press New code for another one.',
    'Showcase is on, so connecting is hidden: Spotify\'s page shows your account. Turn Showcase off to connect.',
    'Never run uicache yourself. If the icon doesn\'t show up, respring.',
    'Showing Encore off? Turn on <b>Showcase</b> (top right) here and <b>Anonymous Mode</b> in the app\'s Settings.',
    '<b>Not set up yet:</b> add your Client ID in the setup guide (step 2).',
    // the values to copy
    "valCopy('Encore')", "valCopy('My iOS 6 player')", "const REDIRECT_URI = 'http://127.0.0.1:8888/callback'",
    'docker compose logs gateway | grep "setup code"',
    // the network check's texts (§4.3)
    "Couldn't tell this computer's address on your home network. Your router's list of devices shows it.",
    "Encore Bridge doesn't answer on its home-network address. Restart it (Windows: Troubleshooting → Restart bridge in the Encore Bridge menu; Docker: docker compose restart gateway).",
    "This computer's network is set to Public, and Windows keeps your phone out on Public networks. If this is your home network, set it to Private: Settings → Network & internet → Wi-Fi (or Ethernet) → your network → Network profile type → Private.",
    'Windows Firewall has a rule that blocks Encore Bridge (Windows makes one when its security prompt is cancelled). Fix it: in the Encore Bridge menu (its icon in the notification area), choose Troubleshooting → Fix firewall…',
    'No Windows Firewall rule lets your phone reach Encore Bridge on port {port}. Fix it: in the Encore Bridge menu, choose Troubleshooting → Fix firewall…',
    "Couldn't read the Windows network settings. If your phone can't connect later, use Troubleshooting → Fix firewall… in the Encore Bridge menu.",
    "This computer's address: ", 'Encore Bridge is listening on port ', 'Network profile: ', 'Windows Firewall lets your phone in',
    'Your phone must be on the same network as this computer: the same Wi-Fi, not a guest network.',
  ];
  for (const s of want) assert.ok(text.includes(s), `missing: ${s}`);
});

test('the guide never uses alert(); the clipboard API only in a secure context; no storage of the Client ID', () => {
  const guide = JS.slice(JS.indexOf('// ================================================================= the setup guide'));
  assert.ok(guide.length > 1000);
  const fns = guide.slice(0, guide.indexOf('// ---- the start'));
  // openWizard runs from the dashboard (its failure is an alert there); every other guide function writes into the step
  assert.equal((fns.replace(/async function openWizard[\s\S]*?\n}\n/, '').match(/\balert\(/g) || []).length, 0);
  assert.match(JS, /window\.isSecureContext && navigator\.clipboard/);
  // the browser keeps one thing only: the page's language (encore.lang), never the Client ID or anything else
  const kept = [...JS.matchAll(/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b[^;\n]*/g)].map((m) => m[0]);
  assert.ok(kept.length > 0 && kept.every((k) => /^localStorage\.(getItem|setItem)\(LANG_KEY[,)]/.test(k)), kept.join('\n'));
  assert.match(JS, /const LANG_KEY = 'encore\.lang';/);
  assert.match(HTML, /id="wzCid"[^>]*autocomplete="off"[^>]*spellcheck="false"|id="wzCid"[^>]*spellcheck="false"/);
  assert.match(HTML, /aria-live="polite"/);
});

// ---- the guide's script run against a stub page (no browser): the timers, the answers and document.hidden are ours
// (nav: the browser's navigator; storage: its localStorage, none by default; marked: the elements with data-t* attributes)
function stubPage({ search = '?setup=1', answers, nav = {}, storage, marked = [] }) {
  const els = new Map();
  const fake = (id) => ({ id, style: {}, innerHTML: '', textContent: '', value: '', dataset: {}, isConnected: true,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {} });
  const listeners = {};
  const timers = [];
  const calls = [];
  const heads = [];
  const doc = { hidden: false, getElementById: (id) => { if (!els.has(id)) els.set(id, fake(id)); return els.get(id); },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, createElement: () => fake('x'), body: { appendChild() {} },
    documentElement: { lang: 'en' }, querySelectorAll: (sel) => marked.filter((e) => e.hasAttribute(sel.slice(1, -1))) };
  const ctx = vm.createContext({
    document: doc, window: { open: () => ({ close() {} }), isSecureContext: false }, navigator: nav, URLSearchParams, console,
    location: { search, replace() {}, reload() { ctx.reloaded = true; } }, history: { replaceState() {} }, alert() {}, confirm: () => true,
    setTimeout: (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].live = false; }, setInterval: () => 0, clearInterval() {},
    ...(storage ? { localStorage: storage } : {}),
    fetch: async (u, o = {}) => {
      const p = String(u).replace(/^\/admin\/api\//, '');
      calls.push(p);
      heads.push([p, { ...(o.headers || {}) }]);
      const body = o.body ? JSON.parse(o.body) : undefined;
      const j = await answers(p, body);
      const status = j && j.__status ? j.__status : 200;
      return { ok: status < 400, status, json: async () => j };
    },
  });
  vm.runInContext(JS, ctx, { filename: 'admin.html <script>' });
  const run = (code) => vm.runInContext(code, ctx);
  // the newest pending timer whose function is `name`, fired once
  const fire = async (name) => {
    await until(() => timers.some((x) => x.live && x.f.name === name), 'a pending ' + name);
    const t = [...timers].reverse().find((x) => x.live && x.f.name === name);
    t.live = false;
    return t.f();
  };
  return { doc, run, fire, calls, heads, listeners, el: doc.getElementById, timers, ctx };
}
const settle = () => new Promise((r) => setImmediate(r));
async function until(fn, what) { for (let i = 0; i < 100; i++) { if (fn()) return; await settle(); } assert.fail('never: ' + what); }

function wizardAnswer(o = {}) {
  return { v: 1, now: 1000, platform: 'docker', showcase: !!o.showcase, show: true, complete: false, complete_how: null, dismissed: false, skipped: [],
    steps: {
      password: { done: true, how: 'stored' },
      client_id: { done: true, source: 'data', editable: true, hint: o.showcase ? null : '…cdef' },
      spotify: { done: false, configured: true, catch_callback: true, auth_broken: false, error: o.spError || null },
      engine: { done: true, state: 'signed_in', managed: true },
      network: { done: false, ok: null, checked_at: null },
      app: { done: !!o.pairedAt, repo_url: 'https://mbucc9000.github.io/slopkit/' },
      pair: { done: false, paired: o.pairedAt ? 1 : 0, newest_at: o.pairedAt || null, address: o.showcase ? null : '192.168.1.20', port: 8095 },
      away: { done: !!o.awayAt, seen_at: o.awayAt || null, address: o.showcase ? null : '192.168.1.20',
        addresses: o.showcase ? null : ['192.168.1.20', ...(o.otherAddr ? [o.otherAddr] : [])], router: o.showcase ? null : o.router || null, port: 8095 },
      play: { done: false, played_at: null },
    } };
}

test('step 7: a code that runs out is renewed only while the page is shown, no phone paired since, at most 3 times in a row', async () => {
  const st = { codes: 0, pairedAt: null };
  const pg = stubPage({ search: '?setup=1&step=pair', answers: (p) => {
    if (p === 'setup') return { setup: false, platform: 'docker' };
    if (p === 'showcase') return { showcase: false };
    if (p === 'wizard') return wizardAnswer({ pairedAt: st.pairedAt });
    if (p === 'pair-code') { st.codes++; return { code: String(100000 + st.codes), expires_in: 300 }; }
    return {};
  } });
  await until(() => st.codes === 1, 'the first code when the step opens');
  assert.equal(pg.run('WZ.step'), 'pair');
  for (let n = 2; n <= 4; n++) {                        // three renewals in a row while shown
    await pg.fire('wzCodeOut');
    await until(() => st.codes === n, 'renewal ' + n);
  }
  await settle();
  await pg.fire('wzCodeOut');                                  // the fourth time: no more by itself
  await settle(); await settle();
  assert.equal(st.codes, 4);
  assert.equal(pg.run('WZ.code'), '');
  assert.match(pg.el('wzPairExp').textContent, /This code has run out\. Press New code for another one\./);
  pg.run('wzNewCode()');                                 // New code: at once, and the count starts over
  await until(() => st.codes === 5, 'New code');
  await settle();
  pg.doc.hidden = true;                                  // runs out while the page is hidden: nothing new
  await pg.fire('wzCodeOut');
  await settle(); await settle();
  assert.equal(st.codes, 5);
  assert.equal(pg.run('WZ.codeOut'), true);
  pg.doc.hidden = false;                                 // shown again: a new one
  for (const f of pg.listeners.visibilitychange) f();
  await until(() => st.codes === 6, 'a code when the page is shown again');
  await settle();
  st.pairedAt = 5000;                                    // a phone paired since the step opened: no renewal
  await pg.run('wzPoll()');
  await pg.fire('wzCodeOut');
  await settle(); await settle();
  assert.equal(st.codes, 6);
  assert.match(pg.el('wzLive').innerHTML, /Your phone is paired\./);
});

test('Showcase on: step 5 never draws an address from the answer it had, and asks again; step 2 drops the Client ID hint', async () => {
  const st = { sc: false, nets: 0 };
  const pg = stubPage({ search: '?setup=1&step=network', answers: (p) => {
    if (p === 'setup') return { setup: false, platform: 'docker' };
    if (p === 'showcase') return { showcase: st.sc };
    if (p === 'wizard') return wizardAnswer({ showcase: st.sc });
    if (p.startsWith('wizard/network')) {
      st.nets++;
      return { platform: 'docker', checked_at: 1, address: st.sc ? null : '192.168.1.20', addresses: st.sc ? null : ['192.168.1.20', '192.0.2.5'],
        port: 8095, listening: true, profile: null, firewall: null, problems: [], ok: true };
    }
    return {};
  } });
  await until(() => st.nets === 1 && /192\.168\.1\.20/.test(pg.el('wzNet').innerHTML), 'the first check drawn');
  assert.match(pg.el('wzNet').innerHTML, /Also: 192\.0\.2\.5/);
  // the switch moves (the page hides at once, before the bridge's answer is trimmed): the old answer isn't drawn again
  st.sc = true;
  pg.run('applySC(true)');
  assert.equal(pg.run('WZ.net'), null);
  await until(() => st.nets >= 2, 'step 5 asks again');
  await settle(); await settle();
  assert.ok(!/192\.168|192\.0\.2\.5/.test(pg.el('wzNet').innerHTML), pg.el('wzNet').innerHTML);
  assert.match(pg.el('wzNet').innerHTML, /Hidden \(Showcase\)/);
  // even an untrimmed answer (asked for just before the bridge turned Showcase on) is drawn without addresses
  pg.run(`WZ.net = { platform: 'docker', address: '192.168.1.20', addresses: ['192.168.1.20', '192.0.2.5'], port: 8095, problems: [], ok: true }; wzNetDraw()`);
  assert.ok(!/192\.168|192\.0\.2\.5/.test(pg.el('wzNet').innerHTML), pg.el('wzNet').innerHTML);
  // step 2 while Showcase is on: no hint, even from an answer that still has one
  pg.run(`WZ.d.steps.client_id.hint = '…cdef'; wzGo('client_id')`);
  assert.match(pg.el('wzBody').innerHTML, /Client ID saved/);
  assert.ok(!pg.el('wzBody').innerHTML.includes('cdef'));
});

test('step 3 (Windows): a caught sign-in that Spotify refused stops the waiting line and says what to do', async () => {
  const st = { error: null };
  const pg = stubPage({ search: '?setup=1&step=spotify', answers: (p) => {
    if (p === 'setup') return { setup: false, platform: 'windows' };
    if (p === 'showcase') return { showcase: false };
    if (p === 'wizard') return wizardAnswer({ spError: st.error });
    if (p === 'spotify/login') return { url: 'https://accounts.example.invalid/authorize' };
    return {};
  } });
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'spotify', 'step 3');
  await settle();
  await pg.run('wzConnect()');
  assert.match(pg.el('wzLive').innerHTML, /Waiting for Spotify…/);
  await pg.run('wzPoll()');
  assert.match(pg.el('wzLive').innerHTML, /Waiting for Spotify…/, 'still waiting without an error');
  st.error = 'spotify_forbidden';
  await pg.run('wzPoll()');
  assert.ok(!/Waiting for Spotify/.test(pg.el('wzLive').innerHTML));
  assert.match(pg.el('wzErr').textContent, /^Spotify refused your account\. Add your account under User Management/);
});

const GOOD = { ip: '203.0.113.7', port: 8095, away: 'http://203.0.113.7:8095', warning: null, service: 'api.ipify.org', checked_at: 1, reused: false };
const FAILED_MSG = 'Couldn\'t find your public IP: no IP-check service answered. Check that this computer is online and press Find my public IP again, or look it up in your router\'s admin page (its Internet or WAN address).';

test('step 8: the router rule, Find my public IP only on the button, the Away address with Copy, Check again, the warnings, an error', async () => {
  const st = { pip: [], answer: GOOD, platform: 'windows' };
  const pg = stubPage({ search: '?setup=1&step=away', answers: (p, body) => {
    if (p === 'setup') return { setup: false, platform: st.platform };
    if (p === 'showcase') return { showcase: false };
    if (p === 'wizard') return wizardAnswer({ otherAddr: '10.0.0.5' });
    if (p === 'wizard/public-ip') { st.pip.push(body); return st.answer; }
    return {};
  } });
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'away', 'step 8');
  await settle();
  assert.equal(pg.el('wzLbl').textContent, 'Step 8 of 10');
  assert.equal(pg.el('wzTitle').textContent, 'Listen away from home');
  const body = pg.el('wzBody').innerHTML;
  assert.match(body, /<span>Forward to \(internal address\)<\/span><span class="vc"><code class="val">192\.168\.1\.20<\/code><button class="grey copy" type="button" data-copy="192\.168\.1\.20">Copy<\/button>/);
  assert.match(body, /<span>External port<\/span><span class="vc"><code class="val">8095<\/code><button class="grey copy" type="button" data-copy="8095">Copy<\/button>/);
  assert.match(body, /and reserve 192\.168\.1\.20 for this computer\./);
  assert.match(body, /Other addresses of this computer: 10\.0\.0\.5\. Use the one your router lists for this computer\./);
  assert.match(body, /the rule <b>Encore Bridge \(phone\)<\/b>/);
  assert.match(pg.el('wzPip').innerHTML, />Find my public IP</);
  assert.match(pg.el('wzAwayLive').innerHTML, /Waiting for your phone to connect from outside your home network…/);
  assert.equal(pg.el('wzSkip').textContent, 'Skip for now');
  // never by itself: entering the step and polling don't ask
  await pg.run('wzPoll()');
  await pg.run('wzPoll()');
  assert.equal(st.pip.length, 0);
  assert.ok(!pg.calls.includes('wizard/public-ip'));
  // the button: the waiting line, then the Away address with its Copy button
  const first = pg.run('wzFindIp()');
  assert.match(pg.el('wzPip').innerHTML, /Finding your public IP…/);
  await first;
  assert.deepEqual(st.pip, [{ fresh: false }]);
  let h = pg.el('wzPip').innerHTML;
  assert.match(h, /<p>Your Away address:<\/p><div class="kvb"><span class="big val">http:\/\/203\.0\.113\.7:8095<\/span><button class="grey copy" type="button" data-copy="http:\/\/203\.0\.113\.7:8095">Copy<\/button><\/div>/);
  assert.match(h, /Away Address<\/b>, type this address and tap <b>Save<\/b>/);
  assert.match(h, />Check again</);
  // Check again: fresh
  await pg.run('wzFindIp()');
  assert.deepEqual(st.pip[1], { fresh: true });
  // shared (CGNAT): the IP and the warning, no Away address and no Copy
  st.answer = { ...GOOD, ip: '100.64.1.2', away: null, warning: 'shared' };
  await pg.run('wzFindIp()');
  h = pg.el('wzPip').innerHTML;
  assert.match(h, /<p>Your public IP: 100\.64\.1\.2<\/p><p class="wz-note">This IP \(100\.64 to 100\.127\) is a shared address of your internet provider \(carrier-grade NAT\)/);
  assert.ok(!/Your Away address:|data-copy/.test(h), h);
  st.answer = { ...GOOD, ip: '192.168.0.5', away: null, warning: 'not_public' };
  await pg.run('wzFindIp()');
  assert.match(pg.el('wzPip').innerHTML.replace(/&#39;/g, "'"), /Your public IP: 192\.168\.0\.5<\/p><p class="wz-note">This isn't a public IP, so a port forward can't reach your home through it\./);
  // an error: its message under the button (not at the foot of the step); an earlier Away address goes; the button stays
  st.answer = GOOD;
  await pg.run('wzFindIp()');
  assert.match(pg.el('wzPip').innerHTML, /Your Away address:/);
  st.answer = { __status: 502, error: { code: 'public_ip_failed', message: FAILED_MSG } };
  await pg.run('wzFindIp()');
  h = pg.el('wzPip').innerHTML;
  assert.ok(h.replace(/&#39;/g, "'").includes(`<p class="wz-err">${FAILED_MSG}</p>`), h);
  assert.ok(!/Your Away address:|203\.0\.113\.7|Your public IP:/.test(h), 'the earlier answer is gone: ' + h);
  assert.equal(pg.el('wzErr').textContent, '');
  assert.match(h, /<button id="wzPipBtn" onclick="wzFindIp\(\)">Find my public IP<\/button>/);
  // the next press clears it
  st.answer = GOOD;
  await pg.run('wzFindIp()');
  h = pg.el('wzPip').innerHTML;
  assert.ok(!/wz-err/.test(h), h);
  assert.match(h, /Your Away address:/);
  // Windows: where the router's admin page is (ipconfig)
  assert.match(pg.el('wzBody').innerHTML, /its address is this computer's <b>Default Gateway<\/b>: run <code>ipconfig<\/code>/);
  assert.match(pg.el('wzBody').innerHTML, /\(iPod touch: join another Wi-Fi instead, for example your phone's hotspot\.\)/);
  assert.match(pg.el('wzBody').innerHTML, /open your Away address with <code>\/admin<\/code> at the end\. It must say <b>Not from this address\.<\/b>/);
  // Docker: the host-firewall line instead of Windows'
  st.platform = 'docker';
  pg.run('PLATFORM = "docker"; wzGo("away")');
  assert.match(pg.el('wzBody').innerHTML, /If this computer runs its own firewall \(ufw, firewalld\), allow TCP port 8095 from anywhere, not only from your home network \(for example <code>sudo ufw allow 8095\/tcp<\/code>\)\./);
  assert.match(pg.el('wzBody').innerHTML, /its address is this computer's default gateway: run <code>ip route<\/code> and use the address after <code>default via<\/code>\./);
  assert.ok(!/ipconfig/.test(pg.el('wzBody').innerHTML));
  assert.ok(!/Encore Bridge \(phone\)/.test(pg.el('wzBody').innerHTML));
});

test('step 8: Showcase hides the addresses and the public IP (a shown one goes at once); leaving the step drops it; a late answer is thrown away', async () => {
  const st = { sc: false, pip: 0, answer: GOOD };
  const pg = stubPage({ search: '?setup=1&step=away', answers: (p) => {
    if (p === 'setup') return { setup: false, platform: 'docker' };
    if (p === 'showcase') return { showcase: st.sc };
    if (p === 'wizard') return wizardAnswer({ showcase: st.sc, otherAddr: '10.0.0.5' });
    if (p === 'wizard/public-ip') { st.pip++; return st.answer; }
    return {};
  } });
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'away', 'step 8');
  await settle();
  await pg.run('wzFindIp()');
  assert.match(pg.el('wzPip').innerHTML, /203\.0\.113\.7/);
  // Showcase on: dropped at once, only the Showcase line, no button; the addresses hidden
  st.sc = true;
  pg.run('applySC(true)');
  assert.equal(pg.run('WZ.pip'), null);
  let h = pg.el('wzPip').innerHTML;
  assert.equal(h, '<p class="wz-note">Showcase is on, so your public IP stays hidden. Turn Showcase off to find it.</p>');
  const body = pg.el('wzBody').innerHTML;
  assert.ok(!/192\.168\.1\.20|10\.0\.0\.5|203\.0\.113/.test(body), body);
  assert.match(body, /<span><b>Hidden<\/b> \(Showcase\)<\/span><span class="muted">Turn Showcase off to see the address<\/span>/);
  assert.match(body, /reserve this computer's address for this computer\./);
  await pg.run('wzFindIp()');
  assert.equal(st.pip, 1, 'the button does nothing while Showcase is on');
  // off again: nothing shown until the button is pressed again
  st.sc = false;
  pg.run('applySC(false)');
  await settle(); await settle();
  assert.ok(!/203\.0\.113/.test(pg.el('wzPip').innerHTML));
  await pg.run('wzFindIp()');
  assert.equal(st.pip, 2);
  assert.match(pg.el('wzPip').innerHTML, /203\.0\.113\.7/);
  // leaving the step drops it; back on the step: the button again
  pg.run('wzGo("play")');
  assert.equal(pg.run('WZ.pip'), null);
  pg.run('wzGo("away")');
  assert.ok(!/203\.0\.113/.test(pg.el('wzPip').innerHTML));
  assert.match(pg.el('wzPip').innerHTML, />Find my public IP</);
  // an answer that comes back after the step was left (or Showcase came on) is thrown away
  let release;
  st.answer = new Promise((r) => { release = r; });
  const late = pg.run('wzFindIp()');
  pg.run('wzGo("play")');
  pg.run('wzGo("away")');
  release(GOOD);
  await late;
  await settle();
  assert.equal(pg.run('WZ.pip'), null);
  assert.ok(!/203\.0\.113/.test(pg.el('wzPip').innerHTML));
  st.answer = new Promise((r) => { release = r; });
  const late2 = pg.run('wzFindIp()');
  st.sc = true;
  pg.run('applySC(true)');
  release(GOOD);
  await late2;
  await settle();
  assert.equal(pg.run('WZ.pip'), null);
  assert.ok(!/203\.0\.113/.test(pg.el('wzPip').innerHTML));
});

test('step 8: Open your router goes to the router the bridge found (new tab, its address shown); none found or Showcase: as before', async () => {
  const st = { router: '192.168.1.1', sc: false };
  const pg = stubPage({ search: '?setup=1&step=away', answers: (p) => {
    if (p === 'setup') return { setup: false, platform: 'windows' };
    if (p === 'showcase') return { showcase: st.sc };
    if (p === 'wizard') return wizardAnswer({ router: st.router, showcase: st.sc });
    return {};
  } });
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'away', 'step 8');
  await settle();
  let body = pg.el('wzBody').innerHTML;
  assert.match(body, /<h3>1\. Forward the port on your router<\/h3><ol><li>Open your router's admin page and sign in:<div class="kvb"><a class="btn" href="http:\/\/192\.168\.1\.1\/" target="_blank" rel="noopener noreferrer">Open your router<\/a><code class="val">192\.168\.1\.1<\/code><\/div><div class="muted">The router's password is usually printed on the router itself\.<\/div><\/li>/);
  assert.ok(!/ipconfig|Default Gateway/.test(body), 'no need to look the address up');
  assert.match(body, /<span>Forward to \(internal address\)<\/span><span class="vc"><code class="val">192\.168\.1\.20<\/code>/, 'the rest of the step as before');
  // found later (the bridge's first lookup was still running): the step is drawn again
  st.router = null;
  pg.run('wzGo("play")'); pg.run('wzGo("away")');
  await pg.run('wzPoll()');
  body = pg.el('wzBody').innerHTML;
  assert.ok(!/Open your router<\/a>|href="http:\/\//.test(body), 'no router: no link');
  assert.match(body, /Open your router's admin page in a browser and sign in\. Its address and password are often printed on the router itself\. If not, its address is this computer's <b>Default Gateway<\/b>: run <code>ipconfig<\/code>/);
  st.router = '172.16.0.1';
  await pg.run('wzPoll()');
  assert.match(pg.el('wzBody').innerHTML, /<a class="btn" href="http:\/\/172\.16\.0\.1\/" target="_blank" rel="noopener noreferrer">Open your router<\/a><code class="val">172\.16\.0\.1<\/code>/);
  // only a dotted IPv4 makes a link (the bridge sends nothing else; the page checks anyway)
  for (const bad of ['evil.example', '192.168.1.1/x', '"><script>', 'javascript:alert(1)']) {
    st.router = bad;
    await pg.run('wzPoll()');
    body = pg.el('wzBody').innerHTML;
    assert.ok(!/Open your router<\/a>/.test(body) && !body.includes(bad), bad);
  }
  // Showcase: the bridge sends no router; the step reads as before, no address anywhere
  st.router = '192.168.1.1';
  st.sc = true;
  pg.run('applySC(true)');
  await pg.run('wzPoll()');
  body = pg.el('wzBody').innerHTML;
  assert.ok(!/192\.168\.1\.1\b|Open your router<\/a>/.test(body), body);
  assert.match(body, /Its address and password are often printed on the router itself\./);
  // Docker / other: the same link
  st.sc = false;
  pg.run('applySC(false)');
  pg.run('PLATFORM = "docker"; wzGo("away")');
  await pg.run('wzPoll()');
  body = pg.el('wzBody').innerHTML;
  assert.match(body, /<a class="btn" href="http:\/\/192\.168\.1\.1\/" target="_blank" rel="noopener noreferrer">Open your router<\/a>/);
  assert.ok(!/ip route/.test(body));
});

test('step 8\'s tick, the summary\'s away note, step 6\'s Encore repo, and the Phone setup card', async () => {
  const st = { awayAt: null };
  const pg = stubPage({ search: '?setup=1&step=away', answers: (p) => {
    if (p === 'setup') return { setup: false, platform: 'docker' };
    if (p === 'showcase') return { showcase: false };
    if (p === 'wizard') return { ...wizardAnswer({ awayAt: st.awayAt }), skipped: st.skipped || [] };
    return {};
  } });
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'away', 'step 8');
  await settle();
  assert.equal(pg.run('wzWaiting()'), true, 'polled every 2 s until it ticks');
  st.awayAt = 5000;
  await pg.run('wzPoll()');
  assert.match(pg.el('wzAwayLive').innerHTML, /<span class="ok">✓<\/span> Your phone reached Encore Bridge from outside your home network\./);
  assert.equal(pg.run('wzWaiting()'), false);
  assert.equal(pg.el('wzLive').innerHTML, '', 'the step\'s own live line, under "3. Test it"');
  // the summary: the note while step 8 isn't done
  pg.run('wzGo("done")');
  assert.ok(!/isn't set up yet/.test(pg.el('wzBody').innerHTML));
  st.awayAt = null;
  await pg.run('wzPoll()');
  assert.match(pg.el('wzBody').innerHTML, /<p class="wz-note"><b>Listen away from home<\/b> isn't set up yet: until it is, Encore plays only on your home Wi-Fi\. <button class="link" onclick="wzGo\('away'\)">Go to step<\/button><\/p>/);
  assert.ok(!/see the guide/.test(pg.el('wzBody').innerHTML), 'the old one-line pointer is gone');
  // skipped: the note names the port forward (the guide has no VPN route any more)
  st.skipped = ['away'];
  await pg.run('wzPoll()');
  assert.match(pg.el('wzBody').innerHTML, /<p class="wz-note"><b>Listen away from home<\/b> isn't set up yet: without a port forward, Encore plays only on your home Wi-Fi\. <button class="link" onclick="wzGo\('away'\)">Go to step<\/button><\/p>/);
  assert.ok(!/VPN|see the guide/.test(pg.el('wzBody').innerHTML));
  st.skipped = [];
  await pg.run('wzPoll()');
  assert.match(pg.el('wzBody').innerHTML, /8\. Listen away from home/);
  // step 6: the Encore repo, big, with Copy; no live line
  pg.run('wzGo("app")');
  const b = pg.el('wzBody').innerHTML;
  assert.match(b, /<div class="kvb"><span class="big val">https:\/\/mbucc9000\.github\.io\/slopkit\/<\/span><button class="grey copy" type="button" data-copy="https:\/\/mbucc9000\.github\.io\/slopkit\/">Copy<\/button><\/div>/);
  assert.match(b, /Type the address exactly \(with <code>https:\/\/<\/code> and the <code>\/<\/code> at the end\)/);
  assert.equal(pg.el('wzLive').innerHTML, '');
  assert.equal(pg.run('wzWaiting()'), false);
  assert.equal(pg.el('wzSkip').textContent, 'I\'ve installed it');
  // the dashboard's Phone setup card: the Encore repo line (also in Showcase) and the button to step 8
  pg.run('phoneHtml = ""; phonePanel({ phone: { address: "192.168.1.20", port: 8095 }, showcase: false, app_repo: "https://mbucc9000.github.io/slopkit/" })');
  let ph = pg.el('phoneHelp').innerHTML;
  assert.match(ph, /Encore's Cydia repo: <code>https:\/\/mbucc9000\.github\.io\/slopkit\/<\/code>/);
  assert.match(ph, /Away from home: step 8 of the setup guide finds the address to type into Encore\./);
  assert.match(ph, /<button class="grey" onclick="openWizard\('away'\)">Listen away from home<\/button>/);
  assert.ok(!/\/repo\//.test(ph + pg.el('phoneAddr').innerHTML));
  pg.run('phoneHtml = ""; phonePanel({ phone: null, showcase: true, app_repo: "https://mbucc9000.github.io/slopkit/" })');
  ph = pg.el('phoneHelp').innerHTML;
  assert.match(ph, /Encore's Cydia repo: <code>https:\/\/mbucc9000\.github\.io\/slopkit\/<\/code>/, 'public: shown in Showcase too');
  assert.match(pg.el('phoneAddr').innerHTML, /Hidden/);
});

// step 10's page: the bridge's answers as a stub (wizard: steps.jam from st.jam, steps 1-8 as wizardAnswer() or all
// done with st.allDone; jam/check: st.verdict, which moves st.jam as the bridge would: accepted ticks it, refused holds
// it for 30 min; with st.hold the answer waits for st.release())
function jamPage(st) {
  return stubPage({ search: '?setup=1&step=jam', answers: (p, body) => {
    if (p === 'setup') return { setup: false, platform: 'docker' };
    if (p === 'showcase') return { showcase: false };
    if (p === 'wizard') {
      if (body) st.posts.push(body);
      if (body && body.action === 'skip' && !st.skipped.includes(body.step)) st.skipped.push(body.step);
      if (body && body.action === 'complete') st.complete = true;
      const a = wizardAnswer();
      const steps = { ...a.steps, play: { done: true, played_at: 1 }, jam: st.jam };
      if (st.allDone) for (const k of Object.keys(steps)) if (k !== 'jam') steps[k] = { ...steps[k], done: true };
      return { ...a, now: st.now, complete: st.complete, skipped: [...st.skipped], steps };
    }
    if (p === 'jam/check') {
      st.checks.push(body);
      const v = st.verdict;
      const answer = () => {
        if (v.verdict === 'accepted') st.jam = { done: true, access: 'accepted', retry_at: null };
        if (v.verdict === 'refused') st.jam = { done: false, access: 'refused', retry_at: st.now + 30 * 60000 };
        return v;
      };
      return st.hold ? new Promise((res) => { st.release = () => res(answer()); }) : answer();
    }
    return {};
  } });
}
const jamState = () => ({ jam: { done: false, access: 'unknown', retry_at: null }, checks: [], posts: [], skipped: [], complete: false, now: 1000000, verdict: null });

test('step 10 (Turn on Jam): the Jam card\'s check and question, the verdict in the step, the 30-minute wait, the tick, Finish', async () => {
  const st = jamState();
  const pg = jamPage(st);
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'jam', 'step 10');
  await settle();
  assert.equal(pg.el('wzLbl').textContent, 'Step 10 of 10');
  assert.equal(pg.el('wzTitle').textContent, 'Turn on Jam');
  const body = pg.el('wzBody').innerHTML;
  assert.match(body, /^<p>Optional\. A Jam is a queue you share with friends\./);
  assert.match(body, /<li>On another phone or computer, open the Spotify app \(the same account\), start a Jam and pick <b>Encore<\/b> as its speaker\.<\/li>/);
  assert.match(body, /<li>Then press <b>Check Jam access<\/b> here\.<\/li>/);
  assert.match(body, /<button id="wzJamBtn" onclick="wzJamCheck\(\)">Check Jam access<\/button>/);
  assert.match(body, /you can check again after 30 minutes\. Not now\? Press <b>Skip Jam<\/b>/);
  assert.equal(pg.el('wzSkip').textContent, 'Skip Jam');
  assert.equal(pg.el('wzSkip').style.display, '');
  assert.deepEqual([pg.el('wzNext').style.display, pg.el('wzFinish').style.display], ['none', ''], 'the last step: Finish, no Next');
  assert.equal(pg.el('wzLive').innerHTML, '');
  assert.equal(pg.el('wzJamBtn').disabled, false);
  // the question first, as on the Jam card: Cancel sends nothing
  pg.ctx.confirm = (q) => { st.asked = q; return false; };
  await pg.run('wzJamCheck()');
  assert.equal(st.asked, 'Send ONE request to Spotify\'s Jam service now? Only do this while a Jam started in Spotify (on another phone or computer) plays on Encore.');
  assert.equal(st.checks.length, 0);
  pg.ctx.confirm = () => true;
  // inconclusive: the Jam card's verdict line, in the step (no alert)
  st.verdict = { on: false, verdict: 'inconclusive', reason: 'nothing was sent' };
  await pg.run('wzJamCheck()');
  assert.deepEqual(st.checks, [{}]);
  assert.equal(pg.el('wzErr').textContent, 'Jam access: inconclusive\nnothing was sent');
  assert.equal(pg.el('wzJamBtn').disabled, false);
  // refused: the minutes left, the button waits (nothing sent), Skip Jam stays
  st.verdict = { on: true, verdict: 'refused', reason: 'Spotify refused (403)', status: 403 };
  await pg.run('wzJamCheck()');
  assert.equal(st.checks.length, 2);
  assert.equal(pg.el('wzErr').textContent, 'Jam access: refused\nSpotify refused (403)');
  assert.equal(pg.el('wzLive').innerHTML, '<div class="wz-note">Spotify refused Jam access. You can check again in 30 min.</div>');
  assert.equal(pg.el('wzJamBtn').disabled, true);
  await pg.run('wzJamCheck()');
  assert.equal(st.checks.length, 2, 'nothing sent during the wait');
  assert.equal(pg.el('wzSkip').style.display, '');
  st.now += 29 * 60000 + 30000;
  await pg.run('wzPoll()');
  assert.match(pg.el('wzLive').innerHTML, /You can check again in 1 min\./);
  // the wait is over: the bridge says unknown again, and the button works
  st.now += 60000;
  st.jam = { done: false, access: 'unknown', retry_at: null };
  await pg.run('wzPoll()');
  assert.equal(pg.el('wzLive').innerHTML, '');
  assert.equal(pg.el('wzJamBtn').disabled, false);
  // accepted: the ✓ line, the list's ✓, no button or Skip Jam any more, Finish stays
  st.verdict = { on: true, verdict: 'accepted', reason: 'Spotify answered with a session Encore can read', members: 2 };
  await pg.run('wzJamCheck()');
  assert.equal(st.checks.length, 3);
  assert.equal(pg.el('wzErr').textContent, '');
  assert.equal(pg.el('wzLive').innerHTML, '<div><span class="ok">✓</span> Jam access accepted. Encore can start and join Jams.</div>');
  assert.ok(!/wzJamBtn/.test(pg.el('wzBody').innerHTML));
  assert.match(pg.el('wzOl').innerHTML, /<span class="n">10<\/span><span class="t">Turn on Jam<\/span><span class="s ok" aria-label="done">✓<\/span>/);
  assert.equal(pg.el('wzSkip').style.display, 'none');
  assert.equal(pg.el('wzFinish').style.display, '');
  await pg.run('wzFinish()');
  assert.deepEqual(st.posts, [{ action: 'complete' }]);
  assert.equal(pg.run('WZ.step'), 'done');
  assert.match(pg.el('wzBody').innerHTML, /<li><span>10\. Turn on Jam<\/span><span><span class="ok">✓<\/span><\/span><\/li>/);
  // step 9 has Next now (Finish moved to step 10)
  pg.run('wzGo("play")');
  assert.deepEqual([pg.el('wzNext').style.display, pg.el('wzFinish').style.display], ['', 'none']);
  assert.equal(pg.el('wzLbl').textContent, 'Step 9 of 10');
});

test('step 10: Skip Jam finishes when no other step is left, else shows the first that is; Finish without a check finishes too; the summary row', async () => {
  // every other step done: Skip Jam skips and finishes
  let st = { ...jamState(), allDone: true };
  let pg = jamPage(st);
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'jam', 'step 10');
  await settle();
  await pg.run('wzSkip()');
  assert.deepEqual(st.posts, [{ action: 'skip', step: 'jam' }, { action: 'complete' }]);
  assert.equal(st.checks.length, 0, 'no request to Spotify');
  assert.equal(pg.run('WZ.step'), 'done');
  assert.match(pg.el('wzBody').innerHTML, /<li><span>10\. Turn on Jam<\/span><span>Skipped <button class="link" onclick="wzGo\('jam'\)">Go to step<\/button><\/span><\/li>/);
  // steps not done yet (here 3, 5, 6, 7, 8; 3 skipped): Skip Jam only skips, and shows the first step neither done nor
  // skipped; the setup stays incomplete until Finish
  st = { ...jamState(), skipped: ['spotify'] };
  pg = jamPage(st);
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'jam', 'step 10');
  await settle();
  await pg.run('wzSkip()');
  assert.deepEqual(st.posts, [{ action: 'skip', step: 'jam' }]);
  assert.equal(st.complete, false);
  assert.equal(pg.run('WZ.step'), 'network');
  assert.equal(pg.el('wzLbl').textContent, 'Step 5 of 10');
  pg.run('wzGo("jam")');
  await pg.run('wzFinish()');
  assert.deepEqual(st.posts, [{ action: 'skip', step: 'jam' }, { action: 'complete' }]);
  assert.equal(pg.run('WZ.step'), 'done');
  st = jamState();
  pg = jamPage(st);
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'jam', 'step 10');
  await settle();
  await pg.run('wzFinish()');
  assert.deepEqual(st.posts, [{ action: 'complete' }]);
  assert.equal(pg.run('WZ.step'), 'done');
  assert.match(pg.el('wzBody').innerHTML, /<li><span>10\. Turn on Jam<\/span><span>Not done yet <button class="link" onclick="wzGo\('jam'\)">Go to step<\/button><\/span><\/li>/);
});

test('step 10: a check in flight keeps the button off when the step is left and opened again (one request); its late answer shows only as the wait', async () => {
  const st = { ...jamState(), hold: true };
  const pg = jamPage(st);
  await until(() => pg.run('typeof WZ === "object" && WZ !== null && WZ.step') === 'jam', 'step 10');
  await settle();
  st.verdict = { on: true, verdict: 'refused', reason: 'Spotify refused (403)', status: 403 };
  const first = pg.run('wzJamCheck()');
  await until(() => st.checks.length === 1 && st.release, 'the check sent');
  assert.equal(pg.el('wzJamBtn').disabled, true);
  assert.match(pg.el('wzLive').innerHTML, /Checking…/);
  // Back and Next, then the step list's step 10: still checking, and the button sends nothing
  pg.run('wzBack()');
  assert.equal(pg.run('WZ.step'), 'play');
  pg.run('wzNext()');
  assert.equal(pg.run('WZ.step'), 'jam');
  assert.equal(pg.el('wzJamBtn').disabled, true);
  assert.match(pg.el('wzLive').innerHTML, /Checking…/);
  await pg.run('wzJamCheck()');
  pg.run('wzGo("jam")');
  assert.equal(pg.el('wzJamBtn').disabled, true);
  await pg.run('wzJamCheck()');
  assert.equal(st.checks.length, 1, 'one request only');
  // the answer comes: no verdict line (the step was left meanwhile), the wait shows and the button stays off
  st.release();
  await first;
  await settle();
  assert.equal(pg.el('wzErr').textContent, '');
  assert.equal(pg.el('wzLive').innerHTML, '<div class="wz-note">Spotify refused Jam access. You can check again in 30 min.</div>');
  assert.equal(pg.el('wzJamBtn').disabled, true);
  await pg.run('wzJamCheck()');
  assert.equal(st.checks.length, 1, 'nothing during the wait');
});

test('step 10: the verdict line keeps its two lines (.wz-err white-space: pre-line)', () => {
  assert.match(HTML, /\.wz-err \{[^}]*white-space: pre-line;[^}]*\}/);
});

// ================================================================= the Updates section (DESIGN-UPDATES.md §5.9, §6, §7.2, §8)
test('the update texts (§5.9, §5.10, §7.2, §8.1) as the docs quote them', () => {
  const text = HTML.replace(/\\'/g, '\'').replace(/&amp;/g, '&');
  const want = [
    // the error codes (§5.9)
    'Couldn\'t reach GitHub. Check that this computer is online; Encore Bridge tries again later.',
    'GitHub didn\'t answer in time. Try again in a minute.',
    'GitHub asked Encore Bridge to wait (too many requests from your network). It tries again after {time}.',
    'GitHub answered with an error (HTTP {n}). Encore Bridge tries again tomorrow.',
    'GitHub\'s answer couldn\'t be read. Encore Bridge tries again tomorrow.',
    'No Encore release is published yet.',
    'Encore Bridge {v} is published, but not all of its files are there yet. Encore Bridge looks again later.',
    'Encore Bridge {v} is published, but it isn\'t signed with Encore\'s release key, so it isn\'t offered. Don\'t install it from anywhere else; see the project page on GitHub.',
    'Encore Bridge {v} doesn\'t include a signed file for this computer, so it isn\'t offered.',
    'The download stopped. Choose Update now again to continue where it stopped.',
    'There isn\'t enough free space for the update: {size} is needed on the drive that holds %LOCALAPPDATA%.',
    'The downloaded installer doesn\'t match Encore\'s signature, so it was deleted and not run. Try again later.',
    'The update was cancelled. Encore Bridge {cur} is still installed.',
    'The installer stopped before it finished (code {n}). Encore Bridge {cur} is still installed.',
    'Windows couldn\'t start the installer. Try again, or download it from the release page.',
    // the dialogs and the running update (§5.9)
    'Encore Bridge {cur} is up to date.', 'This is a development build, so it doesn\'t look for updates.',
    'Updating to {v}: downloading {p}%', 'Updating to {v}: checking the download…', 'Updating to {v}: waiting for Windows…',
    'Update Encore Bridge to {v}?\\n\\nYou have {cur}. Encore Bridge downloads the installer from GitHub ({size}), checks that it\'s signed by Encore, and then Windows asks for permission to install it.\\n\\n' +
      'Phones stop playing for about a minute while the bridge restarts. Your settings, Spotify sign-ins and paired phones stay.\\n\\nAfterwards, update the Encore app on your phone too: Cydia → Changes → Refresh.',
    // §5.10
    'To update, use the Encore Bridge icon on the PC: Encore Bridge {v} is available → Update now…',
    'Updates are handled by the Encore Bridge icon in the notification area.',
    // §8.1: the banner, the section, the status lines, the note
    'Encore Bridge {v} is available.', '>What\'s new<', '>Update…<', '<h2 data-t="Updates">Updates</h2>', '>Check now<',
    'Encore Bridge {cur} · up to date (checked {ago})', 'Encore Bridge {v} is available (you have {cur})', 'Checking…', 'Not checked yet',
    'Automatic checks are off (UPDATE_CHECK=0). Check now still works.',
    'Encore Bridge asks GitHub for the newest version at most once a day. It sends nothing about you or this bridge except its version number; GitHub sees this network\'s public IP address, as with any download. To turn the daily check off, set UPDATE_CHECK=0 in settings.env (Windows: Troubleshooting → Edit settings… in the tray) or in .env (Docker).',
    // §7.2
    'Encore Bridge doesn\'t update itself on Docker. Update it on the computer that runs it, from the folder that holds your current <code>Encore-{cur}</code> folder (if your folder has another name, use that name instead of <code>Encore-{cur}</code>).',
    'If you made a <code>.env</code>, copy it too: <code>sudo cp -p ../../Encore-{cur}/gateway/.env .</code> If you changed <code>engine/config.yml</code> or <code>compose.yaml</code>, make the same changes in the new files (don\'t copy the old ones over them). Then build and start the new version:',
    '<b>With a git clone:</b>', 'Then update the app: Cydia → Changes → Refresh.',
    'Put your clone\'s folder in place of <your clone>. If git checkout refuses because you changed engine/config.yml or compose.yaml, run git stash, then the lines above again, then git stash pop. Then build and start the new version:',
    'Stop the bridge, replace its files with the new <code>gateway/src</code>, keep your data folder (<code>DATA_DIR</code>), and start it again.',
    // the prebuilt images (DESIGN-DOCKER-IMAGES.md §5.3)
    'Encore Bridge doesn\'t update itself on Docker. Update it on the computer that runs it, in the folder with your <code>compose.yaml</code>:',
    'If your <code>.env</code> sets <code>ENCORE_TAG</code> to stay on one version, set it to <code>v{v}</code> first.',
    '<b>Dockge:</b> press <b>Update</b> on the Encore stack. <b>Portainer:</b> open the stack, choose <b>Update the stack</b> and turn on <b>Re-pull image and redeploy</b>.',
    'In Dockge or Portainer, look for "setup code" in the log of the <code>encore-gateway</code> container.',
  ];
  for (const s of want) assert.ok(text.includes(s), `missing: ${s}`);
  // no SHA or checksum wording on the page (the owner's choice: "signed by Encore")
  const shown = HTML.replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\bsha256\b|UPD_HEX/g, '');      // (comments, the field's name aside)
  assert.ok(!/checksum|\bSHA(-?256)?\b/i.test(shown), 'no SHA / checksum wording');
  // the Updates section sits after Engine & stream and before Jam; the banner under the setup banner
  const h2 = (t) => HTML.indexOf(`>${t}</h2>`);
  assert.ok(h2('Engine &amp; stream') > 0 && h2('Engine &amp; stream') < h2('Updates') && h2('Updates') < h2('Jam'));
  assert.ok(HTML.indexOf('id="banner"') < HTML.indexOf('id="updBanner"') && HTML.indexOf('id="updBanner"') < HTML.indexOf('id="wiz"'));
});

test('the Docker commands (§7.2): exactly the guide\'s lines, with {v} and {cur} placeholders only (no literal version)', () => {
  const ctx = vm.createContext({});
  vm.runInContext(JS.slice(JS.indexOf('const UPD_RELEASES'), JS.indexOf('// fills the placeholders')) + ';this.C = UPD_DOCKER_CMDS; this.G = UPD_GIT_CMDS; this.U = UPD_DOCKER_UP; this.I = UPD_IMAGE_CMDS;', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.C)), [
    'curl -fLO https://github.com/mbucc9000/encore/releases/download/v{v}/Encore-{v}-source.tar.gz',
    'tar xzf Encore-{v}-source.tar.gz',
    '(cd Encore-{cur}/gateway && docker compose down)',
    'cd Encore-{v}/gateway',
    'sudo cp -rp ../../Encore-{cur}/gateway/data .',
    'sudo cp -p ../../Encore-{cur}/gateway/engine/state.json engine/',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.G)), ['cd <your clone>/gateway', 'git fetch --tags', 'git checkout v{v}']);
  // the build is its own block, after the .env / config note (never in the block that ends with the copies)
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.U)), ['docker compose up -d --build']);
  // the prebuilt images (DESIGN-DOCKER-IMAGES.md §5.3): new images, then the containers again (the guide's block)
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.I)), ['docker compose pull', 'docker compose up -d']);
  for (const l of [...ctx.C, ...ctx.G, ...ctx.U, ...ctx.I]) assert.ok(!/\d+\.\d+\.\d+/.test(l), l);
  for (const p of ['{v}', '{cur}']) assert.ok(ctx.C.join('\n').includes(p), p);
  // no version, hash or release link written into the page itself: only the two constant prefixes
  assert.ok(!/releases\/(tag|download)\/v\d/.test(HTML));
});

const HEX = 'ab'.repeat(32);
const escT = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const unq = (s) => String(s).replace(/&#39;/g, '\'');
function updView(o = {}) {
  return { v: 1, source: 'bridge', kind: 'docker', current: '1.1.0', auto: true, auto_off: null, state: 'available', checked_at: new Date().toISOString(),
    next_check_at: null, latest: { version: '1.2.0', published_at: null, notes_url: 'https://github.com/mbucc9000/encore/releases/tag/v1.2.0',
      asset: 'Encore-1.2.0-source.tar.gz', size: 32443228, sha256: HEX },
    error: null, install: null, request: null, request_expired: null, request_handled: null, can_install_here: false, relay_missing: false, ...o };
}
async function updPage() {
  const st = { calls: [], answer: {} };
  const pg = stubPage({ search: '', answers: (p, body) => {
    if (p === 'setup') return { setup: false, platform: 'docker' };
    if (p === 'showcase') return { showcase: false };
    if (p === 'wizard') return { ...wizardAnswer({}), show: false, complete: true };
    if (p.startsWith('update/')) { st.calls.push([p, body]); return st.answer; }
    return {};
  } });
  await until(() => pg.run('view') === 'dashboard', 'the dashboard');
  const draw = (u) => {
    pg.run(`updHtml = ''; updDraw(${JSON.stringify(u)})`);
    return { state: pg.el('updState').innerHTML, note: pg.el('updNote').textContent, body: pg.el('updBody').innerHTML, banner: pg.el('updBanner').style.display,
      bannerText: pg.el('updBannerText').textContent, notes: pg.el('updBannerNotes').href, msg: pg.el('updMsg').textContent };
  };
  return { pg, st, draw };
}

test('Updates on Docker: the status line, the banner, the commands filled in with Copy; the same in Showcase; no banner in the guide', async () => {
  const { pg, draw } = await updPage();
  const d = draw(updView());
  assert.equal(d.state, 'Encore Bridge 1.2.0 is available (you have 1.1.0) · <a href="https://github.com/mbucc9000/encore/releases/tag/v1.2.0" target="_blank" rel="noopener noreferrer">What\'s new</a>');
  assert.deepEqual([d.banner, d.bannerText, d.notes], ['', 'Encore Bridge 1.2.0 is available.', 'https://github.com/mbucc9000/encore/releases/tag/v1.2.0']);
  assert.equal(d.note, '');
  // each block fails fast: its lines are joined with " &&", so a failing line stops the rest
  const cmds = ['curl -fLO https://github.com/mbucc9000/encore/releases/download/v1.2.0/Encore-1.2.0-source.tar.gz',
    'tar xzf Encore-1.2.0-source.tar.gz', '(cd Encore-1.1.0/gateway && docker compose down)', 'cd Encore-1.2.0/gateway', 'sudo cp -rp ../../Encore-1.1.0/gateway/data .',
    'sudo cp -p ../../Encore-1.1.0/gateway/engine/state.json engine/'].join(' &&\n');
  assert.ok(d.body.includes(`<div class="cmd"><pre>${escT(cmds)}</pre><button class="grey copy" type="button" data-copy="${escT(cmds)}">Copy</button></div>`), d.body);
  const up = '<div class="cmd"><pre>docker compose up -d --build</pre><button class="grey copy" type="button" data-copy="docker compose up -d --build">Copy</button></div>';
  const git = ['cd <your clone>/gateway', 'git fetch --tags', 'git checkout v1.2.0'].join(' &&\n');
  assert.ok(d.body.includes(`<pre>${escT(git)}</pre>`), d.body);
  // order: the archive's block, the .env / config note, the build; then the clone's block, the stash note, the build
  const at = (s, from = 0) => d.body.indexOf(s, from);
  const iC = at(escT(cmds)), iEnv = at('If you made a <code>.env</code>'), iUp = at(up), iGit = at(escT(git)), iStash = at('git stash'), iUp2 = at(up, iUp + 1);
  assert.ok(iC >= 0 && iC < iEnv && iEnv < iUp && iUp < iGit && iGit < iStash && iStash < iUp2, d.body);
  for (const m of d.body.matchAll(/<pre>([\s\S]*?)<\/pre>/g)) {
    const lines = m[1].split('\n');
    lines.slice(0, -1).forEach((l) => assert.ok(l.endsWith(' &amp;&amp;'), `a line that doesn't stop the block on failure: ${l}`));
  }
  const b = unq(d.body);
  assert.ok(b.includes('<p><b>Encore Bridge 1.2.0 is available</b> (you have 1.1.0) · <a href="https://github.com/mbucc9000/encore/releases/tag/v1.2.0" target="_blank" rel="noopener noreferrer">What\'s new</a></p>'), b);
  assert.ok(b.includes('Encore Bridge doesn\'t update itself on Docker. Update it on the computer that runs it, from the folder that holds your current <code>Encore-1.1.0</code> folder (if your folder has another name, use that name instead of <code>Encore-1.1.0</code>).'), b);
  assert.ok(b.includes('If you made a <code>.env</code>, copy it too: <code>sudo cp -p ../../Encore-1.1.0/gateway/.env .</code>'), b);
  assert.ok(b.includes('If git checkout refuses because you changed engine/config.yml or compose.yaml, run git stash, then the lines above again, then git stash pop.'), b);
  assert.ok(b.includes('Then update the app: Cydia → Changes → Refresh.'), b);
  // Showcase: nothing personal here, so nothing changes
  pg.run('applySC(true)');
  assert.deepEqual(draw(updView()), d);
  pg.run('applySC(false)');
  // the setup guide open: no banner
  pg.run('view = "wizard"');
  assert.equal(draw(updView()).banner, 'none');
  pg.run('view = "dashboard"');
  // a version or hash that doesn't look right: nothing offered, no link, no banner
  for (const latest of [{ ...updView().latest, version: '1.2.0"><script>x</script>' }, { ...updView().latest, sha256: 'nope' }, { ...updView().latest, version: 'v1.2.0' }]) {
    const x = draw(updView({ latest }));
    assert.equal(x.banner, 'none');
    assert.ok(!/script|github\.com/.test(x.state + x.body), x.state + x.body);
  }
  // other installs: the archive's first two lines, then the plain step; no docker command in the first block
  const o = draw(updView({ kind: 'other' }));
  assert.ok(o.body.includes(`<pre>${escT(cmds.split(' &&\n').slice(0, 2).join(' &&\n'))}</pre>`), o.body);
  assert.ok(o.body.includes(`<pre>${escT(git)}</pre>`) && !o.body.includes('git stash'), o.body);
  assert.ok(o.body.includes('<p>Stop the bridge, replace its files with the new <code>gateway/src</code>, keep your data folder (<code>DATA_DIR</code>), and start it again.</p>'));
  assert.ok(!o.body.includes('docker compose down') && !o.body.includes('on Docker'), o.body);
});

test('Updates on the prebuilt images (kind docker-image): pull and up -d with Copy, the ENCORE_TAG note, Dockge / Portainer, the app line; no archive, no hash', async () => {
  const { pg, draw } = await updPage();
  const latest = { version: '1.3.0', published_at: '2026-10-13T09:00:00Z', notes_url: 'https://github.com/mbucc9000/encore/releases/tag/v1.3.0',
    asset: 'encore-docker-compose.yaml', size: 2108, sha256: HEX };
  const view = updView({ kind: 'docker-image', current: '1.2.1', latest });
  const d = draw(view);
  // the status line, the note and the banner: as for a source build
  assert.equal(d.state, 'Encore Bridge 1.3.0 is available (you have 1.2.1) · <a href="https://github.com/mbucc9000/encore/releases/tag/v1.3.0" target="_blank" rel="noopener noreferrer">What\'s new</a>');
  assert.deepEqual([d.banner, d.bannerText, d.notes], ['', 'Encore Bridge 1.3.0 is available.', 'https://github.com/mbucc9000/encore/releases/tag/v1.3.0']);
  assert.equal(d.note, '');
  // the card: the title, the folder, the one command block (its Copy text exactly the guide's), the pinned-tag note,
  // Dockge and Portainer, the app
  const copy = 'docker compose pull &&\ndocker compose up -d';
  const b = unq(d.body);
  assert.equal(b, '<p><b>Encore Bridge 1.3.0 is available</b> (you have 1.2.1) · <a href="https://github.com/mbucc9000/encore/releases/tag/v1.3.0" target="_blank" rel="noopener noreferrer">What\'s new</a></p>'
    + '<p>Encore Bridge doesn\'t update itself on Docker. Update it on the computer that runs it, in the folder with your <code>compose.yaml</code>:</p>'
    + `<div class="cmd"><pre>${escT(copy)}</pre><button class="grey copy" type="button" data-copy="${escT(copy)}">Copy</button></div>`
    + '<p>If your <code>.env</code> sets <code>ENCORE_TAG</code> to stay on one version, set it to <code>v1.3.0</code> first.</p>'
    + '<p><b>Dockge:</b> press <b>Update</b> on the Encore stack. <b>Portainer:</b> open the stack, choose <b>Update the stack</b> and turn on <b>Re-pull image and redeploy</b>.</p>'
    + '<p>Then update the app: Cydia → Changes → Refresh.</p>');
  const copies = [...b.matchAll(/data-copy="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.deepEqual(copies, [copy]);
  // nothing of the source build's card: no download, archive, folder copy, build or clone; no hash, size or download link
  for (const bad of ['curl', 'tar.gz', 'Encore-', 'releases/download', 'docker compose down', '--build', 'sudo', 'git ', 'Open the download page', HEX, '2108', 'MB'])
    assert.ok(!b.includes(bad), bad);
  assert.ok(!/\btar\b/.test(b), b);
  assert.ok(!/sha|checksum|hash/i.test(d.state + d.note + b), 'no hash wording or value');
  // Showcase: nothing personal here, so nothing changes; the setup guide open: no banner
  pg.run('applySC(true)');
  assert.deepEqual(draw(view), d);
  pg.run('applySC(false)');
  pg.run('view = "wizard"');
  assert.equal(draw(view).banner, 'none');
  pg.run('view = "dashboard"');
  // a version or hash that doesn't look right: nothing offered, no command, no link, no banner
  for (const l of [{ ...latest, version: '1.3.0"><script>x</script>' }, { ...latest, sha256: 'nope' }, { ...latest, version: 'v1.3.0' }]) {
    const x = draw(updView({ kind: 'docker-image', current: '1.2.1', latest: l }));
    assert.equal(x.banner, 'none');
    assert.ok(!/script|github\.com|docker compose/.test(x.state + x.body), x.state + x.body);
  }
  // no newer version (the hour after a release, or up to date): no card
  const u = draw(updView({ kind: 'docker-image', current: '1.2.1', state: 'up_to_date', latest: null }));
  assert.deepEqual([u.state, u.body, u.banner], ['Encore Bridge 1.2.1 · up to date (checked just now)', '', 'none']);
  // kind docker (a source build) keeps its own card
  const src = unq(draw(updView()).body);
  assert.ok(src.includes('curl -fLO https://github.com/mbucc9000/encore/releases/download/v1.2.0/Encore-1.2.0-source.tar.gz') && src.includes('docker compose up -d --build'), src);
  assert.ok(!src.includes('docker compose pull') && !src.includes('ENCORE_TAG') && !src.includes('Dockge'), src);
});

test('setup step 1 on Docker: after the setup code command, where to look in Dockge or Portainer; not on Windows or other installs', async () => {
  const sentence = 'In Dockge or Portainer, look for "setup code" in the log of the <code>encore-gateway</code> container.';
  for (const platform of ['docker', 'other', 'windows']) {
    const pg = stubPage({ search: '', answers: (p) => {
      if (p === 'setup') return { setup: true, code_needed: true, min_length: 8, platform, ...(platform === 'windows' ? { windows: true } : {}) };
      return {};
    } });
    await until(() => pg.el('wzBody').innerHTML.includes('id="wzCode"'), `${platform}: step 1 with the setup code field`);
    const h = pg.el('wzBody').innerHTML;
    if (platform === 'docker') {
      const cmd = h.indexOf(escT('docker compose logs gateway | grep "setup code"'));
      assert.ok(cmd > 0, h);
      assert.ok(h.indexOf('The bridge prints a new code every time it starts. ' + sentence) > cmd, h);
    } else {
      assert.ok(!h.includes('Dockge') && !h.includes('encore-gateway'), `${platform}: ${h}`);
    }
  }
});

test('Updates: the other status lines, the error texts, the automatic-check note, a development build', async () => {
  const { draw } = await updPage();
  assert.equal(draw(updView({ state: 'up_to_date', latest: null })).state, 'Encore Bridge 1.1.0 · up to date (checked just now)');
  assert.equal(draw(updView({ state: 'up_to_date', latest: null, checked_at: new Date(Date.now() - 3 * 3600000).toISOString() })).state, 'Encore Bridge 1.1.0 · up to date (checked 3 h ago)');
  assert.equal(draw(updView({ state: 'never', latest: null, checked_at: null })).state, 'Not checked yet');
  assert.equal(draw(updView({ state: 'checking', latest: null })).state, 'Checking…');
  assert.equal(unq(draw(updView({ auto_off: 'dev_build', auto: false, state: 'never', latest: null })).state), 'This is a development build, so it doesn\'t look for updates.');
  assert.equal(draw(updView({ auto_off: 'setting', auto: false, state: 'up_to_date', latest: null })).note, 'Automatic checks are off (UPDATE_CHECK=0). Check now still works.');
  const err = (e) => unq(draw(updView({ state: 'error', latest: null, error: { version: null, retry_at: null, http_status: null, ...e } })).state);
  assert.equal(err({ code: 'offline' }), '<span class="warn">Couldn\'t reach GitHub. Check that this computer is online; Encore Bridge tries again later.</span>');
  assert.equal(err({ code: 'http_error', http_status: 502 }), '<span class="warn">GitHub answered with an error (HTTP 502). Encore Bridge tries again tomorrow.</span>');
  assert.equal(err({ code: 'no_release' }), '<span class="muted">No Encore release is published yet.</span>', 'not shown as a failure');
  assert.match(err({ code: 'rate_limited', retry_at: '2026-10-12T14:05:00Z' }), /^<span class="warn">GitHub asked Encore Bridge to wait \(too many requests from your network\)\. It tries again after [^<]+\.<\/span>$/);
  assert.equal(err({ code: 'bad_signature', version: '1.2.0' }), '<span class="warn">Encore Bridge 1.2.0 is published, but it isn\'t signed with Encore\'s release key, so it isn\'t offered. Don\'t install it from anywhere else; see the project page on GitHub.</span>');
  assert.equal(err({ code: 'bad_signature', version: '<b>x' }), '<span class="warn">Encore Bridge ? is published, but it isn\'t signed with Encore\'s release key, so it isn\'t offered. Don\'t install it from anywhere else; see the project page on GitHub.</span>');
  // a newer version known, the last check failed: both
  const both = draw(updView({ error: { code: 'timeout', version: null, retry_at: null, http_status: null } }));
  assert.match(both.state, /^Encore Bridge 1\.2\.0 is available/);
  assert.equal(both.note, 'GitHub didn\'t answer in time. Try again in a minute.');
  // the relay before the tray has said anything
  const r = draw(updView({ source: 'launcher', kind: null, state: 'never', latest: null, relay_missing: true }));
  assert.equal(r.state, 'Updates are handled by the Encore Bridge icon in the notification area.');
  assert.equal(r.body, '');
});

test('Updates on Windows: the zip\'s card; the installer\'s Update now (this PC only), its progress, Cancel, and its errors', async () => {
  const { draw } = await updPage();
  const latest = { ...updView().latest, asset: 'EncoreBridge-1.2.0-win64.zip' };
  const z = draw(updView({ source: 'launcher', kind: 'windows-zip', latest }));
  const zb = unq(z.body);
  assert.ok(zb.includes('Download <code>EncoreBridge-1.2.0-win64.zip</code> from the release page.'), zb);
  assert.ok(zb.includes('Then choose <b>Quit Encore Bridge</b> in the tray, unzip the new version into a <b>new, empty folder</b>, and start <code>Encore Bridge.exe</code> from there.'), zb);
  assert.ok(zb.includes('Your settings, sign-ins and paired phones in <code>%LOCALAPPDATA%\\Encore</code> stay. Windows asks again about the firewall for the new folder\'s Node.js: allow it on private networks.'), zb);
  assert.ok(zb.includes('If you use <b>Start with Windows</b>, tick it again in the new copy\'s menu.'), zb);
  assert.ok(zb.includes('<a class="btn updlink" href="https://github.com/mbucc9000/encore/releases/tag/v1.2.0" target="_blank" rel="noopener noreferrer">Open the download page</a>'), zb);
  assert.ok(!/updInstall|<pre>/.test(zb), 'no Update now and no commands for the zip');
  const inst = { ...updView().latest, asset: 'EncoreBridge-1.2.0-setup.exe' };
  const W = (o) => updView({ source: 'launcher', kind: 'windows-installer', latest: inst, ...o });
  assert.equal(draw(W({ can_install_here: true })).body, '<div class="row"><button onclick="updInstall()">Update now</button></div>');
  assert.equal(draw(W({ can_install_here: false })).body, '<p>To update, use the Encore Bridge icon on the PC: Encore Bridge 1.2.0 is available → Update now…</p>');
  const prog = (phase, done) => draw(W({ can_install_here: true, install: { version: '1.2.0', phase, done, total: 32443228, error: null, exit_code: null } })).body;
  assert.equal(prog('downloading', 16221614), '<p>Updating to 1.2.0: downloading 50%</p><div class="bar"><i style="width:50%"></i></div><div class="row"><button class="grey" onclick="updCancel()">Cancel</button></div>');
  assert.equal(prog('verifying', 32443228), '<p>Updating to 1.2.0: checking the download…</p>');
  assert.equal(prog('waiting', 32443228), '<p>Updating to 1.2.0: waiting for Windows…</p>', 'no Cancel while Windows asks');
  const fail = (o) => unq(draw(W({ can_install_here: true, install: { version: '1.2.0', done: 0, total: 32443228, error: null, exit_code: null, ...o } })).body);
  assert.equal(fail({ phase: 'failed', error: 'setup_failed', exit_code: 7 }), '<p class="warn">The installer stopped before it finished (code 7). Encore Bridge 1.1.0 is still installed.</p><div class="row"><button onclick="updInstall()">Update now</button></div>');
  assert.match(fail({ phase: 'cancelled' }), /^<p class="warn">The update was cancelled\. Encore Bridge 1\.1\.0 is still installed\.<\/p>/);
  // the size the tray names too: the installer plus the 64 MiB margin (FreeSpaceNeeded)
  assert.match(fail({ phase: 'failed', error: 'no_space' }), /There isn't enough free space for the update: 94\.9 MB is needed on the drive that holds %LOCALAPPDATA%\./);
  // a fresh check in Update now that fails: the version is filled in, never a literal placeholder
  assert.match(fail({ phase: 'failed', error: 'bad_signature' }), /^<p class="warn">Encore Bridge 1\.2\.0 is published, but it isn't signed with Encore's release key, so it isn't offered\./);
  assert.match(fail({ phase: 'failed', error: 'incomplete_release' }), /^<p class="warn">Encore Bridge 1\.2\.0 is published, but not all of its files are there yet\./);
  assert.match(fail({ phase: 'failed', error: 'sums_entry_missing' }), /^<p class="warn">Encore Bridge 1\.2\.0 doesn't include a signed file for this computer, so it isn't offered\.<\/p>/);
  for (const error of ['bad_signature', 'incomplete_release', 'sums_entry_missing', 'http_error', 'no_space', 'setup_failed']) {
    assert.ok(!/\{(v|cur|n|time|size)\}/.test(fail({ phase: 'failed', error })), error);
  }
  assert.match(fail({ phase: 'failed', error: 'hash_mismatch' }), /The downloaded installer doesn't match Encore's signature, so it was deleted and not run\. Try again later\./);
  assert.equal(draw(W({ can_install_here: true })).banner, '', 'the banner on Windows too');
});

test('Updates: Check now (Docker answers at once; the tray within seconds, or the page says it didn\'t answer); Update now asks first', async () => {
  const { pg, st, draw } = await updPage();
  draw(updView({ state: 'never', latest: null }));
  st.answer = updView({ state: 'up_to_date', latest: null, reused: false });
  await pg.run('updCheck()');
  assert.deepEqual(st.calls.pop(), ['update/check', {}]);
  assert.equal(pg.el('updMsg').textContent, 'Encore Bridge 1.1.0 is up to date.');
  assert.equal(pg.el('updState').innerHTML, 'Encore Bridge 1.1.0 · up to date (checked just now)');
  // Windows: queued for the tray
  const id = '00000000000000a1';
  st.answer = { queued: id, update: updView({ source: 'launcher', kind: 'windows-installer', state: 'up_to_date', latest: null, request: { id, action: 'check', age_s: 0 } }) };
  await pg.run('updCheck()');
  assert.equal(pg.el('updMsg').textContent, 'Sent to the Encore Bridge icon on the PC…');
  assert.equal(pg.el('updState').innerHTML, 'Checking…');
  // two minutes later nobody picked it up
  let d = draw(updView({ source: 'launcher', kind: 'windows-installer', state: 'up_to_date', latest: null, request_expired: id }));
  assert.equal(d.msg, '');
  assert.equal(unq(d.body), '<p class="warn">The Encore Bridge icon on the PC didn\'t answer. Check that Encore Bridge is running there, then choose Check for updates in its menu.</p>');
  // Update now: the tray's question first; No sends nothing
  const inst = { ...updView().latest, asset: 'EncoreBridge-1.2.0-setup.exe' };
  draw(updView({ source: 'launcher', kind: 'windows-installer', latest: inst, can_install_here: true }));
  pg.run('confirm = function (m) { globalThis.lastConfirm = m; return false; }');
  await pg.run('updInstall()');
  assert.equal(st.calls.filter((c) => c[0] === 'update/install').length, 0);
  assert.equal(pg.run('lastConfirm'), 'Update Encore Bridge to 1.2.0?\n\nYou have 1.1.0. Encore Bridge downloads the installer from GitHub (30.9 MB), checks that it\'s signed by Encore, and then Windows asks for permission to install it.\n\n' +
    'Phones stop playing for about a minute while the bridge restarts. Your settings, Spotify sign-ins and paired phones stay.\n\nAfterwards, update the Encore app on your phone too: Cydia → Changes → Refresh.');
  pg.run('confirm = function () { return true; }');
  st.answer = { queued: '00000000000000a2', update: updView({ source: 'launcher', kind: 'windows-installer', latest: inst, can_install_here: true, request: { id: '00000000000000a2', action: 'install', age_s: 0 } }) };
  await pg.run('updInstall()');
  assert.deepEqual(st.calls.pop(), ['update/install', {}]);
  assert.equal(pg.el('updMsg').textContent, 'Sent to the Encore Bridge icon on the PC…');
  // the tray took it (acknowledged) and downloads: the message goes, the progress shows
  d = draw(updView({ source: 'launcher', kind: 'windows-installer', latest: inst, can_install_here: true, request_handled: '00000000000000a2',
    install: { version: '1.2.0', phase: 'downloading', done: 0, total: 32443228, error: null, exit_code: null } }));
  assert.equal(d.msg, '');
  assert.match(d.body, /^<p>Updating to 1\.2\.0: downloading 0%<\/p>/);
  // a refusal from the bridge (another computer): its message under the button
  draw(updView({ source: 'launcher', kind: 'windows-installer', latest: inst, can_install_here: true }));
  st.answer = { __status: 403, error: { code: 'update_here_only', message: 'To update, use the Encore Bridge icon on the PC: Encore Bridge 1.2.0 is available → Update now…' } };
  await pg.run('updInstall()');
  assert.equal(pg.el('updMsg').textContent, 'To update, use the Encore Bridge icon on the PC: Encore Bridge 1.2.0 is available → Update now…');
});

// ================================================================= languages: the page's texts in the chosen language (its
// dictionary from GET /admin/i18n/<code>.json); the bridge answers in it too (X-Encore-Lang on the page's API requests)
function langPage({ nav = {}, storage, dict = {}, marked = [] } = {}) {
  return stubPage({ search: '', nav, storage, marked, answers: (p) => {
    if (p.startsWith('/admin/i18n/')) return dict;
    if (p === 'setup') return { setup: false, platform: 'docker' };
    if (p === 'showcase') return { showcase: false };
    if (p === 'wizard') return { ...wizardAnswer({}), show: false, complete: true };
    return {};
  } });
}
// an element of the static markup with data-t* attributes
const mark = (a) => ({ a: { ...a }, innerHTML: a['data-t'] || '', title: a.title || '', placeholder: '',
  getAttribute(k) { return this.a[k]; }, hasAttribute(k) { return k in this.a; }, setAttribute(k, v) { this.a[k] = String(v); } });
const apiHeads = (pg) => pg.heads.filter(([p]) => !p.startsWith('/'));

test('languages: a picker with each language by its own name; English (the default) loads no dictionary and says X-Encore-Lang: en', async () => {
  const pg = langPage({ marked: [mark({ 'data-t': 'Setup guide' })] });
  await until(() => pg.run('view') === 'dashboard', 'the dashboard');
  assert.ok(!pg.calls.some((p) => p.startsWith('/admin/i18n/')), pg.calls.join(' '));
  const sel = pg.el('lang');
  assert.equal(sel.value, 'en');
  assert.deepEqual([...sel.innerHTML.matchAll(/<option value="([^"]+)" lang="[^"]+">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]), [
    ['en', 'English'], ['es', 'Español'], ['pt', 'Português (Brasil)'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['nl', 'Nederlands'],
    ['pl', 'Polski'], ['ru', 'Русский'], ['tr', 'Türkçe'], ['ja', '日本語'], ['ko', '한국어'], ['zh_CN', '简体中文']]);
  const api = apiHeads(pg);
  assert.ok(api.length >= 4 && api.every(([, h]) => h['X-Encore-Lang'] === 'en'), JSON.stringify(api));
  assert.equal(pg.doc.documentElement.lang, 'en');
  assert.match(HTML, /<select class="lang" id="lang"[^>]*onchange="setLang\(this\.value\)"><\/select><\/header>/);
});

test('languages: the browser\'s languages pick one; its dictionary loads before anything else; the markup, T() and the API requests follow it', async () => {
  const dict = { 'Setup guide': 'Einrichtungsanleitung', 'Close the guide': 'Anleitung schließen', 'Step {n} of {total}': 'Schritt {n} von {total}',
    'Spotify link or URI (track, album, playlist)': 'Spotify-Link oder URI', 'Not checked yet': '' };
  const marked = [mark({ 'data-t': 'Setup guide' }), mark({ 'data-t-title': 'Close the guide', title: 'Close the guide', 'aria-label': 'Close the guide' }),
    mark({ 'data-t-ph': 'Spotify link or URI (track, album, playlist)' }), mark({ 'data-t': 'Not in the dictionary' })];
  const pg = langPage({ nav: { languages: ['xx-YY', 'de-AT', 'en'] }, dict, marked });
  await until(() => pg.run('view') === 'dashboard', 'the dashboard');
  assert.equal(pg.calls[0], '/admin/i18n/de.json', 'the dictionary first');
  assert.deepEqual(marked.map((e) => [e.innerHTML, e.title, e.placeholder]), [['Einrichtungsanleitung', '', ''], ['', 'Anleitung schließen', ''],
    ['', '', 'Spotify-Link oder URI'], ['Not in the dictionary', '', '']]);
  assert.equal(marked[1].a['aria-label'], 'Anleitung schließen');
  assert.equal(pg.run('T(\'Step {n} of {total}\', { n: 2, total: 9 })'), 'Schritt 2 von 9');
  assert.equal(pg.run('T(\'Nothing playing\')'), 'Nothing playing', 'English where the dictionary has nothing');
  assert.equal(pg.run('T(\'Not checked yet\')'), 'Not checked yet', 'or an empty text');
  assert.equal(pg.doc.documentElement.lang, 'de');
  assert.equal(pg.el('lang').value, 'de');
  const api = apiHeads(pg);
  assert.ok(api.length >= 4 && api.every(([, h]) => h['X-Encore-Lang'] === 'de'), JSON.stringify(api));
});

test('languages: a saved choice wins over the browser\'s; tags map like the bridge\'s; picking one saves it and reloads; a missing dictionary leaves English', async () => {
  const kept = { 'encore.lang': 'zh_CN' };
  const storage = { getItem: (k) => (k in kept ? kept[k] : null), setItem: (k, v) => { kept[k] = String(v); } };
  const pg = langPage({ nav: { languages: ['de'] }, storage, dict: { 'Setup guide': '设置向导' } });
  await until(() => pg.run('view') === 'dashboard', 'the dashboard');
  assert.equal(pg.calls[0], '/admin/i18n/zh_CN.json');
  assert.equal(pg.doc.documentElement.lang, 'zh-CN');
  for (const [tag, code] of [['es-419', 'es'], ['pt-PT', 'pt'], ['pt_BR', 'pt'], ['zh', 'zh_CN'], ['zh-CN', 'zh_CN'], ['zh-Hans-HK', 'zh_CN'], ['zh-SG', 'zh_CN'],
    ['zh-TW', ''], ['zh-Hant', ''], ['en-GB', 'en'], ['NL', 'nl'], ['sv-SE', ''], ['', '']]) {
    assert.equal(pg.run(`langOfTag(${JSON.stringify(tag)})`), code, tag);
  }
  pg.run('setLang(\'zh_CN\')');                        // the one shown: nothing to do
  pg.run('setLang(\'xx\')');                           // not one of the languages
  assert.ok(!pg.ctx.reloaded && kept['encore.lang'] === 'zh_CN');
  pg.run('setLang(\'ja\')');
  assert.ok(pg.ctx.reloaded && kept['encore.lang'] === 'ja');
  // a saved value that isn't a language: the browser's languages decide
  kept['encore.lang'] = 'klingon';
  const pg2 = langPage({ nav: { languages: ['ko-KR'] }, storage });
  await until(() => pg2.run('view') === 'dashboard', 'the dashboard');
  assert.equal(pg2.calls[0], '/admin/i18n/ko.json');
  // the dictionary doesn't load: the page stays in English
  const marked = [mark({ 'data-t': 'Setup guide' })];
  const pg3 = langPage({ nav: { languages: ['fr'] }, dict: { __status: 404 }, marked });
  await until(() => pg3.run('view') === 'dashboard', 'the dashboard');
  assert.equal(pg3.calls[0], '/admin/i18n/fr.json');
  assert.equal(marked[0].innerHTML, 'Setup guide');
  assert.equal(pg3.doc.documentElement.lang, 'en');
});
