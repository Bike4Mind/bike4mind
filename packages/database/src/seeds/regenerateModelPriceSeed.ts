import { writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { generateModelPriceSeed, ModelPriceSeedEntry } from './generateModelPriceSeed';

export interface ModelPriceSeedFileContents {
  generatedAt: string;
  entries: ModelPriceSeedEntry[];
}

/**
 * generatedAt doubles as every row's effectiveFrom, so it MUST move whenever
 * entries do; an in-place entry edit is dropped by seedModelPrices'
 * alreadyCurrent skip. This builder is the only supported way to update the
 * seed: pnpm --filter @bike4mind/database generate:model-price-seed
 */
export async function buildModelPriceSeedFile(now: Date): Promise<ModelPriceSeedFileContents> {
  return { generatedAt: now.toISOString(), entries: await generateModelPriceSeed() };
}

const isCliInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliInvocation) {
  const file = await buildModelPriceSeedFile(new Date());
  const target = join(dirname(fileURLToPath(import.meta.url)), 'modelPrices.seed.json');
  writeFileSync(target, JSON.stringify(file, null, 2) + '\n');
  console.info(`[modelPriceCatalog] wrote ${file.entries.length} entries to ${target}`);
}
