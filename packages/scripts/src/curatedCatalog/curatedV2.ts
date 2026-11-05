/**
 * Regenerates the curated v2 list from the v3 list's `v2Channel`, so clients that read only v2 keep their picks.
 * `--bump` moves v2Channel to the sequence its newest changelog item names and records that content's hash.
 *
 *   pnpm --filter @bike4mind/scripts curated:v2 [--check | --bump]
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { curatedV2Content, curatedV2FromV3, type HubManifestInput, type HubManifestV3Input } from '@bike4mind/common';
import { format, resolveConfig } from 'prettier';
import { CATALOG_PATH, isEntry, REPO_ROOT } from './cli';

export const CATALOG_V3_PATH = 'catalog/model-hub/curated-v3.json';

/** The hash `v2Channel.contentSha256` records for a v2 list: its content, not its sequence, date or changelog. */
export const curatedV2Sha256 = (v2: HubManifestInput): string =>
  createHash('sha256')
    .update(JSON.stringify(curatedV2Content(v2)))
    .digest('hex');

interface Generated {
  text: string;
  /** Set when the v2 content no longer matches the hash recorded for its sequence. */
  problem: string | null;
}

async function formatJson(value: unknown, configFile: string): Promise<string> {
  // Compact input lets prettier choose every line break, so the output depends only on the content.
  return format(JSON.stringify(value), { ...(await resolveConfig(configFile)), parser: 'json' });
}

/** The v2 file generated from the v3 list under `root`; rejects when the v3 file is unreadable or invalid. */
export async function generateCuratedV2(root: string = REPO_ROOT): Promise<Generated> {
  const v3: HubManifestV3Input = JSON.parse(await readFile(path.join(root, CATALOG_V3_PATH), 'utf8'));
  const v2 = curatedV2FromV3(v3);
  const text = await formatJson(v2, path.join(root, CATALOG_PATH));
  const channel = v3.v2Channel;
  if (!channel) throw new Error('the v3 list has no v2Channel');
  const key = String(channel.sequence);
  const recorded = Object.hasOwn(channel.contentSha256, key) ? channel.contentSha256[key] : undefined;
  if (recorded === curatedV2Sha256(v2)) return { text, problem: null };
  const what =
    recorded === undefined
      ? `v2Channel.contentSha256 has no hash for sequence ${key}`
      : `the v2 content no longer matches the hash recorded for v2Channel sequence ${key}`;
  const problem =
    `${what}; add a v2Channel.changelog item for sequence ${channel.sequence + 1}, ` +
    'then run pnpm --filter @bike4mind/scripts curated:v2 --bump';
  return { text, problem };
}

/**
 * Moves v2Channel to the next sequence, which its newest changelog item must already name, records the new
 * content's hash, and writes both lists. Rejects without writing when that item is missing or nothing changed.
 */
export async function bumpCuratedV2(root: string = REPO_ROOT): Promise<number> {
  const file = path.join(root, CATALOG_V3_PATH);
  const source = await readFile(file, 'utf8');
  const v3: HubManifestV3Input = JSON.parse(source);
  const channel = v3.v2Channel;
  if (!channel) throw new Error('the v3 list has no v2Channel');
  const previous = String(channel.sequence);
  const next = channel.sequence + 1;
  const item = channel.changelog[0];
  if (item?.sequence !== next) throw new Error(`add a v2Channel.changelog item for sequence ${next} first`);
  channel.sequence = next;
  channel.updatedAt = `${item.date}T00:00:00Z`;
  const sha = curatedV2Sha256(curatedV2FromV3(v3));
  if (Object.hasOwn(channel.contentSha256, previous) && channel.contentSha256[previous] === sha)
    throw new Error(`the v2 content has not changed since sequence ${previous}`);
  channel.contentSha256 = { ...channel.contentSha256, [String(next)]: sha };

  // Edits only the three v2Channel fields in place, so the rest of the hand-formatted v3 file keeps its layout.
  const start = source.indexOf('"v2Channel"');
  const edited =
    source.slice(0, start) +
    source
      .slice(start)
      .replace(/"sequence"\s*:\s*\d+/, `"sequence": ${next}`)
      .replace(/"contentSha256"\s*:\s*\{[^}]*\}/, `"contentSha256": ${JSON.stringify(channel.contentSha256)}`)
      .replace(/"updatedAt"\s*:\s*"[^"]*"/, `"updatedAt": "${channel.updatedAt}"`);
  const text = start < 0 ? '' : await format(edited, { ...(await resolveConfig(file)), parser: 'json' });
  if (!text || !isDeepStrictEqual(JSON.parse(text), v3))
    throw new Error(`could not edit v2Channel in ${CATALOG_V3_PATH} in place; bump it by hand`);
  await writeFile(file, text);
  const generated = await generateCuratedV2(root);
  if (generated.problem) throw new Error(generated.problem);
  await writeFile(path.join(root, CATALOG_PATH), generated.text);
  return next;
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
  if (process.argv.includes('--bump')) {
    console.log(`v2Channel is at sequence ${await bumpCuratedV2()}; wrote ${CATALOG_V3_PATH} and ${CATALOG_PATH}`);
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
