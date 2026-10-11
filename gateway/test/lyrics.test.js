'use strict';
// Offline test of lyrics.js with a fake LRCLIB (fetchImpl) and a fake engine (no network, no live gateway).
// Every lyric "text" here is made up; nothing is printed but the result.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Lyrics, TIMING, cleanName, parseLrc } = require('../src/lyrics');

const id = (c) => c.repeat(22).slice(0, 22);
const U = (c) => 'spotify:track:' + id(c);
const Q = (o) => new URLSearchParams(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (m) => JSON.parse(m.body.toString());
const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = () => json({ statusCode: 404, name: 'TrackNotFound', message: 'Failed to find specified track' }, 404);
const rec = (o) => ({ id: 1, name: 'Song', trackName: 'Song', artistName: 'Artist', albumName: 'Album', duration: 200, instrumental: false,
  hasWordSync: false, plainLyrics: null, syncedLyrics: null, lyricsfile: null, ...o });
const UA = 'Encore/' + require('../src/config').version;          // 1.1.0: "Encore/<version>" (RELEASE-PLAN, small items)

// The fake LRCLIB: every request is recorded, `route` answers it.
const calls = [];
let route = () => notFound();
async function fetchImpl(url, o) {
  const u = new URL(url);
  calls.push({ url, origin: u.origin, p: u.pathname, q: Object.fromEntries(u.searchParams), ua: o.headers['User-Agent'] });
  return route(u.pathname, Object.fromEntries(u.searchParams), o);
}
const dirs = [];
const mk = ({ dir, timing, engine, player } = {}) => {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'p08-'));
  dirs.push(d);
  return new Lyrics({ cfg: { cacheDir: d }, engine, player, fetchImpl, timing });
};

(async () => {
  // ---------------------------------------------------------------- LRC parsing
  const lrc = ['[ar:Some Artist]', '[ti:Some Title]', '[al:Some Album]', '[by:someone]', '[length: 03:20]', '[offset:+250]',
    '[00:10.50][00:40.5]chorus line', '[00:05]first line', '  [00:20.123]  third line  ', '[00:30.00]', 'a line without a stamp',
    '[00:00.10]early', '[00:50.00]same time a', '[00:50.00]same time b', '[00:59.00][00:55.00]reversed stamps',
    '[01:02:50]colon hundredths', '[01:10.00]word <01:10.50>stamps <01:11.00>here'].join('\r\n');
  assert.deepStrictEqual(parseLrc(lrc), [
    { t: 0, l: 'early' },                       // 100 - 250: clamped at 0
    { t: 4750, l: 'first line' },               // [mm:ss]
    { t: 10250, l: 'chorus line' },             // [mm:ss.xx], two stamps on one line
    { t: 19873, l: 'third line' },              // [mm:ss.xxx], text trimmed
    { t: 29750, l: '' },                        // a gap
    { t: 40250, l: 'chorus line' },             // [mm:ss.x]
    { t: 49750, l: 'same time a' },             // stable
    { t: 49750, l: 'same time b' },
    { t: 54750, l: 'reversed stamps' },
    { t: 58750, l: 'reversed stamps' },
    { t: 62250, l: 'colon hundredths' },
    { t: 69750, l: 'word stamps here' },
  ]);
  assert.deepStrictEqual(parseLrc('[00:01.5]a\n[00:02.05]b\n[00:03.005]c\n[00:04]d\n[00:04.999]e'),
    [{ t: 1500, l: 'a' }, { t: 2050, l: 'b' }, { t: 3005, l: 'c' }, { t: 4000, l: 'd' }, { t: 4999, l: 'e' }]);
  assert.deepStrictEqual(parseLrc('[offset:-500]\n[00:01.00]later'), [{ t: 1500, l: 'later' }]);
  assert.deepStrictEqual(parseLrc('[offset: +1500]\n[00:01.00]sooner\n[00:02.00]x'), [{ t: 0, l: 'sooner' }, { t: 500, l: 'x' }]);
  assert.deepStrictEqual(parseLrc('[ar:Someone]\n[ti:Title]\nunstamped text'), []);
  assert.deepStrictEqual(parseLrc(''), []);

  // ---------------------------------------------------------------- clean(n)
  for (const [n, want] of [
    ['Song - Remastered 2011', 'Song'], ['Song - 2011 Remaster', 'Song'], ['Song - Single Version', 'Song'], ['Song - Radio Edit', 'Song'],
    ['Song - Mono', 'Song'], ['Song - Live', 'Song'], ['Song - Live at Wembley Stadium / 1986', 'Song'], ['Song (Remastered 2020)', 'Song'],
    ['Song (2015 Remaster)', 'Song'], ['song - REMASTERED 2009', 'song'], ['Song - remastered', 'Song'],
    ['Song (feat. Other) - Remastered 2011', 'Song (feat. Other)'], ['Song - 2011 Remaster - Mono', 'Song'],
    ['Live Forever', 'Live Forever'], ['Lively - Lovely', 'Lively - Lovely'], ['Song - Acoustic', 'Song - Acoustic'],
    ['Song (Live)', 'Song (Live)'], ['Remastered', 'Remastered'], ['Song - Remastered 2011 (Deluxe)', 'Song - Remastered 2011 (Deluxe)'],
  ]) assert.strictEqual(cleanName(n), want, n);

  // ---------------------------------------------------------------- /api/get hit, synced
  const L = mk();
  route = (p) => (p === '/api/get' ? json(rec({ syncedLyrics: '[00:01.00]one\n[00:02.50]two\n[00:04.00]', plainLyrics: 'one\ntwo' })) : notFound());
  const m1 = await L.get(Q({ u: U('a'), n: 'Song A', a: 'Artist A', al: 'Album A', d: '245600' }), false);
  assert.deepStrictEqual(parse(m1), { u: U('a'), s: 1, lines: [{ t: 1000, l: 'one' }, { t: 2500, l: 'two' }, { t: 4000, l: '' }], src: 'LRCLIB' });
  assert.ok(/^"[0-9a-f]{20}"$/.test(m1.etag));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].origin, 'https://lrclib.net');
  assert.strictEqual(calls[0].p, '/api/get');
  assert.deepStrictEqual(calls[0].q, { track_name: 'Song A', artist_name: 'Artist A', album_name: 'Album A', duration: '246' });
  assert.ok(calls[0].url.endsWith('/api/get?track_name=Song%20A&artist_name=Artist%20A&album_name=Album%20A&duration=246'), calls[0].url);
  assert.strictEqual(calls[0].ua, UA);
  // from memory (fresh=1 only concerns a "none"): the same memo, no request
  const m1b = await L.get(Q({ u: U('a'), n: 'Song A', a: 'Artist A' }), true);
  assert.strictEqual(m1b, m1);
  assert.strictEqual(calls.length, 1);

  // 400 for a bad or missing u, n or a (LRCLIB isn't asked)
  for (const bad of [{}, { u: 'spotify:track:short', n: 'x', a: 'y' }, { u: 'spotify:episode:' + id('a'), n: 'x', a: 'y' },
    { u: U('a') + 'x', n: 'x', a: 'y' }, { u: U('a'), a: 'y' }, { u: U('a'), n: 'x' }, { u: U('a'), n: '   ', a: 'y' },
    { u: U('a'), n: 'x'.repeat(301), a: 'y' }, { u: U('a'), n: 'x', a: 'y'.repeat(301) }]) {
    await assert.rejects(L.get(Q(bad), false), { status: 400, code: 'bad_request' });
  }
  assert.strictEqual(calls.length, 1);
  // an album that is too long and a duration that isn't one are left out (not a 400)
  calls.length = 0;
  route = (p) => (p === '/api/get' ? json(rec({ syncedLyrics: '[00:01.00]x' })) : notFound());
  await L.get(Q({ u: U('b'), n: ' Song B ', a: 'Artist B', al: 'z'.repeat(301), d: '12.5' }), false);
  assert.deepStrictEqual(calls.map((c) => c.q), [{ track_name: 'Song B', artist_name: 'Artist B' }]);

  // ---------------------------------------------------------------- 404 -> get without the album -> search
  calls.length = 0;
  route = (p) => (p !== '/api/search' ? notFound() : json([
    rec({ duration: 260, syncedLyrics: '[00:01.00]too long' }),               // 60 s off: filtered out
    rec({ duration: 200.4, plainLyrics: 'plain but closest' }),              // the closest, but plain
    rec({ duration: 202.5, syncedLyrics: '[00:01.00]synced, 2.5 s off' }),
    rec({ duration: 198.5, syncedLyrics: '[00:01.00]synced, 1.5 s off' }),   // synced and the closest synced one
    rec({ duration: 199, syncedLyrics: '[ar:x]', plainLyrics: '' }),         // nothing to show: not a candidate
  ]));
  const b3 = parse(await L.get(Q({ u: U('c'), n: 'Song C - Remastered 2011', a: 'Artist C', al: 'Album C', d: '200000' }), false));
  assert.deepStrictEqual(calls.map((c) => [c.p, c.q]), [
    ['/api/get', { track_name: 'Song C - Remastered 2011', artist_name: 'Artist C', album_name: 'Album C', duration: '200' }],
    ['/api/get', { track_name: 'Song C - Remastered 2011', artist_name: 'Artist C', duration: '200' }],
    ['/api/search', { track_name: 'Song C', artist_name: 'Artist C' }],
  ]);
  assert.deepStrictEqual(b3, { u: U('c'), s: 1, lines: [{ t: 1000, l: 'synced, 1.5 s off' }], src: 'LRCLIB' });
  // no album: one get only; no duration: no filter, the first synced record
  calls.length = 0;
  const b3b = parse(await L.get(Q({ u: U('d'), n: 'Song D', a: 'Artist D' }), false));
  assert.deepStrictEqual(calls.map((c) => [c.p, c.q]), [['/api/get', { track_name: 'Song D', artist_name: 'Artist D' }],
    ['/api/search', { track_name: 'Song D', artist_name: 'Artist D' }]]);
  assert.deepStrictEqual(b3b.lines, [{ t: 1000, l: 'too long' }]);
  // a duration that leaves no candidate: nothing found
  calls.length = 0;
  route = (p) => (p === '/api/search' ? json([rec({ duration: 100, syncedLyrics: '[00:01.00]x' }), rec({ duration: null, syncedLyrics: '[00:01.00]y' })]) : notFound());
  assert.deepStrictEqual(parse(await L.get(Q({ u: U('f'), n: 'Song F', a: 'Artist F', d: '200000' }), false)), { u: U('f'), none: 1 });
  assert.strictEqual(calls.length, 2);
  // the edge: exactly 3 s off is kept (the synced one beats an exact plain one), 3.1 s off is not (the plain one is left)
  route = (p) => (p === '/api/search' ? json([rec({ duration: 200, plainLyrics: 'plain, exact' }), rec({ duration: 203, syncedLyrics: '[00:01.00]synced, 3 s off' })]) : notFound());
  assert.deepStrictEqual(parse(await L.get(Q({ u: U('i'), n: 'Song I', a: 'Artist I', d: '200000' }), false)).lines, [{ t: 1000, l: 'synced, 3 s off' }]);
  route = (p) => (p === '/api/search' ? json([rec({ duration: 200, plainLyrics: 'plain, exact' }), rec({ duration: 196.9, syncedLyrics: '[00:01.00]synced, 3.1 s off' })]) : notFound());
  assert.deepStrictEqual(parse(await L.get(Q({ u: U('j'), n: 'Song J', a: 'Artist J', d: '200000' }), false)), { u: U('j'), s: 0, lines: [{ l: 'plain, exact' }], src: 'LRCLIB' });
  assert.strictEqual(calls.length, 6);
  // synced text without a stamped line: the plain lyrics (s: 0), empty lines kept inside, trimmed at the ends
  calls.length = 0;
  route = (p) => (p === '/api/get' ? json(rec({ syncedLyrics: '[ar:Someone]\nno stamps here', plainLyrics: '\n\nfirst\n\n  second  \r\nthird\n\n' })) : notFound());
  assert.deepStrictEqual(parse(await L.get(Q({ u: U('e'), n: 'Song E', a: 'Artist E', d: '1000' }), false)),
    { u: U('e'), s: 0, lines: [{ l: 'first' }, { l: '' }, { l: 'second' }, { l: 'third' }], src: 'LRCLIB' });
  assert.strictEqual(calls.length, 1);

  // ---------------------------------------------------------------- instrumental
  calls.length = 0;
  route = (p) => (p === '/api/get' ? json(rec({ instrumental: true })) : notFound());
  assert.deepStrictEqual(parse(await L.get(Q({ u: U('g'), n: 'Song G', a: 'Artist G' }), false)), { u: U('g'), inst: 1 });
  assert.strictEqual(calls.length, 1);
  // from the search too; LRCLIB turning a get down (400 ValidationError) is a miss, not a failure
  calls.length = 0;
  route = (p) => (p === '/api/search' ? json([rec({ instrumental: true, duration: 300 })]) : json({ code: 400, name: 'ValidationError' }, 400));
  assert.deepStrictEqual(parse(await L.get(Q({ u: U('h'), n: 'Song H', a: 'Artist H', al: 'Album H', d: '299000' }), false)), { u: U('h'), inst: 1 });
  assert.deepStrictEqual(calls.map((c) => c.p), ['/api/get', '/api/get', '/api/search']);

  // ---------------------------------------------------------------- none: 3 days; fresh=1 at most once a minute
  assert.strictEqual(TIMING.noneTtl, 3 * 86400000);
  assert.strictEqual(TIMING.foundTtl, 60 * 86400000);
  assert.strictEqual(TIMING.freshGap, 60000);
  assert.strictEqual(TIMING.timeoutMs, 8000);
  assert.strictEqual(TIMING.maxFlights, 2);
  assert.strictEqual(TIMING.phoneRecent, 600000);
  const N = mk({ timing: { noneTtl: 300, freshGap: 60 } });
  calls.length = 0;
  route = (p) => (p === '/api/search' ? json([]) : notFound());
  const qn = Q({ u: U('n'), n: 'Song N', a: 'Artist N' });
  assert.deepStrictEqual(parse(await N.get(qn, false)), { u: U('n'), none: 1 });
  assert.strictEqual(calls.length, 2);
  await N.get(qn, false);
  await N.get(qn, true);                         // fresh=1 right after the lookup: just as fresh
  assert.strictEqual(calls.length, 2);
  await sleep(90);
  await N.get(qn, false);                        // within its lifetime (3 days; here 300 ms)
  assert.strictEqual(calls.length, 2);
  await N.get(qn, true);                         // fresh=1 a minute (here 60 ms) later: asks again
  assert.strictEqual(calls.length, 4);
  await N.get(qn, true);                         // ... at most once a minute
  assert.strictEqual(calls.length, 4);
  await sleep(90);
  route = (p) => (p === '/api/get' ? json(rec({ syncedLyrics: '[00:03.00]found now' })) : notFound());
  assert.strictEqual(parse(await N.get(qn, true)).s, 1);
  assert.strictEqual(calls.length, 5);
  await sleep(350);
  assert.strictEqual(parse(await N.get(qn, false)).s, 1);       // found: kept 60 days, past a "none"'s 300 ms here
  assert.strictEqual(calls.length, 5);
  // past its lifetime: asked again; when LRCLIB then fails, the expired copy is the answer
  calls.length = 0;
  route = (p) => (p === '/api/search' ? json([]) : notFound());
  const qm = Q({ u: U('m'), n: 'Song M', a: 'Artist M' });
  await N.get(qm, false);
  assert.strictEqual(calls.length, 2);
  await sleep(350);
  await N.get(qm, false);
  assert.strictEqual(calls.length, 4);
  await sleep(350);
  route = () => json({ message: 'down' }, 503);
  assert.deepStrictEqual(parse(await N.get(qm, false)), { u: U('m'), none: 1 });
  assert.strictEqual(calls.length, 5);

  // ---------------------------------------------------------------- failures: 502, never cached
  const E = mk({ timing: { timeoutMs: 50 } });
  calls.length = 0;
  route = () => json({ statusCode: 503 }, 503);
  const qe = Q({ u: U('x'), n: 'Song X', a: 'Artist X', al: 'Album X' });
  await assert.rejects(E.get(qe, false), { status: 502, code: 'lyrics_unavailable', message: 'Lyrics aren\'t available right now.' });
  assert.strictEqual(calls.length, 1);           // the first failure ends the lookup
  assert.match(E.info().last_error, /get: answered 503$/);
  route = (p) => (p === '/api/get' ? json(rec({ syncedLyrics: '[00:01.00]back' })) : notFound());
  assert.strictEqual(parse(await E.get(qe, false)).s, 1);       // not cached as "none"
  const failures = [
    [(p) => (p === '/api/search' ? json({}, 500) : notFound()), /search: answered 500$/],   // a 5xx at the search step
    [() => json({}, 429), /get: answered 429$/],
    [(p, q, o) => new Promise((resolve, reject) => o.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))), /get: timed out$/],
    [() => { throw new TypeError('fetch failed'); }, /get: fetch failed$/],
    [() => new Response('[00:01.00]not json at all', { status: 200 }), /get: sent something that isn't JSON$/],
    // only LRCLIB's own 404 / 400 on a get is a miss: any other 4xx (a firewall or proxy turning Encore away) fails
    [() => json({ message: 'Forbidden' }, 403), /get: answered 403$/],
    [() => json({}, 408), /get: answered 408$/],
    [(p) => (p === '/api/search' ? json({ code: 400, name: 'ValidationError' }, 400) : notFound()), /search: answered 400$/],
    [() => notFound(), /search: answered 404$/],                 // the search answers [] for nothing, never a 404
    // a 200 of the wrong shape (an error object instead of the search's list, a get that isn't a record)
    [(p) => (p === '/api/search' ? json({ statusCode: 500, message: 'oops' }) : notFound()), /search: sent an answer of the wrong shape$/],
    [() => json(null), /get: sent an answer of the wrong shape$/],
  ];
  for (const [i, [r, why]] of failures.entries()) {
    const c = String.fromCharCode(65 + i);
    route = r;
    await assert.rejects(E.get(Q({ u: U(c), n: 'Song', a: 'Artist', al: 'Album' }), false), { status: 502, code: 'lyrics_unavailable' });
    assert.strictEqual(await E.store.get('l', id(c)), null, 'nothing stored for ' + c);
    assert.match(E.info().last_error, why);
    assert.ok(!E.info().last_error.includes('not json at all'), 'no body text in last_error');
  }
  // ... and once LRCLIB answers again, the song is asked for (no "none" was kept)
  route = (p) => (p === '/api/get' ? json(rec({ syncedLyrics: '[00:01.00]back' })) : notFound());
  assert.strictEqual(parse(await E.get(Q({ u: U('F'), n: 'Song', a: 'Artist', al: 'Album' }), false)).s, 1);
  assert.strictEqual(E.busy, 0);
  assert.strictEqual(E.info().flights, 0);

  // ---------------------------------------------------------------- at most 2 LRCLIB requests; one flight per track
  const C = mk();
  calls.length = 0;
  let active = 0;
  let peak = 0;
  const gates = [];
  route = (p, q) => {
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve) => gates.push(() => { active--; resolve(json(rec({ syncedLyrics: `[00:01.00]${q.track_name}` }))); }));
  };
  const reqs = ['p', 'q', 'r', 's'].map((c) => C.get(Q({ u: U(c), n: 'Song ' + c, a: 'Artist' }), false));
  reqs.push(C.get(Q({ u: U('p'), n: 'Song p', a: 'Artist' }), false), C.get(Q({ u: U('p'), n: 'Song p', a: 'Artist' }), true));
  await sleep(100);
  assert.strictEqual(active, 2);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(C.info().flights, 4);
  assert.strictEqual(C.waiting.length, 2);
  while (gates.length) { gates.shift()(); await sleep(25); }
  const out = await Promise.all(reqs);
  assert.strictEqual(peak, 2);
  assert.strictEqual(calls.length, 4);           // one request per song: the two extra callers joined
  assert.deepStrictEqual(calls.map((c) => c.q.track_name).sort(), ['Song p', 'Song q', 'Song r', 'Song s']);
  assert.strictEqual(out[4], out[0]);
  assert.strictEqual(out[5], out[0]);
  assert.deepStrictEqual(parse(out[1]).lines, [{ t: 1000, l: 'Song q' }]);
  assert.strictEqual(C.busy, 0);
  assert.strictEqual(C.info().flights, 0);
  assert.strictEqual(C.info().lrclib_calls, 4);

  // the phone's requests go before prefetches; a prefetch whose song is no longer playing gives up its place
  const engine = new EventEmitter();
  const player = { lastPhone: Date.now() };
  const P = mk({ engine, player });
  calls.length = 0;
  active = 0;
  peak = 0;
  const held = ['t', 'u'].map((c) => P.get(Q({ u: U(c), n: 'Song ' + c, a: 'Artist' }), false));
  await sleep(100);
  assert.strictEqual(active, 2);
  const meta = (c) => engine.emit('event', 'metadata', { uri: U(c), name: 'Song ' + c, artist_names: ['Artist ' + c], album_name: 'Album ' + c, duration: 180400 });
  meta('v');                                     // prefetch v: waits
  await sleep(50);
  meta('w');                                     // the next song: v is no longer playing; prefetch w waits too
  await sleep(50);
  const phone = P.get(Q({ u: U('y'), n: 'Song y', a: 'Artist' }), false);
  await sleep(50);
  assert.strictEqual(P.waiting.length, 3);
  gates.shift()();
  await sleep(50);
  assert.strictEqual(calls[2].q.track_name, 'Song y');          // the phone first
  gates.shift()();
  await sleep(50);
  assert.deepStrictEqual(calls[3].q, { track_name: 'Song w', artist_name: 'Artist w', album_name: 'Album w', duration: '180' });
  assert.strictEqual(P.waiting.length, 0);                      // v gave up without a request
  while (gates.length) { gates.shift()(); await sleep(25); }
  await Promise.all([...held, phone]);
  assert.strictEqual(calls.length, 4);
  assert.ok(!calls.some((c) => c.q.track_name === 'Song v'));
  assert.strictEqual(P.busy, 0);
  await P.get(Q({ u: U('w'), n: 'Song w', a: 'Artist w' }), false);   // prefetched: no request
  assert.strictEqual(calls.length, 4);

  // ---------------------------------------------------------------- prefetch only while a phone is around
  const engine2 = new EventEmitter();
  const player2 = { lastPhone: 0 };
  const F = mk({ engine: engine2, player: player2 });
  calls.length = 0;
  route = (p) => (p === '/api/get' ? json(rec({ syncedLyrics: '[00:01.00]prefetched' })) : notFound());
  const meta2 = (o) => engine2.emit('event', 'metadata', { name: 'Pre', artist_names: ['Artist P', 'Second Artist'], album_name: 'Album P', duration: 201000, ...o });
  meta2({ uri: U('1') });                        // no phone seen yet: nothing
  player2.lastPhone = Date.now() - 11 * 60000;
  meta2({ uri: U('2') });                        // a phone 11 min ago: nothing
  engine2.emit('event', 'playing', { uri: U('3') });
  await sleep(50);
  assert.strictEqual(calls.length, 0);
  player2.lastPhone = Date.now() - 60000;        // a phone a minute ago: prefetch
  meta2({ uri: U('4'), context_track_uri: U('5') });            // the context's uri is the one the phone has
  meta2({ uri: U('4'), context_track_uri: U('5') });            // the same song again: once
  await sleep(80);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].q, { track_name: 'Pre', artist_name: 'Artist P', album_name: 'Album P', duration: '201' });
  assert.deepStrictEqual(parse(await F.get(Q({ u: U('5'), n: 'Pre', a: 'Artist P' }), false)).lines, [{ t: 1000, l: 'prefetched' }]);
  assert.strictEqual(calls.length, 1);           // opening lyrics is instant
  // a failed prefetch: one log line (no lyric text), nothing stored
  const warns = [];
  const warn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  route = () => json({}, 503);
  meta2({ uri: U('6') });
  await sleep(80);
  console.warn = warn;
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /lyrics prefetch: LRCLIB get answered 503$/);
  assert.strictEqual(await F.store.get('l', id('6')), null);

  // ---------------------------------------------------------------- the disk cache survives a new instance
  await sleep(150);                              // (disk writes are async)
  const onDisk = JSON.parse(fs.readFileSync(L.store.file('l', id('a')), 'utf8'));
  assert.ok(onDisk.at > 0);
  assert.deepStrictEqual(onDisk.body, parse(m1));
  calls.length = 0;
  route = () => { throw new Error('LRCLIB must not be asked'); };
  const L2 = mk({ dir: path.dirname(L.store.dir) });
  const again = await L2.get(Q({ u: U('a'), n: 'Song A', a: 'Artist A' }), false);
  assert.strictEqual(again.etag, m1.etag);
  assert.deepStrictEqual(parse(again), parse(m1));
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(Object.keys(L2.info()), ['cached', 'flights', 'lrclib_calls', 'last_error']);
  assert.strictEqual(L2.info().cached, 1);
  assert.strictEqual(L2.info().lrclib_calls, 0);
  assert.strictEqual(L2.info().last_error, null);

  await sleep(100);
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  console.log('ALL OK');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
