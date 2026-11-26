"use strict";

/**
 * Draws build/icon.png (512×512): the web app's brand mark — a violet→fuchsia rounded tile with a white
 * database symbol — using only Node (no image libraries). electron-builder turns it into .ico/.icns.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 512;
const SS = 4; // supersampling per axis for smooth edges
const px = new Float64Array(SIZE * SIZE * 4);

const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const STOPS = [hex("#8b5cf6"), hex("#9333ea"), hex("#c026d3")];
const gradient = (t) => {
  const [a, b, u] = t < 0.55 ? [STOPS[0], STOPS[1], t / 0.55] : [STOPS[1], STOPS[2], (t - 0.55) / 0.45];
  return a.map((v, i) => lerp(v, b[i], u));
};

// Rounded-square tile with a margin, like an app icon.
const M = 28;
const R = 108;
const insideTile = (x, y) => {
  const cx = Math.min(Math.max(x, M + R), SIZE - M - R);
  const cy = Math.min(Math.max(y, M + R), SIZE - M - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R && x >= M && x <= SIZE - M && y >= M && y <= SIZE - M;
};

// Database symbol (same proportions as the 24×24 SVG icon: ellipse rx 8 ry 3, height 15), scaled up.
const S = 13;
const CX = 256;
const RX = 8 * S;
const RY = 3 * S;
const TOP = 256 - 7.5 * S;
const STROKE = 2.1 * S;
// Distance to an ellipse outline, first-order approximation f / |∇f| — even stroke width all the way round.
const ellipseDist = (x, y, cy) => {
  const dx = x - CX;
  const dy = y - cy;
  const f = (dx * dx) / (RX * RX) + (dy * dy) / (RY * RY) - 1;
  const gx = (2 * dx) / (RX * RX);
  const gy = (2 * dy) / (RY * RY);
  return f / Math.max(1e-9, Math.hypot(gx, gy));
};
const onSymbol = (x, y) => {
  const half = STROKE / 2;
  if (Math.abs(ellipseDist(x, y, TOP)) <= half) return true; // top ring
  for (const cy of [TOP + 6 * S, TOP + 12 * S]) if (y >= cy && Math.abs(ellipseDist(x, y, cy)) <= half) return true; // lower arcs
  const sideTop = TOP;
  const sideBottom = TOP + 12 * S;
  if (y >= sideTop && y <= sideBottom && (Math.abs(x - (CX - RX)) <= half || Math.abs(x - (CX + RX)) <= half)) return true; // sides
  return false;
};

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        if (!insideTile(fx, fy)) continue;
        let [cr, cg, cb] = gradient(Math.min(1, Math.max(0, (fx + fy - 2 * M) / (2 * (SIZE - 2 * M)))));
        const shine = Math.max(0, 1 - fy / (SIZE * 0.55)) * 0.12; // soft top highlight
        cr = lerp(cr, 255, shine); cg = lerp(cg, 255, shine); cb = lerp(cb, 255, shine);
        if (onSymbol(fx, fy)) [cr, cg, cb] = [255, 255, 255];
        r += cr; g += cg; b += cb; a += 255;
      }
    }
    const n = SS * SS;
    const i = (y * SIZE + x) * 4;
    const coverage = a / n / 255;
    px[i] = coverage ? r / (a / 255) : 0;
    px[i + 1] = coverage ? g / (a / 255) : 0;
    px[i + 2] = coverage ? b / (a / 255) : 0;
    px[i + 3] = a / n;
  }
}

// PNG encoding (RGBA, 8-bit).
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE * 4; x += 1) raw[y * (SIZE * 4 + 1) + 1 + x] = Math.round(Math.min(255, Math.max(0, px[y * SIZE * 4 + x])));
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "build", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`✓ wrote ${out} (${(png.length / 1024).toFixed(1)} KB)`);
