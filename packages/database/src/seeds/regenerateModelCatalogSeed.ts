import { realpathSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { generateModelCatalogSeed } from './generateModelCatalogSeed';
import type { ModelCatalogSeedFile } from './seedModelCatalog';

/**
 * The "last maintained" claim, kept honest by a CI staleness guard on
 * generatedAt (modelCatalogSeed.test.ts) and surfaced verbatim in the admin
 * catalog banner. Regenerating is what moves the date.
 */
export function buildSeedNotice(now: Date): string {
  return (
    `Fallback defaults last maintained on ${now.toISOString().slice(0, 10)}. ` +
    'Models and pricing live-update at runtime; this seed only bootstraps empty databases and covers feed outages.'
  );
}

/**
 * generatedAt doubles as every row's effectiveFrom, so it MUST move whenever
 * entries do; an in-place entry edit is dropped by seedModelCatalog's
 * alreadyCurrent skip. This builder is the only supported way to update the
 * seed: pnpm --filter @bike4mind/database generate:model-catalog-seed
 *
 * Run pnpm turbo:core:build first - the generator harvests the BUILT adapter
 * tables, so a stale dist writes a stale seed.
 */
export async function buildModelCatalogSeedFile(now: Date): Promise<ModelCatalogSeedFile> {
  return {
    generatedAt: now.toISOString(),
    notice: buildSeedNotice(now),
    entries: await generateModelCatalogSeed(),
  };
}

// realpath both sides: argv[1] and import.meta.url can disagree on symlinked
// checkout paths (e.g. macOS /tmp), which would make the CLI a silent no-op.
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const isCliInvocation = process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));
if (isCliInvocation) {
  const file = await buildModelCatalogSeedFile(new Date());
  const target = join(dirname(fileURLToPath(import.meta.url)), 'modelCatalog.seed.json');
  writeFileSync(target, JSON.stringify(file, null, 2) + '\n');
  console.info(`[modelCatalog] wrote ${file.entries.length} entries to ${target}`);
}
