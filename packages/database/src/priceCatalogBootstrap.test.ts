import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every collaborator so the module-level wiring latch is the only thing
// under test; no mongoose or real backend is touched.
const baseConnectDB = vi.fn();
const setModelPriceRowsProvider = vi.fn();
const rowsInForce = vi.fn();
const seedModelPrices = vi.fn();

vi.mock('@bike4mind/db-core', () => ({ connectDB: baseConnectDB }));
vi.mock('@bike4mind/llm-adapters', () => ({ setModelPriceRowsProvider }));
vi.mock('./models/billing/ModelPriceModel', () => ({ modelPriceRepository: { rowsInForce } }));
vi.mock('./seeds/seedModelPrices', () => ({ seedModelPrices }));

async function freshConnectDB() {
  // The wired-once latch is module state; a fresh import isolates each test.
  vi.resetModules();
  const { connectDB } = await import('./priceCatalogBootstrap');
  return connectDB;
}

describe('priceCatalogBootstrap.connectDB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseConnectDB.mockResolvedValue('connection');
    seedModelPrices.mockResolvedValue({ inserted: 0, skipped: 0 });
  });

  it('wires the rows provider and seeds exactly once across repeated connects', async () => {
    const connectDB = await freshConnectDB();
    await expect(connectDB('mongodb://x')).resolves.toBe('connection');
    await connectDB('mongodb://x');

    expect(setModelPriceRowsProvider).toHaveBeenCalledTimes(1);
    expect(seedModelPrices).toHaveBeenCalledTimes(1);
    expect(baseConnectDB).toHaveBeenCalledTimes(2);

    const provider = setModelPriceRowsProvider.mock.calls[0][0];
    await provider();
    expect(rowsInForce).toHaveBeenCalledTimes(1);
  });

  it('does not reject the connect when fire-and-forget seeding fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedModelPrices.mockRejectedValue(new Error('mongo down'));

    const connectDB = await freshConnectDB();
    await expect(connectDB('mongodb://x')).resolves.toBe('connection');
    // Flush the detached seeding promise before asserting on its handler.
    await new Promise(resolve => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('seeding failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('leaves the latch open when the underlying connect fails, so a retry still wires', async () => {
    baseConnectDB.mockRejectedValueOnce(new Error('refused'));

    const connectDB = await freshConnectDB();
    await expect(connectDB('mongodb://x')).rejects.toThrow('refused');
    expect(setModelPriceRowsProvider).not.toHaveBeenCalled();

    await connectDB('mongodb://x');
    expect(setModelPriceRowsProvider).toHaveBeenCalledTimes(1);
  });
});
