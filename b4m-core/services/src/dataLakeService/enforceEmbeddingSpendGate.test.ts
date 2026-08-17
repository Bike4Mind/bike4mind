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
  dataLakes: { tryAddEmbeddingSpendMetered: vi.fn().mockResolvedValue({ granted: true, spendMicroUsd: 1_000 }) },
  dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
});

const gate = (
  db: ReturnType<typeof grantAll>,
  estimatedMicroUsd = 1_000,
  notify?: (event: unknown) => Promise<unknown>
) =>
  enforceEmbeddingSpendGate({
    estimatedMicroUsd,
    batchId: 'batch1',
    dataLakeId: 'lake1',
    db,
    sleep: vi.fn().mockResolvedValue(undefined),
    notify,
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
    expect(db.dataLakes.tryAddEmbeddingSpendMetered).toHaveBeenCalledWith('lake1', 1_000, 100_000_000);
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
    [
      'per-lake',
      (db: ReturnType<typeof grantAll>) =>
        db.dataLakes.tryAddEmbeddingSpendMetered.mockResolvedValue({ granted: false, spendMicroUsd: null }),
    ],
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
    expect(db.dataLakes.tryAddEmbeddingSpendMetered).not.toHaveBeenCalled();
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

  it('denies (retryable) once the total wait budget is exhausted, instead of sleeping the Lambda out', async () => {
    const db = grantAll();
    // Each probe reports the window closing 20s out: the first wait fits the 30s budget, the
    // second would exceed it, so the gate hands the message back to SQS instead of sleeping.
    db.cache.tryAddWithinLimitFixedWindow.mockResolvedValue({
      success: false,
      count: 120,
      expiresAt: new Date(Date.now() + 20_000),
    });
    let denial: unknown;
    await gate(db).catch(err => (denial = err));
    expect(denial).toBeInstanceOf(EmbeddingSpendDeniedError);
    expect((denial as EmbeddingSpendDeniedError).retryable).toBe(true);
    expect((denial as Error).message).toMatch(/stayed exhausted after waiting/);
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

describe('enforceEmbeddingSpendGate - spend notifications', () => {
  it('notify is a no-op when omitted - every existing caller/test is unaffected', async () => {
    const db = grantAll();
    await expect(gate(db)).resolves.toBeUndefined();
  });

  it('fires a stopped/switch notification before the switch-off throw', async () => {
    mockedLevers.mockResolvedValue(levers({ spendEnabled: false }));
    const db = grantAll();
    const notify = vi.fn().mockResolvedValue(undefined);
    const order: string[] = [];
    notify.mockImplementation(async () => {
      order.push('notify');
    });

    await gate(db, 1_000, notify).catch(() => order.push('threw'));

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ dataLakeId: 'lake1', kind: 'stopped', scope: 'switch' })
    );
    expect(order).toEqual(['notify', 'threw']);
  });

  it('fires a stopped/rate notification when the rate limit is 0', async () => {
    mockedLevers.mockResolvedValue(levers({ maxCallsPerMinute: 0 }));
    const db = grantAll();
    db.cache.tryAddWithinLimitFixedWindow.mockResolvedValue({ success: false, count: 0, expiresAt: new Date() });
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify).catch(() => {});

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stopped', scope: 'rate' }));
  });

  it('fires a throttled/rate notification when the wait budget is exhausted (retryable)', async () => {
    const db = grantAll();
    db.cache.tryAddWithinLimitFixedWindow.mockResolvedValue({
      success: false,
      count: 120,
      expiresAt: new Date(Date.now() + 20_000),
    });
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify).catch(() => {});

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'throttled',
        scope: 'rate',
        detail: expect.objectContaining({ retryable: true }),
      })
    );
  });

  it('fires a budget_exhausted/run notification on a per-run denial', async () => {
    const db = grantAll();
    db.dataLakeBatches.tryAddEmbeddingSpend.mockResolvedValue(false);
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify).catch(() => {});

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'budget_exhausted', scope: 'run', periodKey: 'run:batch1' })
    );
  });

  it('fires a budget_exhausted/lake notification on a per-lake denial', async () => {
    const db = grantAll();
    db.dataLakes.tryAddEmbeddingSpendMetered.mockResolvedValue({ granted: false, spendMicroUsd: null });
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify).catch(() => {});

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'budget_exhausted', scope: 'lake', periodKey: 'lake:100000000' })
    );
  });

  it('fires a budget_exhausted/period notification on a period denial', async () => {
    const db = grantAll();
    const expiresAt = new Date(Date.now() + 3_600_000);
    db.cache.tryAddWithinLimitFixedWindow.mockImplementation(async (key: string) => ({
      success: key !== EMBEDDING_SPEND_PERIOD_KEY,
      count: 0,
      expiresAt,
    }));
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify).catch(() => {});

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'budget_exhausted', scope: 'period', periodKey: `w:${expiresAt.toISOString()}` })
    );
  });

  it('keys a period denial on the clock, not a synthesized expiresAt, when the cache never seeded a window (budget 0 or a single call over budget)', async () => {
    // Simulates CacheModel.tryAddWithinLimitFixedWindow's real behavior when the seed step is
    // skipped (amount > limit): every call returns a FRESH expiresAt (now + ttl), which would
    // make periodKeyForWindow msec-unique per call if used - the exact bug this test guards.
    mockedLevers.mockResolvedValue(levers({ perPeriodBudgetMicroUsd: 0 }));
    const db = grantAll();
    db.cache.tryAddWithinLimitFixedWindow.mockImplementation(async (key: string) => ({
      success: key !== EMBEDDING_SPEND_PERIOD_KEY,
      count: 0,
      expiresAt: new Date(Date.now() + Math.random() * 1000), // a fresh, distinct instant each call
    }));
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify).catch(() => {});
    await gate(db, 1_000, notify).catch(() => {});

    const periodKeys = notify.mock.calls
      .map(([event]) => event as { scope: string; periodKey: string })
      .filter(event => event.scope === 'period')
      .map(event => event.periodKey);
    expect(periodKeys).toHaveLength(2);
    expect(periodKeys[0]).toEqual(periodKeys[1]);
    expect(periodKeys[0]).toMatch(/^t:\d+$/);
  });

  it('fires approaching_cap/lake at exactly 80% of the per-lake budget', async () => {
    const db = grantAll();
    db.dataLakes.tryAddEmbeddingSpendMetered.mockResolvedValue({ granted: true, spendMicroUsd: 80_000_000 });
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approaching_cap', scope: 'lake', thresholdPct: 0.8 })
    );
  });

  it('does NOT fire approaching_cap/lake at 79% of the per-lake budget', async () => {
    const db = grantAll();
    db.dataLakes.tryAddEmbeddingSpendMetered.mockResolvedValue({ granted: true, spendMicroUsd: 79_000_000 });
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify);

    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'approaching_cap' }));
  });

  it('never fires approaching_cap/period, even at 80%+ of the platform-period budget (deliberate: one arbitrary tenant, no platform admin)', async () => {
    const db = grantAll();
    const expiresAt = new Date(Date.now() + 3_600_000);
    db.cache.tryAddWithinLimitFixedWindow.mockImplementation(async (key: string) => ({
      success: true,
      count: key === EMBEDDING_SPEND_PERIOD_KEY ? 40_000_000 : 1,
      expiresAt,
    }));
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify);

    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ scope: 'period', kind: 'approaching_cap' }));
  });

  it('never fires approaching_cap when a reservation was denied (checked only after every grant)', async () => {
    const db = grantAll();
    db.dataLakes.tryAddEmbeddingSpendMetered.mockResolvedValue({ granted: false, spendMicroUsd: null });
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify).catch(() => {});

    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'approaching_cap' }));
  });

  it("notify rejecting does not change the gate's own resolve/reject outcome (grant path)", async () => {
    const db = grantAll();
    const notify = vi.fn().mockRejectedValue(new Error('mailer down'));

    await expect(gate(db, 1_000, notify)).resolves.toBeUndefined();
  });

  it("notify rejecting does not change the gate's own resolve/reject outcome (deny path)", async () => {
    mockedLevers.mockResolvedValue(levers({ spendEnabled: false }));
    const db = grantAll();
    const notify = vi.fn().mockRejectedValue(new Error('mailer down'));

    await expect(gate(db, 1_000, notify)).rejects.toThrow(EmbeddingSpendDeniedError);
  });

  it('suppresses every notification when dataLakeId is absent (non-lake work)', async () => {
    const db = grantAll();
    db.dataLakeBatches.tryAddEmbeddingSpend.mockResolvedValue(false);
    const notify = vi.fn().mockResolvedValue(undefined);

    await enforceEmbeddingSpendGate({
      estimatedMicroUsd: 1_000,
      batchId: 'batch1',
      db,
      sleep: vi.fn(),
      notify,
    }).catch(() => {});

    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire approaching_cap/lake again on a later message that stays over the threshold', async () => {
    // The lake was already at 85% before this message reserved another 1_000 - the crossing
    // already happened on a prior message, so this one must not re-fire.
    const db = grantAll();
    db.dataLakes.tryAddEmbeddingSpendMetered.mockResolvedValue({ granted: true, spendMicroUsd: 85_001_000 });
    const notify = vi.fn().mockResolvedValue(undefined);

    await gate(db, 1_000, notify);

    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'approaching_cap' }));
  });

  it("bounds a hung notify() so it never blocks the gate's own resolution", async () => {
    const db = grantAll();
    const hungNotify = vi.fn().mockReturnValue(new Promise<never>(() => {})); // never resolves/rejects

    await expect(
      enforceEmbeddingSpendGate({
        estimatedMicroUsd: 1_000,
        batchId: 'batch1',
        dataLakeId: 'lake1',
        db,
        sleep: vi.fn().mockResolvedValue(undefined),
        notify: hungNotify,
        notifyTimeoutMs: 10,
      })
    ).resolves.toBeUndefined();
  });
});
