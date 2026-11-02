/**
 * Generates the published JSON Schema for the curated list from the Zod manifest schema.
 *
 *   pnpm --filter @bike4mind/scripts curated:schema [--check]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CURATED_SCHEMA_ID, curatedJsonSchemaText } from '@bike4mind/common';
import { isEntry, REPO_ROOT } from './cli';

export { curatedJsonSchemaText };
export const SCHEMA_PATH = 'catalog/model-hub/schema/curated-v2.schema.json';
export const SCHEMA_ID = CURATED_SCHEMA_ID;

/** Null when the committed file matches the generated schema, else a message naming the fix. */
export async function checkCuratedSchema(root: string = REPO_ROOT): Promise<string | null> {
  const committed = await readFile(path.join(root, SCHEMA_PATH), 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (committed === curatedJsonSchemaText()) return null;
  return `${SCHEMA_PATH} is ${committed === null ? 'missing' : 'stale'}; run pnpm --filter @bike4mind/scripts curated:schema`;
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    const problem = await checkCuratedSchema();
    if (problem) throw new Error(problem);
    console.log(`${SCHEMA_PATH} is up to date`);
    return;
  }
  await writeFile(path.join(REPO_ROOT, SCHEMA_PATH), curatedJsonSchemaText());
  console.log(`wrote ${SCHEMA_PATH}`);
}

if (isEntry(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
