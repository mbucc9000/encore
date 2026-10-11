'use strict';
// The real bridge (src/main.js, started as a child process) against the stub engine (support/stub-engine.js: the
// patch-2 engine model + /events) and the stub Spotify accounts + Web API (support/stub-spotify.js), all on 127.0.0.1
// with free ports: it needs no network. DATA_DIR and PCM_FIFO are in a temporary folder; the refresh token is fake.
// Every /v1 request is HMAC-signed like the phone's (auth.js). About 1.5 minutes.
// Needs a POSIX FIFO (Linux, macOS) and ffmpeg on PATH; skipped otherwise.
//   node gateway/test/bridge-catalog.test.js        (LIVE=1 also prints the bridge's log)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { EngineModel, id22 } = require('./support/engine-model');
const { startStubEngine } = require('./support/stub-engine');
const { startStubSpotify } = require('./support/stub-spotify');
const { needs, freePort, ffmpeg } = require('./support/platform');
const { version } = require('../src/config');

const SKIP = needs({ fifo: true, ffmpeg: true });
const MAIN = path.join(__dirname, '..', 'src', 'main.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'testuser';
let PORT = 0;                                                  // the bridge's, picked at start
let ROOT = '';                                                 // a temporary folder, made at start
const SECRET = crypto.randomBytes(32).toString('base64');

// ---------------------------------------------------------------- signed requests, like the phone
function req(method, pathq, { body, etag, gzip, sign = true, auth } = {}) {
  return new Promise((resolve, reject) => {
    const b = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const headers = {};
    if (sign) {
      const t = String(Math.floor(Date.now() / 1000));
      const h = crypto.createHash('sha256').update(b).digest('hex');
      headers['X-Encore-Device'] = 'dev_test';
      headers['X-Encore-Time'] = t;
      headers['X-Encore-Sig'] = crypto.createHmac('sha256', Buffer.from(SECRET, 'base64')).update(`${method}\n${pathq}\n${t}\n${h}`).digest('hex');
    }
    if (auth) headers.Authorization = 'Basic ' + Buffer.from('x:pw').toString('base64');
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = b.length; }
    if (etag) headers['If-None-Match'] = etag;
    if (gzip) headers['Accept-Encoding'] = 'gzip';
    const t0 = Date.now();
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: pathq, headers }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(parts);
        const text = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString() : raw.toString();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw, json, ms: Date.now() - t0 });
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => { r.destroy(new Error(`${method} ${pathq.split('?')[0]}: no answer in 20 s`)); });
    r.end(b);
  });
}

// poll a list like the app: again after retry_ms until done (gives up after 40 tries)
async function pollList(pathq, onEach) {
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', pathq, { gzip: true });
    if (onEach) onEach(r, i);
    seen.push(r.json);
    if (r.status !== 200 || r.json.done) return { seen, last: r };
    await sleep(r.json.retry_ms);
  }
  return { seen, last: null };
}

async function main() {
  // ---------------------------------------------------------------- the stubs
  const model = new EngineModel({ username: ME, enumMs: 1500, batchMs: 300, relink: true });
  const P = (name, o) => {
    const uri = 'spotify:playlist:' + id22('pl' + name);
    model.addPlaylist({ uri, name, owner_username: ME, length: 0, can_edit: true, revision: '', ...o });
    return uri;
  };
  const tracks = (tag, n) => Array.from({ length: n }, (_, i) => ({ uri: 'spotify:track:' + id22(tag + i), meta: 'ok', n: i, explicit: i % 7 === 0 }));
  const car = P('drive drive drive', { length: 9, revision: 'a1', image_url: 'https://i.scdn.co/image/ab67706c0000da84' + 'a'.repeat(24) });
  const quiet = P('Quiet', { length: 480, revision: 'b1' });
  const fam = P('Band Practice', { owner_username: 'famowner', length: 20, revision: 'c1', image_url: 'https://i.scdn.co/image/ab67706c0000da84' + 'b'.repeat(24) });
  const love = P('slow sunday', { owner_username: 'someone.else', length: 10, can_edit: false, revision: 'd1' });
  const dw = P('Discover Weekly', { owner_username: 'spotify', length: 30, can_edit: false, revision: 'e1', image_url: 'https://pickasso.spotifycdn.com/image/ab67c0de0000deef/dt/v1/img/dw/cover/en' });
  P('', { owner_username: 'spotify', length: 0, can_edit: false });
  P('DJ', { owner_username: 'spotify', length: 0, can_edit: false, image_url: 'https://lexicon-assets.spotifycdn.com/DJ-Beta-CoverArt-300.jpg' });
  for (let i = 0; i < 40; i++) P('Mix ' + i, { length: 10 + i, revision: 'f' + i, image_url: i % 2 ? 'https://i.scdn.co/image/ab67706c0000da84' + crypto.createHash('sha1').update('m' + i).digest('hex').slice(0, 24) : null });
  model.addContext(car, tracks('car', 9), { revision: 'a1' });
  const qt = tracks('quiet', 480);
  qt[100].meta = 'never';                                     // B1: never arrives, never reported failed
  const qc = model.addContext(quiet, qt, { revision: 'b1', enumMs: 3000 });   // longer than one phone request's 2 s
  const famTracks = tracks('fam', 20);
  const fc = model.addContext(fam, famTracks, { revision: 'c1' });
  model.addContext(dw, tracks('dw', 30), { revision: 'e1' });
  model.addContext('spotify:playlist:' + id22('barrymix'), tracks('bm', 5), { revision: 'z1' });
  const broken = 'spotify:playlist:' + id22('broken');       // outside the library: its first enumeration fails (500 for 30 s)
  const bc = model.addContext(broken, tracks('broken', 12), { revision: 'h1', enumMs: 3000, failEnum: 1, enumHoldMs: 30000 });
  const likedCtx = `spotify:user:${ME}:collection`;
  const lc = model.addContext(likedCtx, tracks('liked', 40), {});
  for (const e of lc.entries) model.liked.add(e.uri);
  const { srv: engineSrv } = await startStubEngine(model, 0);
  const { srv: spotifySrv, st: sp } = await startStubSpotify({ port: 0, me: ME, model });
  const ENGINE = `http://127.0.0.1:${engineSrv.address().port}`;
  const SPOTIFY = `http://127.0.0.1:${spotifySrv.address().port}`;
  PORT = await freePort();

  // ---------------------------------------------------------------- the gateway (real main.js)
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-bridge-catalog-'));
  fs.mkdirSync(ROOT + '/data', { recursive: true });
  fs.writeFileSync(ROOT + '/data/devices.json', JSON.stringify({ dev_test: { name: 'Test iPhone', secret: SECRET, created: new Date().toISOString(), last_seen: null } }));
  fs.writeFileSync(ROOT + '/data/tokens.json', JSON.stringify({ refresh_token: 'fake-refresh', user: { id: ME, name: 'Test User' } }), { mode: 0o600 });
  const gw = spawn(process.execPath, [MAIN], { env: { ...process.env, PORT: String(PORT), DATA_DIR: ROOT + '/data', PCM_FIFO: ROOT + '/pipe/encore.pcm',
    ENGINE_URL: ENGINE, SPOTIFY_API_BASE: SPOTIFY + '/v1', SPOTIFY_ACCOUNTS_BASE: SPOTIFY, FFMPEG: ffmpeg,
    SPOTIFY_CLIENT_ID: 'stub-client', ADMIN_PASSWORD: 'pw', ADMIN_ALLOW: '', ADMIN_TRUST_PROXY: '',
    UPDATE_CHECK: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });     // (no automatic update check in a test)
  let out = '';
  const live = process.env.LIVE === '1';
  gw.stdout.on('data', (d) => { out += d; if (live) process.stdout.write('  gw| ' + d); });
  gw.stderr.on('data', (d) => { out += d; if (live) process.stdout.write('  gw| ' + d); });
  for (let i = 0; i < 50 && !/listening on/.test(out); i++) await sleep(100);
  await sleep(500);
  ok(out.includes(`Encore Bridge ${version} starting`), `the bridge ${version} started`);

  try {
    // ---------------------------------------------------------------- status, signatures
    let r = await req('GET', '/v1/status');
    ok(r.status === 200 && r.json.gateway.version === version, `/v1/status 200, version ${version}`);
    ok(r.json.catalog && ['listing', 'calls', 'engine_est', 'liked_order'].every((k) => k in r.json.catalog), `/v1/status catalog counters ${JSON.stringify(r.json.catalog)}`);
    ok(r.json.catalog.listing === 'on' && !model.log.some((x) => x.path.startsWith('/context/tracks') && !x.path.includes('spotify%3Asearch%3Aencore')),
      `catalog.listing "${r.json.catalog.listing}" before any list was asked for (the probe when the engine's events connected)`);
    r = await req('GET', '/v1/playlists', { sign: false });
    ok(r.status === 401 && r.json.error.code === 'bad_signature', 'unsigned: 401 bad_signature');

    // ---------------------------------------------------------------- the library root: shape, gzip, 304
    r = await req('GET', '/v1/playlists', { gzip: true });
    const lib = r.json;
    ok(r.status === 200 && r.headers['content-encoding'] === 'gzip', `GET /v1/playlists gzipped (${r.raw.length} B on the wire)`);
    ok(r.headers['content-type'] === 'application/json; charset=utf-8' && r.headers['cache-control'] === 'private, no-cache' && /^"[0-9a-f]{20}"$/.test(r.headers.etag), 'JSON headers + ETag');
    ok(lib.me.id === ME && lib.me.n === 'Test User' && lib.liked.ctx === likedCtx, 'me + liked.ctx');
    ok(lib.items.length === 45 && !lib.items.some((x) => x.n === '' || x.n === 'DJ'), `45 rows, junk hidden (${lib.items.length})`);
    const famRow = lib.items.find((x) => x.u === fam);
    ok(famRow.ed === 1 && famRow.c === 1 && !famRow.own, 'Band Practice: ed + c');
    ok(!lib.items.find((x) => x.u === love).ed, 'slow sunday: not editable');
    ok(lib.items.find((x) => x.u === dw).mf === 1 && lib.items.find((x) => x.u === dw).o === 'Spotify', 'Discover Weekly: mf, by Spotify');
    ok(lib.items.find((x) => x.u === car).i === 'ab67706c0000da84' + 'a'.repeat(24) && lib.items.find((x) => x.u === car).v === 'a1', 'drive drive drive: image token + revision');
    const etag = r.headers.etag;
    r = await req('GET', '/v1/playlists');
    ok(r.status === 200 && !r.headers['content-encoding'] && r.headers.etag === etag && JSON.parse(r.raw.toString()).items.length === 45, 'without Accept-Encoding: plain, same ETag');
    r = await req('GET', '/v1/playlists', { etag, gzip: true });
    ok(r.status === 304 && r.raw.length === 0, 'If-None-Match: 304, no body');
    await sleep(300);
    r = await req('GET', '/v1/playlists', { gzip: true });
    const noPic = r.json.items.filter((x) => !x.i).map((x) => x.n);
    ok(lib.items.filter((x) => !x.i).length === 22 && noPic.join() === 'slow sunday', `after the merge only "slow sunday" lacks a cover (before: ${lib.items.filter((x) => !x.i).length}, after: ${noPic.join()})`);

    // ---------------------------------------------------------------- a list whose enumeration fails (the engine answers 500 for 30 s)
    const bPath = '/v1/playlists/' + broken.slice(17);
    const bCalls = () => model.log.filter((x) => x.path.startsWith('/context/tracks') && x.path.includes(encodeURIComponent(broken))).length;
    const b1 = await pollList(bPath);
    const tb = Date.now();
    const be = (b1.last && b1.last.json && b1.last.json.error) || {};
    ok(b1.seen[0].wait === 1 && b1.last.status === 502 && be.code === 'engine_error' && be.retry_after === 30 && bc.n.held500 === 1,
      `an enumeration that fails: wait:1, then ${b1.last && b1.last.status} ${be.code} with retry_after ${be.retry_after} (the engine answered 500 ${bc.n.held500}x)`);
    const nb = bCalls();
    r = await req('GET', bPath);
    ok(r.status === 502 && r.json.error.code === 'engine_error' && r.json.error.retry_after <= 30 && bCalls() === nb, `asked again during the hold: ${r.status} at once, nothing to the engine (retry_after ${r.json.error.retry_after})`);

    // ---------------------------------------------------------------- song lists, polled like the app
    const before = { ...qc.n };
    const roots0 = model.counts.rootlist;
    const tq0 = Date.now();
    const perReq = [];
    const q = await pollList('/v1/playlists/' + quiet.slice(17), () => { perReq.push(qc.n.summaries); });
    const counts = perReq.map((n, i) => n - (i ? perReq[i - 1] : before.summaries));
    const kinds = q.seen.map((x) => (x.done ? 'done' : x.wait ? 'wait' : 'partial'));
    console.log('     Quiet answers:', kinds.join(' -> '), '| summary polls per request:', counts.join(','));
    ok(counts[0] >= 1, `Quiet's first request polled the engine: the failed list holds no enumeration slot (${counts[0]} summaries)`);
    ok(kinds[0] === 'wait' && q.seen[0].len === 480 && q.seen[0].items.length === 0, 'first answer: wait:1 with the rootlist len');
    ok(kinds.includes('partial') && q.seen.filter((x) => !x.done && !x.wait).every((x) => x.items.length <= 100 && x.retry_ms === 2500), 'partials: at most 100 rows, retry_ms 2500');
    const qd = q.last.json;
    ok(qd.done === 1 && qd.len === 480 && qd.have === 479 && qd.items[100].un === 1 && qd.items.filter((x) => x.un).length === 1, 'done: the never-arriving entry is the one un row');
    const tq = Math.round((Date.now() - tq0) / 1000);
    ok(q.seen.slice(0, -1).every((x) => !x.items.some((y) => y.un)) && tq >= 35, `... only after the engine's sweep hold could have passed (${tq} s, ${q.seen.length} answers, no un row before)`);
    ok(model.counts.rootlist === roots0, `no rootlist fetch from the list's polls over ${tq} s (${model.counts.rootlist - roots0})`);
    ok(Math.max(...counts) <= 5, `at most 5 summary polls per phone request (max ${Math.max(...counts)})`);
    const qcalls = model.log.filter((x) => x.path.startsWith('/context/tracks') && x.path.includes(encodeURIComponent(quiet)));
    ok(qcalls.length <= 5 * q.seen.length, `listing calls for it: ${qcalls.length} over ${q.seen.length} phone requests`);
    ok(qd.v === 'b1' && qd.h.n === 'Quiet' && qd.h.len === 480, 'v + header');
    ok(q.last.headers['content-encoding'] === 'gzip', `done list gzipped (${q.last.raw.length} B for ${qd.items.length} rows)`);
    const pagesQ = model.log.filter((x) => x.path.includes(encodeURIComponent(quiet)) && x.path.includes('limit=500'));
    ok(pagesQ.length === 2 && pagesQ.every((x) => x.path.includes('sweep=0')), `rows in sweep=0 pages of 500: at the first stall (it found the held song and waited) and the final one (${pagesQ.length})`);
    const nq = qc.n.summaries + qc.n.pages;
    r = await req('GET', '/v1/playlists/' + quiet.slice(17), { etag: q.last.headers.etag });
    ok(r.status === 304 && qc.n.summaries + qc.n.pages === nq, 'repeat with the ETag: 304, the stub engine asked nothing');
    await sleep(2000);
    r = await req('GET', '/v1/playlists/' + quiet.slice(17), { gzip: true });
    ok(r.status === 200 && qc.n.summaries + qc.n.pages === nq, 'stored: no more polls for it afterwards');
    ok(bCalls() === nb, `the failed list: nothing to the engine for it during the hold (${bCalls() - nb})`);
    await sleep(Math.max(0, tb + 31000 - Date.now()));
    const b2 = await pollList(bPath);
    ok(b2.last && b2.last.status === 200 && b2.last.json.done === 1 && b2.last.json.len === 12 && bc.n.enumerations === 2 && bc.n.held500 === 1,
      `after the hold (${Math.round((Date.now() - tb) / 1000)} s): enumerated again and done, the engine answered 500 once (${bc.n.held500}x, ${bc.n.enumerations} enumerations)`);
    const c = await pollList('/v1/playlists/' + car.slice(17));
    ok(c.last.json.done === 1 && c.last.json.len === 9 && c.last.json.v === c.last.json.h.v, 'drive drive drive: done, listing v == rootlist v');
    const l = await pollList('/v1/liked');
    ok(l.last.json.k === 'liked' && l.last.json.len === 40 && l.last.json.h.n === 'Liked Songs' && l.last.json.items[0].u === lc.entries[0].uri, 'Liked: done, 40 rows');
    r = await req('GET', '/v1/status');
    ok(r.json.catalog.liked_order === 'newest_first', `liked_order ${r.json.catalog.liked_order}`);
    const bm = await pollList('/v1/playlists/' + id22('barrymix'));
    ok(bm.last.json.done === 1 && bm.last.json.h.n === 'Barry mix' && bm.last.json.h.o === 'Someone' && bm.last.json.h.d === 'Smooth & soul', 'a playlist outside the library: header from the Web API');

    // ---------------------------------------------------------------- writes
    const n0 = { ...fc.n };
    r = await req('POST', '/v1/playlists/' + fam.slice(17) + '/items', { body: { op: 'add', uris: [famTracks[3].uri], allow_duplicates: false } });
    ok(r.status === 409 && r.json.error.code === 'duplicate' && r.json.error.uris[0] === famTracks[3].uri && r.json.error.message === 'This song is already in Band Practice.', `duplicate: 409 "${r.json.error.message}"`);
    const famCalls = model.log.filter((x) => x.path.startsWith('/context/tracks') && x.path.includes(encodeURIComponent(fam)));
    ok(fc.n.sweepsScheduled === 0 && famCalls.length > 0 && famCalls.every((x) => x.path.includes('sweep=0')), `the unopened playlist: only sweep=0 calls (${famCalls.length}), never a sweep`);
    ok(fc.n.enumerations - n0.enumerations === 1, 'its enumeration only');
    r = await req('POST', '/v1/playlists/' + fam.slice(17) + '/items', { body: { op: 'add', uris: [famTracks[3].uri], allow_duplicates: true } });
    ok(r.status === 200 && r.json.added === 1 && r.json.playlist.len === 21 && r.json.playlist.u === fam, 'allow_duplicates: added, len 21');
    r = await req('POST', '/v1/playlists/' + love.slice(17) + '/items', { body: { op: 'add', uris: [famTracks[1].uri] } });
    ok(r.status === 403 && r.json.error.code === 'not_editable', 'slow sunday: 403 not_editable');
    r = await req('POST', '/v1/playlists/' + fam.slice(17) + '/items', { body: { op: 'shuffle', uris: [famTracks[1].uri] } });
    ok(r.status === 400, 'an unknown op: 400');
    r = await req('POST', '/v1/playlists/' + fam.slice(17) + '/items', { body: { op: 'add', uris: ['spotify:episode:' + id22('ep')] } });
    ok(r.status === 400, 'an episode: 400');
    r = await req('PUT', '/v1/playlists/' + fam.slice(17) + '/items', { body: { op: 'add', uris: [famTracks[1].uri] } });
    ok(r.status === 404 && r.json.error.code === 'not_found', 'a signed PUT with a body: 404 (its body was read, the signature held)');
    r = await req('POST', '/v1/playlists', { body: { name: '  Road Trip  ', uris: [famTracks[5].uri] } });
    ok(r.status === 200 && r.json.added === 1 && r.json.playlist.n === 'Road Trip' && r.json.playlist.own === 1 && r.json.playlist.ed === 1, 'create: 200, own + ed, added 1');
    ok(sp.created.length === 1 && sp.created[0].public === false && sp.created[0].name === 'Road Trip', 'the playlist is private');
    r = await req('GET', '/v1/playlists');
    ok(r.json.items[0].n === 'Road Trip', 'at the top of the root');
    const nu = 'spotify:track:' + id22('newly liked');
    const lcn = lc.n.summaries + lc.n.pages;
    r = await req('POST', '/v1/library', { body: { uris: [nu], saved: true, rows: [{ u: nu, n: 'Newly Liked', a: 'Someone', d: 201000 }] } });
    ok(r.status === 200 && r.json.items[nu] === 1 && r.json.liked_len === 41, `like: 200, liked_len ${r.json.liked_len}`);
    r = await req('GET', '/v1/liked');
    ok(r.json.items[0].u === nu && r.json.len === 41 && lc.n.summaries + lc.n.pages === lcn, 'the stored Liked list was patched, not re-read');
    r = await req('GET', '/v1/library/contains?uris=' + [nu, 'spotify:track:' + id22('not liked')].join(','), { gzip: true });
    ok(r.status === 200 && r.json.items[nu] === 1 && r.json.items['spotify:track:' + id22('not liked')] === 0 && !r.headers['content-encoding'], 'contains: 1/0; a small body is not gzipped');
    // pull-to-refresh on Liked after a like on the PC (the gateway can't know): the polls after fresh=1 follow the re-read
    const pc = 'spotify:track:' + id22('liked on the PC');
    lc.entries.unshift({ uri: pc, meta: 'ok' });
    lc.enumMs = 4000;
    const ref0 = lc.n.refresh;
    await sleep(5200);                                         // past likedSettle: the Liked signal may run too
    const fr = await req('GET', '/v1/liked?fresh=1', { gzip: true });
    ok(fr.status === 200 && !fr.json.done && lc.n.refresh === ref0 + 1, `fresh=1: refresh=1 sent, answer ${fr.json.done ? 'done' : fr.json.wait ? 'wait' : 'partial'}`);
    const fl = await pollList('/v1/liked');
    ok(fl.seen.slice(0, -1).every((x) => !x.done) && fl.last.json.done === 1 && fl.last.json.len === 42 && fl.last.json.items[0].u === pc,
      `the next polls followed the re-read: done with 42 rows after ${fl.seen.length} polls, the PC's like on top`);
    ok(lc.n.refresh === ref0 + 1, `one refresh=1 for it (${lc.n.refresh - ref0})`);
    lc.enumMs = 1500;
    r = await req('GET', '/v1/events?cursor=0&timeout=0');
    const types = r.json.events.map((e) => e.type);
    ok(types.includes('playlists') && r.json.events.some((e) => e.type === 'playlist' && e.data.u === fam && e.data.len === 21) && r.json.events.some((e) => e.type === 'liked' && e.data.items[0].u === nu), `events: playlists, playlist, liked (${[...new Set(types)].join(',')})`);

    // ---------------------------------------------------------------- Web API pages (in parallel: the stub must never see > 2 at once)
    sp.delay = 250;                                            // slower than the 100 ms start spacing, so calls overlap
    const [al, ar, s1, s2] = await Promise.all([req('GET', '/v1/albums/' + id22('album')), req('GET', '/v1/artists/' + id22('artistBarry White')),
      req('GET', '/v1/search?q=barry%20white', { gzip: true }), req('GET', '/v1/search?q=barry%20white&type=track&offset=10')]);
    ok(al.status === 200 && al.json.k === 'album' && al.json.items.length === 8 && al.json.items[0].tn === 1 && al.json.h.cp.startsWith('℗') && !('i' in al.json.items[0]), 'album: shape');
    ok(ar.status === 200 && ar.json.a.n === 'Barry White' && ar.json.top.length === 2 && ar.json.albums.length === 1 && ar.json.singles.length === 1, 'artist: shape');
    ok(s1.status === 200 && s1.json.top.k === 'artist' && s1.json.tracks.total === 812 && s1.json.tracks.next === 10 && s1.json.playlists.length === 1, 'search: shape (nulls dropped)');
    ok(s2.status === 200 && Object.keys(s2.json).join() === 'q,tracks' && s2.json.tracks.next === 20, 'See all songs: shape');
    sp.delay = 40;
    ok(sp.maxInflight === 2, `the Spotify stub never saw more than 2 requests at once (max ${sp.maxInflight})`);
    r = await req('GET', '/v1/search?q=' + 'x'.repeat(101));
    ok(r.status === 400 && r.json.error.code === 'bad_request', 'q over 100 characters: 400');
    // a Spotify-side 401 (twice): never a 401 to the phone
    sp.fail = { status: 401, n: 2 };
    r = await req('GET', '/v1/search?q=unauthorized');
    ok(r.status === 502 && r.json.error.code === 'spotify_error', `Spotify 401 twice -> ${r.status} ${r.json.error.code} (never 401)`);
    sp.fail = null;
    // covers: no CDN in here (network none) -> an upstream error, never a 401; the old route still checks hosts
    r = await req('GET', '/v1/img/ab67706c0000da84' + 'a'.repeat(24) + '?s=88');
    ok(r.status === 502 && r.json.error.code === 'image_upstream', `/v1/img without a CDN: ${r.status} ${r.json && r.json.error.code}`);
    r = await req('GET', '/v1/image?u=' + encodeURIComponent('https://evil.example/x.jpg'));
    ok(r.status === 400, '/v1/image: other hosts refused');

    // ---------------------------------------------------------------- queue with nothing loaded
    r = await req('POST', '/v1/player/queue', { body: { uri: famTracks[0].uri } });
    ok(r.status === 409 && r.json.error.code === 'not_active' && r.json.error.message === 'Nothing is playing on Encore.', 'queue with nothing loaded: 409 not_active');

    // ---------------------------------------------------------------- the 429 gate
    await sleep(6500);                                         // pollRemote (nothing loaded, a phone around) polls /me/player every 6 s
    const polls0 = sp.log.filter((x) => x === 'GET /v1/me/player').length;
    ok(polls0 >= 1, `pollRemote polled /me/player before the gate (${polls0})`);
    sp.fail = { status: 429, retryAfter: 30, n: 1 };
    r = await req('GET', '/v1/search?q=gate%20one');
    ok(r.status === 503 && r.json.error.code === 'rate_limited' && r.json.error.retry_after >= 30 && r.json.error.retry_after <= 31, `429 -> 503 rate_limited, retry_after ${r.json.error.retry_after}`);
    const total0 = sp.total;
    r = await req('GET', '/v1/search?q=gate%20two');
    ok(r.status === 503 && r.json.error.code === 'rate_limited' && r.ms < 50, `next search: 503 in ${r.ms} ms`);
    r = await req('GET', '/v1/artists/' + id22('another artist'));
    ok(r.status === 503 && r.json.error.code === 'rate_limited', 'artist page: 503 at once');
    await req('GET', '/v1/playlists?fresh=1');
    await sleep(7000);
    ok(sp.total === total0, `the stub saw no requests while blocked (${sp.total - total0}); pollRemote stayed silent`);
    r = await req('GET', '/admin/api/status', { sign: false, auth: true });
    ok(r.status === 200 && r.json.spotify.n429 === 1 && r.json.spotify.blocked_until > Date.now() && ['/search', '/me/player'].includes(r.json.spotify.last429_path), `admin: 429 gate fields (${r.json.spotify.last429_path})`);
    ok(r.json.catalog && r.json.catalog.lists_stored >= 4 && r.json.images && 'disk_files' in r.json.images, `admin: catalog + images info (${r.json.catalog.lists_stored} lists stored, engine_est ${r.json.catalog.engine_est})`);

    // ---------------------------------------------------------------- simulate
    r = await req('POST', '/admin/api/catalog/simulate', { sign: false, auth: true, body: { code: 'listing_off', seconds: 60 } });
    ok(r.status === 200 && r.json.simulate.code === 'listing_off', 'simulate listing_off for 60 s');
    r = await req('GET', '/v1/playlists');
    ok(r.status === 503 && r.json.error.code === 'listing_off' && r.json.error.retry_after <= 60, 'GET /v1/playlists: 503 listing_off');
    r = await req('POST', '/v1/library', { body: { uris: [nu], saved: false } });
    ok(r.status === 503 && r.json.error.code === 'listing_off', 'POST /v1/library: 503 too');
    r = await req('POST', '/admin/api/catalog/simulate', { sign: false, auth: true, body: { code: null } });
    r = await req('GET', '/v1/playlists');
    ok(r.status === 200, 'simulate off: 200 again');

    // ---------------------------------------------------------------- play with shuffle, the track object, queue
    r = await req('POST', '/v1/player/play', { body: { context_uri: car, shuffle: true } });
    const play = model.counts.plays[model.counts.plays.length - 1];
    ok(r.status === 200 && play && play.uri === car && play.shuffle_context === true && play.paused === true, `play shuffle:true reached the engine as shuffle_context (${JSON.stringify(play)})`);
    await sleep(800);
    r = await req('GET', '/v1/player/state');
    const t = r.json.track || {};
    ok(t.context_track_uri && t.uri !== t.context_track_uri && /^[0-9a-f]{40}$/.test(t.img) && /^spotify:album:/.test(t.album_uri) && t.artist_uris.length === 2 && t.cover, 'track: context_track_uri, img, album_uri, artist_uris, cover');
    ok(t.liked === 0 || t.liked === 1, `track.liked from the current-song check (${t.liked})`);
    r = await req('POST', '/v1/player/queue', { body: { uri: famTracks[0].uri } });
    ok(r.status === 200 && model.counts.queue.length === 1, 'queue with a song loaded: 200');

    // ---------------------------------------------------------------- privacy in the log
    ok(!/barry|gate one|unauthorized/i.test(out), 'the log has no search terms');
    ok(!out.includes('a'.repeat(24)) && !out.includes('evil.example'), 'the log has no image tokens or URLs');
    ok(!/fake-refresh|stub-token/.test(out), 'the log has no tokens');
    ok(/GET \/v1\/img: /.test(out) || !/\/v1\/img\//.test(out), 'image errors are logged by route prefix only');
  } catch (e) {
    fails++;
    console.log('FAIL exception', e.stack);
  }
  console.log('---- gateway log (last 40 lines) ----');
  console.log(out.trim().split('\n').slice(-40).join('\n'));
  console.log(fails ? `bridge-catalog: ${fails} FAILED` : 'bridge-catalog: all checks passed');
  gw.kill('SIGKILL');
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(fails ? 1 : 0);
}

if (SKIP) test('the real bridge against a stub engine and a stub Spotify', { skip: SKIP }, () => {});
else main().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
