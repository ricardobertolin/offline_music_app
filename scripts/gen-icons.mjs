/** Generates the PWA PNG icons from code (no dependencies, no binary blobs in git).
 *  Run with:  node scripts/gen-icons.mjs   */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const BG = [0x0d, 0x0f, 0x14];
const BG2 = [0x18, 0x22, 0x2c];
const ACCENT = [0x5e, 0xe1, 0xa0];
const ACCENT2 = [0x4a, 0xa8, 0xff];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Signed-distance helpers, all in 0..1 icon space. */
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const ring = (x, y, cx, cy, r, w) => Math.abs(circle(x, y, cx, cy, r)) - w / 2;
const box = (x, y, x0, y0, x1, y1, r = 0) => {
  const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
  return Math.hypot(dx, dy) - r;
};
const ellipse = (x, y, cx, cy, rx, ry) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);

/** The mark: a vinyl ring with a quaver sitting in it. */
function shade(x, y, inset) {
  // inset shrinks the artwork for maskable icons (safe zone)
  const u = (x - 0.5) / inset + 0.5;
  const v = (y - 0.5) / inset + 0.5;

  let color = mix(BG, BG2, Math.min(1, Math.max(0, (u + v) / 2)));
  let alpha = 1;

  const px = 1 / 512 / inset; // approximate pixel size for anti-aliasing
  const paint = (dist, rgb) => {
    const cover = Math.min(1, Math.max(0, 0.5 - dist / (2 * px)));
    if (cover > 0) color = mix(color, rgb, cover);
  };

  paint(ring(u, v, 0.5, 0.5, 0.345, 0.055), mix(ACCENT2, ACCENT, 0.35));

  // note: stem + head + flag
  const stem = box(u, v, 0.545, 0.285, 0.585, 0.60);
  const head = ellipse(u, v, 0.485, 0.625, 0.105, 0.082);
  const flag = box(u, v, 0.585, 0.285, 0.70, 0.335, 0.02);
  paint(Math.min(stem, head, flag), ACCENT);

  return [...color.map((c) => Math.round(Math.max(0, Math.min(255, c)))), Math.round(alpha * 255)];
}

function render(size, { inset = 1, round = 0 } = {}) {
  const data = new Uint8Array(size * size * 4);
  const SS = 2; // supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const [cr, cg, cb] = shade(x, y, inset);
          let al = 255;
          if (round > 0) {
            const d = box(x, y, round, round, 1 - round, 1 - round, round);
            al = d <= 0 ? 255 : 0;
          }
          r += cr; g += cg; b += cb; a += al;
        }
      }
      const n = SS * SS, i = (py * size + px) * 4;
      data[i] = r / n; data[i + 1] = g / n; data[i + 2] = b / n; data[i + 3] = a / n;
    }
  }
  return data;
}

/* ------------------------------ PNG writing ------------------------------- */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['icon-192.png', 192, { round: 0.16 }],
  ['icon-512.png', 512, { round: 0.16 }],
  ['icon-maskable-512.png', 512, { inset: 0.72 }],  // content inside the safe zone
  ['apple-touch-icon.png', 180, {}],
];

for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT, name), png(size, render(size, opts)));
  console.log('wrote', name, size);
}
