#!/usr/bin/env node
// Draws the menu-bar lantern icons (build/tray/*Template.png, 16 px and @2x) from simple shapes.
// macOS tints a "Template" image to suit a light or dark menu bar, so these are black on clear,
// and the four states differ by shape alone. No dependencies: shapes are rasterised by
// supersampled coverage and written as PNGs with node's zlib.
//
//   node scripts/tray-icons/generate.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../build/tray');
const UNITS = 16;
const SAMPLES = 6;

const roundedRectDistance = (x, y, x0, y0, x1, y1, r) => {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const segmentDistance = (x, y, ax, ay, bx, by) => {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
};

const BODY = [4.5, 5.2, 11.5, 13.0, 1.6];

const handle = (x, y) => y <= 3.6 && Math.abs(Math.hypot(x - 8, y - 3.6) - 1.7) <= 0.55;
const cap = (x, y) => roundedRectDistance(x, y, 5.2, 3.9, 10.8, 5.4, 0.5) <= 0;
const base = (x, y) => roundedRectDistance(x, y, 5.2, 12.8, 10.8, 14.4, 0.5) <= 0;
const bodyOutline = (x, y) => Math.abs(roundedRectDistance(x, y, ...BODY) + 0.6) <= 0.6;
const bodyFilled = (x, y) => roundedRectDistance(x, y, ...BODY) <= 0;
const flame = (x, y) => {
  if (Math.hypot(x - 8, y - 10.3) <= 1.5) return true;
  // A tapered tip above the round bottom.
  if (y < 6.9 || y > 10.3) return false;
  const halfWidth = ((y - 6.9) / (10.3 - 6.9)) * 1.5;
  return Math.abs(x - 8) <= halfWidth;
};
const check = (x, y) =>
  segmentDistance(x, y, 6.0, 9.4, 7.5, 10.9) <= 0.7 || segmentDistance(x, y, 7.5, 10.9, 10.1, 7.4) <= 0.7;
const badge = (x, y) => Math.hypot(x - 12.8, y - 3.4) <= 2.3;
const badgeMoat = (x, y) => Math.hypot(x - 12.8, y - 3.4) <= 3.2;

const frame = (x, y) => handle(x, y) || cap(x, y) || base(x, y);

const ICONS = {
  trayIdle: (x, y) => frame(x, y) || bodyOutline(x, y),
  trayWorking: (x, y) => frame(x, y) || bodyOutline(x, y) || flame(x, y),
  // Solid body plus a badge dot, cut free of the lantern so it reads at 16 px.
  trayNeedsYou: (x, y) => badge(x, y) || (!badgeMoat(x, y) && (frame(x, y) || bodyFilled(x, y))),
  trayDone: (x, y) => frame(x, y) || bodyOutline(x, y) || check(x, y),
};

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, inside) {
  const rows = [];
  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = ((px + (sx + 0.5) / SAMPLES) / size) * UNITS;
          const y = ((py + (sy + 0.5) / SAMPLES) / size) * UNITS;
          if (inside(x, y)) covered += 1;
        }
      }
      row[1 + px * 4 + 3] = Math.round((covered / SAMPLES ** 2) * 255);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, inside] of Object.entries(ICONS)) {
  writeFileSync(join(OUT, `${name}Template.png`), png(16, inside));
  writeFileSync(join(OUT, `${name}Template@2x.png`), png(32, inside));
}
console.log(`wrote ${Object.keys(ICONS).length * 2} icons to ${OUT}`);
