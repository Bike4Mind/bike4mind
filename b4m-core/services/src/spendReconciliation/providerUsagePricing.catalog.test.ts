import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { priceProviderUsage, type UsageReportProvider } from './providerUsagePricing';

interface CatalogSeedEntry {
  modelId: string;
  patch: { id: string; backend: string; type: string; freeToRun?: boolean };
}

// The seed lives in packages/database, which services cannot import; the path is a turbo test input.
const SEED_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/database/src/seeds/modelCatalog.seed.json'
);

const POLLED_BACKENDS: readonly string[] = ['openai', 'anthropic'];
// The poller keeps text and image models (see providerModels); speech-to-text is not token-priced.
const POLLED_TYPES: readonly string[] = ['text', 'image'];

function polledCatalogModels(): { id: string; provider: UsageReportProvider }[] {
  const { entries } = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { entries: CatalogSeedEntry[] };
  return entries
    .filter(({ patch }) => POLLED_BACKENDS.includes(patch.backend) && POLLED_TYPES.includes(patch.type))
    .filter(({ patch }) => !patch.freeToRun)
    .map(({ patch }) => ({ id: patch.id, provider: patch.backend as UsageReportProvider }));
}

// Catalog models priced only by a Mongo ModelPrice row are covered at runtime by the discovery
// snapshot; this is the backstop for every model the code itself declares.
describe('provider usage pricing covers the declared catalog', () => {
  it('prices every OpenAI and Anthropic catalog model without the runtime snapshot', async () => {
    const models = polledCatalogModels();
    expect(models.length).toBeGreaterThan(10);

    const unpriced: string[] = [];
    for (const { id, provider } of models) {
      const result = await priceProviderUsage(provider, [
        {
          bucketStart: new Date('2026-01-01T00:00:00Z'),
          model: id,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inScope: true,
        },
      ]);
      if (result.unpricedOutputTokens !== 0) unpriced.push(`${provider}:${id}`);
    }

    expect(
      unpriced,
      `The hourly provider usage poller cannot price these catalog models without the runtime snapshot: ${unpriced.join(', ')}. ` +
        'Add the price to the provider adapter table in b4m-core/llm-adapters, or to USAGE_ONLY_PRICING in ' +
        'b4m-core/services/src/spendReconciliation/providerUsagePricing.ts.'
    ).toEqual([]);
  });
});
