'use strict';
// Stub Spotify for bridge-catalog.test.js: accounts (/api/token) + the Web API (/v1/...) on 127.0.0.1 (port 0 = any free
// port). Answers /me, /me/playlists, /me/tracks, /me/player (nothing playing), search, albums, artists, playlists/{id},
// POST /me/playlists; 429 or 401 on demand (st.fail = { status, retryAfter, n }). Counts every request and the most in
// flight at once. Every name and id it returns is made up.
const http = require('http');
const { id22 } = require('./engine-model');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const img = (w, k) => ({ url: `https://i.scdn.co/image/ab67616d0000${w === 640 ? 'b273' : w === 300 ? '1e02' : '4851'}${k.repeat(24).slice(0, 24)}`, width: w, height: w });

function startStubSpotify({ port = 0, me, model }) {
  const st = { total: 0, inflight: 0, maxInflight: 0, log: [], tokens: 0, fail: null, created: [], delay: 40 };
  const art = (n) => ({ id: id22('artist' + n), uri: 'spotify:artist:' + id22('artist' + n), name: n });
  const tr = (n, i, a = 'Barry White') => ({ uri: 'spotify:track:' + id22(n + i), name: `${n} ${i}`, artists: [art(a)], duration_ms: 1000 * (180 + i),
    explicit: i % 3 === 0, track_number: i + 1, disc_number: 1, album: { name: 'Can\'t Get Enough', uri: 'spotify:album:' + id22('album'), images: [img(640, 'c'), img(300, 'c'), img(64, 'c')] } });
  const routes = [
    ['GET', /^\/v1\/me$/, () => ({ id: me, display_name: 'Test User', product: 'premium' })],
    ['GET', /^\/v1\/me\/playlists$/, () => ({ items: model.playlists.filter((p) => p.owner_username === me || p.can_edit).map((p) => ({ id: p.uri.slice(17),
      images: p.image_url ? [{ url: p.image_url }] : [{ url: 'https://mosaic.scdn.co/640/ab67616d0000b273' + p.uri.slice(17).toLowerCase() }],
      owner: { id: p.owner_username, display_name: p.owner_username === me ? 'Test User' : 'Friend ' + p.owner_username.slice(0, 4) } })), next: null })],
    ['GET', /^\/v1\/me\/tracks$/, () => { const c = model.ctx(`spotify:user:${me}:collection`); return { total: c.entries.length, items: [{ track: { uri: c.entries[0].uri } }] }; }],
    ['GET', /^\/v1\/me\/player$/, () => null],
    ['GET', /^\/v1\/search$/, (u) => {
      const type = u.searchParams.get('type');
      const q = u.searchParams.get('q');
      if (type === 'track' && q.startsWith('artist:')) return { tracks: { total: 3, items: [tr('pop', 1), tr('pop', 2, 'Someone'), tr('pop', 3)] } };
      if (type === 'track') return { tracks: { total: 25, items: Array.from({ length: 10 }, (_, i) => tr('more', Number(u.searchParams.get('offset')) + i)) } };
      return { tracks: { total: 812, items: Array.from({ length: 10 }, (_, i) => tr('song', i)) }, artists: { items: [{ ...art('Barry White'), images: [] }, art('Barry Manilow')] },
        albums: { items: [{ uri: 'spotify:album:' + id22('album'), name: 'Can\'t Get Enough', release_date: '1974-08-01', album_type: 'album', artists: [art('Barry White')], images: [img(300, 'c')] }] },
        playlists: { items: [null, { uri: 'spotify:playlist:' + id22('barrymix'), name: 'Barry mix', images: [{ url: 'https://mosaic.scdn.co/640/abc' }], owner: { id: 'someone', display_name: 'Someone' } }] } };
    }],
    ['GET', new RegExp(`^/v1/albums/${id22('album')}$`), () => ({ uri: 'spotify:album:' + id22('album'), name: 'Can\'t Get Enough', album_type: 'album', release_date: '1974-08-01',
      artists: [art('Barry White')], images: [img(640, 'c'), img(300, 'c'), img(64, 'c')], copyrights: [{ type: 'P', text: '℗ 1974 20th Century Records' }],
      tracks: { total: 8, items: Array.from({ length: 8 }, (_, i) => { const t = tr('alb', i); delete t.album; return t; }) } })],
    ['GET', new RegExp(`^/v1/artists/${id22('artistBarry White')}$`), () => ({ ...art('Barry White'), images: [{ url: 'https://i.scdn.co/image/ab67616100005174' + 'd'.repeat(24), width: 320 }] })],
    ['GET', new RegExp(`^/v1/artists/${id22('artistBarry White')}/albums$`), () => ({ items: [
      { uri: 'spotify:album:' + id22('album'), name: 'Can\'t Get Enough', release_date: '1974-08-01', album_group: 'album', album_type: 'album', artists: [art('Barry White')], images: [img(300, 'c')] },
      { uri: 'spotify:album:' + id22('single'), name: 'A Single', release_date: '1975', album_group: 'single', album_type: 'single', artists: [art('Barry White')], images: [] }] })],
    ['GET', /^\/v1\/playlists\/[0-9A-Za-z]{22}$/, (u) => {
      if (u.pathname.endsWith(id22('barrymix'))) return { name: 'Barry mix', description: 'Smooth &amp; <b>soul</b>', images: [{ url: 'https://mosaic.scdn.co/640/abc' }], owner: { id: 'someone', display_name: 'Someone' } };
      return { status: 404 };
    }],
    ['POST', /^\/v1\/me\/playlists$/, (u, b) => {
      st.created.push(b);
      const id = id22('created' + b.name);
      model.addPlaylist({ uri: 'spotify:playlist:' + id, name: b.name, owner_username: me, length: 0, can_edit: true, revision: 'c0' });
      model.playlists.unshift(model.playlists.pop());
      return { id, uri: 'spotify:playlist:' + id, name: b.name, owner: { id: me, display_name: 'Test User' }, public: false };
    }],
  ];
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const u = new URL(req.url, 'http://x');
    const send = (status, obj, h = {}) => {
      const out = obj == null ? '' : JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json', ...h });
      res.end(out);
    };
    if (u.pathname === '/api/token') { st.tokens++; return send(200, { access_token: 'stub-token-' + st.tokens, token_type: 'Bearer', expires_in: 3600 }); }
    st.total++;
    st.inflight++;
    st.maxInflight = Math.max(st.maxInflight, st.inflight);
    st.log.push(`${req.method} ${u.pathname}`);
    try {
      await sleep(st.delay);                                 // so overlapping requests overlap
      if (st.fail && st.fail.n > 0) {
        st.fail.n--;
        return send(st.fail.status, { error: { status: st.fail.status, message: 'stub says ' + st.fail.status } }, st.fail.retryAfter ? { 'Retry-After': String(st.fail.retryAfter) } : {});
      }
      for (const [m, re, fn] of routes) {
        if (m !== req.method || !re.test(u.pathname)) continue;
        const out = fn(u, raw ? JSON.parse(raw) : null);
        if (out && out.status === 404) return send(404, { error: { status: 404, message: 'Resource not found' } });
        return out == null ? (res.writeHead(204), res.end()) : send(200, out);
      }
      return send(404, { error: { status: 404, message: 'no stub route' } });
    } finally {
      st.inflight--;
    }
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, st })));
}

module.exports = { startStubSpotify };
