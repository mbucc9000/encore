'use strict';
// Step 8's Open your router (http.js pickRouter; DESIGN-WIZARD.md §1.3): the router is the bridge computer's own default
// gateway, read from /proc/net/route (Linux, and Docker with host networking: the container sees the host's routes) or
// `route print -4` (Windows, any language), on the adapter that holds the Home address, and only a private IPv4 one.
// Synthetic interfaces and routing tables only. The addresses are built with ip() (as in phone-address.test.js) so the
// release scan's address check doesn't take these made-up ones for someone's real network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickRouter, pickPhoneAddress, parseProcRoute, parseRoutePrint, homeNetwork, networkOf } = require('../src/http');

const ip = (...o) => o.join('.');
const HOME = '192.168.1.20';                       // the documented example address
const ROUTER = ip(192, 168, 1, 1);
const v4 = (address, mac = '3c:22:fb:00:00:01') => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false, cidr: address + '/24' });
const lo = { address: ip(127, 0, 0, 1), netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: ip(127, 0, 0, 1) + '/8' };

// ---- /proc/net/route as the kernel writes it on a little-endian computer: each address a 32-bit hex number, low byte first
const hex = (a) => a.split('.').map(Number).reverse().map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join('');
const ANY = ip(0, 0, 0, 0);
const HEAD = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';
// flags: 0001 up, 0003 up + gateway
const rt = (iface, dest, gw, flags, metric, mask) => [iface, hex(dest), hex(gw), flags, 0, 0, metric, hex(mask), 0, 0, 0].join('\t') + '\n';
const dflt = (iface, gw, metric, flags = '0003') => rt(iface, ANY, gw, flags, metric, ANY);
const net24 = (iface, dest) => rt(iface, dest, ANY, '0001', 0, ip(255, 255, 255, 0));
const linux = (ifaces, ...lines) => {
  const routes = parseProcRoute(HEAD + lines.join(''), 'LE');
  return { routes, address: pickPhoneAddress(ifaces, routes), router: pickRouter(ifaces, routes) };
};

test('/proc/net/route: the gateway is decoded in the computer\'s byte order; none when the route has no gateway or isn\'t up', () => {
  assert.equal(hex(ROUTER), '0101A8C0', 'the fixtures write addresses as the kernel does');
  assert.deepEqual(parseProcRoute(HEAD + dflt('enp3s0', ROUTER, 0), 'LE'), [{ iface: 'enp3s0', metric: 0, gateway: ROUTER }]);
  // a big-endian computer prints the same address the other way round
  assert.deepEqual(parseProcRoute(HEAD + 'eth0\t00000000\tC0A80101\t0003\t0\t0\t5\t00000000\t0\t0\t0\n', 'BE'), [{ iface: 'eth0', metric: 5, gateway: ROUTER }]);
  // no gateway (a point-to-point link, a WireGuard tunnel), not up, an all-zero or unreadable gateway
  assert.deepEqual(parseProcRoute(HEAD + dflt('wg0', ANY, 0, '0001') + dflt('enp3s0', ROUTER, 10, '0002') + dflt('eth1', ANY, 20) +
    'eth2\t00000000\tZZZZZZZZ\t0003\t0\t0\t30\t00000000\t0\t0\t0\n', 'LE').map((r) => r.gateway), [null, null, null, null]);
  // only default routes (destination and mask 0): not a LAN route, not OpenVPN's 0.0.0.0/1 + 128.0.0.0/1 pair
  assert.deepEqual(parseProcRoute(HEAD + net24('enp3s0', ip(192, 168, 1, 0)) + rt('tun0', ANY, ip(10, 8, 0, 1), '0003', 0, ip(128, 0, 0, 0)) +
    rt('tun0', ip(128, 0, 0, 0), ip(10, 8, 0, 1), '0003', 0, ip(128, 0, 0, 0)), 'LE'), []);
  assert.deepEqual(parseProcRoute('', 'LE'), []);
});

test('Linux / Docker host networking: the default route\'s gateway on the Home address\'s adapter', () => {
  // a NAS running the bridge's container with host networking: the host's adapters and routes, Docker's bridges too
  const nas = { lo: [lo], enp3s0: [v4(HOME)], docker0: [v4(ip(172, 17, 0, 1), '02:42:ac:11:00:01')], 'br-3f2a1b4c5d6e': [v4(ip(172, 18, 0, 1), '02:42:00:00:00:02')],
    veth1a2b3c4: [] };
  let r = linux(nas, dflt('enp3s0', ROUTER, 0), net24('enp3s0', ip(192, 168, 1, 0)), rt('docker0', ip(172, 17, 0, 0), ANY, '0001', 0, ip(255, 255, 0, 0)),
    rt('br-3f2a1b4c5d6e', ip(172, 18, 0, 0), ANY, '0001', 0, ip(255, 255, 0, 0)));
  assert.deepEqual([r.address, r.router], [HOME, ROUTER]);
  // other private ranges count too
  r = linux({ eth0: [v4(ip(10, 0, 0, 23))] }, dflt('eth0', ip(10, 0, 0, 1), 100));
  assert.equal(r.router, ip(10, 0, 0, 1));
  r = linux({ eth0: [v4(ip(172, 16, 5, 9))] }, dflt('eth0', ip(172, 16, 0, 1), 100));
  assert.equal(r.router, ip(172, 16, 0, 1));
});

test('Docker bridge network instead of host networking: the gateway is Docker\'s own bridge, so no router', () => {
  // `docker run -p 8095:8095`: only eth0 on Docker's network (a random MAC, as Docker 28 gives), the host's bridge as gateway
  const routes = parseProcRoute(HEAD + 'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
    'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n', 'LE');
  const box = { lo: [lo], eth0: [v4(ip(172, 17, 0, 2), '92:f1:3a:00:00:02')] };
  assert.deepEqual(routes, [{ iface: 'eth0', metric: 0, gateway: ip(172, 17, 0, 1) }]);
  assert.deepEqual(networkOf(box, routes, 'docker'), { address: ip(172, 17, 0, 2), router: null });
  // the same table outside a container (a Linux computer on a 172.16/12 home network): its router
  assert.deepEqual(networkOf(box, routes, 'other'), { address: ip(172, 17, 0, 2), router: ip(172, 17, 0, 1) });
  // Docker with host networking: the host's adapters (Docker's bridges too), so the home router
  const nas = { lo: [lo], enp3s0: [v4(HOME)], docker0: [v4(ip(172, 17, 0, 1))] };
  assert.equal(networkOf(nas, [{ iface: 'enp3s0', metric: 0, gateway: ROUTER }], 'docker').router, ROUTER);
  // a container whose only adapter is on the home network (macvlan) keeps its router
  assert.equal(networkOf({ lo: [lo], eth0: [v4(HOME)] }, [{ iface: 'eth0', metric: 0, gateway: ROUTER }], 'docker').router, ROUTER);
});

test('Linux: more than one default route: the lowest metric wins, and always the one on the Home address\'s adapter', () => {
  const two = { enp3s0: [v4(HOME)], wlan0: [v4(ip(192, 168, 1, 21))] };
  const other = ip(192, 168, 1, 254);
  let r = linux(two, dflt('enp3s0', ROUTER, 100), dflt('wlan0', other, 600));
  assert.deepEqual([r.address, r.router], [HOME, ROUTER]);
  r = linux(two, dflt('enp3s0', ROUTER, 600), dflt('wlan0', other, 100));
  assert.deepEqual([r.address, r.router], [ip(192, 168, 1, 21), other], 'the router follows the address step 8 shows');
  // two gateways on one adapter: the lower metric
  r = linux({ enp3s0: [v4(HOME)] }, dflt('enp3s0', other, 200), dflt('enp3s0', ROUTER, 100));
  assert.equal(r.router, ROUTER);
});

test('Linux: a VPN\'s default route is never the router; a VPN-only default route or none at all: no router', () => {
  const nas = { enp3s0: [v4(HOME)], wg0: [v4(ip(10, 66, 0, 2), '00:00:00:00:00:00')], tun0: [v4(ip(10, 8, 0, 6), '00:00:00:00:00:00')] };
  // WireGuard full tunnel (no gateway, lower metric) next to the LAN's default route
  let r = linux(nas, dflt('wg0', ANY, 0, '0001'), dflt('enp3s0', ROUTER, 100));
  assert.deepEqual([r.address, r.router], [HOME, ROUTER]);
  // OpenVPN with a gateway of its own (private, lower metric): skipped, it isn't the Home address's adapter
  r = linux(nas, dflt('tun0', ip(10, 8, 0, 1), 0), dflt('enp3s0', ROUTER, 100));
  assert.deepEqual([r.address, r.router], [HOME, ROUTER]);
  // only the VPN has a default route: the Home address is still found, the router isn't
  r = linux(nas, dflt('tun0', ip(10, 8, 0, 1), 0), net24('enp3s0', ip(192, 168, 1, 0)));
  assert.deepEqual([r.address, r.router], [HOME, null]);
  // no default route at all, and nothing at all
  r = linux({ enp3s0: [v4(HOME)] }, net24('enp3s0', ip(192, 168, 1, 0)));
  assert.deepEqual([r.address, r.router], [HOME, null]);
  assert.equal(pickRouter({}, []), null);
  assert.equal(pickRouter({ enp3s0: [v4(HOME)] }, []), null);
  // the LAN's default route without a gateway (the computer is on a point-to-point link)
  assert.equal(linux({ enp3s0: [v4(HOME)] }, dflt('enp3s0', ANY, 0, '0001')).router, null);
});

test('only a private IPv4 gateway counts: never a public, CGNAT (100.64/10), link-local, loopback or 0.0.0.0 one', () => {
  for (const gw of [ip(203, 0, 113, 1), ip(100, 64, 0, 1), ip(100, 127, 255, 1), ip(169, 254, 1, 1), ip(127, 0, 0, 1), ANY, ip(8, 8, 8, 8), ip(224, 0, 0, 1)]) {
    assert.equal(pickRouter({ Ethernet: [v4(HOME)] }, [{ address: HOME, metric: 1, gateway: gw }]), null, gw);
  }
  for (const gw of [ip(192, 168, 1), ip(192, 168, 1, 256), ip(192, 168, '01', 1), ' ' + ROUTER, null, undefined, 42]) {
    assert.equal(pickRouter({ Ethernet: [v4(HOME)] }, [{ address: HOME, metric: 1, gateway: gw }]), null, String(gw));
  }
  assert.equal(pickRouter({ Ethernet: [v4(HOME)] }, [{ address: HOME, metric: 1, gateway: HOME }]), null, 'not the computer itself');
  assert.equal(pickRouter({ Ethernet: [v4(HOME)] }, [{ address: HOME, metric: 1, gateway: ROUTER }]), ROUTER);
});

// ---- `route print -4` (Windows): padded columns as ROUTE.EXE prints them
const row = (...cols) => cols.map((c) => String(c).padStart(17)).join('');
const table = (active, persistent = []) => [
  '===========================================================================',
  'IPv4 Route Table',
  '===========================================================================',
  'Active Routes:',
  'Network Destination        Netmask          Gateway       Interface  Metric',
  ...active,
  '===========================================================================',
  'Persistent Routes:',
  ...(persistent.length ? ['  Network Address          Netmask  Gateway Address  Metric', ...persistent] : ['  None']),
  '===========================================================================',
].join('\r\n');
const windows = (ifaces, text) => {
  const routes = parseRoutePrint(text);
  return { routes, address: pickPhoneAddress(ifaces, routes), router: pickRouter(ifaces, routes) };
};

test('Windows: the gateway column of the Home address\'s default route; Ethernet and Wi-Fi both connected', () => {
  const pc = { Ethernet: [v4(HOME)], 'Wi-Fi': [v4(ip(192, 168, 1, 21), '3c:22:fb:00:00:02')], 'Loopback Pseudo-Interface 1': [lo] };
  let r = windows(pc, table([row(ANY, ANY, ROUTER, HOME, 25), row(ANY, ANY, ROUTER, ip(192, 168, 1, 21), 50),
    row(ip(127, 0, 0, 0), ip(255, 0, 0, 0), 'On-link', ip(127, 0, 0, 1), 331), row(ip(192, 168, 1, 0), ip(255, 255, 255, 0), 'On-link', HOME, 281)]));
  assert.deepEqual(r.routes.map((x) => x.gateway), [ROUTER, ROUTER]);
  assert.deepEqual([r.address, r.router], [HOME, ROUTER]);
  // a router of its own on each network: the one of the adapter Windows prefers
  const other = ip(10, 0, 0, 1);
  r = windows({ Ethernet: [v4(ip(10, 0, 0, 24))], 'Wi-Fi': [v4(HOME)] }, table([row(ANY, ANY, ROUTER, HOME, 55), row(ANY, ANY, other, ip(10, 0, 0, 24), 25)]));
  assert.deepEqual([r.address, r.router], [ip(10, 0, 0, 24), other]);
});

test('Windows: VPNs (On-link in any language, or a gateway of their own) are skipped; the persistent routes never count', () => {
  const vpn = ip(10, 5, 0, 2);
  const tap = ip(10, 8, 0, 6);
  const pc = { 'Wi-Fi': [v4(HOME)], NordLynx: [v4(vpn, '00:00:00:00:00:00')], 'OpenVPN TAP-Windows6': [v4(tap, '00:ff:aa:bb:cc:dd')] };
  // German "Auf Verbindung", French "Sur la liaison"
  for (const onLink of ['On-link', 'Auf Verbindung', 'Sur la liaison']) {
    const r = windows(pc, table([row(ANY, ANY, onLink, vpn, 5), row(ANY, ANY, ROUTER, HOME, 50)]));
    assert.deepEqual([r.address, r.router], [HOME, ROUTER], onLink);
  }
  let r = windows(pc, table([row(ANY, ANY, ip(10, 8, 0, 5), tap, 1), row(ANY, ANY, ROUTER, HOME, 50)]));
  assert.deepEqual([r.address, r.router], [HOME, ROUTER], 'the VPN\'s own gateway (private, lower metric) isn\'t the router');
  // the only active default route is the VPN's; a persistent route names the router: still none (it has no interface)
  r = windows(pc, table([row(ANY, ANY, 'On-link', vpn, 5)], [row(ANY, ANY, ROUTER, 1)]));
  assert.deepEqual(r.routes.find((x) => x.address === ROUTER), { address: ROUTER, metric: 1, gateway: null });
  assert.deepEqual([r.address, r.router], [HOME, null]);
  // a Hyper-V external switch carries the home network: its default route's gateway is the router
  r = windows({ 'vEthernet (External)': [v4(HOME, '00:15:5d:01:02:03')] }, table([row(ANY, ANY, ROUTER, HOME, 25)]));
  assert.deepEqual([r.address, r.router], [HOME, ROUTER]);
  // a public or CGNAT gateway, and no default route at all
  assert.equal(windows({ Ethernet: [v4(HOME)] }, table([row(ANY, ANY, ip(203, 0, 113, 1), HOME, 25)])).router, null);
  assert.equal(windows({ Ethernet: [v4(HOME)] }, table([row(ANY, ANY, ip(100, 64, 0, 1), HOME, 25)])).router, null);
  assert.equal(windows({ Ethernet: [v4(HOME)] }, table([row(ip(192, 168, 1, 0), ip(255, 255, 255, 0), 'On-link', HOME, 281)])).router, null);
  assert.equal(windows({ Ethernet: [v4(HOME)] }, '').router, null);
});

test('homeNetwork(): {address, router} from one look; no routes known on this platform: no router', async () => {
  const n = await homeNetwork('sunos');
  assert.deepEqual(Object.keys(n).sort(), ['address', 'router']);
  assert.equal(n.router, null);
  // the real routes of the computer running the tests: a private IPv4 or nothing (with --network none: nothing)
  const real = await homeNetwork();
  assert.ok(real.router === null || /^(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(real.router), String(real.router));
});
