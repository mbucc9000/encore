'use strict';
// jamlink.js (DESIGN-4b.md §5.7 Join step 1): every link form, and spotify.link expansion over a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLink, expand, shareOk } = require('../src/jamlink');

const TOK = 'AbC123_-xyz789TOKEN';

test('parseLink: socialsession URLs (?si=, intl-xx/), URIs, bare tokens, spotify.link; rejects the rest', () => {
  assert.deepEqual(parseLink(`https://open.spotify.com/socialsession/${TOK}`), { token: TOK });
  assert.deepEqual(parseLink(`  https://open.spotify.com/socialsession/${TOK}?si=abc123&utm_source=copy-link \n`), { token: TOK });
  assert.deepEqual(parseLink(`https://open.spotify.com/intl-de/socialsession/${TOK}`), { token: TOK });
  assert.deepEqual(parseLink(`https://open.spotify.com/intl-pt-br/socialsession/${TOK}/`), { token: TOK });
  assert.deepEqual(parseLink(`spotify:socialsession:${TOK}`), { token: TOK });
  assert.deepEqual(parseLink(TOK), { token: TOK });
  assert.deepEqual(parseLink('https://spotify.link/AbCdEf123'), { short: 'https://spotify.link/AbCdEf123' });
  assert.deepEqual(parseLink('https://spotify.link/AbCdEf123?x=1'), { short: 'https://spotify.link/AbCdEf123' }, 'the query is dropped');
  for (const bad of [`http://open.spotify.com/socialsession/${TOK}`, `https://evil.example/socialsession/${TOK}`, `https://open.spotify.com.evil.example/socialsession/${TOK}`,
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'http://spotify.link/AbCdEf123', 'https://spotify.app.link/AbCdEf123', 'abc12', 'two words here',
    `spotify:track:${TOK}`, '', null, 42, 'x'.repeat(3000), `https://open.spotify.com/socialsession/${'a'.repeat(129)}`]) {
    assert.equal(parseLink(bad), null, String(bad).slice(0, 60));
  }
  assert.equal(shareOk('https://open.spotify.com/socialsession/x'), true);
  assert.equal(shareOk('https://spotify.link/x'), true);
  assert.equal(shareOk('http://open.spotify.com/socialsession/x'), false);
  assert.equal(shareOk('https://evil.example/x'), false);
});

// a fake fetch: url -> {status, location?, body?}; every URL asked for is logged
function fakeFetch(routes) {
  const log = [];
  const f = async (url, o) => {
    log.push(url);
    assert.equal(o.redirect, 'manual');
    assert.ok(o.signal, 'a timeout signal');
    const r = routes[url];
    if (r === 'hang') return new Promise((resolve, reject) => o.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    if (!r) return { status: 404, headers: { get: () => null }, text: async () => '' };
    return { status: r.status, headers: { get: (h) => (h.toLowerCase() === 'location' ? r.location || null : null) }, text: async () => r.body || '' };
  };
  return { f, log };
}

test('expand: a 307 chain stops at the first socialsession Location and never fetches open.spotify.com', async () => {
  const { f, log } = fakeFetch({
    'https://spotify.link/AbC': { status: 307, location: 'https://spotify.app.link/AbC?_p=1' },
    'https://spotify.app.link/AbC?_p=1': { status: 302, location: `https://open.spotify.com/socialsession/${TOK}?si=zz` },
  });
  const stats = {};
  assert.equal(await expand('https://spotify.link/AbC', { fetch: f, stats }), TOK);
  assert.deepEqual(log, ['https://spotify.link/AbC', 'https://spotify.app.link/AbC?_p=1']);
  assert.equal(stats.gets, 2, 'counted for the budget');
  // a relative Location on the short host, then a spotify: URI
  const b = fakeFetch({ 'https://spotify.link/R': { status: 301, location: '/R2' }, 'https://spotify.link/R2': { status: 302, location: `spotify:socialsession:${TOK}` } });
  assert.equal(await expand('https://spotify.link/R', { fetch: b.f }), TOK);
});

test('expand: a 200 page is scanned (first 64 KB only); song links, loops, > 3 hops and http are not Jams', async () => {
  const page = `<html><script>var u="https://open.spotify.com/intl-fr/socialsession/${TOK}?si=1"</script></html>`;
  let x = fakeFetch({ 'https://spotify.link/P': { status: 200, body: 'x'.repeat(1000) + page } });
  assert.equal(await expand('https://spotify.link/P', { fetch: x.f }), TOK);
  x = fakeFetch({ 'https://spotify.link/P': { status: 200, body: 'x'.repeat(65536) + page } });
  assert.equal(await expand('https://spotify.link/P', { fetch: x.f }), null, 'only after 64 KB');
  x = fakeFetch({ 'https://spotify.link/S': { status: 302, location: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=1' } });
  assert.equal(await expand('https://spotify.link/S', { fetch: x.f }), null, 'a song link');
  assert.deepEqual(x.log, ['https://spotify.link/S'], 'open.spotify.com never fetched');
  x = fakeFetch({ 'https://spotify.link/A': { status: 302, location: 'https://spotify.link/B' }, 'https://spotify.link/B': { status: 302, location: 'https://spotify.link/A' } });
  assert.equal(await expand('https://spotify.link/A', { fetch: x.f }), null, 'a loop');
  assert.equal(x.log.length, 2);
  x = fakeFetch({ 'https://spotify.link/1': { status: 302, location: 'https://spotify.link/2' }, 'https://spotify.link/2': { status: 302, location: 'https://spotify.link/3' },
    'https://spotify.link/3': { status: 302, location: 'https://spotify.link/4' }, 'https://spotify.link/4': { status: 302, location: `https://open.spotify.com/socialsession/${TOK}` } });
  assert.equal(await expand('https://spotify.link/1', { fetch: x.f }), null, '> 3 hops');
  assert.equal(x.log.length, 3);
  x = fakeFetch({ 'https://spotify.link/H': { status: 302, location: 'http://spotify.link/H2' } });
  assert.equal(await expand('https://spotify.link/H', { fetch: x.f }), null, 'a non-https Location');
  assert.equal(x.log.length, 1);
  x = fakeFetch({ 'https://spotify.link/E': { status: 302, location: 'https://evil.example/socialsession/' + TOK } });
  assert.equal(await expand('https://spotify.link/E', { fetch: x.f }), null, 'another host');
  assert.equal(await expand('https://evil.example/x', { fetch: x.f }), null, 'never starts off the short hosts');
});

test('expand: the 5 s timeout per hop answers 502', async () => {
  const { f } = fakeFetch({ 'https://spotify.link/T': 'hang' });
  const keep = setInterval(() => {}, 50);           // AbortSignal.timeout's timer doesn't hold the event loop (the server does)
  const t0 = Date.now();
  try {
    await assert.rejects(expand('https://spotify.link/T', { fetch: f, hopMs: 150 }), (e) => e.status === 502 && e.code === 'spotify_error');
  } finally { clearInterval(keep); }
  assert.ok(Date.now() - t0 < 2000);
});
