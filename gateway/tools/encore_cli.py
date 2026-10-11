#!/usr/bin/env python3
"""encore_cli: a stand-in for the iPhone app, for testing the gateway (Python 3.8+, standard library only).

  encore_cli.py pair --gw http://192.168.1.20:8095 --code 123456
  encore_cli.py status
  encore_cli.py play spotify:album:... [--offset spotify:track:...]   (Spotify links work too)
  encore_cli.py pause|resume|next|prev
  encore_cli.py seek 60000
  encore_cli.py listen [--seconds 15] [--q very_high]     read the stream; report frames/markers (nothing is saved)
  encore_cli.py gate URI                                  Phase 1 gate: play, seek, skip, pause/resume and time each cut-over
  encore_cli.py get PATH [--etag '"..."']                 any signed GET, e.g. get /v1/playlists (gzip like the app)
  encore_cli.py post PATH 'JSON'                          any signed POST with a JSON body

Pairing is stored in ~/.encore-cli.json (another file with --conf FILE, before or after the command).
Audio is parsed and counted only.
"""
import argparse, gzip, hashlib, hmac, http.client, json, os, re, socket, struct, sys, threading, time, urllib.error, urllib.parse, urllib.request

CONF = os.path.expanduser('~/.encore-cli.json')


def load(conf=None):
    try:
        return json.load(open(os.path.expanduser(conf or CONF)))
    except Exception:
        sys.exit('Not paired yet: run  encore_cli.py [--conf FILE] pair --gw http://HOST:8095 --code NNNNNN')


def to_uri(s):
    m = re.search(r'open\.spotify\.com/(?:intl-\w+/)?(track|album|playlist|artist|episode)/([A-Za-z0-9]+)', s)
    return 'spotify:%s:%s' % m.groups() if m else s


def signed(c, method, path, body=b''):
    t = str(int(time.time()))
    msg = '%s\n%s\n%s\n%s' % (method, path, t, hashlib.sha256(body).hexdigest())
    sig = hmac.new(__import__('base64').b64decode(c['secret']), msg.encode(), hashlib.sha256).hexdigest()
    return {'X-Encore-Device': c['device_id'], 'X-Encore-Time': t, 'X-Encore-Sig': sig}


def call(c, method, path, obj=None):
    body = json.dumps(obj).encode() if obj is not None else b''
    h = signed(c, method, path, body)
    if obj is not None:
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(c['gw'] + path, data=body if method == 'POST' else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit('%s %s -> %s %s' % (method, path, e.code, e.read()[:300].decode('utf8', 'replace')))


class Reply:
    """One HTTP answer: status, headers (lowercase names), raw (bytes on the wire), body (inflated), json (or None), ms."""
    def __init__(self, status, headers, raw, ms):
        self.status, self.headers, self.raw, self.ms = status, headers, raw, ms
        self.body = gzip.decompress(raw) if raw and headers.get('content-encoding') == 'gzip' else raw
        try:
            self.json = json.loads(self.body.decode('utf8')) if self.body and 'json' in headers.get('content-type', '') else None
        except ValueError:
            self.json = None

    @property
    def etag(self):
        return self.headers.get('etag')

    @property
    def error(self):
        """{code, message, retry_after?} of an error answer, else {}."""
        e = self.json.get('error') if isinstance(self.json, dict) else None
        return e if isinstance(e, dict) else {}


def request(c, method, path, obj=None, etag=None, gz=True, timeout=60, signed_=True, extra=None):
    """A request like the app's, without raising on HTTP errors: signed (unless signed_=False), JSON body for obj,
    Accept-Encoding gzip (gz), If-None-Match etag. path is sent exactly as signed (quote the query yourself)."""
    u = urllib.parse.urlsplit(c['gw'])
    body = json.dumps(obj).encode() if obj is not None else b''
    h = signed(c, method, path, body) if signed_ else {}
    if obj is not None:
        h['Content-Type'] = 'application/json'
    h['Accept-Encoding'] = 'gzip' if gz else 'identity'
    if etag:
        h['If-None-Match'] = etag
    h.update(extra or {})
    conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=timeout)
    try:
        t0 = time.time()
        conn.request(method, path, body=body if method in ('POST', 'PUT', 'DELETE') else None, headers=h)
        r = conn.getresponse()
        raw = r.read()
        return Reply(r.status, {k.lower(): v for k, v in r.getheaders()}, raw, (time.time() - t0) * 1000)
    finally:
        conn.close()


def get(c, path, etag=None):
    return request(c, 'GET', path, etag=etag)


def post(c, path, obj):
    return request(c, 'POST', path, obj if obj is not None else {})


class Stream:
    """Reads one ENC1 stream in a thread and records timings."""
    def __init__(self, c, gen, q):
        self.c, self.gen, self.q = c, gen, q
        self.t_open = time.time(); self.t_head = None; self.t_first = None; self.frames = 0; self.bytes = 0
        self.markers = []; self.ended = None; self.header = None; self.err = None; self.stop = False
        self.th = threading.Thread(target=self.run, daemon=True); self.th.start()

    def run(self):
        path = '/v1/stream?gen=%d&q=%s' % (self.gen, self.q)
        req = urllib.request.Request(self.c['gw'] + path, headers=signed(self.c, 'GET', path))
        try:
            r = urllib.request.urlopen(req, timeout=15)
            rd = lambda n: r.read(n)
            pre = rd(8)
            if pre[:4] != b'ENC1':
                self.err = 'bad magic %r' % pre[:4]; return
            self.header = json.loads(rd(struct.unpack('>I', pre[4:])[0]))
            self.t_head = time.time()
            while not self.stop:
                h = rd(4)
                if len(h) < 4:
                    self.ended = 'eof'; return
                typ, n = chr(h[0]), int.from_bytes(h[1:4], 'big')
                payload = rd(n)
                if typ == 'A':
                    if self.t_first is None:
                        self.t_first = time.time()
                    self.frames += 1; self.bytes += n
                elif typ in 'MP':
                    self.markers.append((self.frames, typ, json.loads(payload)))
                elif typ == 'Z':
                    self.ended = 'Z'; return
        except Exception as e:
            self.err = repr(e)


def open_stream(c, gen, q):
    return Stream(c, gen, q)


def describe(s):
    t = lambda x: '%.0f ms' % ((x - s.t_open) * 1000) if x else '-'
    names = ['%s@%d: %s' % (k, f, (d.get('name') or d.get('position_ms'))) for f, k, d in s.markers[:4]]
    return 'gen %d: header %s, first audio %s, %d frames (%.1f s of audio), markers [%s], start=%s%s' % (
        s.gen, t(s.t_head), t(s.t_first), s.frames, s.frames * 1024 / 44100.0, '; '.join(names),
        (s.header or {}).get('start'), (' ERROR ' + s.err) if s.err else '')


def pair(gw, code, name, conf=None):
    """POST /v1/pair with a code from the admin page; saves {device_id, secret, gw} to conf (mode 600). The secret is
    never printed."""
    req = urllib.request.Request(gw.rstrip('/') + '/v1/pair', data=json.dumps({'code': code, 'device_name': name}).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=15) as r:
        res = json.load(r)
    res = {'device_id': res['device_id'], 'secret': res['secret'], 'gw': gw.rstrip('/'), 'device_name': name}
    path = os.path.expanduser(conf or CONF)
    if os.path.dirname(path):
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + '.tmp'
    try:
        os.unlink(tmp)                 # a leftover (or a link someone put there) is never written through
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)   # new file: mode 600 before the secret is in it
    with os.fdopen(fd, 'w') as f:
        json.dump(res, f)
    os.replace(tmp, path)
    return res


def show(r):
    size = '%d B' % len(r.body or b'') + (' (gzip %d B)' % len(r.raw) if r.headers.get('content-encoding') == 'gzip' else '')
    print('HTTP %d  %.0f ms  %s%s' % (r.status, r.ms, size, ('  ETag ' + r.etag) if r.etag else ''))
    if r.json is not None:
        print(json.dumps(r.json, indent=1, ensure_ascii=False))
    elif r.body:
        print('(%s, %d bytes)' % (r.headers.get('content-type', '?'), len(r.body)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd')
    ap.add_argument('arg', nargs='?')
    ap.add_argument('arg2', nargs='?')
    ap.add_argument('--gw'); ap.add_argument('--code'); ap.add_argument('--offset')
    ap.add_argument('--seconds', type=float, default=15); ap.add_argument('--q', default='very_high')
    ap.add_argument('--conf', default=CONF, help='pairing file (default ~/.encore-cli.json)')
    ap.add_argument('--name', help='device name when pairing (default "encore_cli on <host>")')
    ap.add_argument('--etag', help='get: send If-None-Match')
    a = ap.parse_args()

    if a.cmd == 'pair':
        if not a.gw or not a.code:
            sys.exit('pair needs --gw and --code')
        res = pair(a.gw, a.code, a.name or 'encore_cli on ' + socket.gethostname(), a.conf)
        print('paired as', res['device_id'])
        return

    c = load(a.conf)
    if a.cmd == 'get':
        show(request(c, 'GET', a.arg or '/v1/status', etag=a.etag))
    elif a.cmd == 'post':
        if not a.arg:
            sys.exit('post needs a PATH and a JSON body, e.g. post /v1/player/pause \'{}\'')
        show(request(c, 'POST', a.arg, json.loads(a.arg2 or '{}')))
    elif a.cmd == 'status':
        print(json.dumps(call(c, 'GET', '/v1/status'), indent=1))
    elif a.cmd == 'play':
        body = {'uri': to_uri(a.arg)}
        if a.offset:
            body = {'context_uri': to_uri(a.arg), 'offset_uri': to_uri(a.offset)}
        r = call(c, 'POST', '/v1/player/play', body); print('gen', r['gen'])
    elif a.cmd in ('pause', 'resume', 'next', 'prev'):
        r = call(c, 'POST', '/v1/player/' + a.cmd, {}); print('gen', r['gen'], r['state']['status'])
    elif a.cmd == 'seek':
        r = call(c, 'POST', '/v1/player/seek', {'position_ms': int(a.arg)}); print('gen', r['gen'])
    elif a.cmd == 'listen':
        gen = call(c, 'GET', '/v1/player/state')['gen']
        s = open_stream(c, gen, a.q); time.sleep(a.seconds); s.stop = True
        print(describe(s))
        print('rate: %.1f frames/s after the first second (43.1 = real time)' % ((s.frames - min(s.frames, 43)) / max(0.1, a.seconds - 1)))
    elif a.cmd == 'gate':
        gate(c, to_uri(a.arg), a.q)
    else:
        sys.exit(__doc__)


def gate(c, uri, q):
    print('Phase 1 gate on', c['gw'], 'tier', q)
    results = []

    def step(name, fn, listen=6):
        t0 = time.time()
        r = fn()
        s = open_stream(c, r['gen'], q)
        time.sleep(listen)
        s.stop = True
        cut = (s.t_first - t0) if s.t_first else None
        results.append((name, cut, s))
        print('  %-14s command -> first audio frame: %s | %s' % (name, ('%.2f s' % cut) if cut else 'NONE', describe(s)))
        return s

    s1 = step('play', lambda: call(c, 'POST', '/v1/player/play', {'uri': uri}), listen=10)
    rate = (s1.frames - 64) / 9.0
    print('  steady rate after the first burst: %.1f frames/s (43.1 = real time); initial burst %d frames' % (rate, min(s1.frames, 64)))
    step('seek +60s', lambda: call(c, 'POST', '/v1/player/seek', {'position_ms': 60000}))
    step('next', lambda: call(c, 'POST', '/v1/player/next', {}))
    st = call(c, 'GET', '/v1/player/state')
    call(c, 'POST', '/v1/player/pause', {'played_ms': st['position_ms']})
    time.sleep(2)
    step('resume', lambda: call(c, 'POST', '/v1/player/resume', {}))
    step('prev', lambda: call(c, 'POST', '/v1/player/prev', {}))
    call(c, 'POST', '/v1/player/pause', {})
    ok = all(cut is not None and cut <= 1.0 for _, cut, _ in results)
    print('GATE (every cut-over <= 1.0 s):', 'PASS' if ok else 'FAIL')


if __name__ == '__main__':
    main()
