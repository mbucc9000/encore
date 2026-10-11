'use strict';
// Showcase (showcase.js, RELEASE-PLAN D4) and the bridge's helpers for the phones' Anonymous Mode: H1 (remote.type in
// the player snapshot), H2 (the member id in Jam events) and the playlist-cover flags (D2). Offline: no engine, no
// Spotify. Every name below is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Showcase, deviceType, deviceLabel, coverFlags, trimAdminStatus, trimSnapshot, trimSpotify, trimReply, routeShape, scrubUris } = require('../src/showcase');
const { Player } = require('../src/player');
const { Jam } = require('../src/jam');
const { tokenFor } = require('../src/image');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-showcase-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// console capture: the bridge's log lines (log.js writes through console.log / console.warn / console.error)
function capture() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, orig) };
}

// Identity planted all over an admin status: none of it may survive trimming.
const ID = {
  account: 'alexexample42', accountName: 'Alex Example', phone1: 'Sam Sample’s iPhone', phone2: 'Kitchen iPod',
  dev1: 'dev_0123456789abcdef', dev2: 'dev_fedcba9876543210', seen: '2026-10-07T12:34:56.000Z', created: '2026-10-01T08:00:00.000Z',
  pc: 'Alex’s Work Laptop', host: 'Jordan Host', hostId: 'jordanhost77',
};
const SONG = { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', name: 'A Made-Up Song', artists: ['The Placeholders'], album: 'Sample Album', duration_ms: 200000 };
function fullStatus() {
  return {
    gateway: { name: 'Encore Bridge', version: '1.1.0', min_app: '1.0.0', uptime_s: 99 },
    engine: { name: 'go-librespot', connected: true, active: true },
    player: {
      gen: 4, status: 'playing', track: { ...SONG, by: ID.hostId }, context_uri: `spotify:user:${ID.account}:collection`, position_ms: 1000,
      remote: { device: ID.pc, type: 'computer', is_playing: true, track: { ...SONG }, position_ms: 5000 },
      jam: { r: 'guest', hn: ID.host, cnt: 3 }, account: true,
    },
    stream: { tiers: { high: 256 }, default: 'high' },
    catalog: { playlists: 12, enumerating: [{ ctx: `spotify:user:${ID.account}:collection`, age_s: 3 }, { ctx: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', age_s: 1 }] },
    jam: { on: true, role: 'guest', members: 3, latch: { ctx: 'collection' }, dealer: { n: 2, uris: [{ uri: 'social-connect/v2/session_update', n: 2 }] } },
    devices: [
      { id: ID.dev1, name: ID.phone1, created: ID.created, last_seen: ID.seen },
      { id: ID.dev2, name: ID.phone2, created: ID.created, last_seen: null },
    ],
    spotify: { configured: true, connected: true, user: { id: ID.account, name: ID.accountName, product: 'premium' }, window: 2, calls: 40,
      n429: 1, last429_path: `/users/${ID.account}/playlists`, auth_broken: null },
    lyrics: { cached: 3, last_error: null }, admin: { mode: 'stored', allow: 'private' },
  };
}
const leaks = (json) => Object.values(ID).filter((v) => json.includes(v));

test('the switch: off by default, saved in showcase.json, kept over a restart; only true/false; never logs a name', () => {
  const dir = tmp();
  const cap = capture();
  let s;
  try {
    s = new Showcase({ dataDir: dir });
    assert.equal(s.isOn(), false);
    assert.deepEqual(s.info(), { showcase: false });
    assert.equal(fs.existsSync(path.join(dir, 'showcase.json')), false, 'nothing written until it changes');
    assert.deepEqual(s.set(true), { showcase: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'showcase.json'), 'utf8')).on, true);
    assert.equal(fs.existsSync(path.join(dir, 'showcase.json.tmp')), false);
    assert.equal(new Showcase({ dataDir: dir }).isOn(), true, 'a restart keeps it on');
    for (const bad of ['yes', 1, null, undefined, {}, 'true']) {
      assert.throws(() => s.set(bad), (e) => e.status === 400 && e.code === 'bad_request', String(bad));
    }
    assert.equal(s.isOn(), true);
    s.set(true);                                                    // no change: no write, no log line
    s.set(false);
    assert.equal(new Showcase({ dataDir: dir }).isOn(), false);
  } finally { cap.restore(); }
  assert.deepEqual(cap.lines.map((l) => l.replace(/^\S+ /, '')), ['I showcase on', 'I showcase off']);

  // an unreadable file: off, with a warning that names nothing
  fs.writeFileSync(path.join(dir, 'showcase.json'), '{"on": tr');
  const cap2 = capture();
  try { s = new Showcase({ dataDir: dir }); } finally { cap2.restore(); }
  assert.equal(s.isOn(), false);
  assert.equal(cap2.lines.length, 1);
  assert.match(cap2.lines[0], / W showcase: its setting file is unreadable/);
  fs.writeFileSync(path.join(dir, 'showcase.json'), '{"on":"true"}');
  assert.equal(new Showcase({ dataDir: dir }).isOn(), false, 'only a real true counts');
  assert.equal(new Showcase().isOn(), false, 'no data folder: memory only');
  assert.deepEqual(new Showcase().set(true), { showcase: true });
});

test('trimming the admin status: no account, phone, device, Jam-host or user-uri identity anywhere; the music and counters stay', () => {
  const s = fullStatus();
  const before = JSON.stringify(s);
  assert.deepEqual(leaks(before).sort(), Object.values(ID).sort(), 'the fixture carries every kind of identity');
  const t = trimAdminStatus(s);
  const json = JSON.stringify(t);
  assert.deepEqual(leaks(json), []);
  assert.ok(!/spotify:user:(?!\(hidden\))/.test(json), 'no spotify:user uri but the masked one');
  assert.equal(JSON.stringify(s), before, 'the input is not changed');

  assert.deepEqual(t.devices, [{ name: 'Phone 1' }, { name: 'Phone 2' }]);
  assert.deepEqual(t.spotify.user, { product: 'premium' });
  assert.equal(t.spotify.connected, true);
  assert.equal(t.spotify.last429_path, '/users/<id>/playlists');
  assert.equal(t.spotify.calls, 40);
  assert.deepEqual(t.player.remote, { device: 'your computer', type: 'computer', is_playing: true, track: { ...SONG }, position_ms: 5000 });
  assert.deepEqual(t.player.jam, { r: 'guest', cnt: 3 });
  assert.deepEqual(t.player.track, { ...SONG }, 'the song stays, "added by" goes');
  assert.equal(t.player.context_uri, 'spotify:user:(hidden):collection');
  assert.equal(t.catalog.enumerating[0].ctx, 'spotify:user:(hidden):collection');
  assert.equal(t.catalog.enumerating[1].ctx, 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 'a playlist uri names no one');
  assert.equal(t.catalog.playlists, 12);
  assert.deepEqual(t.jam, s.jam);
  assert.deepEqual(t.gateway, s.gateway);

  // not connected / no account yet; no devices; no remote
  const t2 = trimAdminStatus({ spotify: { configured: true, connected: false, user: null }, devices: [], player: { status: 'stopped', remote: null } });
  assert.equal(t2.spotify.user, null);
  assert.deepEqual(t2.devices, []);
  assert.equal(t2.player.remote, null);
  assert.equal(trimAdminStatus(null), null);
});

test('the switch trims only while on; command replies and webapi.info() too', () => {
  const sc = new Showcase();
  const s = fullStatus();
  assert.equal(sc.trimStatus(s), s, 'off: the status as it is');
  assert.equal(sc.trimSpotify(s.spotify), s.spotify);
  const reply = { gen: 5, stream: '/v1/stream?gen=5', state: s.player };
  assert.equal(sc.trimReply(reply), reply);
  sc.set(true);
  assert.deepEqual(leaks(JSON.stringify(sc.trimStatus(s))), []);
  assert.deepEqual(leaks(JSON.stringify(sc.trimSpotify(s.spotify))), []);
  const r = sc.trimReply(reply);
  assert.equal(r.gen, 5);
  assert.equal(r.stream, '/v1/stream?gen=5');
  assert.deepEqual(leaks(JSON.stringify(r)), []);
  assert.equal(r.state.remote.device, 'your computer');
  assert.deepEqual(trimReply({ ok: true }), { ok: true }, 'a reply without a state');
  assert.deepEqual(trimSpotify({ configured: false, connected: false, user: null }), { configured: false, connected: false, user: null });
});

test('H1: device kinds from the Web API type; the words the admin page uses for them', () => {
  const cases = { Computer: 'computer', Smartphone: 'smartphone', Tablet: 'tablet', Speaker: 'speaker', TV: 'tv', AVR: 'avr', STB: 'stb',
    AudioDongle: 'audiodongle', GameConsole: 'gameconsole', CastVideo: 'castvideo', CastAudio: 'castaudio', Automobile: 'automobile',
    computer: 'computer', 'game_console': 'gameconsole' };
  for (const [k, v] of Object.entries(cases)) assert.equal(deviceType(k), v, k);
  for (const k of ['Unknown', '', 'Toaster', '<b>Computer</b>x', null, undefined, 42, {}]) assert.equal(deviceType(k), undefined, String(k));
  assert.equal(deviceLabel('Computer'), 'your computer');
  assert.equal(deviceLabel('Smartphone'), 'your phone');
  assert.equal(deviceLabel('CastAudio'), 'a speaker');
  assert.equal(deviceLabel('STB'), 'your TV');
  assert.equal(deviceLabel('Automobile'), 'your car');
  assert.equal(deviceLabel('Unknown'), 'another device');
  assert.equal(deviceLabel(undefined), 'another device');
});

test('H1: the player snapshot carries remote.type beside remote.device (the phone API is never trimmed)', () => {
  const engine = new EventEmitter();
  engine.connected = true;
  engine.refresh = async () => null;
  const clock = new EventEmitter();
  const pushes = [];
  const player = new Player({ engine, clock, bus: { push: (type, data) => pushes.push({ type, data }) }, webapi: { ready: true }, dataDir: tmp() });
  const cover = 'https://i.scdn.co/image/ab67616d0000b273' + 'c'.repeat(24);
  player.remote = { device: { id: 'remote-1', name: ID.pc, type: 'Computer' }, is_playing: true, at: Date.now(), position_ms: 1000,
    track: { uri: SONG.uri, name: SONG.name, artists: SONG.artists, album: SONG.album, cover, duration_ms: SONG.duration_ms } };
  let snap = player.snapshot();
  assert.equal(snap.remote.device, ID.pc, 'the phone gets the name: Anonymous Mode masks it in the app (D3)');
  assert.equal(snap.remote.type, 'computer');
  assert.equal(snap.remote.track.img, tokenFor(cover));
  assert.equal(trimSnapshot(snap).remote.device, 'your computer');
  assert.equal(trimSnapshot(snap).remote.type, 'computer');

  player.remote.device.type = 'Unknown';
  snap = JSON.parse(JSON.stringify(player.snapshot()));
  assert.equal('type' in snap.remote, false, 'an unknown kind is left out');
  assert.equal(trimSnapshot(snap).remote.device, 'another device');
  delete player.remote.device.type;
  assert.equal(JSON.parse(JSON.stringify(player.snapshot())).remote.type, undefined);
  player.remote = null;
  assert.equal(player.snapshot().remote, null);
});

test('H2: a Jam event names the member by id too, the same id as in the JAM object (fake Jam: guest join, host joins)', () => {
  const pushes = [];
  const jam = new Jam({ cfg: { dataDir: tmp(), jam: {} }, engine: null, player: { publish() {} }, bus: { push: (type, data) => pushes.push({ type, data }) },
    webapi: null, encoders: { listening: () => 0 } });
  clearInterval(jam.ticker);
  const evs = () => pushes.filter((x) => x.type === 'jam' && x.data.ev).map((x) => x.data);
  try {
    jam.setFake({ role: 'guest', members: 4 });
    let j = evs().slice(-1)[0];
    assert.equal(j.ev.k, 'join');
    assert.equal(j.ev.id, j.h, 'the host it joined, by the id the member rows use');
    assert.equal(j.ev.n, j.hn);
    assert.ok(j.m.some((m) => m.id === j.ev.id && m.h === 1));

    jam.setFake({ role: 'host', members: 2 });
    assert.deepEqual(evs().slice(-1)[0].ev, { k: 'start' });
    jam.fake.lastIn = 0;
    jam.fakeTick();
    j = evs().slice(-1)[0];
    assert.equal(j.ev.k, 'in');
    const added = j.m[j.m.length - 1];
    assert.deepEqual(j.ev, { k: 'in', n: added.n, id: added.id });

    jam.fakeJoin(true);                                           // the host's Join (replace): a guest of the fake host
    j = evs().slice(-1)[0];
    assert.deepEqual(j.ev, { k: 'join', n: j.hn, id: j.h });
    jam.setFake({ role: null });
    assert.deepEqual(evs().slice(-1)[0].ev, { k: 'end' }, 'our own end names no one');
  } finally { jam.close(); }
});

test('cover flags: a cover the user uploaded (ugc), a Blend (bl); album art, mosaics and Spotify-made covers are neither', () => {
  const up = 'ab67706c0000da84' + '0123456789abcdef01234567';
  assert.deepEqual(coverFlags('https://i.scdn.co/image/' + up), { ugc: 1 });
  assert.deepEqual(coverFlags(up), { ugc: 1 }, "the phone's 40-hex image token");
  assert.deepEqual(coverFlags(up.toUpperCase()), { ugc: 1 });
  assert.deepEqual(coverFlags('https://image-cdn-ak.spotifycdn.com/image/' + up), { ugc: 1 });
  assert.deepEqual(coverFlags('https://image-cdn-fa.spotifycdn.com/image/' + up), { ugc: 1 });
  const blend = 'https://blend-playlist-covers.spotifycdn.com/v2/blend_DEFAULT-example.jpg';
  assert.deepEqual(coverFlags(blend), { bl: 1 });
  assert.deepEqual(coverFlags(tokenFor(blend)), { bl: 1 }, "the phone's u-token of it");
  for (const u of ['https://i.scdn.co/image/ab67616d0000b273' + 'a'.repeat(24),            // album art
    'https://mosaic.scdn.co/640/' + 'ab67616d0000b273' + 'a'.repeat(24) + 'ab67616d0000b273' + 'b'.repeat(24),
    'https://pickasso.spotifycdn.com/image/ab67c0de0000deef/dt/v1/img/daily/1/example/en',
    'https://i.scdn.co/image/ab67706f00000002' + 'a'.repeat(24),                              // Spotify's editorial
    'http://i.scdn.co/image/' + up,                                                           // not https
    'https://i.scdn.co.example.com/image/' + up,
    'https://i.scdn.co/image/' + up + '/x', '', null, undefined, 42, 'u!!', 'not a url']) {
    assert.deepEqual(coverFlags(u), {}, String(u));
  }
});

test('route shapes and uri scrubbing', () => {
  assert.equal(routeShape('/me/player'), '/me/player');
  assert.equal(routeShape('/me/player/recently-played?limit=1'), '/me/player/recently-played');
  assert.equal(routeShape('/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks'), '/playlists/<id>/tracks');
  assert.equal(routeShape('/users/plainwords/playlists'), '/users/<id>/playlists', 'a user id can be plain words');
  assert.equal(routeShape(''), '');
  assert.equal(routeShape(null), null);
  assert.deepEqual(scrubUris({ a: ['spotify:user:x.y-z', 'see spotify:user:abc:playlist:1 and spotify:user:d'], n: 1, b: true, z: null }),
    { a: ['spotify:user:(hidden)', 'see spotify:user:(hidden):playlist:1 and spotify:user:(hidden)'], n: 1, b: true, z: null });
  const m = new Map([[1, 'spotify:user:kept']]);
  assert.equal(scrubUris(m), m, 'not plain data: as it is');
});
