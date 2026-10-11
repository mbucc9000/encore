'use strict';
// The setup guide's network check (netcheck.js; DESIGN-WIZARD.md §4): the problem codes from the address, the
// listening probe and (Windows) one read-only PowerShell run with a constant script, its inputs only in ENCORE_NC_*
// variables and a hidden window; a timeout or odd output is check_failed; Docker / other never run PowerShell; the
// output is never logged; one check at a time and a 15 s reuse. PowerShell is never started here: exec is injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { NetCheck, PS_SCRIPT, parsePs, psEnv, powershellExe, tcpConnect, RULE_NAME } = require('../src/netcheck');
const { capture } = require('./support/wizard-server');

const NODE = 'C:\\Program Files\\Encore Bridge\\runtime\\node.exe';
const OK_PS = { block: 0, allow: true, rule: true, profile: 'Private', error: '' };

// an exec stub: answers with stdout (a function of the call, or a value), or an error
function fakeExec(answer) {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const a = typeof answer === 'function' ? answer(calls.length) : answer;
    setImmediate(() => (a instanceof Error ? cb(a, '', 'stderr text') : cb(null, typeof a === 'string' ? a : JSON.stringify(a), '')));
    return { stdin: { end() {} } };
  };
  exec.calls = calls;
  return exec;
}

// runs fn with the bridge's log captured (the tests that don't look at it keep it out of the runner's output)
async function quiet(fn) {
  const cap = capture();
  try { return await fn(); } finally { cap.restore(); }
}

function check(o = {}) {
  let clock = 1760000000000;
  const connects = [];
  const nc = new NetCheck({
    cfg: { port: 8095 }, platform: o.platform || 'windows', nodePath: NODE,
    lanAddress: async () => (o.address === undefined ? '192.168.1.20' : o.address),
    candidates: () => o.candidates || [{ name: 'Wi-Fi', address: '192.168.1.20', virtual: false }],
    exec: o.exec || fakeExec(OK_PS),
    connect: async (host, port) => { connects.push([host, port]); return o.listening !== false; },
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows', ADMIN_PASSWORD: 'pw-made-up', ENCORE_LAUNCHER_TOKEN: 'tok-made-up', SPOTIFY_CLIENT_ID: 'id-made-up', NODE_OPTIONS: '--inspect' },
    now: () => clock,
  });
  return { nc, connects, tick: (ms) => { clock += ms; } };
}

test('Windows, all fine: four good lines, ok', () => quiet(async () => {
  const { nc, connects } = check();
  const r = await nc.check();
  assert.deepEqual(r, { platform: 'windows', checked_at: 1760000000000, address: '192.168.1.20', addresses: null, port: 8095, listening: true,
    profile: 'private', firewall: { allow: true, block: 0, rule: true }, problems: [], ok: true });
  assert.deepEqual(connects, [['192.168.1.20', 8095]]);
  assert.deepEqual(nc.summary(), { ok: true, checked_at: 1760000000000 });
}));

test('Windows: each problem code from its cause', () => quiet(async () => {
  const cases = [
    [{ ps: { ...OK_PS, profile: 'Public' } }, ['public_network'], 'public'],
    [{ ps: { ...OK_PS, profile: 'DomainAuthenticated' } }, [], 'domain'],
    [{ ps: { ...OK_PS, block: 2 } }, ['firewall_block'], 'private'],
    [{ ps: { ...OK_PS, allow: false } }, ['firewall_missing'], 'private'],
    [{ ps: { ...OK_PS, allow: false, rule: false, block: 1, profile: 'Public' } }, ['public_network', 'firewall_block', 'firewall_missing'], 'public'],
    [{ ps: { ...OK_PS, rule: false } }, [], 'private'],                         // (the portable zip: no installer rule, fine)
    [{ ps: { ...OK_PS, error: 'firewall' } }, ['check_failed'], 'private'],
    [{ ps: { ...OK_PS, profile: '', error: 'profile' } }, ['check_failed'], 'unknown'],
    [{ ps: { ...OK_PS, profile: 'Something' } }, [], 'unknown'],
    [{ ps: new Error('spawn timeout') }, ['check_failed'], 'unknown'],
    [{ ps: 'not json at all' }, ['check_failed'], 'unknown'],
    [{ ps: '' }, ['check_failed'], 'unknown'],
    [{ address: null }, ['no_address'], 'private'],
    [{ listening: false }, ['not_listening'], 'private'],
  ];
  for (const [o, problems, profile] of cases) {
    const { nc, connects } = check({ ...o, exec: o.ps !== undefined ? fakeExec(o.ps) : undefined });
    const r = await nc.check();
    assert.deepEqual(r.problems, problems, JSON.stringify(o));
    assert.equal(r.ok, problems.length === 0);
    assert.equal(r.profile, profile, JSON.stringify(o));
    if (o.address === null) assert.deepEqual(connects, [], 'no address: nothing to connect to');
    if (o.ps && (o.ps instanceof Error || typeof o.ps === 'string' || o.ps.error === 'firewall')) assert.equal(r.firewall, null);
  }
}));

test('PowerShell: the constant script, a hidden window, a timeout and a cap, the inputs only in ENCORE_NC_*, no secrets passed on', () => quiet(async () => {
  const exec = fakeExec(OK_PS);
  const { nc } = check({ exec });
  await nc.check();
  assert.equal(exec.calls.length, 1);
  const { file, args, opts } = exec.calls[0];
  assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT]);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.timeout, 30000);
  assert.equal(opts.maxBuffer, 64 * 1024);
  assert.equal(opts.env.ENCORE_NC_NODE, NODE);
  assert.equal(opts.env.ENCORE_NC_PORT, '8095');
  assert.equal(opts.env.ENCORE_NC_ADDR, '192.168.1.20');
  for (const k of ['ADMIN_PASSWORD', 'ENCORE_LAUNCHER_TOKEN', 'SPOTIFY_CLIENT_ID', 'NODE_OPTIONS']) assert.equal(opts.env[k], undefined, k);
  assert.equal(opts.env.SystemRoot, 'C:\\Windows', 'the rest of the environment stays');
  // the script is a constant: nothing of this computer is in it
  for (const v of [NODE, '192.168.1.20', '8095', 'node.exe']) assert.ok(!PS_SCRIPT.includes(v), v);
  assert.ok(PS_SCRIPT.includes('$env:ENCORE_NC_NODE') && PS_SCRIPT.includes('$env:ENCORE_NC_PORT') && PS_SCRIPT.includes('$env:ENCORE_NC_ADDR'));
  assert.ok(PS_SCRIPT.includes(`'${RULE_NAME}'`) && RULE_NAME === 'Encore Bridge (phone)');
  // read-only, and never the network's name or the adapter's alias
  assert.ok(!/\b(New|Set|Remove|Enable|Disable)-Net/i.test(PS_SCRIPT), 'read-only');
  assert.ok(!/\.Name\b|InterfaceAlias|\.Alias\b|-EncodedCommand|Invoke-Expression|\biex\b/i.test(PS_SCRIPT));
  assert.ok(PS_SCRIPT.includes('ConvertTo-Json -Compress'));
  assert.ok(!PS_SCRIPT.includes('\n'), 'one line');
  // no address: an empty ENCORE_NC_ADDR
  const e2 = fakeExec(OK_PS);
  await check({ exec: e2, address: null }).nc.check();
  assert.equal(e2.calls[0].opts.env.ENCORE_NC_ADDR, '');
  assert.equal(powershellExe({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(psEnv({ node: 'n', port: 1, address: null }, { A: '1', ADMIN_PASSWORD: 'x' }).ADMIN_PASSWORD, undefined);
}));

test('parsePs: the last {...} line, only the known keys and types; anything odd is null', () => {
  assert.deepEqual(parsePs('WARNING: something\r\n{"block":1,"allow":true,"rule":false,"profile":"Public","error":""}\r\n'),
    { block: 1, allow: true, rule: false, profile: 'public', error: '' });
  assert.deepEqual(parsePs('{"block":0}\n{"block":3,"allow":"yes","rule":1,"profile":"Private","error":"Access denied","name":"MyWiFi"}'),
    { block: 3, allow: false, rule: false, profile: 'private', error: 'firewall' }, 'exception text becomes a fixed word');
  assert.equal(parsePs('{nope}'), null);
  assert.equal(parsePs('[]'), null);
  assert.equal(parsePs(''), null);
  assert.equal(parsePs(null), null);
  assert.equal(parsePs('{"block":-1,"allow":true,"rule":true,"profile":"Private","error":"profile"}').block, 0);
});

test('Docker / other: PowerShell is never started; the private addresses on real adapters, the chosen one first', () => quiet(async () => {
  const exec = fakeExec(() => { throw new Error('PowerShell must not run here'); });
  const candidates = [{ name: 'docker0', address: '198.51.100.17', virtual: true }, { name: 'eth1', address: '203.0.113.5', virtual: false },
    { name: 'eth0', address: '192.168.1.20', virtual: false }];
  for (const platform of ['docker', 'other']) {
    const { nc } = check({ platform, exec, candidates });
    const r = await nc.check();
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(r, { platform, checked_at: 1760000000000, address: '192.168.1.20', addresses: ['192.168.1.20', '203.0.113.5'], port: 8095,
      listening: true, profile: null, firewall: null, problems: [], ok: true });
  }
  const { nc } = check({ platform: 'docker', address: null, candidates: [] });
  const r = await nc.check();
  assert.deepEqual(r.problems, ['no_address']);
  assert.deepEqual(r.addresses, []);
}));

test('the log: one line per check, problem codes only; PowerShell\'s output never', async () => {
  const cap = capture();
  try {
    await check({ exec: fakeExec('Living-Room-WiFi-made-up\r\n{"block":1,"allow":false,"rule":false,"profile":"Public","error":""}') }).nc.check();
    await check().nc.check();
    await check({ exec: fakeExec(new Error('Living-Room-WiFi-made-up failed')) }).nc.check();
  } finally { cap.restore(); }
  const lines = cap.lines.map((l) => l.replace(/^\S+ \w /, ''));
  assert.deepEqual(lines, ['network check: public_network, firewall_block, firewall_missing', 'network check: ok', 'network check: check_failed']);
  assert.ok(!cap.text().includes('Living-Room') && !cap.text().includes('192.168.1.20') && !cap.text().includes(NODE));
});

test('reuse: 15 s for a plain look, 3 s with fresh; one check at a time', async () => {
  const exec = fakeExec(OK_PS);
  const { nc, tick } = check({ exec });
  const cap = capture();
  try {
    const [a, b] = await Promise.all([nc.check(), nc.check({ fresh: true })]);
    assert.equal(a, b, 'the same run');
    assert.equal(exec.calls.length, 1);
    tick(2000);
    assert.equal(await nc.check({ fresh: true }), a, 'fresh, but only 2 s old');
    tick(2000);
    const c = await nc.check({ fresh: true });
    assert.notEqual(c, a, 'fresh and older than 3 s: a new check');
    assert.equal(exec.calls.length, 2);
    tick(14000);
    assert.equal(await nc.check(), c, '14 s: reused');
    tick(2000);
    await nc.check();
    assert.equal(exec.calls.length, 3, '16 s: a new check');
  } finally { cap.restore(); }
});

test('Showcase trims the addresses only', () => {
  const r = { platform: 'docker', address: '192.168.1.20', addresses: ['192.168.1.20'], port: 8095, problems: [], ok: true };
  assert.deepEqual(NetCheck.trim(r, true), { ...r, address: null, addresses: null });
  assert.equal(NetCheck.trim(r, false), r);
});

test('tcpConnect: true when something listens, false when nothing does (within the timeout)', async () => {
  const srv = net.createServer((c) => c.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.equal(await tcpConnect('127.0.0.1', port), true);
  } finally { await new Promise((r) => srv.close(r)); }
  assert.equal(await tcpConnect('127.0.0.1', port, 1500), false);
  const t0 = Date.now();
  assert.equal(await tcpConnect('192.0.2.1', 9, 300), false, 'an address that never answers: the timeout');
  assert.ok(Date.now() - t0 < 2000);
});
