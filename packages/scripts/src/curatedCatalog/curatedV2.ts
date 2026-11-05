/**
 * Regenerates the curated v2 list from the v3 list's `v2Channel`, so clients that read only v2 keep their picks.
 *
 *   pnpm --filter @bike4mind/scripts curated:v2 [--check]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { curatedV2FromV3, type HubManifestV3Input } from '@bike4mind/common';
import { format, resolveConfig } from 'prettier';
import { CATALOG_PATH, isEntry, REPO_ROOT } from './cli';

export const CATALOG_V3_PATH = 'catalog/model-hub/curated-v3.json';

/** The v2 file's text for the v3 list under `root`; rejects when the v3 file is unreadable or invalid. */
export async function curatedV2Text(root: string = REPO_ROOT): Promise<string> {
  const v3: HubManifestV3Input = JSON.parse(await readFile(path.join(root, CATALOG_V3_PATH), 'utf8'));
  const target = path.join(root, CATALOG_PATH);
  // Compact input lets prettier choose every line break, so the output depends only on the content.
  return format(JSON.stringify(curatedV2FromV3(v3)), { ...(await resolveConfig(target)), parser: 'json' });
}

/** Null when the committed v2 file matches the one generated from v3, else a message naming the fix. */
export async function checkCuratedV2(root: string = REPO_ROOT): Promise<string | null> {
  const expected = await curatedV2Text(root);
  const committed = await readFile(path.join(root, CATALOG_PATH), 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (committed === expected) return null;
  return `${CATALOG_PATH} is ${committed === null ? 'missing' : 'stale'}; run pnpm --filter @bike4mind/scripts curated:v2`;
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    const problem = await checkCuratedV2();
    if (problem) throw new Error(problem);
    console.log(`${CATALOG_PATH} is up to date`);
    return;
  }
  await writeFile(path.join(REPO_ROOT, CATALOG_PATH), await curatedV2Text());
  console.log(`wrote ${CATALOG_PATH}`);
}

if (isEntry(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
