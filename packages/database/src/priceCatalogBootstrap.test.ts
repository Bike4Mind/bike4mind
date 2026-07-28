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
const catalogInit = vi.fn();
const discoveryStateInit = vi.fn();

vi.mock('@bike4mind/db-core', () => ({ connectDB: baseConnectDB }));
vi.mock('@bike4mind/llm-adapters', () => ({ setModelPriceRowsProvider, setModelCatalogProvider }));
vi.mock('./models/billing/ModelPriceModel', () => ({ modelPriceRepository: { rowsInForce: priceRowsInForce } }));
vi.mock('./models/ai/ModelCatalogModel', () => ({
  modelCatalogRepository: { rowsInForce: catalogRowsInForce },
  ModelCatalog: { init: catalogInit },
}));
vi.mock('./models/ai/ModelDiscoveryStateModel', () => ({ ModelDiscoveryState: { init: discoveryStateInit } }));
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
    catalogInit.mockResolvedValue(undefined);
    discoveryStateInit.mockResolvedValue(undefined);
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

  it('awaits both unique-index builds before the first write', async () => {
    // autoIndex is fire-and-forget: seeding a fresh collection first lets the
    // duplicates land, and createIndexes then fails on them permanently. The
    // discovery drivers gate on whenCatalogSeeded, so the discovery-state index
    // has to be built here too, ahead of the first recordSighting upsert.
    const order: string[] = [];
    catalogInit.mockImplementation(async () => order.push('catalog-index'));
    discoveryStateInit.mockImplementation(async () => order.push('discovery-index'));
    seedModelCatalog.mockImplementation(async () => {
      order.push('catalog-seed');
      return { inserted: 0, skipped: 0 };
    });

    const connectDB = await freshConnectDB();
    await connectDB('mongodb://x');
    await flushSeeding();

    expect(order).toEqual(['catalog-index', 'discovery-index', 'catalog-seed']);
  });

  it('still seeds when an index build fails, so an already-duplicated collection is not left empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    catalogInit.mockRejectedValue(new Error('E11000 duplicate key'));

    const connectDB = await freshConnectDB();
    await connectDB('mongodb://x');
    await flushSeeding();

    expect(seedModelCatalog).toHaveBeenCalledTimes(1);
    expect(seedModelPrices).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unique index build failed'), expect.any(Error));
    warn.mockRestore();
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

  it('still seeds prices when the catalog seed fails, and reports the catalog as unseeded', async () => {
    // The two collections have independent fallback tiers: a catalog write error
    // must not cost the whole process its price rows.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedModelCatalog.mockRejectedValue(new Error('mongo down'));

    vi.resetModules();
    const bootstrap = await import('./priceCatalogBootstrap');
    await expect(bootstrap.connectDB('mongodb://x')).resolves.toBe('connection');
    await flushSeeding();

    expect(seedModelPrices).toHaveBeenCalledTimes(1);
    await expect(bootstrap.whenCatalogSeeded()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('seeding failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('reports the catalog as seeded only when its seed actually completed', async () => {
    vi.resetModules();
    const bootstrap = await import('./priceCatalogBootstrap');
    await bootstrap.connectDB('mongodb://x');
    await flushSeeding();

    await expect(bootstrap.whenCatalogSeeded()).resolves.toBe(true);
  });

  it('reports the catalog as seeded when only the price seed fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedModelPrices.mockRejectedValue(new Error('mongo down'));

    vi.resetModules();
    const bootstrap = await import('./priceCatalogBootstrap');
    await bootstrap.connectDB('mongodb://x');
    await flushSeeding();

    await expect(bootstrap.whenCatalogSeeded()).resolves.toBe(true);
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

  it('whenCatalogSeeded resolves immediately with no bootstrap in flight, and only after the seed settles with one', async () => {
    vi.resetModules();
    const bootstrap = await import('./priceCatalogBootstrap');

    // Nothing in flight (connectDB never called): must not block callers, and
    // an already-seeded deployment is not an unseeded one.
    await expect(bootstrap.whenCatalogSeeded()).resolves.toBe(true);

    let release!: () => void;
    seedModelCatalog.mockImplementation(
      () => new Promise(resolve => (release = () => resolve({ inserted: 113, skipped: 0 })))
    );
    await bootstrap.connectDB('mongodb://x');

    // The discovery drivers await this: resolving before the seed settles is
    // the fresh-database race where a run plans against a half-inserted catalog.
    let settled = false;
    const waiter = bootstrap.whenCatalogSeeded().then(() => (settled = true));
    await flushSeeding();
    expect(settled).toBe(false);

    release();
    await waiter;
    expect(settled).toBe(true);
  });
});
