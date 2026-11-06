#!/usr/bin/env node
// Turn the raw generations into the final assets.
// Usage: node process.mjs --raw <dir> [--out <dir>] [--canvas 256] [--rows 4] [--cols 5] [--alpha 128]
//          [--sheet sheet-all] [--prefix char-{row}] [--poses work,call,rest,ko,idle] [--scale <n>] [--no-backdrop]
//   <raw>/sheet-all.png -> char-{row}-{pose}.png (rows = characters, cols = poses), one shared scale,
//     feet at bottom center, alpha binarized (no soft halo), nearest-neighbor resize, palette PNG.
//   <raw>/backdrop.png  -> backdrop.png (1280x720, nearest, palette-quantized).
// --out defaults to the app's asset folder (src/renderer/src/assets/orchestrator/tavern).
// A one-character sheet (e.g. the Innkeeper) uses --sheet/--prefix/--poses/--no-backdrop, and --scale to fix the
// raw-to-sprite factor so it matches the existing sprites instead of fitting its own widest cell to the canvas.
// If a sheet has an opaque flat background instead of alpha, pixels near --key (default ff00ff) are keyed out.
// sharp is not a desktop dependency, so it is borrowed from the CLI workspace package that already has it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sharp = createRequire(path.resolve(HERE, '../../../../packages/cli/package.json'))('sharp');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const POSES = opt('poses', 'work,call,rest,ko,idle').split(',');
const SHEET = opt('sheet', 'sheet-all');
const PREFIX = opt('prefix', 'char-{row}');
const FIXED_SCALE = opt('scale') === undefined ? undefined : Number(opt('scale'));
const WITH_BACKDROP = !argv.includes('--no-backdrop');
const CANVAS = Number(opt('canvas', 256));
const ROWS = Number(opt('rows', 4));
const COLS = Number(opt('cols', POSES.length));
const ALPHA_THRESHOLD = Number(opt('alpha', 128));
const KEY = opt('key', 'ff00ff');
const RAW_DIR = opt('raw');
if (!RAW_DIR) throw new Error('missing --raw <dir> (the folder holding the sheet and backdrop.png)');
if (POSES.length !== COLS) throw new Error(`--poses names ${POSES.length} poses for ${COLS} columns`);
if (FIXED_SCALE !== undefined && !(FIXED_SCALE > 0)) throw new Error('--scale must be a positive number');
const OUT_DIR = path.resolve(opt('out', path.join(HERE, '../../src/renderer/src/assets/orchestrator/tavern')));
const PADDING = 4;

function keyAndBinarize(data, width, height) {
  const [kr, kg, kb] = [0, 2, 4].map(i => parseInt(KEY.slice(i, i + 2), 16));
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    const isKey = Math.abs(data[o] - kr) + Math.abs(data[o + 1] - kg) + Math.abs(data[o + 2] - kb) < 90;
    data[o + 3] = isKey || data[o + 3] < ALPHA_THRESHOLD ? 0 : 255;
  }
}

/** Split [0,length) into `count` runs of occupied lines, using the widest empty gaps as cuts. */
function segments(occupied, count) {
  const runs = [];
  let start = -1;
  occupied.forEach((on, i) => {
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, occupied.length]);
  // Merge across the narrowest gaps until exactly `count` runs remain (stars sit above a KO body, etc.).
  while (runs.length > count) {
    let best = 1;
    for (let i = 1; i < runs.length; i++) {
      if (runs[i][0] - runs[i - 1][1] < runs[best][0] - runs[best - 1][1]) best = i;
    }
    runs.splice(best - 1, 2, [runs[best - 1][0], runs[best][1]]);
  }
  if (runs.length !== count) throw new Error(`expected ${count} segments, found ${runs.length}`);
  return runs;
}

function bbox(data, width, x0, x1, y0, y1) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -1,
    maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (data[(y * width + x) * 4 + 3]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) throw new Error('empty cell');
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function sliceSheet(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  keyAndBinarize(data, width, height);

  const rowOccupied = Array.from({ length: height }, (_, y) => {
    let n = 0;
    for (let x = 0; x < width; x++) n += data[(y * width + x) * 4 + 3] ? 1 : 0;
    return n > 2;
  });
  const boxes = [];
  for (const [y0, y1] of segments(rowOccupied, ROWS)) {
    const colOccupied = Array.from({ length: width }, (_, x) => {
      let n = 0;
      for (let y = y0; y < y1; y++) n += data[(y * width + x) * 4 + 3] ? 1 : 0;
      return n > 2;
    });
    boxes.push(segments(colOccupied, COLS).map(([x0, x1]) => bbox(data, width, x0, x1, y0, y1)));
  }

  const largest = Math.max(...boxes.flat().map(b => Math.max(b.width, b.height)));
  const scale = FIXED_SCALE ?? (CANVAS - PADDING * 2) / largest;
  const binarized = await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

  for (const [row, rowBoxes] of boxes.entries()) {
    for (const [col, box] of rowBoxes.entries()) {
      const w = Math.max(1, Math.round(box.width * scale));
      const h = Math.max(1, Math.round(box.height * scale));
      if (w > CANVAS - PADDING * 2 || h > CANVAS - PADDING * 2) {
        throw new Error(`row ${row + 1} column ${col + 1} is ${w}x${h} at scale ${scale}; lower --scale`);
      }
      const sprite = await sharp(binarized).extract(box).resize(w, h, { kernel: 'nearest' }).png().toBuffer();
      const out = path.join(OUT_DIR, `${PREFIX.replace('{row}', String(row + 1))}-${POSES[col]}.png`);
      await sharp({
        create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([{ input: sprite, left: Math.round((CANVAS - w) / 2), top: CANVAS - PADDING - h }])
        .png({ palette: true, colours: 64, dither: 0 })
        .toFile(out);
    }
  }
  console.log(`sliced ${ROWS}x${COLS} sprites at scale ${scale.toFixed(3)} onto ${CANVAS}px canvases`);
}

async function backdrop() {
  await sharp(path.join(RAW_DIR, 'backdrop.png'))
    .resize(1280, 720, { kernel: 'nearest' })
    .png({ palette: true, colours: 128, dither: 0 })
    .toFile(path.join(OUT_DIR, 'backdrop.png'));
}

await sliceSheet(path.join(RAW_DIR, `${SHEET}.png`));
if (WITH_BACKDROP) {
  await backdrop();
  if (!fs.existsSync(path.join(OUT_DIR, 'backdrop.png'))) throw new Error('backdrop not written');
}
