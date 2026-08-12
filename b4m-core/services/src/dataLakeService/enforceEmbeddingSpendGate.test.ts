import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_SPEND_PERIOD_KEY,
  EMBEDDING_SPEND_RATE_KEY,
  EmbeddingSpendDeniedError,
  enforceEmbeddingSpendGate,
} from './enforceEmbeddingSpendGate';
import { resolveSpendLevers, SpendLeverResolutionError, type DataLakeSpendLevers } from './resolveSpendLevers';

vi.mock('./resolveSpendLevers', async importOriginal => ({
  ...(await importOriginal<typeof import('./resolveSpendLevers')>()),
  resolveSpendLevers: vi.fn(),
}));

const mockedLevers = vi.mocked(resolveSpendLevers);

const levers = (overrides: Partial<DataLakeSpendLevers> = {}): DataLakeSpendLevers => ({
  spendEnabled: true,
  perRunBudgetMicroUsd: 5_000_000,
  perLakeBudgetMicroUsd: 100_000_000,
  perPeriodBudgetMicroUsd: 50_000_000,
  periodHours: 24,
  maxCallsPerMinute: 120,
  vectorizeChunkBatchSize: 50,
  ...overrides,
});

const grantAll = () => ({
  adminSettings: { findBySettingNames: vi.fn(), findAll: vi.fn() },
  cache: {
    tryAddWithinLimitFixedWindow: vi
      .fn()
      .mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) }),
  },
  dataLakes: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
  dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
});

const gate = (db: ReturnType<typeof grantAll>, estimatedMicroUsd = 1_000) =>
  enforceEmbeddingSpendGate({
    estimatedMicroUsd,
    batchId: 'batch1',
    dataLakeId: 'lake1',
    db,
    sleep: vi.fn().mockResolvedValue(undefined),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockedLevers.mockResolvedValue(levers());
});

describe('enforceEmbeddingSpendGate', () => {
  it('lets the call proceed when every meter grants, reserving in narrowest-first order', async () => {
    const db = grantAll();
    await expect(gate(db)).resolves.toBeUndefined();

    // run -> lake -> period, with the rate check first.
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenNthCalledWith(1, EMBEDDING_SPEND_RATE_KEY, 1, 120, 60_000);
    expect(db.dataLakeBatches.tryAddEmbeddingSpend).toHaveBeenCalledWith('batch1', 1_000, 5_000_000);
    expect(db.dataLakes.tryAddEmbeddingSpend).toHaveBeenCalledWith('lake1', 1_000, 100_000_000);
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenNthCalledWith(
      2,
      EMBEDDING_SPEND_PERIOD_KEY,
      1_000,
      50_000_000,
      24 * 3_600_000
    );
  });

  it('denies everything when the master switch is off, before touching any meter', async () => {
    mockedLevers.mockResolvedValue(levers({ spendEnabled: false }));
    const db = grantAll();
    await expect(gate(db)).rejects.toThrow(EmbeddingSpendDeniedError);
    expect(db.cache.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
    expect(db.dataLakeBatches.tryAddEmbeddingSpend).not.toHaveBeenCalled();
  });

  it('propagates a lever-resolution failure untouched (fail closed, distinct from a denial)', async () => {
    mockedLevers.mockRejectedValue(new SpendLeverResolutionError('unusable'));
    await expect(gate(grantAll())).rejects.toThrow(SpendLeverResolutionError);
  });

  it.each([
    ['per-run', (db: ReturnType<typeof grantAll>) => db.dataLakeBatches.tryAddEmbeddingSpend.mockResolvedValue(false)],
    ['per-lake', (db: ReturnType<typeof grantAll>) => db.dataLakes.tryAddEmbeddingSpend.mockResolvedValue(false)],
  ])('denies with a user-safe message when the %s budget meter denies', async (_name, arm) => {
    const db = grantAll();
    arm(db);
    await expect(gate(db)).rejects.toThrow(/cost governance denied it: the per-.* budget/);
  });

  it('denies when the period meter denies', async () => {
    const db = grantAll();
    db.cache.tryAddWithinLimitFixedWindow.mockImplementation(async (key: string) => ({
      success: key !== EMBEDDING_SPEND_PERIOD_KEY,
      count: 0,
      expiresAt: new Date(),
    }));
    await expect(gate(db)).rejects.toThrow(/platform-wide embedding budget/);
  });

  it('skips the per-run and per-lake meters when the ids are absent (non-batch work)', async () => {
    const db = grantAll();
    await enforceEmbeddingSpendGate({ estimatedMicroUsd: 1_000, db, sleep: vi.fn() });
    expect(db.dataLakeBatches.tryAddEmbeddingSpend).not.toHaveBeenCalled();
    expect(db.dataLakes.tryAddEmbeddingSpend).not.toHaveBeenCalled();
  });

  it('waits out a full rate window and proceeds once it grants', async () => {
    const db = grantAll();
    const sleep = vi.fn().mockResolvedValue(undefined);
    db.cache.tryAddWithinLimitFixedWindow
      .mockResolvedValueOnce({ success: false, count: 120, expiresAt: new Date(Date.now() + 5_000) })
      .mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });

    await enforceEmbeddingSpendGate({ estimatedMicroUsd: 1_000, batchId: 'b', dataLakeId: 'l', db, sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('denies after the rate window stays exhausted across all wait attempts', async () => {
    const db = grantAll();
    db.cache.tryAddWithinLimitFixedWindow.mockResolvedValue({
      success: false,
      count: 120,
      expiresAt: new Date(Date.now() + 5_000),
    });
    await expect(gate(db)).rejects.toThrow(/rate limit .*stayed exhausted/);
  });

  it('denies immediately on a rate limit of 0 (the STOP value) without waiting', async () => {
    mockedLevers.mockResolvedValue(levers({ maxCallsPerMinute: 0 }));
    const db = grantAll();
    const sleep = vi.fn();
    db.cache.tryAddWithinLimitFixedWindow.mockResolvedValue({ success: false, count: 0, expiresAt: new Date() });
    await expect(enforceEmbeddingSpendGate({ estimatedMicroUsd: 1, batchId: 'b', db, sleep })).rejects.toThrow(
      /rate limit is 0/
    );
    expect(sleep).not.toHaveBeenCalled();
  });
});
