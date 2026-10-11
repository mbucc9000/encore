'use strict';
// Jam invite links -> the join token (DESIGN-4b.md §5.7 Join step 1). Nothing here talks to social-connect.
//  - Accepted: https://open.spotify.com/[intl-xx/]socialsession/<t>[?si=…], spotify:socialsession:<t>, a bare token, and
//    https://spotify.link/<x> (Spotify's Branch short links), which expand() follows.
//  - expand(): at most 3 GETs with redirect 'manual', 5 s each, https only, and only on spotify.link and
//    spotify.app.link. It stops at the first Location that names a socialsession and never fetches open.spotify.com.
//    A hop that answers 200 (Branch can serve an HTML/JS page instead of a redirect) has its first 64 KB scanned for
//    an open.spotify.com socialsession link. Anything else is not a Jam link (null).
//  - shareLink(): the session's own join_session_url as the invite link (4b-c), normalised.
// Tokens and links are never logged.

const OPEN = /^https:\/\/open\.spotify\.com\/(?:intl-[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?\/)?socialsession\/([A-Za-z0-9_-]{1,128})\/?(?:[?#].*)?$/;
const URI = /^spotify:socialsession:([A-Za-z0-9_-]{1,128})$/;
const BARE = /^[A-Za-z0-9_-]{6,128}$/;
const SHORT = /^https:\/\/spotify\.link\/([A-Za-z0-9_-]{1,64})\/?(?:[?#].*)?$/;
const SCAN = /https:\/\/open\.spotify\.com\/(?:intl-[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?\/)?socialsession\/([A-Za-z0-9_-]{1,128})/;
const SHORT_HOSTS = new Set(['spotify.link', 'spotify.app.link']);
const HOPS = 3;
const HOP_MS = 5000;
const PAGE_BYTES = 65536;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// s -> {token} | {short: url} | null
function parseLink(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (!s || s.length > 2048) return null;
  let m = s.match(OPEN) || s.match(URI);
  if (m) return { token: m[1] };
  m = s.match(SHORT);
  if (m) return { short: 'https://spotify.link/' + m[1] };
  if (BARE.test(s)) return { token: s };
  return null;
}

function shortHost(url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  return u.protocol === 'https:' && SHORT_HOSTS.has(u.hostname.toLowerCase());
}

// The first `max` bytes of a body (the rest is never read).
async function readCapped(r, max) {
  if (r.body && typeof r.body.getReader === 'function') {
    const rd = r.body.getReader();
    const parts = [];
    let n = 0;
    try {
      while (n < max) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(Buffer.from(value));
        n += value.length;
      }
    } finally { rd.cancel().catch(() => {}); }
    return Buffer.concat(parts).subarray(0, max).toString('latin1');
  }
  const t = typeof r.text === 'function' ? await r.text() : '';
  return String(t).slice(0, max);
}

const drop = (r) => { try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel().catch(() => {}); } catch (e) { /* nothing to drop */ } };

// A spotify.link short link -> the token, or null when it doesn't lead to a Jam. Throws 502 when the host doesn't
// answer in time. opts.fetch (tests), opts.hopMs, opts.stats.gets (counted for the live-test budget).
async function expand(url, { fetch: f = (...a) => fetch(...a), hopMs = HOP_MS, stats } = {}) {
  const seen = new Set();
  let cur = url;
  for (let hop = 0; hop < HOPS; hop++) {
    if (!shortHost(cur) || seen.has(cur)) return null;          // https on Branch's hosts only, and no loops
    seen.add(cur);
    if (stats) stats.gets = (stats.gets || 0) + 1;
    let r;
    try {
      r = await f(cur, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(hopMs) });
    } catch (e) {
      throw fail(502, 'spotify_error', 'Spotify’s link service didn’t answer. Try again, or paste the open.spotify.com link.');
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers && r.headers.get ? r.headers.get('location') : null;
      drop(r);
      if (!loc) return null;
      let next;
      try { next = new URL(loc, cur).href; } catch (e) { return null; }
      const p = parseLink(next);
      if (p && p.token && !BARE.test(next)) return p.token;     // a socialsession URL or URI (never fetched)
      if (shortHost(next)) { cur = next; continue; }
      return null;                                               // http, open.spotify.com elsewhere, other hosts
    }
    if (r.status === 200) {
      let text;
      try { text = await readCapped(r, PAGE_BYTES); } catch (e) {
        throw fail(502, 'spotify_error', 'Spotify’s link service didn’t answer. Try again, or paste the open.spotify.com link.');
      }
      const m = text.match(SCAN);
      return m ? m[1] : null;
    }
    drop(r);
    return null;
  }
  return null;                                                   // more than 3 hops
}

const linkFor = (token) => 'https://open.spotify.com/socialsession/' + token;

// The session's own share link (join_session_url, DESIGN-4b.md §4.7): https on open.spotify.com or spotify.link as it
// is; the same without a scheme (C0: the field isn't http(s)://-prefixed) with https:// put in front. Anything else
// (another scheme, host, a port or credentials) is null, and the caller builds the link from the token.
// -> {url, kind: 'https' | 'no scheme', host} | null
function shareLink(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (!s || s.length > 2048 || /\s/.test(s)) return null;
  let kind = 'https';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^(?:open\.spotify\.com|spotify\.link)\//i.test(s)) return null;
    s = 'https://' + s;
    kind = 'no scheme';
  }
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || (host !== 'open.spotify.com' && host !== 'spotify.link') || u.username || u.password || u.port) return null;
  return { url: s, kind, host };
}

// A share URL the session JSON carries: usable (as https, or without a scheme) on open.spotify.com or spotify.link.
const shareOk = (url) => !!shareLink(url);

module.exports = { parseLink, expand, linkFor, shareOk, shareLink, readCapped };
