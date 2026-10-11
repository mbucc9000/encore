# Generates Encore's app icon and launch images (no image libraries needed: numpy + zlib PNG writer).
# 1.0 (Drop 3c, DESIGN-5 §2.3 C5): also SetupIcon@2x.png, the same icon at 152 px (76 pt at @2x) for the pairing screen's
# centred icon (ENSetupViewController; -[ENTheme setupIconImage:] rounds it to radius 16 and bakes its shadow). It is not
# a home-screen icon (Info.plist lists only Icon.png / Icon@2x.png).
# 1.1 (RELEASE-PLAN R2c, 3.5-inch support): the 3.5-inch launch images too, the same picture at the shorter height:
# Default@2x.png (640 x 960, iPhone 4 / 4S, iPod touch 4) and Default.png (320 x 480, the @2x one averaged 2 x 2).
# Default-568h@2x.png (640 x 1136) stays the 4-inch one, pixel for pixel as before.
# Usage: python make_art.py [out_dir] (default ../Resources); every file is rewritten, the existing four with the same
# pixels as before.
import numpy as np, zlib, struct, os, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'Resources')

def png(path, rgba):
    h, w, _ = rgba.shape
    raw = b''.join(b'\x00' + rgba[y].astype(np.uint8).tobytes() for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)

def hexc(h): return np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255], float)

def record(canvas, cx, cy, r, ss):
    """vinyl record with a green label, drawn onto float RGB canvas (supersampled coords)"""
    H, W, _ = canvas.shape
    y, x = np.mgrid[0:H, 0:W].astype(float)
    d = np.hypot(x - cx, y - cy)
    disc = d <= r
    canvas[disc] = hexc(0x0b0f0c)
    for k in np.arange(0.46, 0.97, 0.075):                         # grooves
        ring = np.abs(d - r * k) <= 0.6 * ss
        canvas[ring & disc] = canvas[ring & disc] * 0.55 + hexc(0x2a332d) * 0.45
    ang = np.arctan2(y - cy, x - cx)
    shine = disc & (d > r * 0.42) & (np.abs(ang + 2.2) < 0.35)     # a soft highlight sweep
    canvas[shine] = canvas[shine] * 0.75 + np.array([255, 255, 255.]) * 0.08
    shine2 = disc & (d > r * 0.42) & (np.abs(ang - 0.95) < 0.3)
    canvas[shine2] = canvas[shine2] * 0.8 + np.array([255, 255, 255.]) * 0.06
    lab = d <= r * 0.36
    canvas[lab] = hexc(0x1ed760)
    canvas[d <= r * 0.075] = hexc(0x0b0f0c)

def icon(size):
    """1.1 icon: iOS 6 style. A deep green tile with a soft glow, a large glossy vinyl record with a lime label and a soft
    shadow, the classic top gloss, and the rounded corners baked in (radius 0.155 x size, just inside iOS 6's own mask,
    so it looks the same masked or not: Cydia, Filza, the setup screen, the docs)."""
    ss = 4
    S = size * ss
    y, x = np.mgrid[0:S, 0:S].astype(float) + 0.5
    u, v = x / S, y / S
    # tile: vertical green gradient + a soft glow behind the record's upper left
    top, bot = hexc(0x2f7a32), hexc(0x0c2810)
    c = top * (1 - v)[..., None] + bot * v[..., None]
    glow = np.exp(-(((u - 0.38) ** 2 + (v - 0.30) ** 2) / 0.09))
    c = c + (hexc(0x5fd35a) - c) * (0.35 * glow)[..., None]
    # the record's soft shadow (down and a little right)
    cx, cy, r = 0.5 * S, 0.515 * S, 0.405 * S
    ds = np.hypot(x - cx - 0.012 * S, y - cy - 0.03 * S)
    shadow = np.clip(1 - (ds - r * 0.92) / (0.09 * S), 0, 1) ** 1.6
    c = c * (1 - 0.55 * shadow)[..., None]
    # the record
    d = np.hypot(x - cx, y - cy)
    disc = d <= r
    ang = np.arctan2(y - cy, x - cx)
    vinyl = np.zeros_like(c) + hexc(0x0c0f0d)
    rr = d / r
    grooves = 0.5 + 0.5 * np.cos(rr * 2 * np.pi * 15)                          # fine grooves
    vinyl = vinyl + hexc(0x1d2620) * (0.55 * grooves * (rr > 0.44))[..., None]
    for a0, w, k in ((-2.25, 0.42, 0.22), (0.89, 0.38, 0.16)):                     # two light reflections
        da = np.angle(np.exp(1j * (ang - a0)))
        sweep = np.exp(-(da / w) ** 2) * (rr > 0.44) * (rr < 0.985)
        vinyl = vinyl + (np.array([255, 255, 255.]) - vinyl) * (k * sweep)[..., None]
    edge = np.clip((rr - 0.965) / 0.035, 0, 1) * disc                              # a faint rim
    vinyl = vinyl + hexc(0x3a4a3f) * (0.6 * edge)[..., None]
    c[disc] = vinyl[disc]
    # the label: lime, lit from the upper left, with a darker ring and the spindle hole
    lab = rr <= 0.37
    lg = np.clip((u - (cx / S - 0.15)) * 0.9 + (v - (cy / S - 0.15)) * 0.9, 0, 1)
    labc = hexc(0x8ff06b) * (1 - lg)[..., None] + hexc(0x23b043) * lg[..., None]
    c[lab] = labc[lab]
    ring = (rr > 0.335) & (rr <= 0.37)
    c[ring] = c[ring] * 0.62
    inner = (rr > 0.10) & (rr <= 0.115)
    c[inner] = c[inner] * 0.78
    c[rr <= 0.055] = hexc(0x0c0f0d)
    # the iOS 6 gloss: a bright band over the top, ending in a soft curve
    gl = 0.35 + 0.65 * np.clip(1 - v / 0.5, 0, 1) ** 1.3
    boundary = 0.49 - 0.17 * ((u - 0.5) * 2) ** 2                                # lower in the middle, like iOS 6
    curve = np.clip((boundary - v) / 0.03, 0, 1)                                    # feathered edge
    c = c + (np.array([255, 255, 255.]) - c) * (0.17 * gl * curve)[..., None]
    c = np.clip(c, 0, 255)
    # rounded corners (anti-aliased by the supersampling)
    R = 0.155 * S
    qx = np.maximum(np.abs(x - S / 2) - (S / 2 - R), 0)
    qy = np.maximum(np.abs(y - S / 2) - (S / 2 - R), 0)
    inside = (np.hypot(qx, qy) <= R).astype(float)
    small = c.reshape(size, ss, size, ss, 3)
    a = inside.reshape(size, ss, size, ss).mean(axis=(1, 3))
    # premultiplied average so the edge pixels don't pick up dark fringes
    rgb = (small * inside.reshape(size, ss, size, ss)[..., None]).mean(axis=(1, 3)) / np.maximum(a, 1e-6)[..., None]
    return np.concatenate([np.clip(rgb, 0, 255), (a * 255)[..., None]], axis=2)

def launch(H=1136):
    """the @2x launch image, 640 px wide and H px tall (1136: 4-inch; 960: 3.5-inch): the status bar's 40 px, the green
    nav bar, the record centred in the rest (30 px above the middle)"""
    W = 640
    c = np.zeros((H, W, 3)) + hexc(0x0d1310)
    nav = slice(40, 128)                                           # under the status bar: a green nav bar like the app's
    g = np.linspace(0, 1, 88)[:, None]
    c[nav] = (hexc(0x1c9a4c) * (1 - g) + hexc(0x117037) * g)[:, None, :]
    c[127] = hexc(0x0a4a24)
    ss = 3
    box = np.zeros((300 * ss, 300 * ss, 3)) + hexc(0x0d1310)
    record(box, 150 * ss, 150 * ss, 110 * ss, ss)
    small = box.reshape(300, ss, 300, ss, 3).mean(axis=(1, 3))
    top = 128 + (H - 128 - 300) // 2 - 30
    c[top:top + 300, 170:470] = small
    a = np.full((H, W, 1), 255.)
    return np.concatenate([c, a], axis=2)

png(os.path.join(OUT, 'Icon.png'), icon(57))
png(os.path.join(OUT, 'Icon@2x.png'), icon(114))
png(os.path.join(OUT, 'Default-568h@2x.png'), launch())
tall35 = launch(960)
png(os.path.join(OUT, 'Default@2x.png'), tall35)
png(os.path.join(OUT, 'Default.png'), tall35.reshape(480, 2, 320, 2, 4).mean(axis=(1, 3)).round())
png(os.path.join(OUT, 'SetupIcon@2x.png'), icon(152))
print('art written')
