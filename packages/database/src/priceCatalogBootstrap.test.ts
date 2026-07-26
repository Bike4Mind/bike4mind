import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every collaborator so the module-level wiring latch is the only thing
// under test; no mongoose or real backend is touched.
const baseConnectDB = vi.fn();
const setModelPriceRowsProvider = vi.fn();
const setModelCatalogProvider = vi.fn();
const priceRowsInForce = vi.fn();
const catalogRowsInForce = vi.fn();
const seedModelPrices = vi.fn();
const seedModelCatalog = vi.fn();

vi.mock('@bike4mind/db-core', () => ({ connectDB: baseConnectDB }));
vi.mock('@bike4mind/llm-adapters', () => ({ setModelPriceRowsProvider, setModelCatalogProvider }));
vi.mock('./models/billing/ModelPriceModel', () => ({ modelPriceRepository: { rowsInForce: priceRowsInForce } }));
vi.mock('./models/ai/ModelCatalogModel', () => ({ modelCatalogRepository: { rowsInForce: catalogRowsInForce } }));
vi.mock('./seeds/seedModelPrices', () => ({ seedModelPrices }));
vi.mock('./seeds/seedModelCatalog', () => ({ seedModelCatalog }));

async function freshConnectDB() {
  // The wired-once latch is module state; a fresh import isolates each test.
  vi.resetModules();
  const { connectDB } = await import('./priceCatalogBootstrap');
  return connectDB;
}

/** Let the detached seeding promise settle before asserting on its effects. */
const flushSeeding = () => new Promise(resolve => setImmediate(resolve));

describe('priceCatalogBootstrap.connectDB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseConnectDB.mockResolvedValue('connection');
    seedModelPrices.mockResolvedValue({ inserted: 0, skipped: 0 });
    seedModelCatalog.mockResolvedValue({ inserted: 0, skipped: 0 });
  });

  it('wires both providers and seeds exactly once across repeated connects', async () => {
    const connectDB = await freshConnectDB();
    await expect(connectDB('mongodb://x')).resolves.toBe('connection');
    await connectDB('mongodb://x');
    await flushSeeding();

    expect(setModelCatalogProvider).toHaveBeenCalledTimes(1);
    expect(setModelPriceRowsProvider).toHaveBeenCalledTimes(1);
    expect(seedModelCatalog).toHaveBeenCalledTimes(1);
    expect(seedModelPrices).toHaveBeenCalledTimes(1);
    expect(baseConnectDB).toHaveBeenCalledTimes(2);

    await setModelCatalogProvider.mock.calls[0][0]();
    expect(catalogRowsInForce).toHaveBeenCalledTimes(1);
    await setModelPriceRowsProvider.mock.calls[0][0]();
    expect(priceRowsInForce).toHaveBeenCalledTimes(1);
  });

  it('seeds the catalog before prices, so a model row exists before a price row references it', async () => {
    const order: string[] = [];
    seedModelCatalog.mockImplementation(async () => {
      order.push('catalog');
      return { inserted: 0, skipped: 0 };
    });
    seedModelPrices.mockImplementation(async () => {
      order.push('prices');
      return { inserted: 0, skipped: 0 };
    });

    const connectDB = await freshConnectDB();
    await connectDB('mongodb://x');
    await flushSeeding();

    expect(order).toEqual(['catalog', 'prices']);
  });

  it('does not reject the connect when fire-and-forget seeding fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedModelPrices.mockRejectedValue(new Error('mongo down'));

    const connectDB = await freshConnectDB();
    await expect(connectDB('mongodb://x')).resolves.toBe('connection');
    await flushSeeding();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('seeding failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('degrades identically when the catalog seed is the one that fails: prices are skipped, the connect is not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedModelCatalog.mockRejectedValue(new Error('mongo down'));

    const connectDB = await freshConnectDB();
    await expect(connectDB('mongodb://x')).resolves.toBe('connection');
    await flushSeeding();

    expect(seedModelPrices).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('seeding failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('leaves the latch open when the underlying connect fails, so a retry still wires', async () => {
    baseConnectDB.mockRejectedValueOnce(new Error('refused'));

    const connectDB = await freshConnectDB();
    await expect(connectDB('mongodb://x')).rejects.toThrow('refused');
    expect(setModelCatalogProvider).not.toHaveBeenCalled();
    expect(setModelPriceRowsProvider).not.toHaveBeenCalled();

    await connectDB('mongodb://x');
    expect(setModelCatalogProvider).toHaveBeenCalledTimes(1);
    expect(setModelPriceRowsProvider).toHaveBeenCalledTimes(1);
  });
});
