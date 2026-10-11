'use strict';
// qr.js + png.js (R3g, D22): the Jam QR code in plain JavaScript for the Windows bridge (Docker keeps qrencode).
//  - Golden symbols: made with qrencode 4.1.1 (`qrencode -8 -l <ecl> -m 0`, the bridge image's version) for made-up
//    links; ours must be identical module for module, and our mask choice must stay the same.
//  - Every version 1-40 and every level: the symbol decodes back to the text (function patterns, format and version
//    bits, Reed-Solomon syndromes all zero, the byte-mode payload), independent of qrencode.
//  - With qrencode on PATH (Linux, the Docker image): random links compared live, modulo the mask choice (qrencode's
//    mask scoring differs from the standard's in places; any mask is valid).
//  - qrPng(): a valid PNG (CRCs, size, pixels) drawn like the bridge's qrencode call (12 px modules, 2-module margin).
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { encode, qrPng, QrCode, numDataCodewords, numRawDataModules } = require('../src/qr');
const { bitmap, crc32 } = require('../src/png');
const { hasCommand } = require('./support/platform');

const VECTORS = [
  { text: 'https://open.spotify.com/socialsession/AbCdEfGhIjKlMnOpQrStUv', ecl: 'M', version: 4, mask: 4, rows:
    'febfe33f8 8238dea08 ba51deae8 bab0742e8 baf7a12e8 82f6f4208 feaaaabf8 00836d800 8b984efc8 29c3ebc60 020729650 e924e4e10 cafccfac8 1126d0620 da89a7730 7cc76fe00 e70046ad0 88e9a5470 234347950 d1ce5fd18 2f7d9aad8 d575c5530 362d69e30 395ef4610 db8a6ef80 00f7a68a0 feef4ead0 8216e4880 baa0cefc0 ba4ad0b80 ba7ba5780 8266f7000 fef6cfc08' },
  { text: 'https://spotify.link/aBcDeFgHiJk', ecl: 'M', version: 3, mask: 2, rows:
    'fe6f2bf8 8277ea08 baf522e8 ba8342e8 ba99bae8 82906a08 feaaabf8 008a9800 be5093e0 a55f3788 ff778e80 05a531d0 ef1b5160 c4d9bf88 0ea80160 19429f10 7f701060 99973ba8 9677cea0 89d42090 86825fb8 00f8a8f8 fe495ae0 82921890 bae00fb0 bacbe578 baebbff0 821d2b50 fec056e0' },
  { text: 'Encore', ecl: 'L', version: 1, mask: 4, rows:
    'fe8bf8 82d208 bafae8 baaae8 ba7ae8 82aa08 feabf8 000000 ce0978 b16e50 8e6c70 703910 721388 009838 fe13b0 82e688 bacf08 ba0ed8 ba6ca0 82d900 feb248' },
  { text: 'x'.repeat(200), ecl: 'M', version: 10, mask: 0, rows:
    'fe626deeeeeb3f8 82a74f3bbbbd208 ba42021191132e8 ba2728c544412e8 ba8a25bfeeed2e8 82273d233bba208 feaaaaaaaaaabf8 0029d9a2eeef800 aa56937fbbbb090 ddeed8711110168 d3d7c4a44444c38 602b5f86eeefe90 8bd694cbbbbb3c0 69ee5ca11110168 c397c40c4444c38 584f5caeeeefe90 b7d6953bbbbb3c0 49c844711110168 e7d77ea44444c38 44cf158aeeefe90 b6769b59bbbb3c0 44507a731110168 a7bf1ea24444c38 4527758f6eefe90 b70ebb5b3bbb3c0 044852719110168 efb73ebf4444fb8 88af7de2eeef890 4a8e3b2bbbbaac0 78d7522311108e8 bfb33efe4445fb8 c8b97fbaeeeeb90 6b0a3fb1bbba940 b857d5451111470 8ad0b9ce44456b0 f9ba797aeeeeb90 5f6a3929bbba948 9432dc6d1111468 8ef02ca644456b8 ddba29aaeeeeb90 5f123331bbba940 9c62fc451111468 ca886cce44456b8 d5d261bb6eeeb90 5b1a3332bbba940 5cd2bc411111468 a68014ca44456b8 f84061b8eeeeb90 0287333fbbbafc0 00ce9c6311118e8 fe0a10aa4444ab8 8249e1e2eeef890 ba8232ffbbbbfc0 ba4f18af1110ef0 bacd901a4445ba8 824ce2d0eeef110 fea5b965bbba458' },
  { text: 'Encore Bridge test vector', ecl: 'H', version: 4, mask: 1, rows:
    'fe759ebf8 829f52a08 baa7972e8 baa1562e8 bad43b2e8 829c27208 feaaaabf8 000a5b800 27ae50df0 bd586bb48 269d67a68 41d012e08 cadf2f2d8 3971b3a00 0b5ae7aa8 d54828410 d668f5b30 094cf9b40 3734f5920 c9c253348 1f24f9140 04172a138 dbda531a8 1d6b58758 df3f57fd8 00b0a5898 feb078ae8 82a5a58c8 ba494df98 ba19a1cf0 ba88018d8 8232a4ce0 fe032ba68' },
];

const bitsOf = (hex, n) => [...hex].map((h) => parseInt(h, 16).toString(2).padStart(4, '0')).join('').slice(0, n);
const rowsOf = (q) => q.modules.map((r) => r.map((c) => (c ? '1' : '0')).join(''));

test('golden symbols from qrencode: identical module for module, the same mask chosen', () => {
  for (const v of VECTORS) {
    const auto = encode(v.text, { ecl: v.ecl });
    assert.equal(auto.version, v.version, v.text);
    assert.equal(auto.mask, v.mask, `mask for ${v.text.slice(0, 30)}`);
    const want = v.rows.split(' ').map((h) => bitsOf(h, auto.size));
    assert.equal(want.length, auto.size);
    assert.deepEqual(rowsOf(auto), want, v.text.slice(0, 40));
  }
});

// ---- an independent reader: function modules, format bits, version bits, codewords, RS syndromes, payload
const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; }
function functionMap(version, ecl) {
  const q = Object.create(QrCode.prototype);
  q.version = version;
  q.ecl = ecl;
  q.size = version * 4 + 17;
  q.modules = Array.from({ length: q.size }, () => new Array(q.size).fill(false));
  q.isFunction = Array.from({ length: q.size }, () => new Array(q.size).fill(false));
  q.drawFunctionPatterns();
  return q.isFunction;
}
function maskBit(mask, x, y) {
  return [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    ((x * y) % 2) + ((x * y) % 3) === 0, (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][mask];
}
function decode(q, ecl) {
  const n = q.size;
  const m = (x, y) => q.modules[y][x];
  // finder pattern (top left) and timing
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    assert.equal(m(x, y), d !== 2, `finder ${x},${y}`);
  }
  for (let i = 8; i < n - 8; i++) { assert.equal(m(i, 6), i % 2 === 0); assert.equal(m(6, i), i % 2 === 0); }
  assert.equal(m(8, n - 8), true, 'the dark module');
  // format bits (first copy): BCH-valid and naming this level and the mask
  let fmt = 0;
  const fpos = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  fpos.forEach(([x, y], i) => { if (m(x, y)) fmt |= 1 << i; });
  fmt ^= 0x5412;
  let rem = fmt;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  assert.equal(rem, 0, 'format BCH');
  assert.equal(fmt >>> 13, ECL_BITS[ecl]);
  const mask = (fmt >>> 10) & 7;
  assert.equal(mask, q.mask);
  // version bits (v7+): BCH-valid and naming the version
  if (q.version >= 7) {
    let vb = 0;
    for (let i = 0; i < 18; i++) if (m(n - 11 + (i % 3), Math.floor(i / 3))) vb |= 1 << i;
    assert.equal(vb >>> 12, q.version);
    let r = vb;
    for (let i = 17; i >= 12; i--) if ((r >>> i) & 1) r ^= 0x1f25 << (i - 12);
    assert.equal(r, 0, 'version BCH');
  }
  // codewords in placement order, unmasked
  const fn = functionMap(q.version, ecl);
  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
      if (!fn[y][x]) bits.push(m(x, y) !== maskBit(mask, x, y) ? 1 : 0);
    }
  }
  const raw = Math.floor(numRawDataModules(q.version) / 8);
  const cw = [];
  for (let i = 0; i < raw; i++) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]; cw.push(b); }
  // de-interleave into blocks; each block is a Reed-Solomon codeword (all syndromes zero)
  const e = ECL_INDEX[ecl];
  const numBlocks = [[-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]][e][q.version];
  const dataCw = numDataCodewords(q.version, e);
  const eccLen = (raw - dataCw) / numBlocks;
  assert.ok(Number.isInteger(eccLen));
  const shortData = Math.floor(dataCw / numBlocks);
  const numLong = dataCw % numBlocks;
  const blocks = Array.from({ length: numBlocks }, (_, i) => ({ data: [], ecc: [], len: shortData + (i >= numBlocks - numLong ? 1 : 0) }));
  let k = 0;
  for (let i = 0; i < shortData + 1; i++) for (const b of blocks) if (i < b.len) b.data.push(cw[k++]);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) b.ecc.push(cw[k++]);
  assert.equal(k, raw);
  for (const b of blocks) {
    const word = [...b.data, ...b.ecc];
    let alpha = 1;
    for (let s = 0; s < eccLen; s++) {                 // syndrome s: the codeword polynomial at alpha^s
      let acc = 0;
      for (const c of word) acc = gfMul(acc, alpha) ^ c;
      assert.equal(acc, 0, `syndrome ${s}`);
      alpha = gfMul(alpha, 2);
    }
  }
  // the payload: byte mode, the count, the bytes, then the terminator / padding
  const data = blocks.flatMap((b) => b.data);
  const dbits = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
  let p = 0;
  const read = (len) => { let v = 0; for (let i = 0; i < len; i++) v = (v << 1) | dbits[p++]; return v; };
  assert.equal(read(4), 4, 'byte mode');
  const count = read(q.version <= 9 ? 8 : 16);
  const out = Buffer.alloc(count);
  for (let i = 0; i < count; i++) out[i] = read(8);
  return out;
}

test('every version and level decodes back to the text (function patterns, format/version bits, RS, payload)', () => {
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    for (let v = 1; v <= 40; v++) {
      const cap = numDataCodewords(v, ECL_INDEX[ecl]) - (v <= 9 ? 2 : 3);
      const text = Array.from({ length: Math.max(1, cap - (v % 3)) }, (_, i) => String.fromCharCode(33 + ((i * 7 + v) % 90))).join('');
      const q = encode(text, { ecl, minVersion: v, maxVersion: v });
      assert.equal(q.version, v);
      assert.equal(decode(q, ecl).toString('latin1'), text, `${ecl} v${v}`);
    }
  }
  // capacities from the standard
  assert.deepEqual([numDataCodewords(1, 1), numDataCodewords(10, 1), numDataCodewords(40, 0), numDataCodewords(40, 1), numDataCodewords(40, 2), numDataCodewords(40, 3)],
    [16, 216, 2956, 2334, 1666, 1276]);
  // UTF-8 text and the smallest version that fits
  const q = encode('Jam für alle ✓', { ecl: 'M' });
  assert.equal(decode(q, 'M').toString('utf8'), 'Jam für alle ✓');
  assert.throws(() => encode('x'.repeat(2400), { ecl: 'M' }), /too much data/);
  assert.throws(() => encode('x', { ecl: 'Z' }), /ecl/);
});

test('live against qrencode (Linux): random links, the same symbol modulo the mask', { skip: !hasCommand('qrencode', ['--version']) && 'qrencode is not on PATH' }, () => {
  let same = 0;
  for (let i = 0; i < 60; i++) {
    let id = '';
    for (let j = 0; j < 22; j++) id += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)];
    const link = i % 2 ? `https://open.spotify.com/socialsession/${id}` : `https://spotify.link/${id.slice(0, 11)}?si=${id}`;
    const ref = execFileSync('qrencode', ['-8', '-l', 'M', '-m', '0', '-t', 'ASCII', '-o', '-', link], { encoding: 'utf8' })
      .split('\n').filter((l) => l.length).map((l) => { let r = ''; for (let x = 0; x < l.length; x += 2) r += l[x] === '#' ? '1' : '0'; return r; });
    const auto = encode(link, { ecl: 'M' });
    let hit = -1;
    for (let mk = 0; mk < 8 && hit < 0; mk++) if (rowsOf(encode(link, { ecl: 'M', mask: mk })).join() === ref.join()) hit = mk;
    assert.notEqual(hit, -1, link);
    if (hit === auto.mask) same++;
  }
  assert.ok(same > 0);
});

test('qrPng: a valid 1-bit PNG, 12 px modules with a 2-module light margin', () => {
  const link = VECTORS[0].text;
  const png = qrPng(link);
  const q = encode(link, { ecl: 'M' });
  const side = (q.size + 4) * 12;
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.toString('ascii', o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + len);
    assert.equal(png.readUInt32BE(o + 8 + len), crc32(png.subarray(o + 4, o + 8 + len)), `${type} CRC`);
    assert.equal(png.readUInt32BE(o + 8 + len), zlib.crc32 ? zlib.crc32(png.subarray(o + 4, o + 8 + len)) : png.readUInt32BE(o + 8 + len), 'the same CRC as zlib');
    chunks.push({ type, data });
    o += 12 + len;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9], ihdr[12]], [side, side, 1, 0, 0]);
  const raw = zlib.inflateSync(chunks[1].data);
  const rowBytes = Math.ceil(side / 8);
  assert.equal(raw.length, (rowBytes + 1) * side);
  const black = (x, y) => ((raw[y * (rowBytes + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1) === 0;
  for (let y = 0; y < side; y += 5) for (let x = 0; x < side; x += 5) {
    assert.equal(black(x, y), q.dark(Math.floor(x / 12) - 2, Math.floor(y / 12) - 2), `pixel ${x},${y}`);
  }
  assert.equal(black(0, 0), false, 'the margin is light');
  assert.equal(black(24, 24), true, 'the finder pattern starts after the margin');
  assert.ok(png.length < 8000, `small (${png.length} bytes)`);
  // the PNG writer on its own
  const tiny = bitmap(3, 2, (x, y) => x === y);
  assert.equal(zlib.inflateSync(tiny.subarray(8 + 25 + 8, tiny.length - 12 - 4)).length, 2 * 2);
  assert.throws(() => bitmap(0, 1, () => false), /size/);
});
