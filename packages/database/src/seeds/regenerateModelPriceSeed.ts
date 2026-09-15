import { realpathSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { generateModelPriceSeed } from './generateModelPriceSeed';
import type { ModelPriceSeedFile } from './seedModelPrices';

/**
 * generatedAt doubles as every row's effectiveFrom, so it MUST move whenever
 * entries do; an in-place entry edit is dropped by seedModelPrices'
 * alreadyCurrent skip. This builder is the only supported way to update the
 * seed: pnpm --filter @bike4mind/database generate:model-price-seed
 */
export async function buildModelPriceSeedFile(now: Date): Promise<ModelPriceSeedFile> {
  return { generatedAt: now.toISOString(), entries: await generateModelPriceSeed() };
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
  const file = await buildModelPriceSeedFile(new Date());
  const target = join(dirname(fileURLToPath(import.meta.url)), 'modelPrices.seed.json');
  writeFileSync(target, JSON.stringify(file, null, 2) + '\n');
  console.info(`[modelPriceCatalog] wrote ${file.entries.length} entries to ${target}`);
}
