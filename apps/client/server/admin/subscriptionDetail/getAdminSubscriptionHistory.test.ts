import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCreditCycles, getAdminSubscriptionHistory, seatChangesFrom } from './getAdminSubscriptionHistory';

const { find, aggregate, findById } = vi.hoisted(() => ({ find: vi.fn(), aggregate: vi.fn(), findById: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  BillingEventModel: { find: vi.fn() },
  CREDIT_BALANCE_EVENT_TYPES: [],
  CreditTransaction: { find, aggregate },
  mongoose: { Types: { ObjectId: { isValid: () => true } } },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({ Subscription: { findById } }));

const at = (day: number) => new Date(Date.UTC(2026, 0, day));

describe('buildCreditCycles', () => {
  it('closes each cycle at the next grant and runs the last to the window end', () => {
    const used = new Map([
      [at(1).getTime(), 400],
      [at(31).getTime(), 120],
    ]);
    expect(
      buildCreditCycles(
        [
          { at: at(1), credits: 1000 },
          { at: at(31), credits: 1000 },
        ],
        at(45),
        used,
        true
      )
    ).toEqual([
      { start: at(1).toISOString(), end: at(31).toISOString(), granted: 1000, used: 400, current: false },
      { start: at(31).toISOString(), end: at(45).toISOString(), granted: 1000, used: 120, current: true },
    ]);
  });

  it('merges grants written in the same millisecond and reads missing usage as zero', () => {
    const cycles = buildCreditCycles(
      [
        { at: at(1), credits: 500 },
        { at: at(1), credits: 250 },
      ],
      at(10),
      new Map(),
      false
    );
    expect(cycles).toEqual([
      { start: at(1).toISOString(), end: at(10).toISOString(), granted: 750, used: 0, current: false },
    ]);
  });

  it('returns no cycles without grants', () => {
    expect(buildCreditCycles([], at(10), new Map(), true)).toEqual([]);
  });
});

describe('buildCreditCycles without usage', () => {
  it('reports used as null for every cycle', () => {
    const cycles = buildCreditCycles(
      [
        { at: at(1), credits: 1000 },
        { at: at(31), credits: 1000 },
      ],
      at(45),
      null,
      true
    );
    expect(cycles.map(cycle => cycle.used)).toEqual([null, null]);
    expect(cycles.map(cycle => cycle.granted)).toEqual([1000, 1000]);
  });
});

describe('getAdminSubscriptionHistory usage time limit', () => {
  const chain = <T>(result: T) => {
    const query = {
      sort: () => query,
      limit: () => query,
      select: () => query,
      maxTimeMS: () => query,
      lean: () => Promise.resolve(result),
    };
    return query;
  };
  const rejectWith = (error: unknown) => ({ option: () => Promise.reject(error) });

  beforeEach(() => {
    findById.mockReturnValue(
      chain({
        subscriptionId: 'sub_1',
        ownerType: 'User',
        ownerId: 'owner-1',
        status: 'active',
        source: 'stripe',
        createdAt: at(1),
      })
    );
    find.mockReturnValue(chain([{ credits: 1000, createdAt: at(1) }]));
  });

  it('returns granted cycles with null usage when the aggregate hits the time limit', async () => {
    aggregate.mockReturnValue(rejectWith(Object.assign(new Error('operation exceeded time limit'), { code: 50 })));
    const history = await getAdminSubscriptionHistory('a'.repeat(24), at(20));
    expect(history?.creditUsageUnavailable).toBe(true);
    expect(history?.creditCycles).toEqual([
      { start: at(1).toISOString(), end: at(20).toISOString(), granted: 1000, used: null, current: true },
    ]);
  });

  it('still rejects on any other aggregate error', async () => {
    aggregate.mockReturnValue(rejectWith(Object.assign(new Error('boom'), { code: 11000 })));
    await expect(getAdminSubscriptionHistory('a'.repeat(24), at(20))).rejects.toThrow('boom');
  });
});

describe('seatChangesFrom', () => {
  it('keeps only the events that changed the quantity', () => {
    expect(
      seatChangesFrom([
        { at: at(1), quantity: 3 },
        { at: at(2), quantity: 3 },
        { at: at(5), quantity: 5 },
        { at: at(9), quantity: 3 },
      ])
    ).toEqual([
      { at: at(1).toISOString(), quantity: 3 },
      { at: at(5).toISOString(), quantity: 5 },
      { at: at(9).toISOString(), quantity: 3 },
    ]);
  });
});
