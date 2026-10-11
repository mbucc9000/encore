'use strict';
// A local fake of GitHub's release API and its download servers, for the update tests (DESIGN-UPDATES.md §14.2). It
// listens on 127.0.0.1 (port 0) and serves
//   GET /repos/mbucc9000/encore/releases/latest                      the latest release, as GitHub's JSON
//   GET /mbucc9000/encore/releases/download/v<ver>/<asset>           a redirect to the "download server" below
//   GET /dl/<token>/<asset>?sig=...                                  the file (Range honoured unless told otherwise)
// It records every request's method, path, query and headers, and can be told to answer newer / older / equal / rc /
// prerelease / draft / malformed tags, leave an asset out, sign with the wrong key, change a file after signing, drop
// an entry from the sums, send 304 on a matching If-None-Match, 403 + x-ratelimit-remaining: 0, 429 + retry-after,
// 404, 500, stall, cut a download at 40 %, ignore Range, send oversized or broken JSON, and redirect to a host or a
// scheme the client must refuse. Every byte it serves is made up; the signing keys are the RFC 8032 test keys.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = 'mbucc9000/encore';
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'update-vectors.json'), 'utf8'));
const KEYS = VECTORS.keys;              // rfc8032_test1, rfc8032_test2: {seed_hex, public_hex, public_b64, id}

const b64u = (h) => Buffer.from(h, 'hex').toString('base64url');
function privateKey(name) {
  const k = KEYS[name];
  return crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64u(k.seed_hex), x: b64u(k.public_hex) }, format: 'jwk' });
}
const signWith = (name, bytes) => crypto.sign(null, bytes, privateKey(name));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const assetNames = (v) => [`Encore-${v}-gpl-source.tar.gz`, `Encore-${v}-source.tar.gz`, `EncoreBridge-${v}-setup.exe`, `EncoreBridge-${v}-win64.zip`,
  `Encore_${v}_iphoneos-arm.deb`];
// SHA256SUMS.txt as checksums.py writes it: sorted by name (bytes), two spaces, LF, a final newline
function sumsOf(files) {
  return Buffer.from(Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((n) => `${sha256(files[n])}  ${n}\n`).join(''));
}

class FakeGitHub {
  constructor() {
    this.requests = [];
    this.release = null;
    this.api = { mode: 'ok', etag: 'hash', honour304: true };   // mode: see answerApi()
    this.dl = {};                    // per asset name: 'ok' | 'missing' | 'cut' | 'stall' | 'bad_host' | 'http' | 'loop'
    this.ignoreRange = false;
    this.nextId = 100;
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
  }

  start() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.port = this.server.address().port;
      this.base = `http://127.0.0.1:${this.port}`;
      resolve(this);
    }));
  }

  close() {
    for (const s of this.sockets) s.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }

  // requests to the API / to downloads (the redirect and the file both count)
  apiCalls() { return this.requests.filter((q) => q.path.startsWith('/repos/') || q.path.startsWith('/repositories/')); }
  downloadCalls(name) { return this.requests.filter((q) => (q.path.startsWith(`/${REPO}/releases/download/`) || q.path.startsWith('/dl/')) && (!name || q.path.endsWith('/' + name))); }

  // A release. tag: its tag ('v1.2.0'); files: the asset names (default: all five of the version); signedBy: the key
  // ('rfc8032_test1' | 'rfc8032_test2' | null: no .sig); omit: assets left out of the release; dropFromSums: a name
  // left out of SHA256SUMS.txt; sums / sig: bytes to serve instead (after signing); tamper: a file changed after the
  // sums were made; notUploaded: an asset whose state isn't "uploaded". New asset ids every time (a re-upload).
  setRelease({ tag = 'v1.2.0', draft = false, prerelease = false, files, signedBy = 'rfc8032_test1', omit = [], dropFromSums = null, sums = null,
    sig = null, tamper = null, notUploaded = [], published_at = '2026-10-11T09:30:00Z' } = {}) {
    const v = String(tag).replace(/^v/, '');
    const names = files || assetNames(v);
    const content = {};
    for (const n of names) content[n] = Buffer.from(`made-up test content of ${n}\n`.repeat(n.endsWith('.exe') ? 64 : 4));
    const listed = { ...content };
    if (dropFromSums) delete listed[dropFromSums];
    const goodSums = sumsOf(listed);
    const all = { ...content, 'SHA256SUMS.txt': sums || goodSums };
    if (signedBy || sig) all['SHA256SUMS.txt.sig'] = sig || signWith(signedBy, goodSums);
    if (tamper && all[tamper]) all[tamper] = Buffer.concat([all[tamper], Buffer.from('changed after signing\n')]);
    for (const n of omit) delete all[n];
    const assets = Object.keys(all).map((n) => ({ id: this.nextId++, name: n, size: all[n].length, state: notUploaded.includes(n) ? 'starter' : 'uploaded' }));
    this.release = { tag, draft, prerelease, published_at, files: all, assets, version: v };
    return this.release;
  }

  json() {
    const r = this.release;
    // hostile fields the client must never read, show or store
    return {
      url: `https://api.github.com/repos/${REPO}/releases/1`, html_url: 'https://evil.example/release-page', id: 1,
      author: { login: 'someone-made-up', id: 42 }, node_id: 'RE_made_up', tag_name: r.tag, target_commitish: 'main',
      name: 'Encore <script>alert(1)</script> 9.9.9', body: 'Install from https://evil.example/now <img src=x onerror=alert(1)>',
      draft: r.draft, prerelease: r.prerelease, created_at: '2026-10-11T09:00:00Z', published_at: r.published_at,
      assets: r.assets.map((a) => ({ url: `https://api.github.com/repos/${REPO}/releases/assets/${a.id}`, id: a.id, node_id: 'RA_x', name: a.name, label: '',
        uploader: { login: 'someone-made-up' }, content_type: 'application/octet-stream', state: a.state, size: a.size, download_count: 7,
        created_at: '2026-10-11T09:10:00Z', updated_at: '2026-10-11T09:10:00Z', browser_download_url: `https://evil.example/${a.name}` })),
      tarball_url: 'https://evil.example/t', zipball_url: 'https://evil.example/z',
    };
  }

  record(req) {
    const u = new URL(req.url, 'http://x');
    this.requests.push({ method: req.method, path: u.pathname, query: u.search, headers: { ...req.headers }, raw: req.rawHeaders.slice() });
    return u;
  }

  handle(req, res) {
    const u = this.record(req);
    if (u.pathname === `/repos/${REPO}/releases/latest`) return this.answerApi(req, res);
    if (u.pathname === '/repositories/4242/releases/latest') return this.answerApi(req, res, true);
    const m = u.pathname.match(new RegExp(`^/${REPO}/releases/download/v([^/]+)/([^/]+)$`));
    if (m) return this.redirectDownload(req, res, m[1], m[2]);
    const d = u.pathname.match(/^\/dl\/([0-9a-f]+)\/([^/]+)$/);
    if (d) return this.serveFile(req, res, decodeURIComponent(d[2]));
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"message":"Not Found"}');
  }

  // api.mode: 'ok' | 404 | 500 | 'ratelimit' | 'retry_after' | 'stall' | 'oversize' | 'badjson' | 'redirect' (same
  // server) | 'redirect_bad_host' | 'redirect_http' | 'redirect_loop'; api.etag: 'hash' | 'tracking' | null
  answerApi(req, res, renamed = false) {
    const a = this.api;
    const mode = a.mode;
    if (mode === 'stall') return undefined;                                        // never answers
    if (mode === 404) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"message":"Not Found"}'); }
    if (mode === 500) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"Server Error"}'); }
    if (mode === 'ratelimit') {
      res.writeHead(403, { 'Content-Type': 'application/json', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(a.reset) });
      return res.end('{"message":"API rate limit exceeded for 203.0.113.50."}');
    }
    if (mode === 'retry_after') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(a.retryAfter || 120) });
      return res.end('{"message":"You have exceeded a secondary rate limit."}');
    }
    // (a renamed repo: GitHub answers 301 to /repositories/<id>/...)
    if (mode === 'redirect' && !renamed) {
      res.writeHead(301, { Location: '/repositories/4242/releases/latest' });
      return res.end();
    }
    if (mode === 'redirect_bad_host') { res.writeHead(301, { Location: `https://evil.example/repos/${REPO}/releases/latest` }); return res.end(); }
    if (mode === 'redirect_http') { res.writeHead(301, { Location: `http://127.0.0.2:${this.port}/repos/${REPO}/releases/latest` }); return res.end(); }
    if (mode === 'redirect_loop') { res.writeHead(302, { Location: `/repos/${REPO}/releases/latest` }); return res.end(); }
    if (mode === 'oversize') {
      const big = JSON.stringify({ ...this.json(), padding: 'x'.repeat((1 << 20) + 10) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(big);
    }
    if (mode === 'badjson') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"tag_name": "v1.2.0", '); }
    if (!this.release) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"message":"Not Found"}'); }
    const body = Buffer.from(JSON.stringify(this.json()));
    const head = { 'Content-Type': 'application/json; charset=utf-8', 'x-ratelimit-remaining': '59', 'Set-Cookie': 'tracking=made-up; Path=/' };
    if (a.etag === 'hash') head.ETag = `W/"${sha256(body)}"`;
    else if (a.etag === 'tracking') head.ETag = '"client-0815-made-up"';
    if (a.honour304 && head.ETag && req.headers['if-none-match'] === head.ETag) { res.writeHead(304, { ETag: head.ETag }); return res.end(); }
    head['Content-Length'] = body.length;
    res.writeHead(200, head);
    return res.end(body);
  }

  // GitHub answers a release download with a redirect to its download servers (a signed, short-lived address)
  redirectDownload(req, res, ver, name) {
    const r = this.release;
    const mode = this.dl[name] || 'ok';
    if (!r || r.version !== ver || !r.files[name] || mode === 'missing') { res.writeHead(404); return res.end('Not Found'); }
    const token = crypto.randomBytes(8).toString('hex');
    if (mode === 'bad_host') { res.writeHead(302, { Location: `https://evil.example/dl/${token}/${name}` }); return res.end(); }
    if (mode === 'http') { res.writeHead(302, { Location: `http://127.0.0.2:${this.port}/dl/${token}/${name}` }); return res.end(); }
    if (mode === 'loop') { res.writeHead(302, { Location: req.url }); return res.end(); }
    res.writeHead(302, { Location: `/dl/${token}/${encodeURIComponent(name)}?sig=made-up-${token}&exp=1` });
    return res.end();
  }

  serveFile(req, res, name) {
    const r = this.release;
    const mode = this.dl[name] || 'ok';
    const buf = r && r.files[name];
    if (!buf) { res.writeHead(404); return res.end(); }
    if (mode === 'stall') return undefined;
    const range = !this.ignoreRange && /^bytes=(\d+)-$/.exec(String(req.headers.range || ''));
    if (range && Number(range[1]) < buf.length) {
      const from = Number(range[1]);
      res.writeHead(206, { 'Content-Length': buf.length - from, 'Content-Range': `bytes ${from}-${buf.length - 1}/${buf.length}`, 'Content-Type': 'application/octet-stream' });
      return res.end(buf.subarray(from));
    }
    res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': 'application/octet-stream' });
    if (mode === 'cut') { res.write(buf.subarray(0, Math.floor(buf.length * 0.4))); return setImmediate(() => res.socket && res.socket.destroy()); }
    return res.end(buf);
  }
}

module.exports = { FakeGitHub, REPO, VECTORS, KEYS, signWith, sumsOf, sha256, assetNames };
