'use strict';
// Home, Your Library's albums / artists / recently played, and your profile (gateway 0.7, app 0.7 "Drop 2"). Everything
// comes from the Web API's /me routes, which dev mode keeps (recently-played, top artists/tracks, saved albums, followed
// artists, /me; see probes/webapi/webapi-report.md). Spotify's own Home feed and Browse/New Releases are gone, so Home is
// built from your own listening.
// Each "part" (one Spotify read, or a few) is kept in memory and on disk with its own lifetime; a request waits at most
// 2.5 s for a refetch when it has an older copy to answer with (the refetch finishes in the background).
// Saving albums (0.9, DESIGN-0.9.md §1): Spotify's generic library routes (PUT/DELETE /me/library, GET
// /me/library/contains; the album routes are gone for dev-mode apps), states kept 60 s per album.
const path = require('path');
const log = require('./log');
const { t } = require('./i18n');
const { JsonCache } = require('./jsoncache');
const { tokenFor } = require('./image');
const { memo, clean, pickImg, webRow, alRow, arRow } = require('./catalog');

const TIMING = {
  recentTtl: 120000,         // recently played
  topTtl: 6 * 3600000,       // top artists / tracks (Spotify recomputes them about daily)
  meTtl: 6 * 3600000,
  releasesTtl: 12 * 3600000,
  savedTtl: 1800000,         // saved albums, followed artists
  artistTtl: 7 * 86400000,   // an artist's picture for a Jump back in tile
  freshGap: 30000,           // pull to refresh refetches a part at most this often
  waitMs: 2500,              // a request with an older copy at hand waits this long for the refetch
  releaseDays: 120,
  playedSaveMs: 10000,       // the engine's play log is written this long after a change (one write per burst)
  albumStateTtl: 60000,      // an album's saved state from contains / a save is good for this long
  albumStateMax: 2000,
};

const ID = /^[0-9A-Za-z]{22}$/;
const ALBUM_URI = /^spotify:album:[0-9A-Za-z]{22}$/;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LATE = Symbol('late');

class Personal {
  constructor({ cfg, webapi, catalog, engine, bus, player, timing }) {
    Object.assign(this, { webapi, catalog, bus: bus || null, player: player || null });
    this.T = { ...TIMING, ...timing };
    this.store = new JsonCache(path.join(cfg.cacheDir, 'personal'), { p: { mem: 20, keep: 0 }, a: { mem: 50, keep: 200 } });
    this.parts = new Map();        // name -> { at, data }
    this.flights = new Map();      // name -> Promise
    this.gens = new Map();         // name -> how often it was dropped (a refetch running across a drop doesn't store)
    this.albumStates = new Map();  // album uri -> { s, at, w } (w: set by a save)
    this.albumChain = Promise.resolve();   // saves, one after another
    this.artistMiss = new Map();   // artist id -> no /artists/{id} before this (it failed lately)
    // What Encore's engine itself played, newest first ({ u, k, at, al? }), and since when it has been logging.
    const pl = this.store.getSync('p', 'played');
    this.played = pl && Array.isArray(pl.items) ? pl.items : [];
    this.playedSince = (pl && pl.since) || 0;
    this.playedTimer = null;
    if (engine) engine.on('event', (type, d) => this.noteEngine(type, d));
  }

  // ------------------------------------------------------------------ what Encore played
  // Spotify's recently-played leaves the context out of plays made through Encore's engine (seen live 2026-10-06: 42 of
  // 50 had none), so Jump back in would only see each song's album. The engine names its context with every song, but
  // not in 'metadata' (an ApiTrack: no context_uri): the player's context for this song (player.js songContext, which
  // has already run: the player is made first, so its engine listener comes first).
  noteEngine(type, d) {
    if (type !== 'metadata' || !d) return;
    const u = String(d.context_uri || (this.player && this.player.st && this.player.st.context_uri) || '');
    const alu = typeof d.album_uri === 'string' && /^spotify:album:[0-9A-Za-z]{22}$/.test(d.album_uri) ? d.album_uri : '';
    let k = null;
    let uri = u;
    if (/^spotify:playlist:[0-9A-Za-z]{22}$/.test(u)) k = 'playlist';
    else if (/^spotify:album:[0-9A-Za-z]{22}$/.test(u)) k = 'album';
    else if (/^spotify:artist:[0-9A-Za-z]{22}$/.test(u)) k = 'artist';
    else if (/^spotify:user:[^:]+:collection$/.test(u)) k = 'liked';
    else if ((!u || /^spotify:track:/.test(u)) && alu) { k = 'album'; uri = alu; }      // one song on its own: its album
    if (!k) return;                                                                   // a Jam, a radio station
    const e = { u: uri, k, at: Date.now() };
    if (k === 'album' && uri === alu) {
      e.al = clean({ u: alu, n: d.album_name, i: tokenFor(d.album_cover_url) || undefined,
        ar: (d.artist_names || [])[0], aru: (d.artist_uris || [])[0] });
    }
    this.played = [e, ...this.played.filter((x) => x.u !== uri)].slice(0, 30);
    if (!this.playedSince) this.playedSince = e.at;
    if (!this.playedTimer) {
      this.playedTimer = setTimeout(() => {
        this.playedTimer = null;
        this.store.put('p', 'played', { since: this.playedSince, items: this.played });
      }, this.T.playedSaveMs);
      this.playedTimer.unref();
    }
  }

  // ------------------------------------------------------------------ parts
  // -> { data, stale }. fresh: pull to refresh. A failed refetch answers with the old copy (stale) when there is one.
  // A copy made for another Spotify account, or one `valid` turns down, counts as none.
  async part(name, ttl, fresh, fetch, valid) {
    const uid = this.uid();
    let c = this.parts.get(name);
    if (!c) {
      c = await this.store.get('p', name);
      if (c) this.parts.set(name, c);
    }
    if (c && ((c.uid && uid && c.uid !== uid) || (valid && !valid(c.data)))) c = null;
    const age = c ? Date.now() - c.at : Infinity;
    if (c && age < ttl && !(fresh && age > this.T.freshGap)) return { data: c.data, stale: false };
    let f = this.flights.get(name);
    if (!f) {
      const gen = this.gens.get(name) || 0;
      f = (async () => {
        const data = await fetch();
        if ((this.gens.get(name) || 0) !== gen) return data;          // dropped meanwhile (a write): not stored
        const n = { at: Date.now(), data, uid: this.uid() || undefined };
        this.parts.set(name, n);
        this.store.put('p', name, n);
        return data;
      })().finally(() => { if (this.flights.get(name) === f) this.flights.delete(name); });
      this.flights.set(name, f);
    }
    try {
      const data = await (c ? Promise.race([f, sleep(this.T.waitMs).then(() => LATE)]) : f);
      if (data === LATE) {
        f.catch((e) => log.warn(`${name}:`, e.message));
        return { data: c.data, stale: false };          // a little old, not wrong: no banner
      }
      return { data, stale: false };
    } catch (e) {
      if (c) return { data: c.data, stale: true };
      throw e;
    }
  }

  // Forget a part (memory and disk) after a write changed it: the next request refetches it, and a refetch already
  // running doesn't store its older answer.
  drop(name) {
    this.gens.set(name, (this.gens.get(name) || 0) + 1);
    this.parts.delete(name);
    this.flights.delete(name);
    return this.store.del('p', name);
  }

  uid() { return (this.webapi.user && this.webapi.user.id) || ''; }

  recent(fresh) {
    return this.part('recent', this.T.recentTtl, fresh, async () => {
      const j = await this.webapi.api('GET', '/me/player/recently-played?limit=50');
      const out = [];
      for (const it of (j && j.items) || []) {
        const t = it && it.track;
        if (!t || typeof t.uri !== 'string' || !t.uri.startsWith('spotify:track:')) continue;
        const ctx = it.context || {};
        out.push(clean({ t: webRow(t), pa: Date.parse(it.played_at) || undefined, cu: typeof ctx.uri === 'string' ? ctx.uri : undefined,
          ct: ctx.type, al: t.album && t.album.uri ? alRow(t.album) : undefined }));
      }
      return out;
    });
  }

  top(fresh) {
    return this.part('top', this.T.topTtl, fresh, async () => {
      const [a, t] = await Promise.all([
        this.webapi.api('GET', '/me/top/artists?limit=10&time_range=short_term'),
        this.webapi.api('GET', '/me/top/tracks?limit=10&time_range=short_term'),
      ]);
      return {
        artists: ((a && a.items) || []).filter((x) => x && x.uri).map(arRow),
        tracks: ((t && t.items) || []).filter((x) => x && typeof x.uri === 'string' && x.uri.startsWith('spotify:track:')).map((x) => webRow(x)),
      };
    });
  }

  me(fresh) {
    return this.part('me', this.T.meTtl, fresh, async () => {
      const j = await this.webapi.api('GET', '/me');
      if (!j || !j.id) throw Object.assign(new Error(t('en', 'Spotify sent no profile.')), { status: 502, code: 'spotify_error' });
      const fol = j.followers && Number.isFinite(j.followers.total) ? j.followers.total : undefined;
      // the biggest picture: the phone shows it at 96 pt (the 216 tier)
      const imgs = Array.isArray(j.images) ? j.images.filter((x) => x && x.url).sort((p, q) => (q.width || 0) - (p.width || 0)) : [];
      return clean({ id: j.id, n: j.display_name || j.id, i: tokenFor(imgs[0] && imgs[0].url), fol });
    });
  }

  // New releases from your top artists (Browse's New Releases is gone): their singles and albums from the last 120 days.
  // Singles and albums are asked for separately (one combined call of 10 never reaches the singles of an artist with 10+
  // albums): singles for the top 6, albums (5) for the top 3 — 9 calls every 12 h. A failed call (not 404/403) keeps the
  // old copy instead of storing a partial list for 12 h. The copy is for one artist list.
  releases(artists, fresh) {
    const ids = artists.map((a) => String(a.u || '').slice(15)).filter((id) => ID.test(id)).slice(0, 6);
    const key = ids.join(',');
    return this.part('releases', this.T.releasesTtl, fresh, async () => {
      const cutoff = new Date(Date.now() - this.T.releaseDays * 86400000).toISOString().slice(0, 10);
      const seen = new Set();
      const all = [];
      let failed = 0;
      const calls = [];
      ids.forEach((id, i) => {
        calls.push(`/artists/${id}/albums?include_groups=single&limit=10`);
        if (i < 3) calls.push(`/artists/${id}/albums?include_groups=album&limit=5`);
      });
      for (const c of calls) {
        let j;
        try { j = await this.webapi.api('GET', c); }
        catch (e) {
          if (e.status === 429 || e.code === 'rate_limited') throw e;
          if (e.status !== 404 && e.status !== 403) failed++;
          continue;
        }
        for (const x of (j && j.items) || []) {
          if (!x || !x.uri || String(x.release_date || '') < cutoff) continue;
          const k = `${String(x.name || '').toLowerCase()}|${((x.artists || [])[0] || {}).id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          all.push({ rd: String(x.release_date), row: alRow(x) });
        }
      }
      if (failed) throw Object.assign(new Error(`new releases: ${failed} of ${calls.length} calls failed`), { status: 502, code: 'spotify_error' });
      return { ids: key, items: all.sort((p, q) => q.rd.localeCompare(p.rd)).slice(0, 10).map((x) => ({ ...x.row, rd: x.rd })) };
    }, (d) => d && d.ids === key && Array.isArray(d.items));
  }

  // GET /me/following?type=artist&limit=1: only the total (the profile's Following), when the full list isn't at hand.
  following(fresh) {
    return this.part('following', this.T.savedTtl, fresh, async () => {
      const j = await this.webapi.api('GET', '/me/following?type=artist&limit=1');
      const t = j && j.artists && Number(j.artists.total);
      return { total: Number.isFinite(t) && t >= 0 ? t : 0 };
    });
  }

  albums(fresh) {
    return this.part('albums', this.T.savedTtl, fresh, async () => {
      const items = [];
      let total = 0;
      for (let off = 0; off < 1000; off += 50) {
        const j = await this.webapi.api('GET', `/me/albums?limit=50&offset=${off}`);
        total = (j && Number(j.total)) || 0;
        const page = ((j && j.items) || []).filter((x) => x && x.album && x.album.uri);
        for (const x of page) items.push(alRow(x.album));
        if (!j || !j.next || !page.length) break;
      }
      return { total: Math.max(total, items.length), items };
    });
  }

  artists(fresh) {
    return this.part('artists', this.T.savedTtl, fresh, async () => {
      const items = [];
      let total = 0;
      let after = '';
      for (let page = 0; page < 20; page++) {
        const j = await this.webapi.api('GET', `/me/following?type=artist&limit=50${after ? '&after=' + encodeURIComponent(after) : ''}`);
        const a = (j && j.artists) || {};
        total = Number(a.total) || 0;
        const got = (a.items || []).filter((x) => x && x.uri);
        items.push(...got.map(arRow));
        after = a.cursors && a.cursors.after;
        if (!a.next || !after || !got.length) break;
      }
      items.sort((p, q) => String(p.n || '').localeCompare(String(q.n || ''), 'en', { sensitivity: 'base' }));
      return { total: Math.max(total, items.length), items };
    });
  }

  // ------------------------------------------------------------------ saved albums (0.9)
  checkAlbums(a) {
    if (!Array.isArray(a) || a.length < 1 || a.length > 40) throw fail(400, 'bad_request', t('en', 'Send 1 to 40 album uris.'));
    for (const u of a) if (typeof u !== 'string' || !ALBUM_URI.test(u)) throw fail(400, 'bad_request', t('en', 'Only albums (spotify:album:…) can be saved here.'));
    return [...new Set(a)];
  }

  setAlbumState(uri, s, w) {
    this.albumStates.delete(uri);
    this.albumStates.set(uri, { s, at: Date.now(), w: w ? 1 : 0 });
    while (this.albumStates.size > this.T.albumStateMax) this.albumStates.delete(this.albumStates.keys().next().value);
  }

  // GET /v1/me/albums/contains?uris=…: {items: {uri: 1|0}}; only the states not known for 60 s go to Spotify. A save
  // that landed while Spotify was asked is newer than its answer (which may predate it): the save's state stays.
  async albumsContain(urisRaw) {
    this.catalog.simCheck();
    const uris = this.checkAlbums(String(urisRaw || '').split(',').filter(Boolean));
    const out = {};
    const ask = [];
    for (const u of uris) {
      const e = this.albumStates.get(u);
      if (e && Date.now() - e.at < this.T.albumStateTtl) out[u] = e.s; else ask.push(u);
    }
    if (ask.length) {
      const t0 = Date.now();
      const j = await this.webapi.api('GET', '/me/library/contains?uris=' + ask.map(encodeURIComponent).join(','));
      if (!Array.isArray(j) || j.length !== ask.length) throw fail(502, 'spotify_error', t('en', 'Spotify sent no library states.'));
      ask.forEach((u, i) => {
        const e = this.albumStates.get(u);
        if (e && e.w && e.at >= t0) { out[u] = e.s; return; }
        out[u] = j[i] ? 1 : 0;
        this.setAlbumState(u, out[u]);
      });
    }
    const items = {};
    for (const u of uris) items[u] = out[u];
    return memo({ items });
  }

  // POST /v1/me/albums {uris, saved}: PUT/DELETE /me/library. The saved albums list is read again next time, and the
  // phones are told (Library refreshes). One save at a time, in the order they came (a quick save + unsave would
  // otherwise race at Spotify, and the state of whichever answered last would be kept).
  async saveAlbums(b) {
    this.catalog.simCheck();
    if (!b || typeof b.saved !== 'boolean') throw fail(400, 'bad_request', 'saved must be true or false.');
    const uris = this.checkAlbums(b.uris);
    const job = this.albumChain.then(() => this.saveAlbumsNow(uris, b.saved));
    this.albumChain = job.catch(() => {});
    return job;
  }

  async saveAlbumsNow(uris, saved) {
    await this.webapi.api(saved ? 'PUT' : 'DELETE', '/me/library?uris=' + uris.map(encodeURIComponent).join(','));
    const s = saved ? 1 : 0;
    const items = {};
    for (const u of uris) { this.setAlbumState(u, s, true); items[u] = s; }
    await this.drop('albums');
    if (this.bus) this.bus.push('albums', {});
    return { items };
  }

  // An artist's row (picture) for a Jump back in tile, without Spotify: our own 7-day copy, else the catalog's artist page.
  // undefined = not at hand (fetchArtist would ask Spotify); null = asked lately and failed (not again for 2 min).
  async cachedArtist(id) {
    const c = await this.store.get('a', id);
    if (c && Date.now() - c.at < this.T.artistTtl) return c.row;
    const page = this.catalog.store.peek('artist', id);
    if (page && page.body && page.body.a) return page.body.a;
    const miss = this.artistMiss.get(id);
    if (miss && Date.now() < miss) return c ? c.row : null;
    return undefined;
  }

  async fetchArtist(id) {
    try {
      const j = await this.webapi.api('GET', `/artists/${id}`);
      if (j && j.uri) {
        const row = arRow(j);
        this.store.put('a', id, { at: Date.now(), row });
        return row;
      }
    } catch (e) { /* below */ }
    this.artistMiss.set(id, Date.now() + 120000);
    if (this.artistMiss.size > 200) this.artistMiss.delete(this.artistMiss.keys().next().value);
    const c = await this.store.get('a', id);
    return c ? c.row : null;
  }

  // ------------------------------------------------------------------ the routes
  libraryRows() { return (this.catalog.build && this.catalog.build.obj && this.catalog.build.obj.items) || []; }
  libraryPl(uri) { const e = this.catalog.build && this.catalog.build.byId.get(String(uri).slice(17)); return e ? e.pl : null; }

  // Jump back in: the places your recent plays came from, newest first (playlists, albums, artists, Liked Songs): what
  // Encore's engine logged, merged with Spotify's history (plays on your other devices). A play without a context after
  // the engine log began is an Encore play the log already holds: it doesn't add its album.
  async jump(recent, top) {
    const me = this.catalog.username();
    const since = this.playedSince || Infinity;
    const cands = this.played.map((p) => ({ at: p.at, uri: p.u, k: p.k, al: p.al }));
    for (const r of recent) {
      const at = r.pa || 0;
      if (r.cu && ['playlist', 'album', 'artist', 'collection'].includes(r.ct)) {
        cands.push({ at, uri: r.cu, k: r.ct === 'collection' ? 'liked' : r.ct, al: r.al && r.al.u === r.cu ? r.al : undefined });
      } else if (at < since && r.al && r.al.u) cands.push({ at, uri: r.al.u, k: 'album', al: r.al });
    }
    cands.sort((p, q) => q.at - p.at);
    // slots in order; a slot is a tile, or a lookup still running (tile null until it answers)
    const slots = [];
    const seen = new Set();
    const waits = [];
    let lookups = 0;
    for (const { uri, k, al } of cands) {
      if (slots.length >= 14) break;                                 // a few spare: some lookups find nothing
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      if (k === 'liked') {
        if (/^spotify:user:[^:]+:collection$/.test(uri)) slots.push({ tile: clean({ k: 'liked', n: 'Liked Songs', len: this.catalog.likedCount() }) });
      } else if (k === 'playlist') {
        const id = uri.slice(17);
        if (!/^spotify:playlist:/.test(uri) || !ID.test(id)) continue;
        const pl = this.libraryPl(uri);
        if (pl) { slots.push({ tile: { k: 'playlist', o: pl } }); continue; }
        const hc = this.catalog.headers.get(uri);                     // a header we already have (or know is gone)
        if (hc && Date.now() < hc.exp) { if (hc.h && hc.h.n) slots.push({ tile: { k: 'playlist', o: hc.h } }); continue; }
        if (lookups >= 4) continue;
        lookups++;
        const slot = { tile: null };
        slots.push(slot);
        waits.push(this.catalog.webHeader(id).then((h) => { if (h && h.n) slot.tile = { k: 'playlist', o: h }; }, () => {}));
      } else if (k === 'album') {
        if (al && al.u === uri && al.n) slots.push({ tile: { k: 'album', o: al } });
      } else if (k === 'artist') {
        const id = uri.slice(15);
        if (!ID.test(id)) continue;
        let ar = top.artists.find((a) => a.u === uri);
        if (!ar) ar = await this.cachedArtist(id);
        if (ar) slots.push({ tile: { k: 'artist', o: ar } });
        else if (ar === undefined && lookups < 4) {
          lookups++;
          const slot = { tile: null };
          slots.push(slot);
          waits.push(this.fetchArtist(id).then((row) => { if (row) slot.tile = { k: 'artist', o: row }; }, () => {}));
        }
      }
    }
    // the lookups run together; whatever hasn't answered after waitMs is left out (it still fills the caches)
    if (waits.length) await Promise.race([Promise.all(waits), sleep(this.T.waitMs)]);
    const tiles = slots.map((x) => x.tile).filter(Boolean).slice(0, 10);
    if (me && !tiles.length && this.libraryRows().length) {          // nothing played lately: your first playlists
      for (const pl of this.libraryRows().slice(0, 6)) tiles.push({ k: 'playlist', o: pl });
    }
    return tiles;
  }

  async home(fresh) {
    this.catalog.simCheck();
    const [rc, tp, me] = await Promise.all([this.recent(fresh), this.top(fresh), this.me(false).catch(() => null)]);
    let rel = { data: { items: [] }, stale: false };
    try { rel = await this.releases(tp.data.artists, fresh); } catch (e) { log.warn('home releases:', e.message); }
    const made = this.libraryRows().filter((pl) => pl.mf).slice(0, 10);
    const obj = { me: me ? clean({ n: me.data.n, i: me.data.i }) : undefined,
      jump: await this.jump(rc.data, tp.data), made, artists: tp.data.artists, releases: rel.data.items, top: tp.data.tracks };
    if (rc.stale || tp.stale) obj.stale = 1;
    return memo(clean(obj));
  }

  async recentList(fresh) {
    this.catalog.simCheck();
    const rc = await this.recent(fresh);
    const obj = { items: rc.data.map((r) => ({ ...r.t, pa: r.pa })) };
    if (rc.stale) obj.stale = 1;
    return memo(obj);
  }

  async albumList(fresh) {
    this.catalog.simCheck();
    const r = await this.albums(fresh);
    return memo(r.stale ? { ...r.data, stale: 1 } : r.data);
  }

  async artistList(fresh) {
    this.catalog.simCheck();
    const r = await this.artists(fresh);
    return memo(r.stale ? { ...r.data, stale: 1 } : r.data);
  }

  // Your profile: name, picture, followers (when Spotify still sends them), following, top artists / tracks this month,
  // and your PUBLIC playlists, as other people see your profile on Spotify (by design; the Playlists tab
  // and Library still show everything): only the ones the library merge (/me/playlists) confirmed public.
  async profile(fresh) {
    this.catalog.simCheck();
    this.catalog.mergeMaybe();
    const fa = this.parts.get('artists');
    const listFresh = fa && Date.now() - fa.at < this.T.savedTtl && (!fa.uid || fa.uid === this.uid());
    const [me, tp, fol] = await Promise.all([this.me(fresh), this.top(fresh),
      listFresh ? Promise.resolve({ data: { total: fa.data.total } }) : this.following(fresh).catch(() => null)]);
    const webpl = (this.catalog.webpl && this.catalog.webpl.map) || {};
    const playlists = this.libraryRows().filter((pl) => { const w = webpl[pl.u.slice(17)]; return pl.own && w && w.pub === 1; });
    const obj = { me: clean({ u: `spotify:user:${me.data.id}`, n: me.data.n, i: me.data.i, fol: me.data.fol, fing: fol ? fol.data.total : undefined }),
      artists: tp.data.artists, top: tp.data.tracks, playlists };
    if (me.stale || tp.stale) obj.stale = 1;
    return memo(obj);
  }

  info() {
    const parts = {};
    for (const [k, v] of this.parts) parts[k] = { age_s: Math.round((Date.now() - v.at) / 1000) };
    return { parts, flights: [...this.flights.keys()], played: this.played.length, played_since: this.playedSince, album_states: this.albumStates.size };
  }
}

module.exports = { Personal, TIMING };
