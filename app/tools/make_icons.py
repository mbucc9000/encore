# Generates the optional home-screen icons for Settings > Appearance > App Icon (DESIGN-APP-ICONS.md §4).
# The art is exactly the owner's five images in appicons-src/ ("dont redraw use these"): each one is only cropped to
# its tile, cleaned in the corners and scaled down. No gloss, no rounding, no colour changes (iOS 6 rounds the corners).
# No image libraries (same rule as make_art.py): a numpy + zlib PNG reader and writer, Lanczos-3 in numpy.
# Output: <out_dir>/<id>/Icon.png 57, Icon@2x.png 114, Icon-Small.png 29, Icon-Small@2x.png 58 for the five ids.
# Written RGBA, opaque, with only IHDR / IDAT / IEND (no metadata), deterministic: a re-run is byte-identical.
# Usage: python make_icons.py [out_dir] [--preview preview.png]   (default out_dir ../Resources/AppIcons)
#   --preview writes each icon at 114 under an iOS 6 mask (radius 0.1754 x size) on a light and a dark background.
#   Write it to a scratch folder, never into the app.
import numpy as np, zlib, struct, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'appicons-src')

# id, source, crop box (x0, y0, x1, y1; end exclusive) and the corner radius r in crop pixels (0 = no corner cleanup).
# Boxes are MEASURED from the source pixels (spec §4). r is MEASURED too: the smallest radius whose rounded square
# holds no background pixel (white corners and their anti-aliased arc, which runs a long way along the edges; the flat
# one's checkerboard and its dark rim), plus 2 px:
#   classic: white up to r 79 -> 82.   2013: white along the top edge up to r 73 -> 76.
#   flat: checkerboard up to r 91, dark rim up to r 101 -> 104.
# (The spec's 73 / 56 / 98 sit inside those arcs, so a faint white fringe or rim would have stayed.) iOS 6 masks with
# 0.1754 x side (classic 78, 2013 67, flat 78 px here), so every corner it shows is the tile's own colour.
ICONS = (
    ('classic', 'spotify-glossy-square.png', (0, 0, 447, 447), 82),
    ('round',   'spotify-round.png',         (0, 0, 447, 447), 0),
    ('2013',    'spotify-2013.png',          (13, 20, 395, 402), 76),
    ('flat',    'spotify-flat-dark.png',     (35, 35, 477, 477), 104),
    ('disco',   'spotify-disco.png',         (0, 0, 447, 447), 0),
)
SIZES = (('Icon@2x.png', 114), ('Icon.png', 57), ('Icon-Small@2x.png', 58), ('Icon-Small.png', 29))
SOURCE_SIZES = {'spotify-glossy-square.png': (447, 447), 'spotify-round.png': (447, 447),
                'spotify-2013.png': (414, 420), 'spotify-flat-dark.png': (512, 512), 'spotify-disco.png': (447, 447)}

# ---------------------------------------------------------------- PNG in / out

def read_png(path):
    """8-bit, non-interlaced, colour type 2 (RGB) or 6 (RGBA); anything else is a hard error. Returns (rgb uint8 HxWx3,
    alpha uint8 HxW or None, chunk names)."""
    b = open(path, 'rb').read()
    if b[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('%s: not a PNG' % path)
    i, ihdr, idat, names = 8, None, [], []
    while i < len(b):
        n = struct.unpack('>I', b[i:i + 4])[0]
        t, d = b[i + 4:i + 8], b[i + 8:i + 8 + n]
        if struct.unpack('>I', b[i + 8 + n:i + 12 + n])[0] != zlib.crc32(t + d) & 0xffffffff:
            raise SystemExit('%s: bad CRC in %r' % (path, t))
        names.append(t.decode('latin-1'))
        if t == b'IHDR': ihdr = struct.unpack('>IIBBBBB', d)
        elif t == b'IDAT': idat.append(d)
        elif t == b'IEND': break
        elif t[0] & 0x20 == 0: raise SystemExit('%s: unsupported critical chunk %r' % (path, t))
        i += 12 + n
    w, h, depth, ctype, comp, filt, inter = ihdr
    if depth != 8 or ctype not in (2, 6) or comp or filt or inter:
        raise SystemExit('%s: need 8-bit RGB/RGBA non-interlaced, got %r' % (path, ihdr))
    bpp = 3 if ctype == 2 else 4
    stride = w * bpp
    raw = zlib.decompress(b''.join(idat))
    if len(raw) != h * (stride + 1):
        raise SystemExit('%s: bad image data length' % path)
    out = np.zeros((h, stride), np.uint8)
    prev = np.zeros(stride, np.int32)
    for y in range(h):
        ft = raw[y * (stride + 1)]
        cur = np.frombuffer(raw, np.uint8, stride, y * (stride + 1) + 1).astype(np.int32)
        if ft == 0:
            row = cur
        elif ft == 1:                                       # Sub: running sum per channel
            row = cur.reshape(w, bpp).cumsum(0).reshape(-1) & 255
        elif ft == 2:                                       # Up
            row = (cur + prev) & 255
        elif ft in (3, 4):                                  # Average / Paeth: sequential
            c, p, r = cur.tolist(), prev.tolist(), [0] * stride
            for x in range(stride):
                a = r[x - bpp] if x >= bpp else 0
                if ft == 3:
                    r[x] = (c[x] + ((a + p[x]) >> 1)) & 255
                else:
                    bb = p[x]; cc = p[x - bpp] if x >= bpp else 0
                    pa, pb, pc = abs(bb - cc), abs(a - cc), abs(a + bb - 2 * cc)
                    r[x] = (c[x] + (a if pa <= pb and pa <= pc else bb if pb <= pc else cc)) & 255
            row = np.array(r, np.int32)
        else:
            raise SystemExit('%s: bad filter %d on row %d' % (path, ft, y))
        out[y] = row
        prev = row
    px = out.reshape(h, w, bpp)
    return px[..., :3].copy(), (px[..., 3].copy() if bpp == 4 else None), names


def write_png(path, rgb):
    """RGBA, alpha 255, only IHDR / IDAT / IEND."""
    h, w, _ = rgb.shape
    rgba = np.concatenate([rgb.astype(np.uint8), np.full((h, w, 1), 255, np.uint8)], 2)
    raw = b''.join(b'\x00' + rgba[y].tobytes() for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(data)

# ---------------------------------------------------------------- crop, corners, scale

def corner_dist(n, r):
    """Per pixel (by centre): its distance from the nearest corner-arc centre of the n x n rounded square of radius r
    (0 along the middle, so the square's inside is corner_dist <= r)."""
    c = np.arange(n) + 0.5
    d = np.maximum(np.maximum(r - c, c - (n - r)), 0)
    return np.hypot(d[:, None], d[None, :])


def rounded_inside(n, r):
    return corner_dist(n, r) <= r


def bleed(img, known):
    """Corner cleanup. 1) Every unknown pixel gets the mean of its already-known 4-neighbours, ring by ring from the
    inside out (spec §4). 2) The filled pixels are then relaxed (each one the mean of its 4 neighbours, known ones held
    fixed, 400 rounds), which smooths the streaks step 1 draws out of single texture pixels. Known pixels never change."""
    v, filled = img.copy(), ~known
    known = known.copy()
    H, W = known.shape
    def shifted(a, dy, dx):                                   # a moved by (dy, dx), edges repeated
        p = np.pad(a, ((1, 1), (1, 1)) + ((0, 0),) * (a.ndim - 2), mode='edge')
        return p[1 + dy:1 + dy + H, 1 + dx:1 + dx + W]
    while not known.all():
        acc = np.zeros_like(v); cnt = np.zeros(known.shape)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = shifted(known, dy, dx)
            if dy > 0: k[-1:] = False                              # no wrap-around from the repeated edge
            if dy < 0: k[:1] = False
            if dx > 0: k[:, -1:] = False
            if dx < 0: k[:, :1] = False
            acc += shifted(v, dy, dx) * k[..., None]; cnt += k
        new = ~known & (cnt > 0)
        if not new.any():
            raise SystemExit('bleed: unreachable pixels')
        v[new] = acc[new] / cnt[new][:, None]
        known |= new
    ys, xs = np.nonzero(filled)                               # relax each corner on its own small block
    for yb in (ys < H // 2, ys >= H // 2):
        for xb in (xs < W // 2, xs >= W // 2):
            sel = yb & xb
            if not sel.any(): continue
            y0, y1 = max(ys[sel].min() - 1, 0), min(ys[sel].max() + 2, H)
            x0, x1 = max(xs[sel].min() - 1, 0), min(xs[sel].max() + 2, W)
            blk, f = v[y0:y1, x0:x1].copy(), filled[y0:y1, x0:x1]
            h, w = f.shape
            for _ in range(400):
                p = np.pad(blk, ((1, 1), (1, 1), (0, 0)), mode='edge')
                m = (p[:h, 1:w + 1] + p[2:, 1:w + 1] + p[1:h + 1, :w] + p[1:h + 1, 2:]) / 4
                blk[f] = m[f]
            v[y0:y1, x0:x1] = blk
    return v


def lanczos_matrix(n, m):
    """m x n Lanczos-3 resampling weights; the kernel is widened by the scale factor when shrinking (antialiased)."""
    s = n / m
    fs = max(s, 1.0)
    support = 3.0 * fs
    W = np.zeros((m, n))
    for i in range(m):
        c = (i + 0.5) * s
        lo, hi = max(int(c - support + 0.5), 0), min(int(c + support + 0.5), n)
        x = (np.arange(lo, hi) - c + 0.5) / fs
        w = np.where(np.abs(x) < 3, np.sinc(x) * np.sinc(x / 3), 0.0)
        W[i, lo:hi] = w / w.sum()
    return W


def resize(img, m):
    W = lanczos_matrix(img.shape[0], m)
    out = np.stack([W @ img[..., k] @ W.T for k in range(3)], 2)
    return np.clip(np.floor(out + 0.5), 0, 255).astype(np.uint8)


def clean_square(name, box, r):
    rgb, alpha, names = read_png(os.path.join(SRC, name))
    if (rgb.shape[1], rgb.shape[0]) != SOURCE_SIZES[name]:
        raise SystemExit('%s: expected %r, got %dx%d' % (name, SOURCE_SIZES[name], rgb.shape[1], rgb.shape[0]))
    if alpha is not None and alpha.min() != 255:
        raise SystemExit('%s: has real transparency; the recipe expects an opaque image' % name)
    x0, y0, x1, y1 = box
    sq = rgb[y0:y1, x0:x1].astype(float)
    if sq.shape[0] != sq.shape[1]:
        raise SystemExit('%s: crop is not square: %r' % (name, sq.shape))
    if r:
        sq = bleed(sq, rounded_inside(sq.shape[0], r))
    return sq

# ---------------------------------------------------------------- checks

def light_neutral(px):
    px = px.astype(int)
    return (px.max(-1) - px.min(-1) <= 8) & (px.min(-1) >= 120)


def corner_zones(n, side):
    c = np.arange(n)
    e = (c < side) | (c >= n - side)
    return e[:, None] & e[None, :]


def check(ident, sq, r, outs, out_dir):
    fails = []
    n = sq.shape[0]
    # every file is there, at its size, opaque RGBA with no extra chunks, and holds exactly what was computed
    for fname, size in SIZES:
        rgb, alpha, names = read_png(os.path.join(out_dir, ident, fname))
        if rgb.shape != (size, size, 3): fails.append('%s/%s: size %r' % (ident, fname, rgb.shape))
        if alpha is None or alpha.min() != 255: fails.append('%s/%s: not opaque RGBA' % (ident, fname))
        if names != ['IHDR', 'IDAT', 'IEND']: fails.append('%s/%s: chunks %r' % (ident, fname, names))
        if not np.array_equal(rgb, outs[size]): fails.append('%s/%s: read-back differs' % (ident, fname))
    if r:
        # the pixels the corners were filled from (the last 1.5 px inside the radius) hold no background. Limits are
        # the tiles' own brightest / darkest edge pixels plus a little; a white fringe or the rim breaks them.
        src = (corner_dist(n, r) <= r) & (corner_dist(n, r) > r - 1.5) & corner_zones(n, r + 2)
        g = sq.mean(-1)
        if ident == 'classic' and sq.min(-1)[src].max() > 120:       # its top gloss row: min channel ~105
            fails.append('classic: corner source pixel min channel %.0f > 120 (white fringe)' % sq.min(-1)[src].max())
        if ident == '2013' and g[src].max() > 112:                    # its lit top edge: ~110
            fails.append('2013: corner source pixel %.0f > 112 (white fringe)' % g[src].max())
        if ident == 'flat':                                            # vertical grey ramp, about #484848 to #1d1d1d
            ys = np.arange(n)
            band = np.concatenate([g[:, 2:14], g[:, n - 14:n - 2]], 1).mean(1)
            mid = (ys >= r) & (ys < n - r)
            k, b = np.polyfit(ys[mid], band[mid], 1)
            dev = g - (b + k * ys)[:, None]
            if dev[src].min() < -16 or dev[src].max() > 20:
                fails.append('flat: corner source pixel off its row grey by %.0f / +%.0f (rim or checkerboard)'
                             % (dev[src].min(), dev[src].max()))
    if ident == 'flat':
        # no trace of the fake checkerboard: no light neutral pixel at all, full size or scaled (spec)
        for what, px in (('cleaned', np.floor(sq + 0.5)), ('114', outs[114]), ('57', outs[57]),
                         ('58', outs[58]), ('29', outs[29])):
            k = int(light_neutral(px).sum())
            if k: fails.append('flat %s: %d light neutral (checkerboard) pixels' % (what, k))
    if ident in ('classic', '2013'):
        # no near-white pixel in the four corner zones at 114 (spec)
        k = int(((outs[114].min(-1) >= 230) & corner_zones(114, round(0.1754 * 114))).sum())
        if k: fails.append('%s 114: %d near-white corner pixels' % (ident, k))
    return fails

# ---------------------------------------------------------------- preview

def mask(size, ss=4):
    S = size * ss
    inside = rounded_inside(S, 0.1754 * S).astype(float)
    return inside.reshape(size, ss, size, ss).mean((1, 3))


def preview(path, results):
    pad, size = 16, 114
    a = mask(size)[..., None]
    rows = []
    for bg in ((235, 235, 235), (28, 28, 30)):
        row = np.zeros((size + 2 * pad, pad + len(results) * (size + pad), 3)) + bg
        for i, (ident, outs) in enumerate(results):
            x = pad + i * (size + pad)
            tile = row[pad:pad + size, x:x + size]
            row[pad:pad + size, x:x + size] = outs[size] * a + tile * (1 - a)
        rows.append(row)
    write_png(path, np.clip(np.floor(np.concatenate(rows, 0) + 0.5), 0, 255).astype(np.uint8))

# ---------------------------------------------------------------- main

def main(argv):
    args, prev = [], None
    it = iter(argv)
    for a in it:
        if a == '--preview': prev = next(it)
        else: args.append(a)
    out_dir = args[0] if args else os.path.join(HERE, '..', 'Resources', 'AppIcons')
    results, fails = [], []
    for ident, name, box, r in ICONS:
        sq = clean_square(name, box, r)
        outs = {size: resize(sq, size) for _, size in SIZES}      # every size straight from the cleaned square
        os.makedirs(os.path.join(out_dir, ident), exist_ok=True)
        for fname, size in SIZES:
            write_png(os.path.join(out_dir, ident, fname), outs[size])
        fails += check(ident, sq, r, outs, out_dir)
        results.append((ident, outs))
        print('%-8s %s crop %s -> %d, corner bleed r %s' % (ident, name, box, sq.shape[0], r or 'none'))
    if prev:
        preview(prev, results)
        print('preview:', prev)
    if fails:
        print('\n'.join('FAIL ' + f for f in fails))
        raise SystemExit(1)
    print('ALL OK: %d files in %s' % (len(ICONS) * len(SIZES), os.path.normpath(out_dir)))


if __name__ == '__main__':
    main(sys.argv[1:])
