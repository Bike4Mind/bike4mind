import { CreditHolderType } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Hold = {
  id: string;
  ownerId: string;
  ownerType: CreditHolderType.User | CreditHolderType.Organization;
  userId: string;
  organizationId: string | null;
  reservedCredits: number;
  balanceAfterHold: number;
  featureLabel: string;
  expiresAt: Date;
};

const { holds, userIncrement, orgIncrement, emitMetrics } = vi.hoisted(() => ({
  holds: new Map<string, Hold>(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  emitMetrics: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  // Rolls the fake hold store back on a throw, as a Mongo transaction would.
  withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
    const snapshot = new Map(holds);
    try {
      return await fn();
    } catch (err) {
      holds.clear();
      snapshot.forEach((hold, id) => holds.set(id, hold));
      throw err;
    }
  },
  userRepository: { incrementCredits: userIncrement },
  organizationRepository: { incrementCredits: orgIncrement },
  pendingCreditHoldRepository: {
    findExpired: async (now: Date, limit: number) =>
      [...holds.values()]
        .filter(h => h.expiresAt <= now)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, limit),
    claimExpired: async (id: string, now: Date) => {
      const hold = holds.get(id);
      if (!hold || hold.expiresAt > now) return null;
      holds.delete(id);
      return hold;
    },
  },
}));
vi.mock('@bike4mind/services', async () => ({
  creditService: await vi.importActual<typeof import('@bike4mind/services/creditService')>(
    '@bike4mind/services/creditService'
  ),
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
  },
}));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetrics }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import { CREDIT_HOLD_SWEEP_LIMIT, runCreditHoldSweep } from './creditHoldSweep';

const NOW = new Date('2026-10-19T12:00:00Z');
const minutesFromNow = (n: number) => new Date(NOW.getTime() + n * 60_000);

const addHold = (id: string, overrides: Partial<Hold> = {}): Hold => {
  const hold: Hold = {
    id,
    ownerId: `user-${id}`,
    ownerType: CreditHolderType.User,
    userId: `user-${id}`,
    organizationId: null,
    reservedCredits: 10,
    balanceAfterHold: 90,
    featureLabel: 'embeddings',
    expiresAt: minutesFromNow(-5),
    ...overrides,
  };
  holds.set(id, hold);
  return hold;
};

const metricValue = (name: string) =>
  (emitMetrics.mock.calls[0]?.[1] as { name: string; value: number }[] | undefined)?.find(m => m.name === name)?.value;

describe('creditHoldSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    holds.clear();
    userIncrement.mockResolvedValue({ currentCredits: 100 });
    orgIncrement.mockResolvedValue({ currentCredits: 100 });
  });

  it('refunds an expired hold to its owner and emits the reclaim metrics', async () => {
    addHold('a', { reservedCredits: 7 });

    const result = await runCreditHoldSweep({ now: NOW });

    expect(userIncrement).toHaveBeenCalledExactlyOnceWith('user-a', 7);
    expect(result).toEqual({ candidates: 1, reclaimed: 1, reclaimedCredits: 7, alreadyClaimed: 0, failed: 0 });
    expect(metricValue('ExpiredHoldsReclaimed')).toBe(1);
    expect(metricValue('ReclaimedCredits')).toBe(7);
    expect(metricValue('ExpiredHoldRefundFailures')).toBe(0);
    expect(emitMetrics).toHaveBeenCalledExactlyOnceWith(
      'Lumina5/CreditHolds',
      expect.arrayContaining([
        { name: 'ExpiredHoldsReclaimed', value: 1, dimensions: { Stage: 'test' }, unit: 'Count' },
      ])
    );
  });

  it('refunds an organization hold to the organization pool', async () => {
    addHold('o', { ownerId: 'org-1', ownerType: CreditHolderType.Organization, organizationId: 'org-1' });

    await runCreditHoldSweep({ now: NOW });

    expect(orgIncrement).toHaveBeenCalledExactlyOnceWith('org-1', 10);
    expect(userIncrement).not.toHaveBeenCalled();
  });

  it('leaves holds that have not expired yet', async () => {
    addHold('live', { expiresAt: minutesFromNow(5) });

    const result = await runCreditHoldSweep({ now: NOW });

    expect(result.candidates).toBe(0);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(holds.has('live')).toBe(true);
    expect(metricValue('ExpiredHoldsReclaimed')).toBe(0);
  });

  it('never refunds the same hold twice across runs', async () => {
    addHold('a');

    await runCreditHoldSweep({ now: NOW });
    const second = await runCreditHoldSweep({ now: NOW });

    expect(userIncrement).toHaveBeenCalledTimes(1);
    expect(second.reclaimed).toBe(0);
  });

  it('skips a hold that a settle or refund claimed after the sweep listed it', async () => {
    addHold('a');
    const { pendingCreditHoldRepository } = await import('@bike4mind/database');
    const findExpired = pendingCreditHoldRepository.findExpired;
    vi.spyOn(pendingCreditHoldRepository, 'findExpired').mockImplementationOnce(async (now, limit) => {
      const listed = await findExpired(now, limit);
      holds.delete('a');
      return listed;
    });

    const result = await runCreditHoldSweep({ now: NOW });

    expect(userIncrement).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 1, reclaimed: 0, alreadyClaimed: 1 });
  });

  it('rolls back the claim of a failed refund, keeps sweeping the rest, and retries it next run', async () => {
    addHold('a', { expiresAt: minutesFromNow(-10) });
    addHold('b', { expiresAt: minutesFromNow(-5) });
    userIncrement.mockRejectedValueOnce(new Error('db down'));

    const result = await runCreditHoldSweep({ now: NOW });

    expect(result).toMatchObject({ candidates: 2, reclaimed: 1, failed: 1 });
    expect(userIncrement).toHaveBeenLastCalledWith('user-b', 10);
    expect(metricValue('ExpiredHoldRefundFailures')).toBe(1);
    expect([...holds.keys()]).toEqual(['a']);

    const retry = await runCreditHoldSweep({ now: NOW });

    expect(retry).toMatchObject({ reclaimed: 1, failed: 0 });
    expect(userIncrement).toHaveBeenLastCalledWith('user-a', 10);
    expect(holds.size).toBe(0);
  });

  it('caps one run at the sweep limit, oldest first', async () => {
    for (let i = 0; i <= CREDIT_HOLD_SWEEP_LIMIT; i++) addHold(`h${i}`, { expiresAt: minutesFromNow(-1000 + i) });

    const result = await runCreditHoldSweep({ now: NOW, emitMetrics: false });

    expect(result.reclaimed).toBe(CREDIT_HOLD_SWEEP_LIMIT);
    expect([...holds.keys()]).toEqual([`h${CREDIT_HOLD_SWEEP_LIMIT}`]);
    expect(emitMetrics).not.toHaveBeenCalled();
  });
});
