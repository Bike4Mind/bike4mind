#!/usr/bin/env node
// Rasterizes the Office's SVG pixel art into the PNGs the scene framework draws.
// Usage: node render.mjs [--out <dir>]
//   backdrop.svg (1000x640) -> backdrop.png at 2x, so its lettering stays sharp when the scene is large.
//   The sprite below -> char-<n>-<pose>.png per look and manager-<pose>.png, square canvases with the
//   feet at bottom center, as every scene sprite is (see the tavern assets README).
// --out defaults to the app's asset folder (src/renderer/src/assets/orchestrator/office).
// sharp is not a desktop dependency, so it is borrowed from the CLI workspace package that already has it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sharp = createRequire(path.resolve(HERE, '../../../../../packages/cli/package.json'))('sharp');

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const OUT =
  outIndex >= 0 ? argv[outIndex + 1] : path.resolve(HERE, '../../../src/renderer/src/assets/orchestrator/office');

const BACKDROP_SCALE = 2;
// The sprite grid is 24x36; on a 36x36 canvas it renders at 8x so 1px strokes on whole units stay crisp.
const SPRITE_SCALE = 8;

/** One look per agent sheet: hair, shirt, skin, and the touches that tell them apart at a glance. */
const LOOKS = [
  { hair: '#65432e', shirt: '#c9dce5', skin: '#e3b28c' },
  { hair: '#6a4325', shirt: '#d7bd63', skin: '#e4b98e', glasses: true, tie: '#8b6130' },
  { hair: '#985c32', shirt: '#cd9396', skin: '#edbd9c', longHair: true },
  { hair: '#382b27', shirt: '#bec9db', skin: '#895b40' },
  { hair: '#75472d', shirt: '#b28da8', skin: '#e6b799', longHair: true, glasses: true },
  { hair: '#332a27', shirt: '#a1c4ac', skin: '#b98159' },
  { hair: '#65442f', shirt: '#d7c9aa', skin: '#dfaf88', receding: true },
  { hair: '#292020', shirt: '#c56f9e', skin: '#b98159', longHair: true },
];
const MANAGER = { hair: '#342c29', shirt: '#39495e', skin: '#e5b38e' };

const AGENT_POSES = ['work', 'call', 'rest', 'idle'];
const HOST_POSES = ['idle', 'writing', 'reading', 'walking', 'cheering'];
const HOST_POSE_AS = { idle: 'idle', writing: 'work', reading: 'read', walking: 'walk', cheering: 'cheer' };

function sprite(look, pose) {
  const { hair, shirt, skin, longHair = false, glasses = false, receding = false, tie = '#4b5f66' } = look;
  const legs =
    pose === 'walk'
      ? '<path d="M6 21H18V28H17V33H14V27H11V31H8V33H6V28Z" fill="#424640"/><path d="M5 33H9V35H4V34H5ZM14 32H17V33H19V35H14Z" fill="#272b2d"/>'
      : '<path d="M6 21H18V28H16V33H13V27H11V33H7V28H6Z" fill="#424640"/><path d="M6 32H11V35H5V33H6ZM13 32H17V33H19V35H13Z" fill="#272b2d"/>';
  const hands = {
    work: `<path d="M4 23H8V25H4Z" fill="${skin}"/><path d="M16 23H20V25H16Z" fill="${skin}"/>`,
    idle: `<path d="M4 24H7V27H4Z" fill="${skin}"/><path d="M17 24H20V27H17Z" fill="${skin}"/>`,
    walk: `<path d="M4 23H7V26H4Z" fill="${skin}"/><path d="M17 25H20V28H17Z" fill="${skin}"/>`,
    call: `<path d="M4 24H7V27H4Z" fill="${skin}"/><path d="M17 16H20V12H23V20H17Z" fill="${shirt}"/><path d="M20 9H23V13H20Z" fill="${skin}"/>`,
    cheer: `<path d="M7 16H4V12H1V20H7Z" fill="${shirt}"/><path d="M1 9H4V13H1Z" fill="${skin}"/><path d="M17 16H20V12H23V20H17Z" fill="${shirt}"/><path d="M20 9H23V13H20Z" fill="${skin}"/>`,
    read: `<path d="M7 18H17V26H7Z" fill="#f4edd5"/><path d="M9 20H15M9 22H14M9 24H15" stroke="#8b9c94"/><path d="M5 21H8V24H5ZM16 21H19V24H16Z" fill="${skin}"/>`,
    rest: `<path d="M17 20H22V25H17Z" fill="#f4edd5"/><path d="M22 21H24V24H22" fill="none" stroke="#e2d9be"/><path d="M18 20H21" stroke="#71503a"/><path d="M18 18V16H19V14M21 18V15H20V13" fill="none" stroke="#f4edd5" opacity=".6"/><rect x="17" y="25" width="4" height="2" fill="${skin}"/><path d="M4 24H7V27H4Z" fill="${skin}"/>`,
  }[pose];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 0 36 36" width="${36 * SPRITE_SCALE}" height="${36 * SPRITE_SCALE}" shape-rendering="crispEdges">
<rect x="3" y="33" width="18" height="2" fill="#26302b" opacity=".25"/>
${longHair ? `<path d="M5 5H19V21H4V9H5Z" fill="${hair}"/>` : ''}
${legs}
<path d="M7 15H17V17H20V25H17V22H7V25H4V17H7Z" fill="${shirt}"/>
<path d="M10 14H14V18H10Z" fill="${skin}"/>
<path d="M8 16L11 19H13L16 16H14L12 18L10 16Z" fill="#eee7ce"/>
<path d="M12 19H13V25H11V20H12Z" fill="${tie}"/>
<path d="M6 4H18V7H19V12H17V14H15V16H9V14H7V12H5V7H6Z" fill="${skin}"/>
${receding ? `<path d="M6 4H18V7H16V5H8V7H6Z" fill="${hair}"/>` : `<path d="M7 2H17V3H19V8H17V6H12V5H8V9H5V5H7Z" fill="${hair}"/>`}
${longHair ? `<path d="M5 7H7V17H4V9H5ZM17 6H19V18H17Z" fill="${hair}"/>` : ''}
<path d="M8 9H10V11H8ZM14 9H16V11H14Z" fill="#30312e"/>
<path d="M10 13H14V14H10Z" fill="#a36e52"/>
${glasses ? '<path d="M7 8H11V12H7ZM13 8H17V12H13ZM11 9H13" fill="none" stroke="#594a30" stroke-width="1"/>' : ''}
${hands}
</svg>`;
}

const png = input => sharp(Buffer.from(input)).png({ palette: true, colors: 64, compressionLevel: 9 });

fs.mkdirSync(OUT, { recursive: true });
const written = [];
const write = async (name, pipeline) => {
  await pipeline.toFile(path.join(OUT, name));
  written.push(name);
};

await write(
  'backdrop.png',
  sharp(path.join(HERE, 'backdrop.svg'), { density: 72 * BACKDROP_SCALE }).png({ palette: true, compressionLevel: 9 })
);
for (const [index, look] of LOOKS.entries()) {
  for (const pose of AGENT_POSES) await write(`char-${index + 1}-${pose}.png`, png(sprite(look, pose)));
}
for (const pose of HOST_POSES) await write(`manager-${pose}.png`, png(sprite(MANAGER, HOST_POSE_AS[pose])));
console.log(`wrote ${written.length} files to ${OUT}`);
