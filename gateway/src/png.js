'use strict';
// A minimal PNG writer for black-and-white pictures (the Jam QR code on Windows, D22): 1-bit grayscale, no
// interlacing, deflated with Node's zlib. No npm packages.
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// width x height pixels; isDark(x, y) says which are black (the rest are white).
function bitmap(width, height, isDark) {
  if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384)) throw new RangeError('bad PNG size');
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);     // each row: filter byte 0 (none), then the pixels
  for (let y = 0; y < height; y++) {
    const o = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x++) if (!isDark(x, y)) raw[o + (x >> 3)] |= 0x80 >> (x & 7);   // 1 = white
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1;      // bit depth
  ihdr[9] = 0;      // grayscale
  ihdr[10] = 0;     // deflate
  ihdr[11] = 0;     // adaptive filtering (each row says which filter)
  ihdr[12] = 0;     // no interlacing
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { bitmap, crc32 };
