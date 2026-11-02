/**
 * Generates the published JSON Schema for the curated list from the Zod manifest schema.
 *
 *   pnpm --filter @bike4mind/scripts curated:schema [--check]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CuratedCatalogSchema } from '@bike4mind/common';
import { z } from 'zod';
import { isEntry, REPO_ROOT } from './cli';

export const SCHEMA_PATH = 'catalog/model-hub/schema/curated-v2.schema.json';
export const SCHEMA_ID = 'https://app.bike4mind.com/api/model-hub/curated/v2/schema.json';

const DESCRIPTION =
  'Structure of a curated local-model list (schemaVersion 2). This checks shape only: link safety (https on a ' +
  'public host, no credentials), per-entry and per-build consistency, and cross-references (tier picks, families, ' +
  'rankings, unique ids, sequence and changelog) are enforced by the Zod schema when a list is published.';

/** The schema of a list as authors write it (defaults optional), as the text committed at SCHEMA_PATH. */
export function curatedJsonSchemaText(): string {
  const generated = z.toJSONSchema(CuratedCatalogSchema, { target: 'draft-2020-12', io: 'input' });
  const { $schema, ...rest } = generated;
  const schema = { $schema, $id: SCHEMA_ID, title: 'Bike4Mind curated model list', description: DESCRIPTION, ...rest };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

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
