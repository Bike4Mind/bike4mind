// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  countDocuments: vi.fn(),
  pay: vi.fn(),
  buildAdapters: vi.fn(),
  onPaid: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ User: { countDocuments: m.countDocuments } }));
vi.mock('@bike4mind/services', () => ({ creditService: { payCreditReward: m.pay } }));
vi.mock('../credits/creditRewardAdapters', () => ({ buildCreditRewardAdapters: () => m.buildAdapters() }));

import { REFERRAL_REWARD_REASON } from '@bike4mind/common';
import { activeReferredFriendsFilter, readReferralMilestones } from './activeFriends';
import { milestoneTransactionId, payReachedMilestones } from './milestoneReward';

const TIERS = [
  { friends: 5, credits: 500 },
  { friends: 10, credits: 1500 },
  { friends: 25, credits: 5000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  m.buildAdapters.mockReturnValue({ rewardAdapters: true });
  m.pay.mockImplementation(async (reward: { transactionId: string }) => ({
    outcome: 'paid',
    creditTransactionId: `tx-${reward.transactionId}`,
  }));
  m.onPaid.mockResolvedValue(undefined);
});

describe('readReferralMilestones', () => {
  it('parses the stored setting', () => {
    expect(readReferralMilestones('10:1500, 5:500')).toEqual([
      { friends: 5, credits: 500 },
      { friends: 10, credits: 1500 },
    ]);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['malformed', '5 friends'],
    ['not a string', 5],
  ])('reads %s as no milestones', (_label, stored) => {
    expect(readReferralMilestones(stored)).toEqual([]);
  });
});

describe('payReachedMilestones', () => {
  it('counts only active, real friends of this inviter', async () => {
    m.countDocuments.mockResolvedValue(0);
    await payReachedMilestones('inviter1', TIERS, m.onPaid);
    expect(m.countDocuments).toHaveBeenCalledWith(activeReferredFriendsFilter('inviter1'));
    expect(activeReferredFriendsFilter('inviter1')).toEqual({
      referredByUserId: 'inviter1',
      isSynthetic: { $ne: true },
      deletedAt: null,
      emailVerified: true,
      firstValueAt: { $ne: null },
    });
  });

  it('pays every milestone reached, each under its own stable key, and none beyond', async () => {
    m.countDocuments.mockResolvedValue(12);
    await payReachedMilestones('inviter1', TIERS, m.onPaid);

    expect(m.pay).toHaveBeenCalledTimes(2);
    expect(m.pay.mock.calls[0][0]).toEqual({
      transactionId: 'referral-milestone:inviter1:5',
      userId: 'inviter1',
      credits: 500,
      source: 'referral_milestone',
      reason: REFERRAL_REWARD_REASON,
      description: 'Referral reward: 5 active friends',
      metadata: { step: 'milestone', milestoneFriends: 5 },
    });
    expect(m.pay.mock.calls[1][0]).toMatchObject({ transactionId: 'referral-milestone:inviter1:10', credits: 1500 });
    expect(m.pay.mock.calls[0][1]).toEqual({ rewardAdapters: true });
    expect(m.onPaid.mock.calls).toEqual([['tx-referral-milestone:inviter1:5'], ['tx-referral-milestone:inviter1:10']]);
  });

  it('pays a milestone the moment the count meets it exactly', async () => {
    m.countDocuments.mockResolvedValue(5);
    await payReachedMilestones('inviter1', TIERS, m.onPaid);
    expect(m.pay).toHaveBeenCalledTimes(1);
  });

  it('pays nothing below the first milestone', async () => {
    m.countDocuments.mockResolvedValue(4);
    await payReachedMilestones('inviter1', TIERS, m.onPaid);
    expect(m.pay).not.toHaveBeenCalled();
  });

  it('reports only payouts that wrote a ledger row now', async () => {
    m.countDocuments.mockResolvedValue(25);
    m.pay
      .mockResolvedValueOnce({ outcome: 'duplicate' })
      .mockResolvedValueOnce({ outcome: 'queued' })
      .mockResolvedValueOnce({ outcome: 'paid', creditTransactionId: 'tx25' });
    await payReachedMilestones('inviter1', TIERS, m.onPaid);
    expect(m.pay).toHaveBeenCalledTimes(3);
    expect(m.onPaid.mock.calls).toEqual([['tx25']]);
  });

  it('reads nothing while no milestone is set', async () => {
    await payReachedMilestones('inviter1', [], m.onPaid);
    expect(m.countDocuments).not.toHaveBeenCalled();
    expect(m.pay).not.toHaveBeenCalled();
  });

  it('keys a milestone by inviter and friend count', () => {
    expect(milestoneTransactionId('inviter1', 10)).toBe('referral-milestone:inviter1:10');
  });
});
