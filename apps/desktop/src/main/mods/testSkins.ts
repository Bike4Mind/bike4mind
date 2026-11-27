import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sceneSkinAssetPaths, type SkinTokens } from '@shared/mods';
import sampleTokens from '@shared/__fixtures__/skins/nightglass/tokens.json';

/** Test helpers for the skin loader; the sample skin lives in shared/__fixtures__ so renderer tests can read it too. */
const FIXTURE = join(__dirname, '../../shared/__fixtures__/skins/nightglass');

export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
/** Every sprite the sample skin's tokens reference, across all its scenes. */
export const SAMPLE_SKIN_SPRITES: readonly string[] = [
  ...new Set(Object.values((sampleTokens as SkinTokens).scenes ?? {}).flatMap(sceneSkinAssetPaths)),
];

export const OGG_BYTES = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(32)]);

/** Copies the sample skin into mods/<id> and writes the sprites and sounds its tokens reference. */
export async function installSampleSkin(root: string, id = 'nightglass'): Promise<string> {
  const folder = join(root, id);
  await cp(FIXTURE, folder, { recursive: true });
  await rm(join(folder, 'README.md'));
  await mkdir(join(folder, 'sprites'));
  await mkdir(join(folder, 'sounds'));
  for (const path of SAMPLE_SKIN_SPRITES) await writeFile(join(folder, path), PNG_BYTES);
  await writeFile(join(folder, 'sounds/finale.ogg'), OGG_BYTES);
  await writeFile(join(folder, 'sounds/alarm.ogg'), OGG_BYTES);
  return folder;
}

const PACK_FIXTURE = join(__dirname, '../../shared/__fixtures__/sound-packs/chimes');

/** Copies the sample sound pack into mods/<id> and writes the silent audio files its manifest references. */
export async function installSamplePack(root: string, id = 'chimes'): Promise<string> {
  const folder = join(root, id);
  await cp(PACK_FIXTURE, folder, { recursive: true });
  await rm(join(folder, 'README.md'));
  await mkdir(join(folder, 'sounds'));
  for (const file of ['done', 'error', 'approval', 'finale']) {
    await writeFile(join(folder, `sounds/${file}.ogg`), OGG_BYTES);
  }
  return folder;
}
