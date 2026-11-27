import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  payCreditReward,
  releaseHeldCreditRewards,
  REFERRAL_SUBSCRIPTION_REWARD_TTL_DAYS,
  type HeldCreditRewardInput,
  type HeldCreditRewardRow,
  type PayCreditRewardAdapters,
} from './payCreditReward';

vi.mock('../userService/signupGrantBudget', () => ({
  drawnInRefundScope: vi.fn(() => true),
  queueHeadBlocks: vi.fn(async () => false),
  reserveSignupGrantBudget: vi.fn(async () => ({ outcome: 'exhausted' })),
  resolvePoolBudget: vi.fn(async () => ({ budget: 0 })),
}));

const NOW = new Date('2026-11-20T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = REFERRAL_SUBSCRIPTION_REWARD_TTL_DAYS * DAY_MS;

const input = (overrides: Partial<HeldCreditRewardInput> = {}): HeldCreditRewardInput => ({
  transactionId: 'tx1',
  userId: 'u1',
  credits: 10,
  source: 'referral_subscription',
  reason: 'reward',
  description: 'reward',
  ...overrides,
});

const heldRow = (overrides: Partial<HeldCreditRewardRow> = {}): HeldCreditRewardRow => ({
  ...input(),
  status: 'held',
  heldAt: NOW,
  ...overrides,
});

const makeAdapters = (rows: HeldCreditRewardRow[] = []) => {
  const heldRewards = {
    hold: vi.fn(async () => undefined),
    findByTransactionIds: vi.fn(async () => rows),
    listHeld: vi.fn(async () => rows),
    settle: vi.fn(async () => 1),
    pauseOne: vi.fn(async () => 1),
  };
  const creditTransactions = { findOne: vi.fn(async () => null), create: vi.fn() };
  const adapters = {
    heldRewards,
    db: { creditTransactions },
    users: { findById: vi.fn(async () => ({})) },
    adminSettings: { findBySettingName: vi.fn(async () => null) },
  } as unknown as PayCreditRewardAdapters;
  return { adapters, heldRewards, creditTransactions };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('payCreditReward expiry', () => {
  it('blocks a held row past its deadline without settling it', async () => {
    const { adapters, heldRewards } = makeAdapters([heldRow({ expiresAt: new Date(NOW.getTime() - 1) })]);

    expect(await payCreditReward(input(), adapters, { now: NOW })).toEqual({ outcome: 'blocked' });
    expect(heldRewards.settle).not.toHaveBeenCalled();
  });

  it('blocks a fresh reward whose deadline has been reached, writing nothing', async () => {
    const { adapters, heldRewards, creditTransactions } = makeAdapters();

    expect(await payCreditReward(input({ expiresAt: NOW }), adapters, { now: NOW })).toEqual({ outcome: 'blocked' });
    expect(heldRewards.hold).not.toHaveBeenCalled();
    expect(creditTransactions.create).not.toHaveBeenCalled();
  });

  it('does not block on expiry a fresh reward with a deadline 1ms ahead', async () => {
    const { adapters, heldRewards } = makeAdapters();

    const result = await payCreditReward(input({ expiresAt: new Date(NOW.getTime() + 1) }), adapters, { now: NOW });

    expect(result).toEqual({ outcome: 'queued' });
    expect(heldRewards.hold).toHaveBeenCalledOnce();
  });
});

describe('releaseHeldCreditRewards expiry', () => {
  it('keeps an old held row of another source that has no deadline', async () => {
    const { adapters, heldRewards } = makeAdapters([
      heldRow({ source: 'gear', heldAt: new Date(NOW.getTime() - 2 * TTL_MS) }),
    ]);

    const result = await releaseHeldCreditRewards(adapters, { limit: 10, now: NOW });

    expect(result.voided).toBe(0);
    expect(heldRewards.settle).not.toHaveBeenCalledWith('tx1', 'void');
  });

  it('voids a referral subscription row without a deadline once heldAt + TTL has passed', async () => {
    const { adapters, heldRewards } = makeAdapters([heldRow({ heldAt: new Date(NOW.getTime() - TTL_MS) })]);

    const result = await releaseHeldCreditRewards(adapters, { limit: 10, now: NOW });

    expect(result.voided).toBe(1);
    expect(heldRewards.settle).toHaveBeenCalledWith('tx1', 'void');
  });
});
