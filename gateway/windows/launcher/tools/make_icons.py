# Generates the Windows icons for Encore Bridge (the tray launcher's exe icon, its three tray states and the
# installer icon). Same artwork as the app icon (app/tools/make_art.py): a vinyl record with a green label on a green
# gradient, here with rounded corners so it sits well in the notification area.
# Needs numpy only. Usage: python make_icons.py [out_dir]   (default: ../assets). Every file is rewritten; the output
# is deterministic, so re-running it on an unchanged script changes nothing.
#   encore.ico          16..256 px  the exe icon (winres/winres.json), the installer and its uninstaller
#   tray.ico            16..48 px   running normally
#   tray-attention.ico  16..48 px   needs you (sign in, first-run setup, an error): an amber dot
#   tray-off.ico        16..48 px   starting or stopped: grey
#   encore-256.png      256 px      the same artwork as a PNG (for docs)
import numpy as np, os, struct, sys, zlib

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')


def hexc(h):
    return np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255], float)


def record(canvas, cx, cy, r, ss):
    """vinyl record with a green label (the app icon's), drawn onto a float RGB canvas in supersampled coords"""
    H, W, _ = canvas.shape
    y, x = np.mgrid[0:H, 0:W].astype(float)
    d = np.hypot(x - cx, y - cy)
    disc = d <= r
    canvas[disc] = hexc(0x0b0f0c)
    for k in np.arange(0.46, 0.97, 0.075):                          # grooves
        ring = np.abs(d - r * k) <= 0.6 * ss
        canvas[ring & disc] = canvas[ring & disc] * 0.55 + hexc(0x2a332d) * 0.45
    ang = np.arctan2(y - cy, x - cx)
    shine = disc & (d > r * 0.42) & (np.abs(ang + 2.2) < 0.35)
    canvas[shine] = canvas[shine] * 0.75 + np.array([255, 255, 255.]) * 0.08
    lab = d <= r * 0.36
    canvas[lab] = hexc(0x1ed760)
    canvas[d <= r * 0.075] = hexc(0x0b0f0c)


def art(size, variant='normal'):
    """RGBA uint8 array (size x size)"""
    ss = 8 if size <= 64 else 4
    S = size * ss
    y, x = np.mgrid[0:S, 0:S].astype(float)
    t = (x + y) / (2 * S)
    c = hexc(0x2be06c) * (1 - t)[..., None] + hexc(0x0d6b31) * t[..., None]
    c = np.ascontiguousarray(c)
    # small sizes: a bigger record (fewer, wider grooves would read as noise anyway)
    record(c, S * 0.5, S * 0.5, S * (0.44 if size <= 24 else 0.40), ss)
    # rounded-square mask
    rad = S * 0.22
    qx = np.clip(np.abs(x + 0.5 - S / 2) - (S / 2 - rad), 0, None)
    qy = np.clip(np.abs(y + 0.5 - S / 2) - (S / 2 - rad), 0, None)
    alpha = (np.hypot(qx, qy) <= rad).astype(float)
    if variant == 'off':
        g = c @ np.array([0.299, 0.587, 0.114])
        c = (g[..., None] * 0.55 + 70) * np.ones(3)
    if variant == 'attention':
        dr = S * 0.25
        dcx, dcy = S - dr - S * 0.01, S - dr - S * 0.01
        dd = np.hypot(x + 0.5 - dcx, y + 0.5 - dcy)
        ring = dd <= dr
        c[ring] = hexc(0x1a1a1a)
        c[dd <= dr - max(S * 0.06, ss)] = hexc(0xffb020)
        alpha = np.maximum(alpha, ring.astype(float))
    rgb = c.reshape(size, ss, size, ss, 3).mean(axis=(1, 3))
    a = alpha.reshape(size, ss, size, ss).mean(axis=(1, 3))
    # un-premultiply is not needed: colours were averaged with the mask applied below
    cm = (c * alpha[..., None]).reshape(size, ss, size, ss, 3).mean(axis=(1, 3))
    rgb = np.where(a[..., None] > 0, cm / np.maximum(a[..., None], 1e-6), rgb)
    out = np.concatenate([np.clip(rgb, 0, 255), (a * 255)[..., None]], axis=2)
    return np.round(out).astype(np.uint8)


def png_bytes(rgba):
    h, w, _ = rgba.shape
    raw = b''.join(b'\x00' + rgba[y].tobytes() for y in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def dib_bytes(rgba):
    """32-bit BGRA DIB for an ICO entry (bottom-up rows, then an all-zero AND mask; alpha does the masking)"""
    h, w, _ = rgba.shape
    hdr = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
    bgra = rgba[::-1][..., [2, 1, 0, 3]].tobytes()
    mask_row = ((w + 31) // 32) * 4
    return hdr + bgra + b'\x00' * (mask_row * h)


def ico(path, sizes, variant='normal'):
    images = []
    for s in sizes:
        rgba = art(s, variant)
        images.append((s, png_bytes(rgba) if s >= 256 else dib_bytes(rgba)))
    head = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b'', b''
    for s, data in images:
        entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    with open(path, 'wb') as f:
        f.write(head + entries + blobs)


os.makedirs(OUT, exist_ok=True)
TRAY = [16, 20, 24, 32, 40, 48]
ico(os.path.join(OUT, 'encore.ico'), [16, 20, 24, 32, 40, 48, 64, 256])
ico(os.path.join(OUT, 'tray.ico'), TRAY)
ico(os.path.join(OUT, 'tray-attention.ico'), TRAY, 'attention')
ico(os.path.join(OUT, 'tray-off.ico'), TRAY, 'off')
with open(os.path.join(OUT, 'encore-256.png'), 'wb') as f:
    f.write(png_bytes(art(256)))
print('icons written to', os.path.normpath(OUT))
