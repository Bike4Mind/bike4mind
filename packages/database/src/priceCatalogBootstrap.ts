import { connectDB as baseConnectDB } from '@bike4mind/db-core';
import { setModelCatalogProvider, setModelPriceRowsProvider } from '@bike4mind/llm-adapters';
import { modelPriceRepository } from './models/billing/ModelPriceModel';
import { modelCatalogRepository } from './models/ai/ModelCatalogModel';
import { seedModelCatalog } from './seeds/seedModelCatalog';
import { seedModelPrices } from './seeds/seedModelPrices';

let catalogWired = false;
let catalogSeedSettled: Promise<void> | null = null;

/**
 * Resolves once the boot-time catalog seed has settled (success or failure).
 * The discovery drivers await this before their first run: on a fresh database
 * the startup leg otherwise races seedCatalogs() and plans against a
 * half-inserted catalog - observed live as aggregators joining 23 targets
 * instead of 113. Resolved immediately when no bootstrap is in flight, so
 * callers on an already-seeded deployment pay nothing.
 */
export const whenCatalogSeeded = (): Promise<void> => catalogSeedSettled ?? Promise.resolve();

/**
 * Model catalog first, then prices: a model row always exists before a price row
 * can reference it, and a failure in either degrades identically (one catch, one
 * fallback tier). Discovery is deliberately NOT triggered here - connectDB
 * installs providers and seeds, nothing more.
 */
async function seedCatalogs(): Promise<void> {
  const catalog = await seedModelCatalog(modelCatalogRepository);
  if (catalog.inserted > 0) console.info(`[modelCatalog] seeded ${catalog.inserted} catalog rows`);
  const prices = await seedModelPrices(modelPriceRepository);
  if (prices.inserted > 0) console.info(`[modelPriceCatalog] seeded ${prices.inserted} price rows`);
}

/**
 * connectDB with one-time catalog bootstrap. Every server context that bills
 * (API routes, queue handlers, the chat-completion service, websocket handlers,
 * cron jobs) reaches Mongo through this export, so wiring here - rather than per
 * entry point - is what guarantees no settlement path bills from stale adapter
 * literals and no picker reads a stale model list. After the first successful
 * connect it (a) injects the model-catalog and price rows providers into
 * getAvailableModels and (b) self-seeds both collections (append-only,
 * race-safe, operator rows always win). Fire-and-forget: seeding failure
 * degrades to the adapter tables, never blocks a request.
 *
 * Known limitation, unchanged from the price-only version: the latch is set
 * before the async seed resolves, so a failed seed is never retried in-process.
 * Acceptable for the same reason - the next process boot retries and the
 * fallback tier is correct meanwhile.
 *
 * Tests use the unwrapped connectDB via packages/database/src/utils/mongo so
 * in-memory suites are not seeded and no global provider leaks across tests.
 */
export const connectDB: typeof baseConnectDB = async (url, logger) => {
  const result = await baseConnectDB(url, logger);
  if (!catalogWired) {
    catalogWired = true;
    setModelCatalogProvider(() => modelCatalogRepository.rowsInForce());
    setModelPriceRowsProvider(() => modelPriceRepository.rowsInForce());
    catalogSeedSettled = seedCatalogs().catch((error: unknown) => {
      console.warn('[modelCatalog] seeding failed; adapter tables remain the fallback', error);
    });
  }
  return result;
};
