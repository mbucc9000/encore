'use strict';
// Offline test of personal.js with a fake Web API and a fake catalog (no Spotify, no live gateway).
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Personal } = require('../src/personal');

const img = (h) => [{ url: 'https://i.scdn.co/image/ab67616d0000b273' + h.padEnd(24, '0'), width: 640 }, { url: 'https://i.scdn.co/image/ab67616d00001e02' + h.padEnd(24, '0'), width: 300 }];
const id = (c) => c.repeat(22).slice(0, 22);
const album = (c, date, type = 'album') => ({ uri: 'spotify:album:' + id(c), name: 'Album ' + c, images: img(c), artists: [{ id: id('A'), name: 'Artist A', uri: 'spotify:artist:' + id('A') }], release_date: date, album_type: type });
const track = (c, al) => ({ uri: 'spotify:track:' + id(c), name: 'Song ' + c, duration_ms: 200000, explicit: c === 'e', artists: [{ name: 'Artist A', uri: 'spotify:artist:' + id('A'), id: id('A') }], album: al });
const today = new Date().toISOString().slice(0, 10);

const calls = [];
const ROUTES = {
  '/me/player/recently-played?limit=50': () => ({ items: [
    { track: track('a', album('x', '2020-01-01')), played_at: '2026-10-06T20:00:00Z', context: { type: 'playlist', uri: 'spotify:playlist:' + id('p') } },
    { track: track('b', album('x', '2020-01-01')), played_at: '2026-10-06T19:00:00Z', context: { type: 'playlist', uri: 'spotify:playlist:' + id('p') } },
    { track: track('c', album('y', '2021-01-01')), played_at: '2026-10-06T18:00:00Z', context: { type: 'album', uri: 'spotify:album:' + id('y') } },
    { track: track('d', album('z', '2022-01-01')), played_at: '2026-10-06T17:00:00Z', context: null },
    { track: track('e', album('z', '2022-01-01')), played_at: '2026-10-06T16:00:00Z', context: { type: 'collection', uri: 'spotify:user:alex:collection' } },
    { track: track('f', album('w', '2022-01-01')), played_at: '2026-10-06T15:00:00Z', context: { type: 'artist', uri: 'spotify:artist:' + id('B') } },
    { track: track('g', album('w', '2022-01-01')), played_at: '2026-10-06T14:00:00Z', context: { type: 'playlist', uri: 'spotify:playlist:' + id('q') } },
    { track: { uri: 'spotify:episode:' + id('h'), name: 'pod' }, played_at: '2026-10-06T13:00:00Z' },
  ] }),
  '/me/top/artists?limit=10&time_range=short_term': () => ({ items: [{ uri: 'spotify:artist:' + id('A'), name: 'Artist A', images: img('A') }] }),
  '/me/top/tracks?limit=10&time_range=short_term': () => ({ items: [track('a', album('x', '2020-01-01'))] }),
  '/me': () => ({ id: 'alex', display_name: 'Alex', images: [{ url: 'https://i.scdn.co/image/ab6775700000ee85' + 'c'.repeat(24), width: 300 }, { url: 'https://i.scdn.co/image/ab67757000003b82' + 'c'.repeat(24), width: 64 }] }),
  ['/artists/' + id('A') + '/albums?include_groups=single&limit=10']: () => { if (failReleases) throw Object.assign(new Error('500'), { status: 500 }); return { items: [album('n', today, 'single')] }; },
  ['/artists/' + id('A') + '/albums?include_groups=album&limit=5']: () => ({ items: [album('o', '2019-01-01'), album('r', today)] }),
  '/me/following?type=artist&limit=1': () => ({ artists: { total: 19, items: [] } }),
  ['/artists/' + id('B')]: () => ({ uri: 'spotify:artist:' + id('B'), name: 'Artist B', images: img('B') }),
  '/me/albums?limit=50&offset=0': () => ({ total: 51, next: 'x', items: Array.from({ length: 50 }, (_, i) => ({ album: album(String.fromCharCode(97 + (i % 26)), '2020-01-01') })) }),
  '/me/albums?limit=50&offset=50': () => ({ total: 51, next: null, items: [{ album: album('Z', '2020-01-01') }] }),
  '/me/following?type=artist&limit=50': () => ({ artists: { total: 2, next: null, cursors: {}, items: [{ uri: 'spotify:artist:' + id('Z'), name: 'zed', images: [] }, { uri: 'spotify:artist:' + id('Y'), name: 'Alpha', images: img('Y') }] } }),
};
let failNext = false;
let failReleases = false;
// 0.9: Spotify's generic library routes (uris in the query, comma-separated, 1-40), against a fake saved set
const saved = new Set();
const libCalls = [];
let libFail = null;
let libFailOnce = null;               // the next library call only
let libOdd = false;
let albumsGate = null;                // a promise the saved albums route waits for (a slow refetch)
let libGate = null;                   // ... a contains answer waits for (Spotify answered, the reply is slow)
let libWriteGate = null;              // ... a PUT/DELETE answer waits for
function libraryRoute(method, p, body) {
  const u = new URL('https://api.spotify.com/v1' + p);
  const uris = (u.searchParams.get('uris') || '').split(',').filter(Boolean);
  libCalls.push({ method, path: u.pathname.slice(3), raw: p, uris, body });
  if (libFail) throw libFail;
  if (libFailOnce) { const f = libFailOnce; libFailOnce = null; throw f; }
  if (uris.length < 1 || uris.length > 40) throw Object.assign(new Error('Spotify GET /me/library: 400'), { status: 502, code: 'spotify_error', spotifyStatus: 400 });
  if (method === 'GET' && u.pathname === '/v1/me/library/contains') return libOdd ? {} : uris.map((x) => saved.has(x));
  if (method === 'PUT' && u.pathname === '/v1/me/library') { uris.forEach((x) => saved.add(x)); return null; }
  if (method === 'DELETE' && u.pathname === '/v1/me/library') { uris.forEach((x) => saved.delete(x)); return null; }
  throw Object.assign(new Error('unrouted ' + method + ' ' + p), { status: 404 });
}
const webapi = {
  ready: true,
  user: { id: 'alex' },
  async api(method, p, body) {
    if (p.startsWith('/me/library')) {
      const r = libraryRoute(method, p, body);                     // (applied / answered now, the reply after the gate)
      const g = method === 'GET' ? libGate : libWriteGate;
      if (g) await g;
      return r;
    }
    calls.push(p);
    if (albumsGate && p.startsWith('/me/albums?')) await albumsGate;
    if (failNext) throw Object.assign(new Error('boom'), { status: 502 });
    const f = ROUTES[p];
    if (!f) throw Object.assign(new Error('unrouted ' + p), { status: 404 });
    return f();
  },
};
const pl = (c, extra) => ({ u: 'spotify:playlist:' + id(c), n: 'PL ' + c, len: 3, ...extra });
const catalog = {
  build: { obj: { items: [pl('p', { own: 1 }), pl('m', { mf: 1, o: 'Spotify' }), pl('r', { own: 1 })] }, byId: new Map([[id('p'), { pl: pl('p', { own: 1 }) }]]) },
  webpl: { map: { [id('p')]: { pub: 1 }, [id('r')]: { pub: 0 } } },
  headers: new Map(), mergeMaybe() { this.merged = (this.merged || 0) + 1; },
  username: () => 'alex', likedCount: () => 1234, simCheck() {},
  store: { peek: () => null },
  async webHeader(i) { calls.push('header ' + i); return { u: 'spotify:playlist:' + i, n: 'Outside ' + i, o: 'Someone' }; },
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p07-'));
  const P = new Personal({ cfg: { cacheDir: dir }, webapi, catalog });
  const parse = (m) => JSON.parse(m.body.toString());

  const home = parse(await P.home(false));
  console.log(JSON.stringify(home, null, 1).slice(0, 2500));
  assert.deepStrictEqual(home.jump.map((t) => t.k), ['playlist', 'album', 'album', 'liked', 'artist', 'playlist']);
  assert.strictEqual(home.jump[0].o.n, 'PL p');
  assert.strictEqual(home.jump[2].o.u, 'spotify:album:' + id('z'));    // no context: the song's album
  assert.strictEqual(home.jump[3].len, 1234);
  assert.strictEqual(home.jump[4].o.n, 'Artist B');
  assert.strictEqual(home.jump[5].o.n, 'Outside ' + id('q'));
  assert.strictEqual(home.made.length, 1);
  assert.deepStrictEqual(home.releases.map((x) => x.t), ['single', 'album']);     // singles and albums both reached, old one dropped
  assert.strictEqual(home.me.n, 'Alex');
  assert.ok(home.me.i);
  assert.strictEqual(home.top.length, 1);
  assert.ok(!home.stale);

  const n = calls.length;
  const home2 = await P.home(false);
  console.log('second home: extra calls', calls.slice(n));
  assert.ok(calls.slice(n).every((c) => c.startsWith('header')), 'second home: only the (fake, uncached) header lookups');
  assert.strictEqual(home2.etag, (await P.home(false)).etag);

  const rec = parse(await P.recentList(false));
  assert.strictEqual(rec.items.length, 7);
  assert.ok(rec.items[0].pa > 0 && rec.items[0].u.startsWith('spotify:track:'));

  const al = parse(await P.albumList(false));
  assert.strictEqual(al.total, 51);
  assert.strictEqual(al.items.length, 51);

  const ar = parse(await P.artistList(false));
  assert.deepStrictEqual(ar.items.map((x) => x.n), ['Alpha', 'zed']);

  const prof = parse(await P.profile(false));
  console.log(JSON.stringify(prof).slice(0, 600));
  assert.strictEqual(prof.me.fing, 2);
  assert.strictEqual(prof.me.u, 'spotify:user:alex');
  assert.deepStrictEqual(prof.playlists.map((x) => x.n), ['PL p']);      // public only: PL r is private; PL m isn't own
  assert.ok(catalog.merged >= 1, 'profile asks for a merge');
  assert.ok(!calls.includes('/me/following?type=artist&limit=1'), 'the fresh artist list gives Following');
  // without a fresh list: the small following part
  P.parts.get('artists').at = 0;
  const prof2 = parse(await P.profile(false));
  assert.strictEqual(prof2.me.fing, 19);
  // releases: a failed call keeps no partial copy; home still answers
  const R = new Personal({ cfg: { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'p07r-')) }, webapi, catalog });
  failReleases = true;
  const hr = parse(await R.home(false));
  assert.deepStrictEqual(hr.releases || [], []);
  assert.ok(!R.parts.get('releases'), 'no partial releases stored');
  failReleases = false;
  const hr2 = parse(await R.home(false));
  assert.strictEqual(hr2.releases.length, 2);
  // a part made for another account counts as none
  const nBefore = calls.length;
  webapi.user = { id: 'someone-else' };
  await R.albumList(false);
  assert.ok(calls.length > nBefore && calls[nBefore].startsWith('/me/albums'), 'refetched for the other account');
  webapi.user = { id: 'alex' };

  // a failing refetch answers with the old copy, stale
  P.parts.get('recent').at = 0;
  failNext = true;
  const rs = parse(await P.recentList(true));
  assert.strictEqual(rs.stale, 1);
  assert.strictEqual(rs.items.length, 7);
  // no copy at all: the error
  const P2 = new Personal({ cfg: { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'p07b-')) }, webapi, catalog });
  await assert.rejects(P2.albumList(false));
  failNext = false;

  // the disk copy survives a restart
  await new Promise((r) => setTimeout(r, 300));
  const P3 = new Personal({ cfg: { cacheDir: dir }, webapi, catalog });
  const before = calls.length;
  const al3 = parse(await P3.albumList(false));
  assert.strictEqual(al3.items.length, 51);
  assert.strictEqual(calls.length, before, 'albums from disk');
  // ETag stable for the same content
  assert.strictEqual((await P3.albumList(false)).etag, (await P3.albumList(false)).etag);
  // ---- the engine's own play log (Jump back in for plays Spotify's history leaves without a context)
  const { EventEmitter } = require('events');
  const engine = new EventEmitter();
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'p07d-'));
  // go-librespot's metadata is an ApiTrack with NO context_uri: the context is the player's for that song (player.js
  // songContext, which runs first); this fake player stands in for it
  const fakePlayer = { st: { context_uri: null } };
  const P4 = new Personal({ cfg: { cacheDir: dir4 }, webapi, catalog, engine, player: fakePlayer, timing: { playedSaveMs: 50 } });
  const meta = ({ context_uri, ...o }) => {
    fakePlayer.st.context_uri = context_uri || null;
    engine.emit('event', 'metadata', { uri: 'spotify:track:' + id('t'), name: 'T', artist_names: ['Artist M'], artist_uris: ['spotify:artist:' + id('M')], ...o });
  };
  meta({ context_uri: 'spotify:list:jam-list:abc', album_uri: 'spotify:album:' + id('j') });   // a Jam: ignored
  assert.strictEqual(P4.played.length, 0);
  meta({ context_uri: 'spotify:station:playlist:' + id('M'), album_uri: 'spotify:album:' + id('j') });   // a station: too
  assert.strictEqual(P4.played.length, 0);
  meta({ context_uri: 'spotify:track:' + id('t'), album_uri: 'spotify:album:' + id('s'), album_name: 'Solo Album', album_cover_url: 'https://i.scdn.co/image/' + 'b'.repeat(40) });
  await new Promise((r) => setTimeout(r, 5));
  meta({ context_uri: 'spotify:playlist:' + id('M'), album_uri: 'spotify:album:' + id('k') });
  assert.deepStrictEqual(P4.played.map((x) => x.k), ['playlist', 'album']);
  assert.strictEqual(P4.played[1].al.n, 'Solo Album');
  assert.strictEqual(P4.played[1].al.i, 'b'.repeat(40));
  // Encore's log began at 16:30 Z: the no-context play at 17:00 (album z) is one of its own plays, so no album z tile
  P4.playedSince = Date.parse('2026-10-06T16:30:00Z');
  const h4 = parse(await P4.home(false));
  const ks = h4.jump.map((t) => (t.o && t.o.u) || t.k);
  console.log('jump with engine log:', ks);
  assert.strictEqual(ks[0], 'spotify:playlist:' + id('M'));
  assert.strictEqual(ks[1], 'spotify:album:' + id('s'));
  assert.ok(!ks.includes('spotify:album:' + id('z')), 'album z suppressed (after the log began)');
  assert.ok(ks.includes('liked') && ks.includes('spotify:album:' + id('y')) && ks.includes('spotify:playlist:' + id('p')));
  // the log is written and read back
  await new Promise((r) => setTimeout(r, 400));
  const P5 = new Personal({ cfg: { cacheDir: dir4 }, webapi, catalog, engine: new EventEmitter() });
  assert.deepStrictEqual(P5.played.map((x) => x.k), ['playlist', 'album']);
  assert.ok(P5.playedSince > 0);
  // the same context again moves to the front without a duplicate
  meta({ context_uri: 'spotify:track:' + id('t'), album_uri: 'spotify:album:' + id('s'), album_name: 'Solo Album' });
  assert.deepStrictEqual(P4.played.map((x) => x.u), ['spotify:album:' + id('s'), 'spotify:playlist:' + id('M')]);
  // Liked Songs; a song with no context at all (null): its album
  meta({ context_uri: 'spotify:user:testuser:collection', album_uri: 'spotify:album:' + id('k') });
  meta({ album_uri: 'spotify:album:' + id('n'), album_name: 'Lone Album' });
  assert.deepStrictEqual(P4.played.slice(0, 2).map((x) => [x.k, x.u]), [['album', 'spotify:album:' + id('n')], ['liked', 'spotify:user:testuser:collection']]);
  // without a player (and no context_uri in the metadata): the album, as before
  const P7 = new Personal({ cfg: { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'p07e-')) }, webapi, catalog, engine: new EventEmitter() });
  P7.noteEngine('metadata', { uri: 'spotify:track:' + id('t'), album_uri: 'spotify:album:' + id('s'), album_name: 'Solo Album' });
  assert.deepStrictEqual(P7.played.map((x) => [x.k, x.u]), [['album', 'spotify:album:' + id('s')]]);

  // ---- saving albums (0.9, DESIGN-0.9.md §1)
  const alU = (c) => 'spotify:album:' + id(c);
  const bus = { events: [], push(type, data) { this.events.push({ type, data }); } };
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'p07s-'));
  const PA = new Personal({ cfg: { cacheDir: dirA }, webapi, catalog, bus, timing: { waitMs: 50 } });
  saved.add(alU('x'));
  // anything but 1-40 album uris: 400, nothing reaches Spotify
  const forty1 = Array.from({ length: 41 }, (_, i) => alU(String.fromCharCode(65 + (i % 26)))).join(',');
  for (const bad of ['', undefined, ',', 'spotify:track:' + id('a'), 'spotify:album:short', alU('x') + ',spotify:artist:' + id('A'), forty1]) {
    await assert.rejects(PA.albumsContain(bad), (e) => e.status === 400 && e.code === 'bad_request', String(bad).slice(0, 40));
  }
  assert.strictEqual(libCalls.length, 0);
  const c1 = parse(await PA.albumsContain([alU('x'), alU('y'), alU('x')].join(',')));
  assert.deepStrictEqual(c1, { items: { [alU('x')]: 1, [alU('y')]: 0 } });
  assert.strictEqual(libCalls.length, 1);
  assert.strictEqual(libCalls[0].method, 'GET');
  assert.strictEqual(libCalls[0].path, '/me/library/contains');
  assert.deepStrictEqual(libCalls[0].uris, [alU('x'), alU('y')], 'each uri asked once');
  assert.ok(/\?uris=[^&,]+,[^&,]+$/.test(libCalls[0].raw), 'comma-separated in the query');
  // 40 is fine
  const forty = Array.from({ length: 40 }, (_, i) => alU(String.fromCharCode(65 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26))));
  assert.strictEqual(Object.keys(parse(await PA.albumsContain(forty.join(','))).items).length, 40);
  assert.strictEqual(libCalls.length, 2);
  // states are kept 60 s
  const m2 = await PA.albumsContain(alU('y'));
  assert.strictEqual(libCalls.length, 2, 'cached');
  assert.deepStrictEqual(parse(m2).items, { [alU('y')]: 0 });
  assert.strictEqual(m2.etag, (await PA.albumsContain(alU('y'))).etag, 'same answer, same ETag');
  PA.albumStates.get(alU('y')).at -= 61000;
  await PA.albumsContain([alU('x'), alU('y')].join(','));
  assert.strictEqual(libCalls.length, 3);
  assert.deepStrictEqual(libCalls[2].uris, [alU('y')], 'only the old state asked again');
  // Spotify sending something else than one boolean per uri
  libOdd = true;
  await assert.rejects(PA.albumsContain(alU('o')), (e) => e.code === 'spotify_error' && e.status === 502);
  libOdd = false;
  assert.ok(!PA.albumStates.has(alU('o')));

  // a save: PUT /me/library, states set, the saved albums part dropped (memory and disk), the phones told
  const albFile = path.join(dirA, 'personal', 'p', 'albums.json');
  assert.strictEqual(parse(await PA.albumList(false)).items.length, 51);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(PA.parts.get('albums') && fs.existsSync(albFile), 'the albums part is in memory and on disk');
  const sv = await PA.saveAlbums({ uris: [alU('y')], saved: true });
  assert.deepStrictEqual(sv, { items: { [alU('y')]: 1 } });
  assert.ok(!sv.etag && !Buffer.isBuffer(sv.body), 'a plain object for send(), not a memo');
  let last = libCalls[libCalls.length - 1];
  assert.deepStrictEqual([last.method, last.path, last.uris, last.body], ['PUT', '/me/library', [alU('y')], undefined]);
  assert.ok(saved.has(alU('y')));
  assert.ok(!PA.parts.get('albums'), 'dropped from memory');
  assert.ok(!fs.existsSync(albFile), 'dropped from disk');
  assert.deepStrictEqual(bus.events, [{ type: 'albums', data: {} }]);
  const nl = libCalls.length;
  assert.deepStrictEqual(parse(await PA.albumsContain(alU('y'))).items, { [alU('y')]: 1 }, 'the saved state, without asking');
  assert.strictEqual(libCalls.length, nl);
  const nc = calls.length;
  await PA.albumList(false);
  assert.ok(calls.slice(nc).some((c) => c.startsWith('/me/albums?')), 'the next /v1/me/albums refetches');
  // remove two (one listed twice): DELETE /me/library
  const rmv = await PA.saveAlbums({ uris: [alU('y'), alU('x'), alU('y')], saved: false });
  assert.deepStrictEqual(rmv, { items: { [alU('y')]: 0, [alU('x')]: 0 } });
  last = libCalls[libCalls.length - 1];
  assert.deepStrictEqual([last.method, last.path, last.uris], ['DELETE', '/me/library', [alU('y'), alU('x')]]);
  assert.ok(!saved.has(alU('x')) && !saved.has(alU('y')));
  assert.strictEqual(bus.events.length, 2);
  assert.deepStrictEqual(parse(await PA.albumsContain(alU('x'))).items, { [alU('x')]: 0 });
  // bad bodies: 400, nothing reaches Spotify
  const nb = libCalls.length;
  for (const b of [null, {}, { uris: [alU('x')] }, { uris: [alU('x')], saved: 'yes' }, { uris: [alU('x')], saved: 1 }, { uris: [], saved: true },
    { uris: alU('x'), saved: true }, { uris: ['spotify:track:' + id('a')], saved: true }, { uris: [alU('x'), 7], saved: true },
    { uris: Array.from({ length: 41 }, () => alU('x')), saved: true }]) {
    await assert.rejects(PA.saveAlbums(b), (e) => e.status === 400 && e.code === 'bad_request', JSON.stringify(b));
  }
  assert.strictEqual(libCalls.length, nb);
  // Spotify's errors are passed on (rate_limited / spotify_not_connected / spotify_error); nothing changes
  await PA.albumList(false);
  assert.ok(PA.parts.get('albums'));
  for (const err of [Object.assign(new Error('Spotify is limiting requests. Try again in 5 s.'), { status: 503, code: 'rate_limited', retry_after: 5 }),
    Object.assign(new Error('Connect your Spotify account on the gateway admin page first'), { status: 503, code: 'spotify_not_connected' }),
    Object.assign(new Error('Spotify PUT /me/library: boom'), { status: 502, code: 'spotify_error' })]) {
    libFail = err;
    await assert.rejects(PA.saveAlbums({ uris: [alU('z')], saved: true }), (e) => e.code === err.code && e.status === err.status);
    await assert.rejects(PA.albumsContain(alU('z')), (e) => e.code === err.code);
  }
  libFail = null;
  assert.ok(PA.parts.get('albums'), 'kept after failed saves');
  assert.strictEqual(bus.events.length, 2, 'no event for a failed save');
  assert.ok(!PA.albumStates.has(alU('z')) && !saved.has(alU('z')));
  // a refetch running across a save doesn't store the older list
  let release;
  albumsGate = new Promise((r) => { release = r; });
  PA.parts.get('albums').at = 0;                                     // old: the next request refetches
  const slow = parse(await PA.albumList(false));                    // answers the old copy after waitMs, the refetch goes on
  assert.strictEqual(slow.items.length, 51);
  assert.ok(PA.flights.has('albums'), 'refetch still running');
  await PA.saveAlbums({ uris: [alU('q')], saved: true });
  assert.ok(!PA.flights.has('albums'), 'the running refetch is forgotten');
  release();
  albumsGate = null;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!PA.parts.get('albums'), 'the older answer was not stored');
  assert.ok(!fs.existsSync(albFile));
  const nr = calls.length;
  await PA.albumList(false);
  assert.ok(calls.slice(nr).some((c) => c.startsWith('/me/albums?')), 'fetched again');
  assert.ok(PA.parts.get('albums'), 'and stored');
  // a contains Spotify answered before a save, whose reply comes after the save, doesn't overwrite the saved state
  let releaseGet;
  libGate = new Promise((r) => { releaseGet = r; });
  const slowContains = PA.albumsContain(alU('g'));                  // Spotify says "not saved", the reply is slow
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!saved.has(alU('g')) && libCalls[libCalls.length - 1].method === 'GET');
  await PA.saveAlbums({ uris: [alU('g')], saved: true });
  releaseGet();
  libGate = null;
  assert.deepStrictEqual(parse(await slowContains).items, { [alU('g')]: 1 }, 'the save is newer than that answer');
  assert.strictEqual(PA.albumStates.get(alU('g')).s, 1, 'the cached state is the saved one');
  const ng = libCalls.length;
  assert.deepStrictEqual(parse(await PA.albumsContain(alU('g'))).items, { [alU('g')]: 1 }, 'and answered from the cache');
  assert.strictEqual(libCalls.length, ng);
  // a contains asked after a save (another device may have changed it since) is taken as it comes
  PA.albumStates.get(alU('g')).at -= 61000;
  saved.delete(alU('g'));
  assert.deepStrictEqual(parse(await PA.albumsContain(alU('g'))).items, { [alU('g')]: 0 });
  // saves run one after another, in the order they came: a quick save + unsave ends unsaved, at Spotify and here
  let releaseWrite;
  libWriteGate = new Promise((r) => { releaseWrite = r; });
  const nw = libCalls.length;
  const save1 = PA.saveAlbums({ uris: [alU('h')], saved: true });
  const save2 = PA.saveAlbums({ uris: [alU('h')], saved: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(libCalls.slice(nw).map((x) => x.method), ['PUT'], 'the unsave waits for the save');
  releaseWrite();
  libWriteGate = null;
  assert.deepStrictEqual(await save1, { items: { [alU('h')]: 1 } });
  assert.deepStrictEqual(await save2, { items: { [alU('h')]: 0 } });
  assert.deepStrictEqual(libCalls.slice(nw).map((x) => x.method), ['PUT', 'DELETE']);
  assert.ok(!saved.has(alU('h')));
  assert.strictEqual(PA.albumStates.get(alU('h')).s, 0);
  // a failed save doesn't stop the next one
  libFailOnce = Object.assign(new Error('Spotify PUT /me/library: boom'), { status: 502, code: 'spotify_error' });
  const bad = PA.saveAlbums({ uris: [alU('i')], saved: true });
  const good = PA.saveAlbums({ uris: [alU('j')], saved: true });
  await assert.rejects(bad, (e) => e.code === 'spotify_error');
  assert.deepStrictEqual(await good, { items: { [alU('j')]: 1 } });
  assert.ok(saved.has(alU('j')) && !saved.has(alU('i')));
  // without a bus (an older wiring) a save still works
  const P6 = new Personal({ cfg: { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'p07n-')) }, webapi, catalog });
  assert.deepStrictEqual(await P6.saveAlbums({ uris: [alU('n')], saved: true }), { items: { [alU('n')]: 1 } });
  assert.strictEqual(P6.info().album_states, 1);
  console.log('ALL OK', calls.length, 'fake calls,', libCalls.length, 'library calls');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
