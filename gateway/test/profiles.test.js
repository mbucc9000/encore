'use strict';
// Offline test of social.js (0.10 profiles, DESIGN-PROFILES.md §5.1) with the real http.js and catalog.js: a fake engine
// (POST /token counted, the patch-2 model for the catalog), a fake fetch that routes spclient, pathfinder, the web
// player and its CDN by host, a fake Web API, a stub auth, and every console line captured.
//   node gateway/test/profiles.test.js   (VERBOSE=1 also prints the gateway's own log lines)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert');

// ---- every console line the gateway writes is kept (the test's own output goes straight to stdout)
const lines = [];
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    lines.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? (x.stack || x.message) : JSON.stringify(x))).join(' '));
    if (process.env.VERBOSE) orig(...a);
  };
}
const out = (s) => process.stdout.write(s + '\n');
let nOk = 0;
const ok = (m) => { nOk++; out('ok   ' + m); };

const { Social, DEFAULTS, searchChunk, collectOps, imageUrl, userIdOf, staleHash } = require('../src/social');
const { createServer } = require('../src/http');
const { makeCatalog, FakeWebApi, sleep, ME, id22 } = require('./support/helpers');

const hx = (s, n) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
const IMG = (k) => 'https://i.scdn.co/image/ab6775700000ee85' + hx(k, 24);
const TOK = (k) => 'ab6775700000ee85' + hx(k, 24);
const uTok = (url) => 'u' + Buffer.from(url).toString('base64url');
const art = (k) => 'spotify:artist:' + id22('art' + k);
const PLU = (k) => 'spotify:playlist:' + id22(k);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

const SP = 'https://sp.test';
const PF = 'https://pf.test';
const WEB = 'https://web.test';
const CDN = 'https://cdn.test/cdn/build/web-player/';
const PROFILES = { spclient: SP, pathfinder: PF, web: WEB, cdn: CDN };
const SECRET = 'tok-SECRET-';
const NEW1 = hx('new hash one', 40) + hx('x1', 24);
const NEW2 = hx('new hash two', 40) + hx('x2', 24);

// ------------------------------------------------------------------ fixtures (Spotify's shapes, FINDINGS 2026-10-06)
const plr = (k, o = {}) => ({ uri: PLU(k), name: o.name || 'List ' + k, image_url: o.img === undefined ? IMG('pl' + k) : o.img,
  followers_count: o.fol || 0, owner_name: o.on || 'Friendly Person Zed', owner_uri: o.ou || 'spotify:user:friend.one', ...(o.extra || {}) });
const MOSAIC = [1, 2, 3, 4].map((n) => hx('m' + n, 40));
const FRIEND_PLS = [
  plr('fzpl0', { name: 'Zed Secret Mix', fol: 7 }),
  plr('fzpl1', { img: 'spotify:image:' + hx('img1', 40) }),
  plr('fzpl2', { img: 'spotify:mosaic:' + MOSAIC.join(':'), on: 'Alex Test', ou: 'spotify:user:testuser' }),
  plr('fzpl3', { on: 'Spotify', ou: 'spotify:user:spotify', img: 'spotify:mosaic:' + hx('single', 40) }),
  plr('fzpl4', { img: 'spotify:mosaic:abc' }),
  { uri: 'spotify:playlist:short', name: 'Broken', owner_uri: 'spotify:user:friend.one' },
  ...Array.from({ length: 19 }, (_, i) => plr('fzmore' + i)),
];
const spPl = (i) => plr('sppl' + i, { on: 'Spotify', ou: 'spotify:user:spotify', fol: 1000 + i });
const USERS = {
  'friend.one': {
    profile: { uri: 'spotify:user:friend.one', name: 'Friendly Person Zed', image_url: IMG('fp'), followers_count: 12, following_count: 3,
      public_playlists: FRIEND_PLS.slice(0, 10), total_public_playlists_count: 25,
      recently_played_artists: [{ uri: art('a1'), name: 'Artist Uno', image_url: IMG('a1'), followers_count: 5 }, { uri: 'spotify:artist:bad', name: 'Nope' }],
      is_verified: false, report_abuse_disabled: false, has_spotify_name: true, has_spotify_image: true, color: 123, allow_follows: true, show_follows: true, account_id: 'acc' },
    pls: (off, lim) => ({ public_playlists: FRIEND_PLS.slice(off, off + lim), total_public_playlists_count: 25 }),
    followers: Array.from({ length: 250 }, (_, i) => ({ uri: 'spotify:user:fol' + i, name: 'Follower ' + i, image_url: IMG('fo' + i), followers_count: i % 3,
      is_followed: false, is_following: i === 0, color: 1, account_id: 'a' })),
    following: [{ uri: art('a2'), name: 'Artist Dos', image_url: IMG('a2'), followers_count: 99 },
      { uri: 'spotify:user:fz.pal', name: 'Pal Person', image_url: 'spotify:image:' + hx('pal', 40), followers_count: 0, is_following: true },
      { uri: 'spotify:user:x:collection', name: 'Bad' }, { uri: 'spotify:show:' + id22('s'), name: 'Show' }, { uri: 'spotify:user:noname.pal' }],
  },
  spotify: {
    profile: { uri: 'spotify:user:spotify', name: 'Spotify', image_url: IMG('sp'), followers_count: 5000000, following_count: 520,
      public_playlists: Array.from({ length: 10 }, (_, i) => spPl(i)), total_public_playlists_count: 120, is_verified: true, allow_follows: true, show_follows: true },
    pls: (off, lim) => ({ public_playlists: Array.from({ length: Math.max(0, Math.min(lim, 120 - off)) }, (_, i) => spPl(off + i)), total_public_playlists_count: 120 }),
    followers: [],
    following: Array.from({ length: 520 }, (_, i) => ({ uri: art('sp' + i), name: 'Art ' + i, image_url: IMG('spa' + i), followers_count: i })),
  },
  'big.list': {
    profile: { uri: 'spotify:user:big.list', name: 'Big', total_public_playlists_count: 5000 },
    pls: (off, lim) => ({ public_playlists: Array.from({ length: lim }, (_, i) => plr('big' + (off + i), { ou: 'spotify:user:big.list', on: 'Big' })), total_public_playlists_count: 5000 }),
  },
  'quiet.one': { profile: { uri: 'spotify:user:quiet.one' }, pls: () => ({ public_playlists: [], total_public_playlists_count: 0 }), followers: [], following: [] },
  testuser: {
    profile: { uri: 'spotify:user:testuser', name: 'Alex Test', image_url: IMG('me'), followers_count: 21, following_count: 45,
      public_playlists: [plr('mine1', { on: 'Alex Test', ou: 'spotify:user:testuser', extra: { is_following: true } })], total_public_playlists_count: 1,
      is_current_user: true, allow_follows: true, show_follows: true },
    pls: () => ({ public_playlists: [], total_public_playlists_count: 1 }), followers: [], following: [],
  },
  'mx+test@x': { profile: { uri: 'spotify:user:mx%2Btest%40x', name: 'Odd Name' } },
  'nopl.total': { profile: { uri: 'spotify:user:nopl.total', name: 'NP', total_public_playlists_count: 70 }, pls: (off) => ({ public_playlists: [plr('np' + off)] }) },
};
function userFor(id) {
  if (USERS[id]) return USERS[id];
  if (/^u\d+[a-z0-9]*$/.test(id)) return { profile: { uri: 'spotify:user:' + id, name: 'Gen ' + id, followers_count: 1 }, pls: () => ({ public_playlists: [], total_public_playlists_count: 0 }), followers: [], following: [] };
  return null;
}

function searchAnswer(v) {
  const q = v.searchTerm.toLowerCase();
  const off = v.offset;
  const total = q === 'many' ? 500 : q.startsWith('friendly zed') || q.startsWith('hashtest') ? 35 : 0;
  const items = [];
  for (let i = off; i < Math.min(total, off + 10); i++) {
    if (i % 10 === 3) items.push({ __typename: 'NotFoundResponseWrapper', data: { __typename: 'NotFound' } });
    else if (i % 10 === 7) items.push({ __typename: 'UserResponseWrapper', data: { __typename: 'User', uri: 'spotify:user:bad:collection', id: 'bad', username: 'bad', displayName: 'Bad' } });
    else {
      items.push({ __typename: 'UserResponseWrapper', data: { __typename: 'User', uri: 'spotify:user:fz' + i, id: 'fz' + i, username: 'fz' + i, displayName: 'Friendly Zed ' + i,
        socialHandle: null, avatar: i % 10 === 5 ? null : { extractedColors: { colorDark: { hex: '#000000', isFallback: false } },
          sources: [{ url: IMG('s64' + i), width: 64, height: 64 }, { url: IMG('s300' + i), width: 300, height: 300 }] } } });
    }
  }
  return { data: { searchV2: { query: v.searchTerm, users: { items, pagingInfo: { limit: 10, nextOffset: off + 10 }, totalCount: total } } }, extensions: { requestIds: { '/searchV2': {} } } };
}

// ------------------------------------------------------------------ the fake Spotify (by host)
function makeSpotify() {
  const S = { log: [], inflight: 0, maxInflight: 0, delay: 2, force: [], auth401: 0, serverHashes: { ...DEFAULTS.hashes }, bundleOps: { ...DEFAULTS.hashes },
    followed: new Set(), lie: false, refuse: null, staleStatus: 200 };
  const SPCT = { 'content-type': 'application/vnd.spotify.user-profile-view+json; charset=UTF-8' };
  const json = (status, obj, headers = {}) => new Response(obj === undefined ? null : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  const bundle = () => '(()=>{"use strict";var a=new X.Q("isFollowingUsers","query","' + S.bundleOps.isFollowingUsers + '",null),'
    + 'b=new X.Q("followUsers","mutation","' + S.bundleOps.followUsers + '",null),c=new X.Q("unfollowUsers","mutation","' + S.bundleOps.unfollowUsers + '",null);'
    + 'u.u=e=>""+(({11:"xpui-pip-mini-player",4406:"xpui-routes-search",77:"xpui-routes-profile"})[e]||e)+"."+({11:"aaaa1111",4406:"5e6f7a8b",77:"bbbb2222",9:"cccc3333"})[e]+".js",u.miniCssF=e=>{}})();';
  const chunk = () => '(self.webpackChunk=self.webpackChunk||[]).push([[4406],{1:(e,t,n)=>{n.d(t,{A:()=>r});const r=new X.Q("searchUsers","query","'
    + S.bundleOps.searchUsers + '",null),s=new X.Q("searchDesktop","query","' + hx('desk', 40) + hx('d', 24) + '",null)}}]);';
  function webRoute(u) {
    if (u.host === 'web.test' && u.pathname === '/') return new Response(`<!doctype html><html><head><script src="${CDN}web-player.1a2b3c4d.js"></script></head></html>`, { status: 200 });
    if (u.pathname === '/cdn/build/web-player/web-player.1a2b3c4d.js') return new Response(bundle(), { status: 200 });
    if (u.pathname === '/cdn/build/web-player/xpui-routes-search.5e6f7a8b.js') return new Response(chunk(), { status: 200 });
    return new Response('nope', { status: 404 });
  }
  function spRoute(u) {
    const m = u.pathname.match(/^\/user-profile-view\/v3\/profile\/([^/]+)(?:\/(playlists|followers|following))?$/);
    if (!m) return json(404, { error: { status: 404 } });
    const usr = userFor(decodeURIComponent(m[1]));
    if (!usr) return json(404, { error: { status: 404, message: 'not found' } });
    if (!m[2]) return json(200, usr.profile, SPCT);
    if (m[2] === 'playlists') return json(200, usr.pls(Number(u.searchParams.get('offset')), Number(u.searchParams.get('limit'))), SPCT);
    return json(200, { profiles: usr[m[2]] || [] }, SPCT);
  }
  function pfRoute(rec) {
    if (rec.method !== 'POST' || rec.path !== '/pathfinder/v2/query') return json(404, {});
    const h = rec.headers;
    if (h['App-Platform'] !== 'Win32_x86_64' || h['Spotify-App-Version'] !== '1.2.77.358' || h['User-Agent'] !== 'Spotify/127700358 Win32_x86_64/0 (PC desktop)') {
      return json(403, { error: { status: 403, message: 'Forbidden' } });
    }
    const b = JSON.parse(rec.body);
    const op = b.operationName;
    if (b.extensions.persistedQuery.sha256Hash !== S.serverHashes[op]) {
      return json(S.staleStatus, { errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }], data: null });
    }
    const v = b.variables;
    if (op === 'searchUsers') return json(200, searchAnswer(v));
    if (op === 'isFollowingUsers') return json(200, { data: { users: v.uris.map((uri) => ({ __typename: 'User', uri, following: S.followed.has(decodeURIComponent(uri.slice(13))) })) } });
    if (op === 'followUsers' || op === 'unfollowUsers') {
      if (S.refuse === 403) return json(403, { error: { status: 403, message: 'Forbidden' } });
      if (S.refuse === 'errors') return json(200, { errors: [{ message: 'Something went wrong' }], data: null });
      if (S.refuse === 'type') return json(200, { data: { [op]: { responses: [{ __typename: 'FollowUserError', username: v.usernames[0] }] } } });
      if (!S.lie) for (const n of v.usernames) { if (op === 'followUsers') S.followed.add(n); else S.followed.delete(n); }
      if (op === 'unfollowUsers' && S.altShape === 'typename') return json(200, { data: { [op]: { responses: v.usernames.map((n) => ({ __typename: 'UnfollowUserSuccess', username: n })) } } });
      if (op === 'unfollowUsers' && S.altShape === 'key') return json(200, { data: { removeFollowing: { responses: [{ __typename: 'Ok' }] } } });
      if (op === 'unfollowUsers' && S.altShape === 'empty') return json(200, { data: { [op]: null } });
      return json(200,{ data: { [op]: { responses: v.usernames.map((n) => ({ __typename: 'FollowUserResult', username: n, result: 'OK' })) } }, extensions: {} });
    }
    return json(400, { errors: [{ message: 'unknown op' }] });
  }
  S.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const host = { 'sp.test': 'sp', 'pf.test': 'pf', 'web.test': 'web', 'cdn.test': 'cdn' }[u.host] || 'other';
    const rec = { host, path: u.pathname, search: u.search, method, headers, body: init.body, t: Date.now() };
    S.log.push(rec);
    const counted = host === 'sp' || host === 'pf';
    if (counted) { S.inflight++; S.maxInflight = Math.max(S.maxInflight, S.inflight); }
    try {
      await sleep(S.delay);
      if (host === 'web' || host === 'cdn') return webRoute(u);
      if (host === 'other') throw new TypeError('fetch failed');
      const f = S.force.find((x) => x.host === host && x.n > 0);
      if (f) {
        f.n--;
        if (f.status === 'net') throw new TypeError('fetch failed');
        return json(f.status, f.body || { error: { status: f.status, message: 'forced' } }, f.retryAfter ? { 'Retry-After': String(f.retryAfter) } : {});
      }
      if (!String(headers.Authorization || '').startsWith('Bearer ' + SECRET)) return json(401, { error: { status: 401 } });
      if (S.auth401 > 0) { S.auth401--; return json(401, { error: { status: 401, message: 'The access token expired' } }); }
      return host === 'sp' ? spRoute(u) : pfRoute(rec);
    } finally {
      if (counted) S.inflight--;
    }
  };
  S.count = (host, re) => S.log.filter((r) => r.host === host && (!re || re.test(r.path + r.search))).length;
  S.calls = () => S.log.filter((r) => r.host === 'sp' || r.host === 'pf').length;
  return S;
}

// a minimal engine for Social instances that don't need the catalog's model
function tokenEngine(mode) {
  const e = { n: 0, mode: mode || 200 };
  e.send = async (m, p) => {
    assert.strictEqual(m + ' ' + p, 'POST /token');
    e.n++;
    await sleep(1);
    if (e.mode === 204) return { status: 204, json: null, retryAfter: null, upstream: null };
    if (e.mode === 'down') throw Object.assign(new Error('Encore\'s player isn\'t reachable.'), { status: 502, code: 'engine_error' });
    return { status: 200, json: { token: SECRET + 'g' + e.n }, retryAfter: null, upstream: null };
  };
  return e;
}
const stubCatalog = { username: () => 'testuser', myName: () => 'Alex Test', build: null };
const tmpDir = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'prof10-' + n + '-'));
const allDirs = [];
function newSocial(name, { timing, engine, now, S, catalog, webapi } = {}) {
  const dir = tmpDir(name);
  allDirs.push(dir);
  S = S || makeSpotify();
  const social = new Social({ cfg: { cacheDir: dir, profiles: PROFILES }, engine: engine || tokenEngine(), webapi: webapi || { ready: true }, catalog: catalog || stubCatalog,
    fetch: S.fetch, now, timing: { jitterMs: 0, ...timing } });
  return { social, S, dir };
}
const errOf = async (p) => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); };
const parse = (m) => JSON.parse(m.body.toString());

// ------------------------------------------------------------------ the expected answers
const PL = {
  fzpl0: { u: PLU('fzpl0'), n: 'Zed Secret Mix', i: TOK('plfzpl0'), o: 'Friendly Person Zed', ou: 'spotify:user:friend.one', fol: 7 },
  fzpl1: { u: PLU('fzpl1'), n: 'List fzpl1', i: hx('img1', 40), o: 'Friendly Person Zed', ou: 'spotify:user:friend.one' },
  fzpl2: { u: PLU('fzpl2'), n: 'List fzpl2', i: uTok('https://mosaic.scdn.co/640/' + MOSAIC.join('')), o: 'Alex Test', ou: 'spotify:user:testuser', own: 1 },
  fzpl3: { u: PLU('fzpl3'), n: 'List fzpl3', i: hx('single', 40), o: 'Spotify', ou: 'spotify:user:spotify' },
  fzpl4: { u: PLU('fzpl4'), n: 'List fzpl4', o: 'Friendly Person Zed', ou: 'spotify:user:friend.one' },
};
const more = (i) => ({ u: PLU('fzmore' + i), n: 'List fzmore' + i, i: TOK('plfzmore' + i), o: 'Friendly Person Zed', ou: 'spotify:user:friend.one' });
const FRIEND = { u: 'spotify:user:friend.one', id: 'friend.one', n: 'Friendly Person Zed', i: TOK('fp'), fol: 12, fing: 3, cf: 1, plt: 25,
  pl: [PL.fzpl0, PL.fzpl1, PL.fzpl2, PL.fzpl3, PL.fzpl4, more(0), more(1), more(2), more(3)], ar: [{ u: art('a1'), n: 'Artist Uno', i: TOK('a1') }] };

(async () => {
  // ================================================================ 0. helpers
  assert.strictEqual(imageUrl('https://i.scdn.co/image/' + hx('a', 40)), 'https://i.scdn.co/image/' + hx('a', 40));
  assert.strictEqual(imageUrl('spotify:image:' + hx('a', 40).toUpperCase()), 'https://i.scdn.co/image/' + hx('a', 40));
  assert.strictEqual(imageUrl('spotify:mosaic:' + MOSAIC.join(':')), 'https://mosaic.scdn.co/640/' + MOSAIC.join(''));
  assert.strictEqual(imageUrl('spotify:mosaic:' + MOSAIC[0]), 'https://i.scdn.co/image/' + MOSAIC[0]);
  for (const bad of ['spotify:mosaic:' + MOSAIC.slice(0, 2).join(':'), 'spotify:mosaic:abc', 'http://i.scdn.co/image/x', 'spotify:image:zz', '', null, 7]) assert.strictEqual(imageUrl(bad), '');
  assert.strictEqual(userIdOf('spotify:user:friend.one'), 'friend.one');
  assert.strictEqual(userIdOf('spotify:user:mx%2Btest%40x'), 'mx+test@x');
  for (const bad of ['spotify:user:x:collection', 'spotify:user:', 'spotify:artist:' + id22('a'), 'spotify:user:a%2Fb', 'spotify:user:%E0%A4%A', 'spotify:user:' + 'x'.repeat(65), 'spotify:user:a%20b', null]) {
    assert.strictEqual(userIdOf(bad), '', String(bad));
  }
  assert.ok(staleHash(412, { errors: [{ message: 'PersistedQueryNotFound' }] }));
  assert.ok(staleHash(200, { errors: [{ message: 'x', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }], data: null }));
  assert.ok(staleHash(400, { errors: [{ message: 'Persisted query not found' }], data: { a: null } }));
  assert.ok(!staleHash(200, { errors: [{ message: 'PersistedQueryNotFound' }], data: { searchV2: {} } }), 'data present');
  assert.ok(!staleHash(500, { errors: [{ message: 'PersistedQueryNotFound' }] }), '5xx is not a stale hash');
  assert.ok(!staleHash(200, { errors: [{ message: 'Something went wrong' }], data: null }));
  {
    const S = makeSpotify();
    S.bundleOps.searchUsers = NEW1;
    const main = await (await S.fetch(CDN + 'web-player.1a2b3c4d.js')).text();
    assert.strictEqual(searchChunk(main), 'xpui-routes-search.5e6f7a8b.js');
    assert.deepStrictEqual(collectOps(main), { isFollowingUsers: DEFAULTS.hashes.isFollowingUsers, followUsers: DEFAULTS.hashes.followUsers, unfollowUsers: DEFAULTS.hashes.unfollowUsers });
    assert.strictEqual(searchChunk('no map here'), null);
  }
  ok('helpers: pictures, ids, stale-hash detection, the chunk map');

  // ================================================================ the main setup: real catalog + http.js
  let off = 0;
  const now = () => Date.now() + off;
  class TWebApi extends FakeWebApi {
    info() { return { connected: this.ready }; }
    async api(method, p, body, opts) {
      if (!this.ready) throw Object.assign(new Error('Connect your Spotify account on the gateway admin page first'), { status: 503, code: 'spotify_not_connected' });
      return super.api(method, p, body, opts);
    }
  }
  const webapi = new TWebApi();
  const { cat, model, engine, events } = makeCatalog({ webapi });
  let tokenCalls = 0;
  let tokenMode = 200;
  const engineSend = engine.send;
  engine.send = async (m, p, b, o) => {
    if (m === 'POST' && p === '/token') {
      tokenCalls++;
      await sleep(1);
      if (tokenMode === 204) return { status: 204, json: null, retryAfter: null, upstream: null };
      return { status: 200, json: { token: SECRET + tokenCalls }, retryAfter: null, upstream: null };
    }
    return engineSend(m, p, b, o);
  };
  // the library: one of Alex's, one he follows (friend.one's), one of Spotify's
  model.addPlaylist({ uri: PLU('mine1'), name: 'My List', owner_username: ME, length: 3, can_edit: true, revision: 'r1' });
  model.addPlaylist({ uri: PLU('fzfollowed'), name: 'Followed One', owner_username: 'friend.one', length: 2, revision: 'r2' });
  model.addPlaylist({ uri: PLU('dm1'), name: 'Daily Mix 1', owner_username: 'spotify', length: 50 });
  for (const k of ['outside1', 'fzpl0', 'mine1']) model.addContext(PLU(k), Array.from({ length: 3 }, (_, i) => ({ uri: 'spotify:track:' + id22(k + i), meta: 'ok' })));
  webapi.on(/^\/me\/playlists\?/, () => ({ items: [], next: null }));
  webapi.on(/^\/me\/tracks\?/, () => ({ total: 0, items: [] }));
  webapi.on(new RegExp('^/playlists/' + id22('outside1') + '\\?fields='), () => ({ name: 'Outside One', description: '', images: [{ url: IMG('out1') }], owner: { id: 'friend.one', display_name: 'Friendly Person Zed' } }));
  webapi.on(/^\/search\?/, () => ({ tracks: { total: 0, items: [] }, artists: { items: [] }, albums: { items: [] },
    playlists: { items: [null, { uri: PLU('srch1'), name: 'Found List', images: [{ url: IMG('s1') }], owner: { id: 'friend.one', display_name: 'Friendly Person Zed' } },
      { uri: PLU('srch2'), name: 'Weird Owner', images: [], owner: { id: 'a/b', display_name: 'W' } }] } }));
  // P3: Spotify's generic library route against the engine model's rootlist
  const lib = { noop: false, refuse: null, calls: [] };
  webapi.on(/^\/me\/library\?uris=/, (method, p) => {
    const uri = decodeURIComponent(p.split('uris=')[1]);
    lib.calls.push([method, uri]);
    if (lib.refuse) throw Object.assign(new Error(`Spotify refused this (${method} /me/library: Forbidden).`), { status: 403, code: 'spotify_forbidden', spotifyStatus: lib.refuse });
    if (lib.noop) return null;
    if (method === 'PUT' && !model.playlists.some((x) => x.uri === uri)) model.addPlaylist({ uri, name: 'Zed Secret Mix', owner_username: 'friend.one', length: 3, revision: 'r9' });
    if (method === 'DELETE') model.playlists = model.playlists.filter((x) => x.uri !== uri);
    return null;
  });
  const S = makeSpotify();
  const dir = tmpDir('main');
  allDirs.push(dir, path.dirname(cat.store.dir));
  const T = { minGapMs: 15, retryMs: 20, tokenGap: 150, noSessionGap: 50, queueWait: 3000, jitterMs: 0, holdMin: 1, saveRecheck: 50 };
  const social = new Social({ cfg: { cacheDir: dir, profiles: PROFILES }, engine, webapi, catalog: cat, fetch: S.fetch, now, timing: T });
  cat.hintFor = (id) => social.hint(id);
  const calls = { search: 0, users: 0 };
  const realSearch = cat.search.bind(cat);
  cat.search = (...a) => { calls.search++; return realSearch(...a); };
  const realUsers = social.searchUsers.bind(social);
  social.searchUsers = (...a) => { calls.users++; return realUsers(...a); };
  const player = { lastPhone: Date.now(), pollRemote: async () => {}, snapshot: () => ({ status: 'stopped' }), st: { active: false, status: 'stopped' },
    genInfo: new Map(), pending: null, heardInfo: () => ({}), syncInfo: () => ({}) };
  const stubInfo = { info: () => ({}) };
  const server = createServer({ cfg: { dataDir: dir, version: '0.10.0', adminPassword: 'pw', tiers: {}, defaultTier: 'high' }, player,
    auth: { verify: () => ({ id: 'dev', name: 'test' }), list: () => [] }, bus: { wait: async () => [] },
    encoders: { warmAll() {}, info: () => ({}) }, engine, clock: { sample: 0, lead: () => 0, leadMs: 0, frozen: null, pipeBytes: 0, stats: {} }, started: Date.now(),
    webapi, catalog: cat, images: stubInfo, jam: { statusInfo: () => ({}), info: () => ({}) }, personal: {}, lyrics: stubInfo, membership: stubInfo, social });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const bodies = [];
  const req = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...headers, ...(body != null ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(parts);
        const text = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString() : raw.toString();
        bodies.push(text);
        let j = null;
        try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, j, raw });
      });
    });
    rq.on('error', reject);
    if (body != null) rq.write(typeof body === 'string' ? body : JSON.stringify(body));
    rq.end();
  });
  const errIs = (r, status, code, message) => {
    assert.strictEqual(r.status, status, `${r.status} ${r.text}`);
    assert.strictEqual(r.j.error.code, code, r.text);
    if (message) assert.strictEqual(r.j.error.message, message);
  };
  const ADMIN = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };

  // ================================================================ 1. shapes (§2.4)
  let r = await req('/v1/users/friend.one');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.j, FRIEND);
  const spReq = S.log.filter((x) => x.host === 'sp').pop();
  assert.strictEqual(spReq.path + spReq.search, '/user-profile-view/v3/profile/friend.one?playlist_limit=10&artist_limit=10&episode_limit=0&market=from_token');
  assert.strictEqual(spReq.headers['User-Agent'], 'Spotify/127700358 Linux/0 (PC desktop)');
  assert.strictEqual(spReq.headers.Accept, 'application/json');
  assert.ok(spReq.headers.Authorization.startsWith('Bearer ' + SECRET));
  ok('PROFILE: https / spotify:image / spotify:mosaic pictures, ou / own / fol, bad rows dropped, ar, cf');
  r = await req('/v1/users/quiet.one');
  assert.deepStrictEqual(r.j, { u: 'spotify:user:quiet.one', id: 'quiet.one', n: 'quiet.one', fol: 0, fing: 0, plt: 0, pl: [] });
  r = await req('/v1/users/testuser');
  assert.deepStrictEqual(r.j, { u: 'spotify:user:testuser', id: 'testuser', n: 'Alex Test', i: TOK('me'), fol: 21, fing: 45, me: 1, plt: 1,
    pl: [{ u: PLU('mine1'), n: 'List mine1', i: TOK('plmine1'), o: 'Alex Test', ou: 'spotify:user:testuser', own: 1 }] });
  r = await req('/v1/users/spotify');
  assert.strictEqual(r.j.vf, 1);
  assert.strictEqual(r.j.cf, 1);
  assert.strictEqual(r.j.pl.length, 10);
  assert.deepStrictEqual(r.j.pl[0], { u: PLU('sppl0'), n: 'List sppl0', i: TOK('plsppl0'), o: 'Spotify', ou: 'spotify:user:spotify', fol: 1000 });
  r = await req('/v1/users/mx%2Btest%40x');
  assert.deepStrictEqual(r.j, { u: 'spotify:user:mx%2Btest%40x', id: 'mx+test@x', n: 'Odd Name', fol: 0, fing: 0, plt: 0, pl: [] });
  assert.strictEqual(S.log.filter((x) => x.host === 'sp').pop().path, '/user-profile-view/v3/profile/mx%2Btest%40x', 'the id percent-encoded again');
  ok('PROFILE: counts default to 0, n falls back to the id, me (no cf), vf, cf without allow_follows absent, an encoded id round trip');

  // ETag, 304, fresh
  let n0 = S.calls();
  r = await req('/v1/users/friend.one');
  const etag = r.headers.etag;
  assert.ok(etag);
  r = await req('/v1/users/friend.one', { headers: { 'If-None-Match': etag } });
  assert.strictEqual(r.status, 304);
  r = await req('/v1/users/friend.one?fresh=1');
  assert.strictEqual(S.calls(), n0, 'a young copy: no refetch, even with fresh=1');
  off += 31000;
  r = await req('/v1/users/friend.one?fresh=1', { headers: { 'If-None-Match': etag } });
  assert.strictEqual(S.calls(), n0 + 1, 'fresh=1 on a copy older than 30 s refetches');
  assert.strictEqual(r.status, 304, 'same content, same ETag');
  ok('routes: ETag then 304, fresh=1 only past 30 s');

  // PAGE
  r = await req('/v1/users/friend.one/playlists');
  assert.deepStrictEqual(r.j, { total: 25, offset: 0, items: [PL.fzpl0, PL.fzpl1, PL.fzpl2, PL.fzpl3, PL.fzpl4, ...Array.from({ length: 19 }, (_, i) => more(i))] });
  assert.strictEqual(S.log.filter((x) => x.host === 'sp').pop().search, '?offset=0&limit=50');
  r = await req('/v1/users/spotify/playlists?offset=0');
  assert.strictEqual(r.j.total, 120);
  assert.strictEqual(r.j.next, 50);
  assert.strictEqual(r.j.items.length, 50);
  r = await req('/v1/users/spotify/playlists?offset=50');
  assert.strictEqual(r.j.next, 100);
  r = await req('/v1/users/spotify/playlists?offset=100');
  assert.strictEqual(r.j.items.length, 20);
  assert.ok(!('next' in r.j));
  r = await req('/v1/users/big.list/playlists?offset=900');
  assert.strictEqual(r.j.next, 950);
  r = await req('/v1/users/big.list/playlists?offset=950');
  assert.ok(!('next' in r.j), 'nothing past 950');
  assert.strictEqual(r.j.offset, 950);
  await req('/v1/users/nopl.total');
  r = await req('/v1/users/nopl.total/playlists');
  assert.deepStrictEqual([r.j.total, r.j.next], [70, 50], 'no total in the page: the profile\'s plt');
  ok('PAGE: total, offset, items, next while < total and <= 950');

  // PEOPLE (+ gzip)
  r = await req('/v1/users/friend.one/followers', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(r.headers['content-encoding'], 'gzip');
  assert.strictEqual(r.j.total, 250);
  assert.strictEqual(r.j.items.length, 200);
  assert.strictEqual(r.j.trunc, 1);
  assert.deepStrictEqual(r.j.items.slice(0, 2), [{ k: 'user', u: 'spotify:user:fol0', id: 'fol0', n: 'Follower 0', i: TOK('fo0'), f: 1 },
    { k: 'user', u: 'spotify:user:fol1', id: 'fol1', n: 'Follower 1', i: TOK('fo1'), fol: 1 }]);
  r = await req('/v1/users/friend.one/following');
  assert.deepStrictEqual(r.j, { total: 5, items: [{ k: 'artist', u: art('a2'), n: 'Artist Dos', i: TOK('a2'), fol: 99 },
    { k: 'user', u: 'spotify:user:fz.pal', id: 'fz.pal', n: 'Pal Person', i: hx('pal', 40), f: 1 }, { k: 'user', u: 'spotify:user:noname.pal', id: 'noname.pal', n: 'noname.pal' }] });
  assert.ok(!r.headers['content-encoding'], 'small: no gzip');
  r = await req('/v1/users/spotify/following');
  assert.deepStrictEqual([r.j.total, r.j.items.length, r.j.trunc, r.j.items[0].k], [520, 500, 1, 'artist']);
  r = await req('/v1/users/quiet.one/followers');
  assert.deepStrictEqual(r.j, { total: 0, items: [] });
  ok('PEOPLE: users and artists (k), the 200 / 500 caps with trunc, gzip over 2 KB');

  // USERS
  r = await req('/v1/search/users?q=' + encodeURIComponent('  Friendly   Zed '));
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.j.q, 'friendly zed');
  assert.deepStrictEqual([r.j.total, r.j.next, r.j.items.length], [35, 10, 8]);
  assert.deepStrictEqual(r.j.items[0], { k: 'user', u: 'spotify:user:fz0', id: 'fz0', n: 'Friendly Zed 0', i: TOK('s3000') });
  assert.deepStrictEqual(r.j.items.find((x) => x.id === 'fz5'), { k: 'user', u: 'spotify:user:fz5', id: 'fz5', n: 'Friendly Zed 5' }, 'a null avatar: no i');
  assert.ok(!r.j.items.some((x) => x.id === 'fz3' || x.id === 'bad'), 'NotFound and a bad uri skipped');
  const pfReq = S.log.filter((x) => x.host === 'pf').pop();
  const pfBody = JSON.parse(pfReq.body);
  assert.deepStrictEqual(pfBody, { variables: { searchTerm: 'Friendly Zed', offset: 0, limit: 10, numberOfTopResults: 20, includeAudiobooks: true, includePreReleases: false,
    includeAlbumPreReleases: false, includeAuthors: false, includeEpisodeContentRatingsV2: false }, operationName: 'searchUsers',
  extensions: { persistedQuery: { version: 1, sha256Hash: DEFAULTS.hashes.searchUsers } } });
  assert.strictEqual(pfReq.headers['Content-Type'], 'application/json;charset=UTF-8');
  r = await req('/v1/search/users?q=friendly%20zed&offset=30');
  assert.deepStrictEqual([r.j.items.length, 'next' in r.j], [4, false], 'next only below totalCount');
  r = await req('/v1/search/users?q=many&offset=80');
  assert.strictEqual(r.j.next, 90);
  r = await req('/v1/search/users?q=many&offset=90');
  assert.ok(!('next' in r.j), 'nothing past 90');
  n0 = S.calls();
  r = await req('/v1/search/users?q=FRIENDLY%20ZED');
  assert.strictEqual(S.calls(), n0, 'the search cache (lower-cased q)');
  assert.ok(lines.some((l) => /social: searchUsers 200 \(8\)/.test(l)));
  ok('USERS: q trimmed + lower-cased, NotFound skipped, null avatar, next rules, the variables, the cache');

  // routing: /v1/search/users vs /v1/search
  const c0 = { ...calls };
  r = await req('/v1/search?q=abc');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([calls.search - c0.search, calls.users - c0.users], [1, 0]);
  r = await req('/v1/search/users?q=abc');
  assert.deepStrictEqual([calls.search - c0.search, calls.users - c0.users], [1, 1]);
  assert.deepStrictEqual(r.j, { q: 'abc', total: 0, items: [] });
  ok('routes: /v1/search/users and /v1/search don\'t shadow each other');

  // bad input
  n0 = S.calls();
  for (const [p, msg] of [
    ['/v1/users/a%2Fb', 'That isn\'t a Spotify profile.'], ['/v1/users/%E0%A4%A', 'That isn\'t a Spotify profile.'], ['/v1/users/' + 'x'.repeat(65), 'That isn\'t a Spotify profile.'],
    ['/v1/users/a%3Ab', 'That isn\'t a Spotify profile.'], ['/v1/users/a%20b/followers', 'That isn\'t a Spotify profile.'],
    ['/v1/search/users?q=%20%20', 'Search needs 1 to 100 characters.'], ['/v1/search/users', 'Search needs 1 to 100 characters.'], ['/v1/search/users?q=' + 'a'.repeat(101), 'Search needs 1 to 100 characters.'],
    ['/v1/search/users?q=ab&offset=5', 'offset must be 0 to 90 in steps of 10.'], ['/v1/search/users?q=ab&offset=100', 'offset must be 0 to 90 in steps of 10.'], ['/v1/search/users?q=ab&offset=x', 'offset must be 0 to 90 in steps of 10.'],
    ['/v1/users/friend.one/playlists?offset=25', 'offset must be 0 to 950 in steps of 50.'], ['/v1/users/friend.one/playlists?offset=1000', 'offset must be 0 to 950 in steps of 50.'],
    ['/v1/users/friend.one/playlists?offset=-50', 'offset must be 0 to 950 in steps of 50.'],
  ]) errIs(await req(p), 400, 'bad_request', msg);
  errIs(await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: 'yes' } }), 400, 'bad_request', 'following must be true or false.');
  errIs(await req('/v1/users/friend.one/follow', { method: 'POST', body: '{nope' }), 400, 'bad_request');
  errIs(await req('/v1/users/testuser/follow', { method: 'POST', body: { following: true } }), 400, 'bad_request');
  errIs(await req('/v1/me/playlists', { method: 'POST', body: { uri: 'spotify:album:' + id22('x'), saved: true } }), 400, 'bad_request', 'Only playlists (spotify:playlist:…) can be saved here.');
  errIs(await req('/v1/me/playlists', { method: 'POST', body: { uri: PLU('x'), saved: 1 } }), 400, 'bad_request', 'saved must be true or false.');
  assert.strictEqual((await req('/v1/users/friend.one/follow')).status, 404, 'GET on follow');
  assert.strictEqual((await req('/v1/users/friend.one', { method: 'POST', body: {} })).status, 404, 'POST on a profile');
  assert.strictEqual((await req('/v1/users/friend.one/likes')).status, 404);
  assert.strictEqual((await req('/v1/me/playlists')).status, 404, 'GET /v1/me/playlists is not a route');
  assert.strictEqual(S.calls(), n0, 'nothing went upstream');
  ok('routes: the 400s (id, q, offsets, bodies, yourself) and the 404s, nothing upstream');

  // user_not_found and its miss cache
  n0 = S.calls();
  r = await req('/v1/users/ghost');
  errIs(r, 404, 'user_not_found', 'This profile isn\'t available on Spotify.');
  assert.strictEqual(S.calls(), n0 + 1);
  errIs(await req('/v1/users/ghost'), 404, 'user_not_found');
  errIs(await req('/v1/users/ghost/playlists'), 404, 'user_not_found');
  errIs(await req('/v1/users/ghost/following'), 404, 'user_not_found');
  assert.strictEqual(S.calls(), n0 + 1, 'the 10-min miss: no second upstream call');
  off += 601000;
  errIs(await req('/v1/users/ghost'), 404, 'user_not_found');
  assert.strictEqual(S.calls(), n0 + 2, 'asked again after 10 min');
  ok('user_not_found (never not_found), cached as a miss for 10 min');

  // logPath: a 5xx on a users route logs /v1/users/<id>, never the id
  n0 = S.calls();
  S.force.push({ host: 'sp', status: 500, n: 2 });
  r = await req('/v1/users/u500');
  errIs(r, 502, 'spotify_error', 'Spotify didn\'t answer. Try again in a moment.');
  assert.strictEqual(S.calls(), n0 + 2, 'one retry after a 5xx');
  assert.ok(lines.some((l) => l.includes('GET /v1/users/<id>: Spotify didn\'t answer')), 'logPath');
  assert.ok(!lines.some((l) => l.includes('u500')), 'the id never logged');
  S.force.push({ host: 'sp', status: 'net', n: 1 });
  r = await req('/v1/users/u501');
  assert.strictEqual(r.status, 200, 'a network error on a read: one retry');
  ok('logPath hides the id; a read is retried once after a 5xx or a network error');

  // /v1/status
  r = await req('/v1/status');
  assert.deepStrictEqual(r.j.profiles, { v: 1, follow: 1, sp: 1 });
  assert.strictEqual(r.j.gateway.version, '0.10.0');
  ok('/v1/status profiles');

  // ================================================================ 3. the token
  assert.strictEqual(tokenCalls, 1, 'one /token for every call so far');
  await sleep(T.tokenGap + 20);
  n0 = S.calls();
  S.auth401 = 1;
  r = await req('/v1/users/u401a');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([tokenCalls, S.calls() - n0], [2, 2], 'a 401: one refetch, one retry');
  S.auth401 = 1;
  r = await req('/v1/users/u401b');
  errIs(r, 503, 'profiles_unavailable', 'Profiles aren\'t available right now. Try again in a moment.');
  assert.strictEqual(r.j.error.retry_after, 30);
  assert.strictEqual(tokenCalls, 2, 'a 401 within 30 s of the last fetch: no fetch');
  r = await req('/v1/users/u401b2');
  errIs(r, 503, 'profiles_unavailable');
  assert.strictEqual(tokenCalls, 2, 'still within the 30 s');
  assert.strictEqual(lines.filter((l) => l.includes('social: profiles unavailable')).length, 1, 'logged once where it starts');
  await sleep(T.tokenGap + 20);
  r = await req('/v1/users/u401x');
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(tokenCalls, 3, 'fetched again once the 30 s are over');
  await sleep(T.tokenGap + 20);
  n0 = S.calls();
  S.auth401 = 2;
  r = await req('/v1/users/u401c');
  errIs(r, 503, 'profiles_unavailable');
  assert.strictEqual(r.j.error.retry_after, 30);
  assert.deepStrictEqual([tokenCalls, S.calls() - n0], [4, 2], 'one refetch, then the second 401');
  assert.strictEqual(lines.filter((l) => l.includes('social: profiles unavailable')).length, 2, 'once per episode');
  assert.ok(!lines.some((l) => /GET \/v1\/users\/<id>: Profiles/.test(l)), 'quiet in http.js');
  r = await req('/v1/users/u401d');
  assert.strictEqual(r.status, 200, 'the fresh token works');
  assert.strictEqual(tokenCalls, 4);
  ok('token: one fetch for N calls, a 401 refetches once (30 s rule), a second 401 = profiles_unavailable');
  {
    const N = newSocial('t204', { engine: tokenEngine(204), timing: { noSessionGap: 50 } });
    let e = await errOf(N.social.profile('friend.one', false));
    assert.deepStrictEqual([e.status, e.code, e.retry_after], [503, 'profiles_unavailable', 5]);
    e = await errOf(N.social.profile('friend.one', false));
    assert.strictEqual(e.retry_after, 5);
    assert.strictEqual(N.social.engine.n, 1, 'no second fetch within 5 s of a 204');
    assert.strictEqual(N.S.calls(), 0, 'nothing went to Spotify');
    await sleep(60);
    await errOf(N.social.profile('friend.one', false));
    assert.strictEqual(N.social.engine.n, 2);
    const D = newSocial('tdown', { engine: tokenEngine('down') });
    e = await errOf(D.social.profile('friend.one', false));
    assert.deepStrictEqual([e.code, e.retry_after], ['profiles_unavailable', 30]);
    ok('token: 204 = profiles_unavailable with retry_after 5; an unreachable engine 30');
  }

  // ================================================================ 4. the gate
  {
    const G = newSocial('gap', { timing: { minGapMs: 40 } });
    G.S.delay = 15;
    const rs = await Promise.all(['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((id) => G.social.profile(id, false)));
    assert.strictEqual(rs.length, 6);
    assert.strictEqual(G.S.maxInflight, 1, 'never two in flight');
    const ts = G.S.log.filter((x) => x.host === 'sp').map((x) => x.t);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 38, `starts ${ts[i] - ts[i - 1]} ms apart`);
    ok('gate: one in flight, starts at least minGapMs apart');
    const O = newSocial('overflow', { timing: { minGapMs: 1, queueWait: 5000 } });
    await O.social.profile('u0', false);                                   // (the token)
    O.S.delay = 150;
    const res = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => O.social.profile('u' + (10 + i), false)));
    const busy = res.filter((x) => x.status === 'rejected');
    assert.strictEqual(busy.length, 1, 'one in flight + 6 queued; the 8th is busy');
    assert.deepStrictEqual([busy[0].reason.status, busy[0].reason.code, busy[0].reason.retry_after, busy[0].reason.message],
      [503, 'busy', 3, 'Encore is busy loading profiles. Try again in a moment.']);
    const W = newSocial('wait', { timing: { minGapMs: 1, queueWait: 100 } });
    await W.social.profile('u0', false);
    W.S.delay = 300;
    const rw = await Promise.allSettled(['u1', 'u2', 'u3'].map((id) => W.social.profile(id, false)));
    assert.deepStrictEqual(rw.map((x) => (x.status === 'fulfilled' ? 'ok' : x.reason.code)), ['ok', 'busy', 'busy'], 'the 8 s (here 100 ms) wait');
    ok('gate: queue overflow and the queue wait are busy (retry_after 3)');
    let boff = 0;
    const B = newSocial('budget', { timing: { minGapMs: 1 }, now: () => Date.now() + boff });
    for (let i = 0; i < 60; i++) await B.social.profile('u' + (100 + i), false);
    const e = await errOf(B.social.profile('u999', false));
    assert.deepStrictEqual([e.status, e.code], [503, 'rate_limited']);
    assert.ok(e.retry_after >= 299 && e.retry_after <= 300, String(e.retry_after));
    assert.strictEqual(B.S.calls(), 60, 'the 61st never started');
    assert.strictEqual(B.social.info().window, 60);
    boff += 300001;
    await B.social.profile('u999', false);
    assert.strictEqual(B.S.calls(), 61, 'the window moved on');
    ok('gate: the 61st start in 5 min is rate_limited until the oldest leaves the window');
  }
  {
    let hoff = 0;
    const H = newSocial('hold', { timing: { minGapMs: 1, holdMin: 1 }, now: () => Date.now() + hoff });
    await H.social.profile('friend.one', false);
    await H.social.people('friend.one', 'following', false);
    hoff += 31 * 60000;                                                      // both copies expired
    H.S.delay = 40;
    H.S.force.push({ host: 'sp', status: 429, n: 1, retryAfter: 7 });
    const n1 = H.S.calls();
    const res = await Promise.allSettled([H.social.profile('friend.one', false), H.social.profile('u1', false), H.social.profile('u2', false),
      H.social.people('friend.one', 'following', false), H.social.profile('u3', false)]);
    assert.strictEqual(H.S.calls() - n1, 1, 'one call went out, the queued ones were failed');
    const pr = res[0].value && parse(res[0].value);
    assert.strictEqual(pr && pr.stale, 1, 'a copy answers stale: 1');
    assert.strictEqual(pr.n, 'Friendly Person Zed');
    assert.strictEqual(parse(res[3].value).stale, 1);
    for (const i of [1, 2, 4]) {
      assert.strictEqual(res[i].status, 'rejected');
      assert.deepStrictEqual([res[i].reason.code, res[i].reason.status], ['rate_limited', 503]);
      assert.ok(res[i].reason.retry_after >= 6 && res[i].reason.retry_after <= 7, String(res[i].reason.retry_after));
      assert.strictEqual(res[i].reason.message, `Spotify is limiting requests. Try again in ${res[i].reason.retry_after} s.`);
    }
    const e = await errOf(H.social.profile('u4', false));
    assert.strictEqual(e.code, 'rate_limited', 'held');
    assert.strictEqual(H.S.calls() - n1, 1, 'nothing goes out while held');
    assert.strictEqual(lines.filter((l) => l.includes('social: 429, holding 7 s')).length, 1, 'logged once');
    const se = await errOf(H.social.searchUsers('friendly zed', '0'));
    assert.strictEqual(se.code, 'rate_limited');
    hoff += 8000;
    await H.social.profile('u4', false);
    assert.strictEqual(H.S.calls() - n1, 2, 'the hold is over');
    const hf = H.S.force;
    hf.push({ host: 'sp', status: 429, n: 1 });
    await errOf(H.social.profile('u5', false));
    assert.ok(H.social.blockedUntil - (Date.now() + hoff) > 29000, 'no Retry-After: 30 s');
    hoff += 31000;
    hf.push({ host: 'sp', status: 429, n: 1, retryAfter: 5000 });
    await errOf(H.social.profile('u6', false));
    assert.ok(H.social.blockedUntil - (Date.now() + hoff) <= 900000 + 5, 'clamped to 900 s');
    ok('gate: a 429 holds every call (Retry-After, default 30, clamp) and fails the queued; copies answer stale: 1');
  }

  {
    // (verify run) a call that waits too long in the queue (busy) answers the expired copy with stale: 1
    let soff = 0;
    const Q = newSocial('stalebusy', { timing: { minGapMs: 1, queueWait: 100 }, now: () => Date.now() + soff });
    await Q.social.profile('friend.one', false);
    soff += 601000;
    Q.S.delay = 300;
    const first = Q.social.profile('u1', false);
    await sleep(30);
    const pb = parse(await Q.social.profile('friend.one', false));
    assert.deepStrictEqual([pb.stale, pb.n], [1, 'Friendly Person Zed']);
    assert.strictEqual(parse(await first).n, 'Gen u1');
    const f2 = Q.social.profile('u2', false);
    await sleep(30);
    const e = await errOf(Q.social.profile('u3', false));
    assert.strictEqual(e.code, 'busy', 'no copy: busy');
    await f2;
    ok('gate: busy with a copy = stale: 1');
  }

  // ================================================================ 5. hashes
  {
    S.serverHashes.searchUsers = NEW1;
    S.bundleOps.searchUsers = NEW1;
    const pf0 = S.count('pf');
    const w0 = S.count('web') + S.count('cdn');
    r = await req('/v1/search/users?q=hashtest');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.j.total, 35);
    assert.strictEqual(S.count('pf') - pf0, 2, 'the stale call and its one retry');
    assert.deepStrictEqual(S.log.filter((x) => x.host === 'web' || x.host === 'cdn').slice(-3).map((x) => x.path),
      ['/', '/cdn/build/web-player/web-player.1a2b3c4d.js', '/cdn/build/web-player/xpui-routes-search.5e6f7a8b.js']);
    assert.strictEqual(S.count('web') + S.count('cdn') - w0, 3, 'home, bundle, chunk: once each');
    assert.ok(S.log.filter((x) => x.host === 'web' || x.host === 'cdn').every((x) => /^Mozilla\/5\.0/.test(x.headers['User-Agent'])));
    assert.strictEqual(JSON.parse(S.log.filter((x) => x.host === 'pf').pop().body).extensions.persistedQuery.sha256Hash, NEW1, 'the new hash is used');
    assert.strictEqual(social.hashes.searchUsers, NEW1);
    assert.ok(lines.some((l) => l.includes('social: hashes refreshed (1 changed)')));
    await sleep(100);
    const hj = JSON.parse(fs.readFileSync(path.join(dir, 'social', 'hashes.json'), 'utf8'));
    assert.deepStrictEqual(hj.ops, { ...DEFAULTS.hashes, searchUsers: NEW1 });
    assert.ok(hj.at > 0);
    // within the hour: no refresh, spotify_error
    S.serverHashes.searchUsers = NEW2;
    r = await req('/v1/search/users?q=hashtest2');
    errIs(r, 502, 'spotify_error');
    assert.strictEqual(S.count('web') + S.count('cdn') - w0, 3, 'no second refresh within the hour');
    assert.strictEqual(S.count('pf') - pf0, 3);
    S.serverHashes.searchUsers = NEW1;
    // a stale answer with 412, after the hour, a refresh that doesn't find the op: spotify_error
    off += 3600001;
    S.staleStatus = 412;
    S.serverHashes.searchUsers = NEW2;
    S.bundleOps.searchUsers = 'gone';
    r = await req('/v1/search/users?q=hashtest3');
    errIs(r, 502, 'spotify_error');
    assert.strictEqual(S.count('web') + S.count('cdn') - w0, 6, 'one more refresh after the hour');
    assert.strictEqual(S.count('pf') - pf0, 4, 'no retry with a hash the refresh didn\'t find');
    S.serverHashes.searchUsers = NEW1;
    S.bundleOps.searchUsers = NEW1;
    S.staleStatus = 200;
    assert.strictEqual(social.hashes.searchUsers, NEW1, 'an op the refresh didn\'t find keeps its hash');
    // every pathfinder call carried the desktop headers
    assert.ok(S.log.filter((x) => x.host === 'pf').every((x) => x.headers['App-Platform'] === 'Win32_x86_64' && x.headers['Spotify-App-Version'] === '1.2.77.358'
      && x.headers['User-Agent'] === 'Spotify/127700358 Win32_x86_64/0 (PC desktop)' && x.headers.Accept === 'application/json'));
    // a restart keeps them
    const R2 = new Social({ cfg: { cacheDir: dir, profiles: PROFILES }, engine: tokenEngine(), webapi, catalog: stubCatalog, fetch: S.fetch });
    assert.strictEqual(R2.hashes.searchUsers, NEW1);
    // ... and a profile served from the disk copy fills the playlist hints
    const c2 = S.calls();
    assert.strictEqual(R2.hint(id22('fzpl0')), undefined);
    assert.strictEqual(parse(await R2.profile('friend.one', false)).n, 'Friendly Person Zed');
    assert.strictEqual(S.calls(), c2, 'from disk');
    assert.deepStrictEqual(R2.hint(id22('fzpl0')), PL.fzpl0, 'a copy from disk fills the hints');
    ok('hashes: a stale answer refreshes once (home, bundle, chunk), the new hash is used, hashes.json; once an hour; desktop headers');
  }

  // ================================================================ 6. writes
  // follow, confirmed; the cached profile is patched; Alex's own copies are dropped
  await req('/v1/users/testuser');
  await req('/v1/users/testuser/following');
  r = await req('/v1/users/friend.one?fresh=1');
  assert.deepStrictEqual([r.j.fol, r.j.f, r.j.cf], [12, undefined, 1]);
  assert.ok(social.store.peek('p', sha1('testuser')) && social.store.peek('fo', sha1('testuser|following')));
  let pf0 = S.count('pf');
  r = await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: true } });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.j, { u: 'spotify:user:friend.one', f: 1, fol: 13 });
  assert.ok(!r.headers.etag, 'a write: no ETag');
  const ops = S.log.filter((x) => x.host === 'pf').slice(pf0).map((x) => JSON.parse(x.body));
  assert.deepStrictEqual(ops.map((b) => [b.operationName, b.variables]), [['followUsers', { usernames: ['friend.one'] }], ['isFollowingUsers', { uris: ['spotify:user:friend.one'] }]]);
  assert.strictEqual(social.caps.follow, 'ok');
  n0 = S.calls();
  r = await req('/v1/users/friend.one');
  assert.deepStrictEqual([r.j.f, r.j.fol, r.j.cf], [1, 13, 1]);
  assert.strictEqual(S.calls(), n0, 'the patched copy');
  assert.ok(!social.store.peek('p', sha1('testuser')) && !social.store.peek('fo', sha1('testuser|following')), 'Alex\'s own profile and following dropped');
  r = await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: false } });
  assert.deepStrictEqual(r.j, { u: 'spotify:user:friend.one', f: 0, fol: 12 });
  r = await req('/v1/users/friend.one');
  assert.deepStrictEqual([r.j.f, r.j.fol], [undefined, 12]);
  r = await req('/v1/users/u77/follow', { method: 'POST', body: { following: true } });
  assert.deepStrictEqual(r.j, { u: 'spotify:user:u77', f: 1 }, 'no cached profile: no fol');
  ok('follow: followUsers then isFollowingUsers, {u, f, fol}, the cached profile patched, own copies dropped');
  // not confirmed
  S.lie = true;
  r = await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: true } });
  errIs(r, 502, 'not_saved', 'Spotify didn\'t confirm the change. Try again.');
  assert.strictEqual(social.caps.follow, 'ok', 'the capability stays');
  S.lie = false;
  ok('follow: not confirmed = not_saved');
  // live 2026-10-07: unfollowUsers answers 200 in another shape (and did unfollow): confirmed by isFollowingUsers = ok
  for (const alt of ['typename', 'key', 'empty']) {
    S.altShape = alt;
    r = await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: true } });
    assert.strictEqual(r.status, 200, alt + ' follow ' + r.text);
    r = await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: false } });
    assert.strictEqual(r.status, 200, alt + ' unfollow ' + r.text);
    assert.strictEqual(r.j.f, 0);
    assert.strictEqual(social.caps.follow, 'ok', alt + ': the capability stays');
  }
  S.altShape = null;
  ok('follow: another answer shape, confirmed by isFollowingUsers = ok (the live unfollow case)');
  // hard refusals: 403, GraphQL errors, another __typename
  for (const how of [403, 'errors', 'type']) {
    S.refuse = how;
    pf0 = S.count('pf');
    r = await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: true } });
    errIs(r, 501, 'not_supported', 'Following people isn\'t available right now.');
    assert.strictEqual(S.count('pf') - pf0, how === 'type' ? 2 : 1, 'no check after a refusal (an odd shape is checked once)');
    assert.strictEqual(social.caps.follow, 'off');
    await sleep(60);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'social', 'caps.json'), 'utf8')), { follow: 'off', save: 'unknown' });
    r = await req('/v1/users/friend.one');
    assert.ok(!('cf' in r.j), 'cf gone');
    r = await req('/v1/status');
    assert.deepStrictEqual(r.j.profiles, { v: 1, follow: 0, sp: 1 });
    pf0 = S.count('pf');
    errIs(await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: false } }), 501, 'not_supported');
    assert.strictEqual(S.count('pf'), pf0, 'off: nothing goes out');
    const R3 = new Social({ cfg: { cacheDir: dir, profiles: PROFILES }, engine: tokenEngine(), webapi, catalog: stubCatalog, fetch: S.fetch });
    assert.strictEqual(R3.caps.follow, 'off', 'persisted');
    // the admin reset
    r = await req('/admin/api/profiles/caps', { method: 'POST', headers: ADMIN, body: { reset: true } });
    assert.deepStrictEqual(r.j, { caps: { follow: 'unknown', save: 'unknown' } });
    r = await req('/v1/users/friend.one');
    assert.strictEqual(r.j.cf, 1, 'cf is back');
    S.refuse = null;
  }
  assert.strictEqual((await req('/admin/api/profiles/caps', { method: 'POST', headers: ADMIN, body: {} })).status, 400);
  assert.strictEqual((await req('/admin/api/profiles/caps', { method: 'POST', body: { reset: true } })).status, 401, 'the admin password');
  ok('follow: hard refusals (403, GraphQL errors, another type) = caps off persisted, 501, cf gone, status follow 0; the admin reset');
  // a stale hash on a write: refreshed and retried
  S.serverHashes.followUsers = NEW2;
  S.bundleOps.followUsers = NEW2;
  off += 3600001;
  r = await req('/v1/users/friend.one/follow', { method: 'POST', body: { following: true } });
  assert.deepStrictEqual(r.j, { u: 'spotify:user:friend.one', f: 1, fol: 13 });
  assert.strictEqual(social.hashes.followUsers, NEW2);
  assert.strictEqual(social.caps.follow, 'ok', 'a stale hash is not a refusal');
  ok('follow: a stale hash refreshes and retries, not a refusal');

  // P3: save someone else's playlist
  const PLX = PLU('fzpl0');
  r = await req('/v1/playlists');
  assert.ok(!r.j.items.some((x) => x.u === PLX));
  r = await req('/v1/me/playlists', { method: 'POST', body: { uri: PLX, saved: true } });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.j, { u: PLX, saved: 1 });
  assert.deepStrictEqual(lib.calls.pop(), ['PUT', PLX]);
  assert.strictEqual(social.caps.save, 'ok');
  assert.ok(events.some((e) => e.type === 'playlists'), 'the rebuild pushed playlists');
  r = await req('/v1/playlists');
  assert.strictEqual(r.j.items.find((x) => x.u === PLX).ou, 'spotify:user:friend.one');
  r = await req('/v1/me/playlists', { method: 'POST', body: { uri: PLX, saved: false } });
  assert.deepStrictEqual(r.j, { u: PLX, saved: 0 });
  assert.deepStrictEqual(lib.calls.pop(), ['DELETE', PLX]);
  lib.noop = true;
  r = await req('/v1/me/playlists', { method: 'POST', body: { uri: PLX, saved: true } });
  errIs(r, 502, 'not_saved');
  lib.noop = false;
  webapi.ready = false;
  r = await req('/v1/me/playlists', { method: 'POST', body: { uri: PLX, saved: true } });
  errIs(r, 503, 'spotify_not_connected');
  assert.deepStrictEqual((await req('/v1/status')).j.profiles, { v: 1, follow: 1, sp: 0 }, 'sp: needs the Web API account');
  webapi.ready = true;
  lib.refuse = 403;
  r = await req('/v1/me/playlists', { method: 'POST', body: { uri: PLX, saved: true } });
  errIs(r, 501, 'not_supported', 'Saving other people\'s playlists isn\'t available right now.');
  assert.strictEqual(social.caps.save, 'off');
  assert.deepStrictEqual((await req('/v1/status')).j.profiles, { v: 1, follow: 1, sp: 0 });
  const nl = lib.calls.length;
  errIs(await req('/v1/me/playlists', { method: 'POST', body: { uri: PLX, saved: false } }), 501, 'not_supported');
  assert.strictEqual(lib.calls.length, nl, 'off: nothing goes out');
  lib.refuse = null;
  await req('/admin/api/profiles/caps', { method: 'POST', headers: ADMIN, body: { reset: true } });
  assert.deepStrictEqual((await req('/v1/status')).j.profiles, { v: 1, follow: 1, sp: 1 });
  ok('save (P3): PUT / DELETE /me/library checked against the library, not_saved, spotify_not_connected, 501 + off, the reset');

  // ================================================================ 7. catalog: ou and the header hint
  r = await req('/v1/playlists?fresh=1');
  const ou = Object.fromEntries(r.j.items.map((x) => [x.n, x.ou]));
  assert.deepStrictEqual(ou, { 'My List': 'spotify:user:' + ME, 'Followed One': 'spotify:user:friend.one', 'Daily Mix 1': 'spotify:user:spotify' });
  r = await req('/v1/playlists/' + id22('outside1'));
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.j.h, { u: PLU('outside1'), n: 'Outside One', i: TOK('out1'), o: 'Friendly Person Zed', ou: 'spotify:user:friend.one' });
  r = await req('/v1/search?q=lists');
  assert.deepStrictEqual(r.j.playlists, [{ u: PLU('srch1'), n: 'Found List', i: TOK('s1'), o: 'Friendly Person Zed', ou: 'spotify:user:friend.one' },
    { u: PLU('srch2'), n: 'Weird Owner', o: 'W' }]);
  // a playlist the Web API has no header for: the profile's row
  r = await req('/v1/playlists/' + id22('fzpl0'));
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.j.h, PL.fzpl0);
  assert.ok(webapi.log.some((x) => x.path.startsWith('/playlists/' + id22('fzpl0') + '?fields=')), 'the Web API was asked first');
  assert.strictEqual(cat.hintFor(id22('nothing')), undefined);
  ok('catalog: ou on library, header and search rows; a {u} header takes the profile\'s row');

  // ================================================================ 7b. the less-travelled branches (verify run)
  {
    const { hostOk } = require('../src/image');
    assert.ok(hostOk('https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1'), 'Facebook profile pictures');
    assert.ok(!hostOk('https://platform-lookaside-fbsbx.com/x') && !hostOk('https://evil.fbsbx.com/x') && !hostOk('http://platform-lookaside.fbsbx.com/x'));
    // a 403 on a read: profiles_unavailable (30 s), never retried, never a miss
    n0 = S.calls();
    S.force.push({ host: 'sp', status: 403, n: 1 });
    r = await req('/v1/users/u403');
    errIs(r, 503, 'profiles_unavailable', 'Profiles aren\'t available right now. Try again in a moment.');
    assert.strictEqual(r.j.error.retry_after, 30);
    assert.strictEqual(S.calls() - n0, 1, 'a 403 is not retried');
    assert.ok(lines.some((l) => l.includes('social: profiles unavailable (403)')));
    r = await req('/v1/users/u403');
    assert.strictEqual(r.status, 200, 'not cached as a miss: ' + r.text);
    ok('a spclient 403 on a read = 503 profiles_unavailable, retry_after 30');
    // expired copies answer stale: 1 instead of profiles_unavailable (a 403) and spotify_error (a 5xx and its retry)
    off += 1800001;
    n0 = S.calls();
    S.force.push({ host: 'sp', status: 403, n: 1 });
    r = await req('/v1/users/friend.one');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.j.stale, r.j.n, r.j.id], [1, 'Friendly Person Zed', 'friend.one']);
    S.force.push({ host: 'sp', status: 502, n: 2 });
    r = await req('/v1/users/friend.one/following');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.j.stale, r.j.total], [1, 5]);
    assert.strictEqual(S.calls() - n0, 3, 'the 403 once, the 5xx and its one retry');
    r = await req('/v1/users/friend.one');
    assert.ok(!('stale' in r.j), 'the next call refetches');
    ok('copies answer stale: 1 for profiles_unavailable and spotify_error');
    // fresh=1 on a playlist page (after ?offset=, as the phone sends it) and on a people list: only past 30 s
    await req('/v1/users/spotify/playlists?offset=50');
    await req('/v1/users/spotify/following');
    n0 = S.calls();
    r = await req('/v1/users/spotify/playlists?offset=50&fresh=1');
    assert.deepStrictEqual([r.status, r.j.offset, r.j.next], [200, 50, 100]);
    await req('/v1/users/spotify/following?fresh=1');
    assert.strictEqual(S.calls(), n0, 'young copies: no refetch, even with fresh=1');
    off += 31000;
    r = await req('/v1/users/spotify/playlists?offset=50');
    assert.strictEqual(S.calls(), n0, 'no fresh: the copy');
    r = await req('/v1/users/spotify/playlists?offset=50&fresh=1');
    assert.strictEqual(S.calls(), n0 + 1, 'fresh=1 past 30 s refetches the page');
    assert.strictEqual(S.log.filter((x) => x.host === 'sp').pop().search, '?offset=50&limit=50');
    assert.deepStrictEqual([r.j.offset, r.j.items.length, r.j.next], [50, 50, 100]);
    r = await req('/v1/users/spotify/following?fresh=1');
    assert.strictEqual(S.calls(), n0 + 2, 'fresh=1 past 30 s refetches the people list');
    assert.strictEqual(r.j.total, 520);
    ok('fresh=1 on /playlists?offset= and /following: a refetch only past 30 s');
    // a Facebook-hosted picture: a u token
    const FB = 'https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1234567890&height=300&width=300&ext=1760000000&hash=AbCdEf';
    USERS['fb.one'] = { profile: { uri: 'spotify:user:fb.one', name: 'Fb Person', image_url: FB, followers_count: 2 } };
    r = await req('/v1/users/fb.one');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.j.i, uTok(FB));
    ok('a platform-lookaside.fbsbx.com profile picture gets a u token');
    // P3: a library that shows the save only after the recheck (saveRecheck + forceRoot) = saved: 1
    r = await req('/v1/playlists');
    assert.ok(!r.j.items.some((x) => x.u === PLX), 'not in the library yet');
    lib.noop = true;
    const realSettle = cat.settleRoot;
    let added = false;
    cat.settleRoot = async function () {
      await realSettle.call(this);
      cat.settleRoot = realSettle;
      setTimeout(() => { model.addPlaylist({ uri: PLX, name: 'Zed Secret Mix', owner_username: 'friend.one', length: 3, revision: 'r10' }); added = true; }, 0);
    };
    r = await req('/v1/me/playlists', { method: 'POST', body: { uri: PLX, saved: true } });
    lib.noop = false;
    cat.settleRoot = realSettle;
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.j, { u: PLX, saved: 1 });
    assert.ok(added, 'it showed up between the first check and the recheck');
    assert.deepStrictEqual(lib.calls.pop(), ['PUT', PLX]);
    assert.strictEqual(social.caps.save, 'ok');
    r = await req('/v1/me/playlists', { method: 'POST', body: { uri: PLX, saved: false } });
    assert.deepStrictEqual(r.j, { u: PLX, saved: 0 });
    ok('save (P3): a library that shows it only after the recheck = saved: 1');
  }

  // ================================================================ admin status (never the token)
  r = await req('/admin/api/status', { headers: ADMIN });
  assert.strictEqual(r.status, 200, r.text);
  const si = r.j.social;
  assert.deepStrictEqual(Object.keys(si).sort(), ['blocked_until', 'cache', 'calls', 'caps', 'hash_refresh_at', 'hashes', 'inflight', 'n429', 'queued', 'token', 'window']);
  assert.deepStrictEqual(Object.keys(si.token).sort(), ['age_s', 'fetches']);
  assert.strictEqual(si.hashes.searchUsers, NEW1.slice(0, 8));
  assert.ok(!r.text.includes(SECRET));
  ok('admin: social info (calls, window, token age / fetches only, hashes as 8 hex, caps, cache sizes)');

  server.close();
  await sleep(150);                                                          // (disk writes)

  // ================================================================ 8. nothing personal in a log line, the token nowhere
  const forbidden = ['friend.one', 'Friendly Person Zed', 'Zed Secret Mix', 'friendly zed', 'Friendly Zed', 'hashtest', 'Follower 1', 'mx+test', 'mx%2Btest',
    'fz.pal', 'Pal Person', 'quiet.one', 'big.list', 'nopl.total', 'Outside One', 'Artist Uno', 'u500', 'ghost', 'i.scdn.co', 'mosaic.scdn.co', SECRET, 'Bearer',
    'u403', 'fb.one', 'Fb Person', 'fbsbx', 'asid'];
  for (const l of lines) for (const f of forbidden) assert.ok(!l.toLowerCase().includes(f.toLowerCase()), `"${f}" in a log line: ${l}`);
  assert.ok(lines.some((l) => /social: profile 200 in \d+ ms/.test(l)) && lines.some((l) => l.includes('social: token fetched')), 'the call kinds are logged');
  for (const b of bodies) assert.ok(!b.includes(SECRET), 'the token in an answer');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
  let nFiles = 0;
  for (const d of allDirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of walk(d)) {
      nFiles++;
      assert.ok(!fs.readFileSync(f).toString('latin1').includes(SECRET), 'the token on disk: ' + f);
      for (const u of ['friend.one', 'testuser', 'quiet.one', 'mx+test']) assert.ok(!path.basename(f).includes(u), 'a username in a file name: ' + f);
    }
  }
  assert.ok(nFiles > 10);
  ok(`logs: ${lines.length} lines without a name, id, query, picture or token; the token in no answer and no file (${nFiles} files)`);

  out(`ALL OK (${nOk} checks groups, ${S.calls()} fake Spotify calls in the main run)`);
  process.exit(0);
})().catch((e) => { out('FAIL ' + (e && e.stack || e)); out('--- last log lines:\n' + lines.slice(-25).join('\n')); process.exit(1); });
