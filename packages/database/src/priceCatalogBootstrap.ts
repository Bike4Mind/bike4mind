import { connectDB as baseConnectDB } from '@bike4mind/db-core';
import { setModelPriceRowsProvider } from '@bike4mind/llm-adapters';
import { modelPriceRepository } from './models/billing/ModelPriceModel';
import { seedModelPrices } from './seeds/seedModelPrices';

let catalogWired = false;

/**
 * connectDB with one-time price-catalog bootstrap. Every server context that
 * bills (API routes, queue handlers, the chat-completion service, websocket
 * handlers, cron jobs) reaches Mongo through this export, so wiring here -
 * rather than per entry point - is what guarantees no settlement path bills
 * from stale adapter literals. After the first successful connect it (a)
 * injects the catalog rows provider into getAvailableModels and (b) self-seeds
 * the catalog (append-only, race-safe, operator rows always win). Fire-and-
 * forget: seeding failure degrades to adapter literals, never blocks a request.
 *
 * Tests use the unwrapped connectDB via packages/database/src/utils/mongo so
 * in-memory suites are not seeded and no global provider leaks across tests.
 */
export const connectDB: typeof baseConnectDB = async (url, logger) => {
  const result = await baseConnectDB(url, logger);
  if (!catalogWired) {
    catalogWired = true;
    setModelPriceRowsProvider(() => modelPriceRepository.rowsInForce());
    seedModelPrices(modelPriceRepository)
      .then(({ inserted }) => {
        if (inserted > 0) console.info(`[modelPriceCatalog] seeded ${inserted} price rows`);
      })
      .catch((error: unknown) => {
        console.warn('[modelPriceCatalog] seeding failed; adapter literals remain the fallback', error);
      });
  }
  return result;
};
