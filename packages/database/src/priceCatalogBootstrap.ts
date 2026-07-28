import { connectDB as baseConnectDB } from '@bike4mind/db-core';
import { setModelCatalogProvider, setModelPriceRowsProvider } from '@bike4mind/llm-adapters';
import { modelPriceRepository } from './models/billing/ModelPriceModel';
import { ModelCatalog, modelCatalogRepository } from './models/ai/ModelCatalogModel';
import { ModelDiscoveryState } from './models/ai/ModelDiscoveryStateModel';
import { seedModelCatalog } from './seeds/seedModelCatalog';
import { seedModelPrices } from './seeds/seedModelPrices';

let catalogWired = false;
let catalogSeedSettled: Promise<boolean> | null = null;

/**
 * Resolves once the boot-time catalog seed has settled, to whether the CATALOG
 * seed itself succeeded (never rejects). The discovery drivers await this before
 * their first run: on a fresh database the startup leg otherwise races
 * seedCatalogs() and plans against a half-inserted catalog - observed live as
 * aggregators joining 23 targets instead of 113. A failed seed resolves false,
 * because the same half-seeded catalog is what the run would then plan against.
 * Resolves immediately to true when no bootstrap is in flight, so callers on an
 * already-seeded deployment pay nothing.
 */
export const whenCatalogSeeded = (): Promise<boolean> => catalogSeedSettled ?? Promise.resolve(true);

/**
 * Await one collection's index build, warning instead of throwing.
 *
 * mongo.ts sets autoIndex, but Mongoose fires createIndexes without anything
 * awaiting it, so on a fresh database the first writers can beat their own
 * unique index into the collection: the duplicates land, createIndexes then
 * fails on them, and the index is never created again. ModelCatalog and
 * ModelDiscoveryState are both new collections, so every deployment gets exactly
 * that cold start. ModelPrice is deliberately absent - its collection and index
 * predate this.
 *
 * A failed build must not skip the seeding it precedes: an already-duplicated
 * collection would then never receive its rows.
 */
async function ensureUniqueIndex(label: string, model: { init(): Promise<unknown> }): Promise<void> {
  try {
    await model.init();
  } catch (error) {
    console.warn(`[${label}] unique index build failed; concurrent writers may duplicate rows`, error);
  }
}

/**
 * Seed both collections, each independently: a catalog failure must not cancel
 * price seeding, or one transient write error would leave the process billing
 * from adapter literals for its whole lifetime. Catalog first only for ordering
 * on a fresh database (a model row before the price row referencing it) - the
 * price seed does not depend on the catalog seed's success. Discovery is
 * deliberately NOT triggered here - connectDB installs providers and seeds,
 * nothing more.
 *
 * Returns whether the catalog seed succeeded; see whenCatalogSeeded.
 */
async function seedCatalogs(): Promise<boolean> {
  // Before any write: seedModelCatalog resolves the concurrent-seeder race only
  // by catching E11000, which needs the {modelId, effectiveFrom} unique index to
  // already exist. The discovery drivers gate on whenCatalogSeeded, so awaiting
  // ModelDiscoveryState's index here also puts it ahead of the first
  // recordSighting upsert.
  await Promise.all([
    ensureUniqueIndex('modelCatalog', ModelCatalog),
    ensureUniqueIndex('modelDiscoveryState', ModelDiscoveryState),
  ]);

  let catalogSeeded = true;
  try {
    const catalog = await seedModelCatalog(modelCatalogRepository);
    if (catalog.inserted > 0) console.info(`[modelCatalog] seeded ${catalog.inserted} catalog rows`);
  } catch (error) {
    catalogSeeded = false;
    console.warn('[modelCatalog] catalog seeding failed; adapter tables remain the fallback', error);
  }

  try {
    const prices = await seedModelPrices(modelPriceRepository);
    if (prices.inserted > 0) console.info(`[modelPriceCatalog] seeded ${prices.inserted} price rows`);
  } catch (error) {
    console.warn('[modelPriceCatalog] price seeding failed; adapter literals remain the fallback', error);
  }

  return catalogSeeded;
}

/**
 * connectDB with one-time catalog bootstrap. Every server context that bills
 * (API routes, queue handlers, the chat-completion service, websocket handlers,
 * cron jobs) reaches Mongo through this export, so wiring here - rather than per
 * entry point - is what guarantees no settlement path bills from stale adapter
 * literals and no picker reads a stale model list. After the first successful
 * connect it (a) injects the model-catalog and price rows providers into
 * getAvailableModels and (b) self-seeds both collections (append-only,
 * race-safe, operator rows always win). Fire-and-forget: a seeding failure
 * degrades that collection to its adapter fallback, never blocks a request and
 * never stops the other collection from seeding.
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
    // seedCatalogs catches per collection; this catch only keeps the
    // fire-and-forget promise from ever rejecting, which whenCatalogSeeded's
    // callers rely on.
    catalogSeedSettled = seedCatalogs().catch((error: unknown) => {
      console.warn('[modelCatalog] seeding failed unexpectedly; adapter tables remain the fallback', error);
      return false;
    });
  }
  return result;
};
