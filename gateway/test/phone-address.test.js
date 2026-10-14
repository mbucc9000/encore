'use strict';
// The iPhone's Home address (R3c, http.js): the admin page's Phone setup panel and the tray's phone_url
// (gateway/windows/CONTRACT.md §5). This computer's private IPv4 address on the adapter its default route uses, skipping
// virtual switches, VM host adapters, container bridges, VPNs and overlays. Routes from /proc/net/route (Linux) or
// `route print -4` (Windows, any language). Synthetic interfaces and routing tables only. The addresses are built with
// ip() so the release scan's address check doesn't take these made-up ones for someone's real network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickPhoneAddress, parseProcRoute, parseRoutePrint, lanCandidates } = require('../src/http');

const ip = (...o) => o.join('.');
const HOME = '192.168.1.20';                       // the documented example address
const v4 = (address, mac = '3c:22:fb:00:00:01', extra = {}) => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false, cidr: address + '/24', ...extra });
const lo = { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' };

test('only private IPv4 on non-loopback adapters are candidates; virtual ones are marked', () => {
  const c = lanCandidates({
    'Loopback Pseudo-Interface 1': [lo],
    'Wi-Fi': [v4(HOME), { address: 'fe80::1', family: 'IPv6', mac: '3c:22:fb:00:00:01', internal: false }],
    Tailscale: [v4(ip(100, 101, 102, 103), '00:00:00:00:00:00')],
    'Ethernet 3': [v4('169.254.10.20')],
    Public: [v4('203.0.113.5')],
    'vEthernet (Default Switch)': [v4(ip(172, 20, 16, 1), '00:15:5d:00:00:01')],
    'Node 18.0-18.3 family as a number': [v4(ip(10, 1, 2, 3), '3c:22:fb:00:00:02', { family: 4 })],
  });
  assert.deepEqual(c.map((x) => [x.name, x.address, x.virtual]), [
    ['Wi-Fi', HOME, false],
    ['vEthernet (Default Switch)', ip(172, 20, 16, 1), true],
    ['Node 18.0-18.3 family as a number', ip(10, 1, 2, 3), false],
  ]);
});

test('the default route\'s adapter wins over a "nicer" range; VPNs, VM host adapters and container bridges are skipped', () => {
  // a PC with VMware host-only networks on 192.168, Hyper-V's switch, and Wi-Fi on 10.x (the default route)
  const wifi = ip(10, 0, 0, 23);
  const pc = {
    'VMware Network Adapter VMnet1': [v4(ip(192, 168, 56, 1), '00:50:56:c0:00:01')],
    'VMware Network Adapter VMnet8': [v4(ip(192, 168, 57, 1), '00:50:56:c0:00:08')],
    'Wi-Fi': [v4(wifi)],
    'vEthernet (Default Switch)': [v4(ip(172, 20, 16, 1), '00:15:5d:00:00:01')],
  };
  assert.equal(pickPhoneAddress(pc, [{ address: wifi, metric: 50 }]), wifi);
  assert.equal(pickPhoneAddress(pc, []), wifi, 'no routes known: the best real adapter');
  // a full-tunnel VPN takes the default route with a lower metric: skipped
  const vpn = { ...pc, NordLynx: [v4(ip(10, 5, 0, 2), '00:00:00:00:00:00')], 'OpenVPN TAP-Windows6': [v4(ip(10, 8, 0, 6), '00:ff:aa:bb:cc:dd')] };
  assert.equal(pickPhoneAddress(vpn, [{ address: ip(10, 5, 0, 2), metric: 5 }, { address: ip(10, 8, 0, 6), metric: 10 }, { address: wifi, metric: 50 }]), wifi);
  // the VPN's adapter named like a real one but with a TAP-Windows MAC
  assert.equal(pickPhoneAddress({ 'Ethernet 2': [v4(ip(10, 8, 0, 6), '00:ff:12:34:56:78')], Ethernet: [v4(HOME)] }, [{ address: ip(10, 8, 0, 6), metric: 1 }]), HOME);
  // Linux with Docker: docker0 and br-<id> are skipped by name, WireGuard by name and its all-zero MAC
  const nas = { docker0: [v4(ip(172, 17, 0, 1), '02:42:ac:11:00:01')], 'br-3f2a1b4c5d6e': [v4(ip(172, 18, 0, 1), '02:42:00:00:00:02')], enp3s0: [v4(HOME)],
    wg0: [v4(ip(10, 66, 0, 1), '00:00:00:00:00:00')] };
  assert.equal(pickPhoneAddress(nas, [{ iface: 'enp3s0', metric: 100 }]), HOME);
  assert.equal(pickPhoneAddress(nas, [{ iface: 'wg0', metric: 1 }]), HOME);
  assert.equal(pickPhoneAddress(nas, []), HOME);
  // a Linux bridge for the LAN (br0, not a container network) counts
  assert.equal(pickPhoneAddress({ br0: [v4(HOME)], docker0: [v4(ip(172, 17, 0, 1), '02:42:ac:11:00:01')] }, [{ iface: 'br0', metric: 0 }]), HOME);
  // the lowest metric wins among real adapters with a default route
  assert.equal(pickPhoneAddress({ Ethernet: [v4(ip(10, 0, 0, 24))], 'Wi-Fi': [v4(HOME)] }, [{ address: HOME, metric: 55 }, { address: ip(10, 0, 0, 24), metric: 25 }]), ip(10, 0, 0, 24));
});

test('when the only private adapter looks virtual (the bridge inside a VM, a Hyper-V external switch), the default route\'s own is used', () => {
  assert.equal(pickPhoneAddress({ ens18: [v4(HOME, '52:54:00:12:34:56')] }, [{ iface: 'ens18', metric: 0 }]), HOME);
  assert.equal(pickPhoneAddress({ 'vEthernet (External)': [v4(HOME, '00:15:5d:01:02:03')], 'vEthernet (WSL)': [v4(ip(172, 29, 0, 1), '00:15:5d:0a:0b:0c')] },
    [{ address: HOME, metric: 25 }]), HOME);
  assert.equal(pickPhoneAddress({ 'vEthernet (WSL)': [v4(ip(172, 29, 0, 1), '00:15:5d:0a:0b:0c')] }, []), null, 'virtual only and no route: nothing to suggest');
  assert.equal(pickPhoneAddress({}, []), null);
  assert.equal(pickPhoneAddress({ Tailscale: [v4(ip(100, 64, 1, 2))] }, [{ iface: 'Tailscale', metric: 0 }]), null, 'an overlay address is never the Home address');
});

test('/proc/net/route: the default routes by interface, lowest metric first, with their gateway', () => {
  const text = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'enp3s0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n' +
    'enp3s0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n' +
    'wg0\t00000000\t00000000\t0001\t0\t0\t50\t00000080\t0\t0\t0\n' +           // 0.0.0.0/1: not a default route
    'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n';
  assert.deepEqual(parseProcRoute(text, 'LE'), [{ iface: 'enp3s0', metric: 100, gateway: ip(192, 168, 1, 1) }, { iface: 'wlan0', metric: 600, gateway: ip(192, 168, 1, 1) }]);
  assert.deepEqual(parseProcRoute(''), []);
});

test('route print -4: the interface address, metric and gateway of each default route, in any language; persistent routes ignored', () => {
  const gw = ip(192, 168, 1, 1);
  const vpn = ip(10, 5, 0, 2);
  const row = (...cols) => cols.map((c) => String(c).padStart(17)).join('');
  const en = [
    '===========================================================================',
    'IPv4 Route Table',
    '===========================================================================',
    'Active Routes:',
    'Network Destination        Netmask          Gateway       Interface  Metric',
    row('0.0.0.0', '0.0.0.0', gw, HOME, 50),
    row('0.0.0.0', '0.0.0.0', 'On-link', vpn, 5),
    row('127.0.0.0', '255.0.0.0', 'On-link', '127.0.0.1', 331),
    row(ip(192, 168, 1, 0), '255.255.255.0', 'On-link', HOME, 306),
    '===========================================================================',
    'Persistent Routes:',
    '  Network Address          Netmask  Gateway Address  Metric',
    row('0.0.0.0', '0.0.0.0', gw, 1),
    '===========================================================================',
  ].join('\r\n');
  const r = parseRoutePrint(en);
  assert.deepEqual(r, [{ address: HOME, metric: 50, gateway: gw }, { address: vpn, metric: 5, gateway: null }, { address: gw, metric: 1, gateway: null }]);
  // the persistent route names the gateway, never one of this computer's addresses: it can't be picked
  assert.equal(pickPhoneAddress({ 'Wi-Fi': [v4(HOME)] }, r), HOME);
  // French: "On-link" is "Sur la liaison" (spaces in the gateway column)
  assert.deepEqual(parseRoutePrint(row('0.0.0.0', '0.0.0.0', 'Sur la liaison', HOME, 35) + '\r\n'), [{ address: HOME, metric: 35, gateway: null }]);
  assert.deepEqual(parseRoutePrint('nothing useful\n'), []);
});
