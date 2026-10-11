'use strict';
// QR codes in plain JavaScript, for the Jam invite on Windows (D22: Docker keeps using qrencode). Byte mode only,
// which is all a link needs; versions 1-40, error correction L/M/Q/H, the mask chosen by the standard's penalty rules.
// qrPng(text) draws it as a PNG the way the bridge's qrencode call does (12 px per module, a 2-module margin).
//
// The encoder follows Project Nayuki's QR Code generator library, which is under the MIT License:
//
//   Copyright (c) Project Nayuki. (MIT License)
//   https://www.nayuki.io/page/qr-code-generator-library
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//   - The above copyright notice and this permission notice shall be included in all copies or substantial portions
//     of the Software.
//   - The Software is provided "as is", without warranty of any kind, express or implied, including but not limited
//     to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall
//     the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of
//     contract, tort or otherwise, arising from, out of or in connection with the Software or the use or other
//     dealings in the Software.
const { bitmap } = require('./png');

// error correction level -> [index into the tables, the 2 format bits]
const ECL = { L: [0, 1], M: [1, 0], Q: [2, 3], H: [3, 2] };

// per level (L, M, Q, H), per version (index 0 unused)
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

// modules that hold data or error correction (everything but the function patterns), in bits
function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const numDataCodewords = (ver, e) =>
  Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];

// ---- Reed-Solomon over GF(2^8) with the polynomial 0x11D
function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor); });
  }
  return result;
}

// ---- the symbol
class QrCode {
  constructor(version, e, dataCodewords, mask) {
    this.version = version;
    this.ecl = Object.keys(ECL).find((k) => ECL[k][0] === e);
    this.e = e;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.drawFunctionPatterns();
    this.drawCodewords(this.addEccAndInterleave(dataCodewords));
    if (mask === -1) {
      let min = Infinity;
      for (let i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const p = this.penalty();
        if (p < min) { mask = i; min = p; }
        this.applyMask(i);          // XOR again: undone
      }
    }
    this.mask = mask;
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = null;
  }

  dark(x, y) { return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x]; }

  setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {             // timing patterns
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);
    const pos = this.alignmentPatternPositions();
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // not on the three finder corners
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.drawAlignmentPattern(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0);       // reserves the area; drawn for real once the mask is known
    this.drawVersion();
  }

  drawFormatBits(mask) {
    const data = (ECL[this.ecl][1] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, this.size - 8, true);           // the dark module
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;                     // 18 bits
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  alignmentPatternPositions() {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  addEccAndInterleave(data) {
    const ver = this.version;
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[this.e][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[this.e][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const blocks = [];
    const div = rsDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);   // skip the short blocks' pad
      });
    }
    return result;
  }

  drawCodewords(data) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                    // the vertical timing pattern
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new RangeError('bad mask');
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  penalty() {
    const size = this.size;
    const m = this.modules;
    let result = 0;
    for (let pass = 0; pass < 2; pass++) {          // rows, then columns
      for (let a = 0; a < size; a++) {
        let runColor = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const c = pass === 0 ? m[a][b] : m[b][a];
          if (c === runColor) {
            run++;
            if (run === 5) result += PENALTY_N1;
            else if (run > 5) result++;
          } else {
            this.addHistory(run, history);
            if (!runColor) result += this.countPatterns(history) * PENALTY_N3;
            runColor = c;
            run = 1;
          }
        }
        result += this.terminateAndCount(runColor, run, history) * PENALTY_N3;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += PENALTY_N2;
      }
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  }

  countPatterns(h) {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  }

  terminateAndCount(runColor, run, h) {
    if (runColor) { this.addHistory(run, h); run = 0; }
    run += this.size;                               // the light border after the last run
    this.addHistory(run, h);
    return this.countPatterns(h);
  }

  addHistory(run, h) {
    if (h[0] === 0) run += this.size;               // the light border before the first run
    h.pop();
    h.unshift(run);
  }
}

// text (a string, as UTF-8) or bytes -> a QrCode. opts: ecl 'L'|'M'|'Q'|'H' (default M, as the bridge's qrencode
// call), minVersion/maxVersion, mask 0-7 (default: the lowest penalty).
function encode(data, { ecl = 'M', minVersion = 1, maxVersion = 40, mask = -1 } = {}) {
  if (!ECL[ecl]) throw new RangeError('ecl must be L, M, Q or H');
  if (!(mask >= -1 && mask <= 7)) throw new RangeError('mask must be 0-7');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const e = ECL[ecl][0];
  let version;
  let ccBits;
  for (version = Math.max(1, minVersion); ; version++) {
    ccBits = version <= 9 ? 8 : 16;                 // byte mode's character count field
    const used = 4 + ccBits + bytes.length * 8;
    if (bytes.length < (1 << ccBits) && used <= numDataCodewords(version, e) * 8) break;
    if (version >= maxVersion) throw new RangeError('too much data for a QR code');
  }
  const bits = [];
  const append = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  append(0x4, 4);                                   // byte mode
  append(bytes.length, ccBits);
  for (const b of bytes) append(b, 8);
  const capacity = numDataCodewords(version, e) * 8;
  append(0, Math.min(4, capacity - bits.length));   // terminator
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }
  return new QrCode(version, e, codewords, mask);
}

// The QR code as a PNG: `scale` pixels per module and a light margin of `margin` modules (the bridge's qrencode call
// uses -s 12 -m 2).
function qrPng(text, { ecl = 'M', scale = 12, margin = 2 } = {}) {
  const qr = encode(text, { ecl });
  const n = (qr.size + margin * 2) * scale;
  return bitmap(n, n, (x, y) => qr.dark(Math.floor(x / scale) - margin, Math.floor(y / scale) - margin));
}

module.exports = { encode, qrPng, QrCode, numDataCodewords, numRawDataModules };
