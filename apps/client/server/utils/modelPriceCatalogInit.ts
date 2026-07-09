import { setModelPriceRowsProvider } from '@bike4mind/llm-adapters';
import { modelPriceRepository, seedModelPrices, SEED_EPOCH } from '@bike4mind/database';

let wired = false;

/**
 * Wire the versioned price catalog into getAvailableModels (one process-wide
 * call; the provider then costs one DB read per model-cache rebuild) and
 * self-seed the catalog from the checked-in seed file on first run. Seeding is
 * append-only and race-safe (deterministic SEED_EPOCH + unique index), so this
 * is safe to call from every request path; it no-ops after the first call.
 * Must run after connectDB - both request chokepoints guarantee that.
 */
export function ensureModelPriceCatalog(): void {
  if (wired) return;
  wired = true;

  setModelPriceRowsProvider(() => modelPriceRepository.rowsInForce());

  seedModelPrices(modelPriceRepository, { effectiveFrom: SEED_EPOCH })
    .then(({ inserted }) => {
      if (inserted > 0) console.info(`[modelPriceCatalog] seeded ${inserted} price rows`);
    })
    .catch((error: unknown) => {
      console.warn('[modelPriceCatalog] seeding failed; adapter literals remain the fallback', error);
    });
}
