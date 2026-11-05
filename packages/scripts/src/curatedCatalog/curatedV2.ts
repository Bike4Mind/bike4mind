/**
 * Regenerates the curated v2 list from the v3 list's `v2Channel`, so clients that read only v2 keep their picks.
 *
 *   pnpm --filter @bike4mind/scripts curated:v2 [--check]
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { curatedV2FromV3, type HubManifestInput, type HubManifestV3Input } from '@bike4mind/common';
import { format, resolveConfig } from 'prettier';
import { CATALOG_PATH, isEntry, REPO_ROOT } from './cli';

export const CATALOG_V3_PATH = 'catalog/model-hub/curated-v3.json';

/** The hash `v2Channel.contentSha256` records for a generated v2 list. */
export const curatedV2Sha256 = (v2: HubManifestInput): string =>
  createHash('sha256').update(JSON.stringify(v2)).digest('hex');

interface Generated {
  text: string;
  /** Set when the v2 content no longer matches the hash recorded for its sequence. */
  problem: string | null;
}

/** The v2 file generated from the v3 list under `root`; rejects when the v3 file is unreadable or invalid. */
export async function generateCuratedV2(root: string = REPO_ROOT): Promise<Generated> {
  const v3: HubManifestV3Input = JSON.parse(await readFile(path.join(root, CATALOG_V3_PATH), 'utf8'));
  const v2 = curatedV2FromV3(v3);
  // Compact input lets prettier choose every line break, so the output depends only on the content.
  const text = await format(JSON.stringify(v2), {
    ...(await resolveConfig(path.join(root, CATALOG_PATH))),
    parser: 'json',
  });
  const channel = v3.v2Channel;
  const sha = curatedV2Sha256(v2);
  const recorded = channel && Object.hasOwn(channel.contentSha256, String(channel.sequence));
  if (channel && recorded && channel.contentSha256[String(channel.sequence)] === sha) return { text, problem: null };
  const next = (channel?.sequence ?? 0) + 1;
  const problem =
    `the v2 content no longer matches v2Channel sequence ${channel?.sequence}: set v2Channel.sequence to ${next}, ` +
    `add "${next}": "${sha}" to contentSha256, and record the change in the v2 changelog`;
  return { text, problem };
}

/** Null when the committed v2 file matches the one generated from v3 under an unchanged sequence, else the fix. */
export async function checkCuratedV2(root: string = REPO_ROOT): Promise<string | null> {
  const { text, problem } = await generateCuratedV2(root);
  if (problem) return problem;
  const committed = await readFile(path.join(root, CATALOG_PATH), 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (committed === text) return null;
  return `${CATALOG_PATH} is ${committed === null ? 'missing' : 'stale'}; run pnpm --filter @bike4mind/scripts curated:v2`;
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    const problem = await checkCuratedV2();
    if (problem) throw new Error(problem);
    console.log(`${CATALOG_PATH} is up to date`);
    return;
  }
  const { text, problem } = await generateCuratedV2();
  if (problem) throw new Error(problem);
  await writeFile(path.join(REPO_ROOT, CATALOG_PATH), text);
  console.log(`wrote ${CATALOG_PATH}`);
}

if (isEntry(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
