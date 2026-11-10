import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import {
  EMBEDDING_SPEND_PERIOD_KEY,
  EMBEDDING_SPEND_RATE_KEY,
  EMBEDDING_SPEND_TOKEN_RATE_KEY,
  EmbeddingSpendDeniedError,
  enforceEmbeddingSpendGate,
  type SpendGateDb,
} from './enforceEmbeddingSpendGate';
import { resolveSpendLevers, SpendLeverResolutionError, type DataLakeSpendLevers } from './resolveSpendLevers';
import { ownerEmbeddingSpendKey } from './reserveOwnerEmbeddingSpend';
import type { DataLakeSpendNotificationEvent } from './sendDataLakeSpendNotification';

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
  perOwnerPeriodBudgetMicroUsd: 5_000_000,
  periodHours: 24,
  maxCallsPerMinute: 120,
  maxTokensPerMinute: 600_000,
  vectorizeChunkBatchSize: 50,
  tierMultiplier: 1,
  ...overrides,
});

/** An individual-owned lake unless a test says otherwise (no organizationId). */
const lakeDoc = (organizationId?: string) => ({ id: 'lake1', createdByUserId: 'user1', organizationId });

const grantAll = () => ({
  adminSettings: { findBySettingNames: vi.fn(), findAll: vi.fn() },
  cache: {
    tryAddWithinLimitFixedWindow: vi
      .fn()
      .mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) }),
  },
  dataLakes: {
    tryAddEmbeddingSpendMetered: vi.fn().mockResolvedValue({ granted: true, spendMicroUsd: 1_000 }),
    findById: vi.fn().mockResolvedValue(lakeDoc()),
  },
  dataLakeBatches: { tryAddEmbeddingSpend: vi.fn().mockResolvedValue(true) },
});

const gate = (
  db: ReturnType<typeof grantAll>,
  estimatedMicroUsd = 1_000,
  notify?: (event: unknown) => Promise<unknown>,
  estimatedTokens = 1_000
) =>
  enforceEmbeddingSpendGate({
    estimatedMicroUsd,
    estimatedTokens,
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

    // run -> lake -> owner -> period, with both throughput windows (calls, then tokens) checked first.
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenNthCalledWith(1, EMBEDDING_SPEND_RATE_KEY, 1, 120, 60_000);
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenNthCalledWith(
      2,
      EMBEDDING_SPEND_TOKEN_RATE_KEY,
      1_000,
      600_000,
      60_000
    );
    expect(db.dataLakeBatches.tryAddEmbeddingSpend).toHaveBeenCalledWith('batch1', 1_000, 5_000_000);
    expect(db.dataLakes.tryAddEmbeddingSpendMetered).toHaveBeenCalledWith('lake1', 1_000, 100_000_000);
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenNthCalledWith(
      3,
      ownerEmbeddingSpendKey({ type: CreditHolderType.User, id: 'user1' }),
      1_000,
      5_000_000,
      24 * 3_600_000
    );
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenNthCalledWith(
      4,
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
    await enforceEmbeddingSpendGate({ estimatedMicroUsd: 1_000, estimatedTokens: 1_000, db, sleep: vi.fn() });
    expect(db.dataLakeBatches.tryAddEmbeddingSpend).not.toHaveBeenCalled();
    expect(db.dataLakes.tryAddEmbeddingSpendMetered).not.toHaveBeenCalled();
  });

  it('waits out a full rate window and proceeds once it grants', async () => {
    const db = grantAll();
    const sleep = vi.fn().mockResolvedValue(undefined);
    db.cache.tryAddWithinLimitFixedWindow
      .mockResolvedValueOnce({ success: false, count: 120, expiresAt: new Date(Date.now() + 5_000) })
      .mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });

    await enforceEmbeddingSpendGate({
      estimatedMicroUsd: 1_000,
      estimatedTokens: 1_000,
      batchId: 'b',
      dataLakeId: 'l',
      db,
      sleep,
    });
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
    expect((denial as EmbeddingSpendDeniedError).retryAfterMs).toBeGreaterThan(0);
  });

  it('denies without sleeping when the window resets later than the whole wait budget, and says when it resets', async () => {
    const db = grantAll();
    // 45s to reset > the 30s budget: sleeping first would only burn reserved concurrency before
    // denying anyway, so the gate denies at once and reports the reset for the consumer's back-off.
    db.cache.tryAddWithinLimitFixedWindow.mockResolvedValue({
      success: false,
      count: 120,
      expiresAt: new Date(Date.now() + 45_000),
    });
    const sleep = vi.fn(async () => undefined);
    let denial: unknown;
    await enforceEmbeddingSpendGate({
      estimatedMicroUsd: 1_000,
      estimatedTokens: 1_000,
      batchId: 'batch1',
      dataLakeId: 'lake1',
      db,
      sleep,
    }).catch(err => (denial = err));
    expect(sleep).not.toHaveBeenCalled();
    expect((denial as EmbeddingSpendDeniedError).retryable).toBe(true);
    expect((denial as EmbeddingSpendDeniedError).retryAfterMs).toBeGreaterThan(40_000);
    expect((denial as Error).message).toMatch(
      /after waiting 0ms \(it resets in 4\ds, past the 30s in-handler wait budget\)/
    );
  });

  it("meters the token window with the call's own token count, not one unit", async () => {
    const db = grantAll();
    await gate(db, 1_000, undefined, 4_096);
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(EMBEDDING_SPEND_RATE_KEY, 1, 120, 60_000);
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(
      EMBEDDING_SPEND_TOKEN_RATE_KEY,
      4_096,
      600_000,
      60_000
    );
  });

  it('does not re-charge the call window while waiting out the token window', async () => {
    // The regression this guards: reserving both windows in one retry loop would consume a call
    // slot on every probe, so a saturated TPM window would silently burn the RPM budget too.
    const db = grantAll();
    const sleep = vi.fn().mockResolvedValue(undefined);
    db.cache.tryAddWithinLimitFixedWindow.mockImplementation(async (key: string) =>
      key === EMBEDDING_SPEND_TOKEN_RATE_KEY && sleep.mock.calls.length === 0
        ? { success: false, count: 600_000, expiresAt: new Date(Date.now() + 5_000) }
        : { success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) }
    );

    await enforceEmbeddingSpendGate({
      estimatedMicroUsd: 1_000,
      estimatedTokens: 1_000,
      batchId: 'b',
      dataLakeId: 'l',
      db,
      sleep,
    });

    const callWindowProbes = db.cache.tryAddWithinLimitFixedWindow.mock.calls.filter(
      ([key]: [string]) => key === EMBEDDING_SPEND_RATE_KEY
    );
    expect(callWindowProbes).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('denies a call larger than the whole token window as terminal, since waiting cannot help', async () => {
    const db = grantAll();
    const sleep = vi.fn();
    let denial: unknown;
    await gate(db, 1_000, undefined, 700_000).catch(err => (denial = err));
    expect(denial).toBeInstanceOf(EmbeddingSpendDeniedError);
    expect((denial as EmbeddingSpendDeniedError).retryable).toBe(false);
    expect((denial as Error).message).toMatch(/can never fit/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('denies immediately on a token rate limit of 0 (the STOP value)', async () => {
    mockedLevers.mockResolvedValue(levers({ maxTokensPerMinute: 0 }));
    const db = grantAll();
    const sleep = vi.fn();
    db.cache.tryAddWithinLimitFixedWindow.mockImplementation(async (key: string) =>
      key === EMBEDDING_SPEND_TOKEN_RATE_KEY
        ? { success: false, count: 0, expiresAt: new Date() }
        : { success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) }
    );
    await expect(
      enforceEmbeddingSpendGate({ estimatedMicroUsd: 1, estimatedTokens: 1, batchId: 'b', db, sleep })
    ).rejects.toThrow(/token rate limit is 0/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('denies immediately on a rate limit of 0 (the STOP value) without waiting', async () => {
    mockedLevers.mockResolvedValue(levers({ maxCallsPerMinute: 0 }));
    const db = grantAll();
    const sleep = vi.fn();
    db.cache.tryAddWithinLimitFixedWindow.mockResolvedValue({ success: false, count: 0, expiresAt: new Date() });
    await expect(
      enforceEmbeddingSpendGate({ estimatedMicroUsd: 1, estimatedTokens: 1, batchId: 'b', db, sleep })
    ).rejects.toThrow(/rate limit is 0/);
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
      expect.objectContaining({
        kind: 'budget_exhausted',
        scope: 'period',
        periodKey: `w:${expiresAt.toISOString()}`,
        detail: expect.objectContaining({ windowEndsAt: expiresAt }),
      })
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

    const periodEvents = notify.mock.calls
      .map(([event]) => event as { scope: string; periodKey: string; detail: { windowEndsAt?: Date } })
      .filter(event => event.scope === 'period');
    const periodKeys = periodEvents.map(event => event.periodKey);
    expect(periodKeys).toHaveLength(2);
    expect(periodKeys[0]).toEqual(periodKeys[1]);
    expect(periodKeys[0]).toMatch(/^t:\d+$/);
    // B2: a STUCK denial (budget <= 0) must never carry a windowEndsAt - its presence is the
    // renderer's only signal for whether to promise automatic resumption, and neither this
    // sub-case nor an over-budget single message ever actually resolves on its own.
    expect(periodEvents.every(event => event.detail.windowEndsAt === undefined)).toBe(true);
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
      estimatedTokens: 1_000,
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
        estimatedTokens: 1_000,
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

// #1675: the gate is where a lake's ownership becomes its cost tier. These pin WHICH owner type
// reaches the resolver - the ratio the tiers imply is resolveSpendLevers' concern, tested there.
describe('enforceEmbeddingSpendGate cost tier', () => {
  const ownerTypePassedToResolver = () => mockedLevers.mock.calls[0]?.[2];

  it('resolves an org-owned lake on the organization tier', async () => {
    const db = grantAll();
    db.dataLakes.findById.mockResolvedValue(lakeDoc('org1'));
    await gate(db);
    expect(db.dataLakes.findById).toHaveBeenCalledWith('lake1');
    expect(ownerTypePassedToResolver()).toBe(CreditHolderType.Organization);
  });

  it('resolves a lake with no organization on the individual tier', async () => {
    const db = grantAll();
    await gate(db);
    expect(ownerTypePassedToResolver()).toBe(CreditHolderType.User);
  });

  // A lake deleted mid-run is a deterministic ABSENCE of ownership, so the restrictive tier is an
  // honest answer and the run proceeds against it.
  it('leaves the tier unresolved rather than guessing when the lake row is gone', async () => {
    const db = grantAll();
    db.dataLakes.findById.mockResolvedValue(null);
    await expect(gate(db)).resolves.toBeUndefined();
    expect(ownerTypePassedToResolver()).toBeUndefined();
  });

  // But an ERRORING read is unknown, not absent. Swallowing it into the restrictive tier could
  // deny on the per-lake budget, and that denial is non-retryable - the handler would permanently
  // fail the file over a transient blip, blaming a budget that was never the problem. The error
  // must surface so the message stays on the queue.
  it('propagates a lake-read error instead of billing the run on a tier nobody chose', async () => {
    const db = grantAll();
    const outage = new Error('mongo down');
    db.dataLakes.findById.mockRejectedValue(outage);
    await expect(gate(db)).rejects.toThrow(outage);
    // Not an EmbeddingSpendDeniedError: the caller must see a retryable error, not a verdict.
    await expect(gate(db)).rejects.not.toBeInstanceOf(EmbeddingSpendDeniedError);
    expect(db.dataLakeBatches.tryAddEmbeddingSpend).not.toHaveBeenCalled();
  });

  it('does not read a lake when the run has none (a per-run budget still applies)', async () => {
    const db = grantAll();
    await enforceEmbeddingSpendGate({
      estimatedMicroUsd: 1,
      estimatedTokens: 1_000,
      batchId: 'batch1',
      db,
      sleep: vi.fn(),
    });
    expect(db.dataLakes.findById).not.toHaveBeenCalled();
    expect(ownerTypePassedToResolver()).toBeUndefined();
  });
});

/**
 * An in-memory stand-in for CacheModel.tryAddWithinLimitFixedWindow that actually meters, so the
 * owner and platform windows interact the way they do against Mongo.
 */
const meteringCache = () => {
  const counts = new Map<string, number>();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  return {
    counts,
    tryAddWithinLimitFixedWindow: vi.fn(async (key: string, amount: number, limit: number) => {
      const next = (counts.get(key) ?? 0) + amount;
      if (next > limit) return { success: false, count: counts.get(key) ?? 0, expiresAt };
      counts.set(key, next);
      return { success: true, count: next, expiresAt };
    }),
  };
};

describe('enforceEmbeddingSpendGate per-owner window', () => {
  const lakesByOwner: Record<string, { id: string; createdByUserId: string; organizationId?: string }> = {
    lakeA: { id: 'lakeA', createdByUserId: 'userA' },
    lakeB: { id: 'lakeB', createdByUserId: 'userB' },
    lakeOrg: { id: 'lakeOrg', createdByUserId: 'userA', organizationId: 'org1' },
  };

  const meteredDb = () => {
    const base = grantAll();
    const cache = meteringCache();
    base.dataLakes.findById.mockImplementation(async (id: string) => lakesByOwner[id] ?? null);
    const db: SpendGateDb = { ...base, cache: { tryAddWithinLimitFixedWindow: cache.tryAddWithinLimitFixedWindow } };
    return { db, cache };
  };

  const gateFor = (
    db: SpendGateDb,
    dataLakeId: string,
    estimatedMicroUsd: number,
    notify?: (event: DataLakeSpendNotificationEvent) => Promise<unknown>
  ) =>
    enforceEmbeddingSpendGate({
      estimatedMicroUsd,
      estimatedTokens: 1_000,
      dataLakeId,
      db,
      sleep: vi.fn().mockResolvedValue(undefined),
      notify,
    });

  it('pauses only the owner that used up its window while another owner keeps embedding', async () => {
    mockedLevers.mockResolvedValue(levers({ perOwnerPeriodBudgetMicroUsd: 2_000 }));
    const { db } = meteredDb();

    await expect(gateFor(db, 'lakeA', 1_500)).resolves.toBeUndefined();
    await expect(gateFor(db, 'lakeA', 1_500)).rejects.toThrow(/lake owner's embedding budget/);
    await expect(gateFor(db, 'lakeB', 1_500)).resolves.toBeUndefined();
  });

  it('still enforces the platform window when every owner is under its own share', async () => {
    mockedLevers.mockResolvedValue(levers({ perOwnerPeriodBudgetMicroUsd: 2_000, perPeriodBudgetMicroUsd: 2_500 }));
    const { db } = meteredDb();

    await expect(gateFor(db, 'lakeA', 1_500)).resolves.toBeUndefined();
    await expect(gateFor(db, 'lakeB', 1_500)).rejects.toThrow(/platform-wide embedding budget/);
  });

  it('charges an org-owned lake to the organization, not to the user who created it', async () => {
    mockedLevers.mockResolvedValue(levers({ perOwnerPeriodBudgetMicroUsd: 2_000 }));
    const { db, cache } = meteredDb();

    await gateFor(db, 'lakeOrg', 1_500);
    expect(cache.counts.get(ownerEmbeddingSpendKey({ type: CreditHolderType.Organization, id: 'org1' }))).toBe(1_500);
    expect(cache.counts.has(ownerEmbeddingSpendKey({ type: CreditHolderType.User, id: 'userA' }))).toBe(false);
    // userA's personal lake still has its own full share.
    await expect(gateFor(db, 'lakeA', 1_500)).resolves.toBeUndefined();
  });

  it('does not reserve platform spend for a call the owner window denied', async () => {
    mockedLevers.mockResolvedValue(levers({ perOwnerPeriodBudgetMicroUsd: 1_000 }));
    const { db, cache } = meteredDb();

    await expect(gateFor(db, 'lakeA', 1_500)).rejects.toThrow(EmbeddingSpendDeniedError);
    expect(cache.counts.has(EMBEDDING_SPEND_PERIOD_KEY)).toBe(false);
  });

  it('notifies owner/budget_exhausted keyed on the window, carrying when it ends', async () => {
    mockedLevers.mockResolvedValue(levers({ perOwnerPeriodBudgetMicroUsd: 2_000 }));
    const { db } = meteredDb();
    const notify = vi.fn().mockResolvedValue(undefined);

    await gateFor(db, 'lakeA', 1_500, notify);
    await gateFor(db, 'lakeA', 1_500, notify).catch(() => {});

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'lakeA',
        kind: 'budget_exhausted',
        scope: 'owner',
        periodKey: expect.stringMatching(/^w:/),
        detail: expect.objectContaining({ budgetMicroUsd: 2_000, periodHours: 24, windowEndsAt: expect.any(Date) }),
      })
    );
  });

  it('withholds windowEndsAt and keys on the clock when the owner budget is 0 (a stuck denial)', async () => {
    mockedLevers.mockResolvedValue(levers({ perOwnerPeriodBudgetMicroUsd: 0 }));
    const { db } = meteredDb();
    const notify = vi.fn().mockResolvedValue(undefined);

    await expect(gateFor(db, 'lakeA', 1, notify)).rejects.toThrow(EmbeddingSpendDeniedError);
    const event = notify.mock.calls
      .map(([sent]) => sent as DataLakeSpendNotificationEvent)
      .find(sent => sent.scope === 'owner');
    expect(event?.periodKey).toMatch(/^t:\d+$/);
    expect(event?.detail.windowEndsAt).toBeUndefined();
  });

  it('skips the owner window when the run has no lake', async () => {
    const { db, cache } = meteredDb();
    await enforceEmbeddingSpendGate({ estimatedMicroUsd: 1_000, estimatedTokens: 1_000, db, sleep: vi.fn() });
    expect([...cache.counts.keys()].some(key => key.startsWith('dataLakeEmbeddingSpend:owner:'))).toBe(false);
  });
});
