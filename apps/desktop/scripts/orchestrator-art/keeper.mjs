#!/usr/bin/env node
// Draws the Aquarium's host, the Keeper (an octopus), as pixel-art SVGs: one per host pose.
// Usage: node keeper.mjs [--out <dir>]   (defaults to the app's aquarium asset folder)
// Hand-drawn in code rather than generated, so a pose can be tweaked and redrawn exactly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const OUT =
  outIndex >= 0 ? argv[outIndex + 1] : path.resolve(HERE, '../../src/renderer/src/assets/orchestrator/aquarium');

const SIZE = 32;
const COLOR = {
  outline: '#4a1d14',
  body: '#e9785d',
  shade: '#c95c45',
  light: '#f6a688',
  arm: '#d9684f',
  sucker: '#f7c9b0',
  eye: '#fff6ea',
  pupil: '#1b1010',
  wood: '#6b4523',
  feather: '#f4f1e8',
  paper: '#f3e2b8',
  ink: '#8a6a3a',
  spark: '#ffd75e',
};

function canvas() {
  const pixels = new Map();
  const key = (x, y) => `${x},${y}`;
  const inside = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;
  return {
    set(x, y, color) {
      if (inside(x, y)) pixels.set(key(Math.round(x), Math.round(y)), color);
    },
    get: (x, y) => pixels.get(key(x, y)),
    has: (x, y) => pixels.has(key(x, y)),
    pixels,
  };
}

/** A 2px-wide limb along the points, one pixel step at a time. */
function limb(art, points, color) {
  for (let index = 1; index < points.length; index++) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let step = 0; step <= steps; step++) {
      const x = Math.round(x0 + ((x1 - x0) * step) / steps);
      const y = Math.round(y0 + ((y1 - y0) * step) / steps);
      art.set(x, y, color);
      art.set(x + 1, y, color);
    }
  }
}

function head(art, dy) {
  const cx = 15.5;
  const cy = 11 + dy;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const nx = (x - cx) / 8.5;
      const ny = (y - cy) / 7.5;
      if (nx * nx + ny * ny > 1) continue;
      const color = y > cy + 3 ? COLOR.shade : nx < -0.2 && ny < -0.3 ? COLOR.light : COLOR.body;
      art.set(x, y, color);
    }
  }
  for (const ex of [11, 18]) {
    art.set(ex, 12 + dy, COLOR.eye);
    art.set(ex + 1, 12 + dy, COLOR.eye);
    art.set(ex, 13 + dy, COLOR.eye);
    art.set(ex + 1, 13 + dy, COLOR.pupil);
  }
}

/** The arms' roots along the mantle's lower edge, left to right. */
const ROOTS = [8, 11, 14, 17, 20, 23];

/** A resting arm: straight down from its root, the tip curling outward on the floor. */
function hangingArm(root, dy, lean = 0) {
  const out = root < 15.5 ? -1 : 1;
  return [
    [root, 17 + dy],
    [root + lean, 26],
    [root + lean + out, 29],
    [root + lean + out * 3, 31],
  ];
}

function arms(art, dy, raised, lean = 0) {
  ROOTS.forEach((root, index) => {
    const path = raised[index] ?? hangingArm(root, dy, lean);
    limb(art, path, COLOR.arm);
    if (!raised[index]) art.set(root + lean, 24, COLOR.sucker);
  });
}

function outline(art) {
  const edge = [];
  for (const position of art.pixels.keys()) {
    const [x, y] = position.split(',').map(Number);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      if (!art.has(x + dx, y + dy)) edge.push([x + dx, y + dy]);
    }
  }
  for (const [x, y] of edge) art.set(x, y, COLOR.outline);
}

function spark(art, x, y) {
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ])
    art.set(x + dx, y + dy, COLOR.spark);
}

const POSES = {
  idle(art) {
    head(art, 0);
    arms(art, 0, {});
    outline(art);
  },
  walking(art) {
    head(art, -1);
    arms(art, -1, {}, -2);
    outline(art);
  },
  writing(art) {
    head(art, 0);
    arms(art, 0, {
      5: [
        [23, 17],
        [26, 15],
        [27, 11],
      ],
    });
    outline(art);
    limb(
      art,
      [
        [29, 14],
        [27, 4],
      ],
      COLOR.wood
    );
    for (let y = 3; y <= 8; y++) art.set(26 - Math.floor((8 - y) / 3), y, COLOR.feather);
  },
  reading(art) {
    head(art, 0);
    arms(art, 0, {
      2: [
        [14, 17],
        [11, 20],
      ],
      3: [
        [17, 17],
        [20, 20],
      ],
    });
    for (let y = 19; y <= 25; y++) for (let x = 9; x <= 22; x++) art.set(x, y, COLOR.paper);
    for (const y of [21, 23]) for (let x = 11; x <= 20; x += 1) if (x % 4 !== 2) art.set(x, y, COLOR.ink);
    outline(art);
  },
  cheering(art) {
    head(art, 1);
    arms(art, 1, {
      0: [
        [8, 17],
        [4, 12],
        [3, 5],
        [5, 2],
      ],
      5: [
        [23, 17],
        [27, 12],
        [28, 5],
        [26, 2],
      ],
    });
    outline(art);
    spark(art, 2, 18);
    spark(art, 29, 19);
  },
};

function svg(art) {
  const rows = new Map();
  for (const [position, color] of art.pixels) {
    const [x, y] = position.split(',').map(Number);
    rows.set(y, [...(rows.get(y) ?? []), { x, color }]);
  }
  const rects = [];
  for (const [y, cells] of [...rows].sort((a, b) => a[0] - b[0])) {
    cells.sort((a, b) => a.x - b.x);
    let run;
    for (const cell of cells) {
      if (run && cell.x === run.x + run.width && cell.color === run.color) {
        run.width++;
        continue;
      }
      if (run) rects.push(run);
      run = { x: cell.x, y, width: 1, color: cell.color };
    }
    if (run) rects.push(run);
  }
  const body = rects
    .map(({ x, y, width, color }) => `<rect x="${x}" y="${y}" width="${width}" height="1" fill="${color}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">${body}</svg>\n`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [pose, draw] of Object.entries(POSES)) {
  const art = canvas();
  draw(art);
  const file = path.join(OUT, `keeper-${pose}.svg`);
  fs.writeFileSync(file, svg(art));
  console.log(file);
}
