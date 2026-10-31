// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindById, mockCountDocuments, mockAddCredits, mockGetSettingsMap, mockSlack } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockCountDocuments: vi.fn(),
  mockAddCredits: vi.fn(),
  mockGetSettingsMap: vi.fn(),
  mockSlack: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  CreditTransaction: { countDocuments: mockCountDocuments },
  User: { findById: mockFindById },
}));
vi.mock('@bike4mind/services', () => ({ creditService: { addCreditsWithLedgerRow: mockAddCredits } }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: mockGetSettingsMap,
  getSettingsValue: (key: string, settings: Record<string, string>, fallback = 0) => Number(settings[key] ?? fallback),
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: mockSlack }));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn() } }));

import { REFERRAL_REWARD_REASON, rewardInviterForFirstAnswer } from './firstAnswerReward';

const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const verifiedFriend = {
  emailVerified: true,
  firstValueAt: new Date('2026-10-27T00:00:00Z'),
  referredByUserId: 'inviter1',
};

const givenUsers = (friend: unknown, inviter: unknown = {}) =>
  mockFindById.mockImplementation((id: string) => lean(id === 'friend1' ? friend : inviter));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettingsMap.mockResolvedValue({ ReferralFirstAnswerCredits: '1000', ReferralAlertRewardsPerDay: '50' });
  mockAddCredits.mockResolvedValue({ creditTransactionId: 'tx1' });
  mockCountDocuments.mockResolvedValue(1);
  givenUsers(verifiedFriend);
});

describe('rewardInviterForFirstAnswer', () => {
  it('pays the inviter once with a stable key, a referral reason and the configured amount', async () => {
    await rewardInviterForFirstAnswer('friend1');

    expect(mockAddCredits).toHaveBeenCalledTimes(1);
    expect(mockAddCredits.mock.calls[0][0]).toMatchObject({
      ownerId: 'inviter1',
      ownerType: 'User',
      credits: 1000,
      type: 'generic_add',
      reason: REFERRAL_REWARD_REASON,
      transactionId: 'referral-first-answer:inviter1:friend1',
    });
    expect(mockAddCredits.mock.calls[0][1].db.creditLots).toBeDefined();
  });

  it.each([
    ['has no inviter', { ...verifiedFriend, referredByUserId: null }],
    ['has not verified the email', { ...verifiedFriend, emailVerified: false }],
    ['has no first answer yet', { ...verifiedFriend, firstValueAt: null }],
    ['is synthetic', { ...verifiedFriend, isSynthetic: true }],
    ['is deleted', { ...verifiedFriend, deletedAt: new Date() }],
    ['no longer exists', null],
  ])('pays nothing when the friend %s', async (_label, friend) => {
    givenUsers(friend);
    await rewardInviterForFirstAnswer('friend1');
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('pays nothing while the amount is 0', async () => {
    mockGetSettingsMap.mockResolvedValue({ ReferralFirstAnswerCredits: '0' });
    await rewardInviterForFirstAnswer('friend1');
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it.each([
    ['is deleted', { deletedAt: new Date() }],
    ['is synthetic', { isSynthetic: true }],
    ['is banned', { isBanned: true }],
    ['has a chargeback pending', { disputePending: true }],
    ['is suspended', { moderation: { status: 'suspended' } }],
    ['is pending suspension', { moderation: { status: 'suspend_pending' } }],
    ['no longer exists', null],
  ])('pays nothing when the inviter %s', async (_label, inviter) => {
    givenUsers(verifiedFriend, inviter);
    await rewardInviterForFirstAnswer('friend1');
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('still pays a throttled inviter', async () => {
    givenUsers(verifiedFriend, { moderation: { status: 'throttled' } });
    await rewardInviterForFirstAnswer('friend1');
    expect(mockAddCredits).toHaveBeenCalledTimes(1);
  });

  it('does not count or alert on a replay that wrote no transaction', async () => {
    mockAddCredits.mockResolvedValue({ creditTransactionId: undefined });
    await rewardInviterForFirstAnswer('friend1');
    expect(mockCountDocuments).not.toHaveBeenCalled();
    expect(mockSlack).not.toHaveBeenCalled();
  });

  it('alerts only on the reward ranked one past the threshold, by counting rewards with a smaller id', async () => {
    mockCountDocuments.mockResolvedValue(50);
    await rewardInviterForFirstAnswer('friend1');
    expect(mockSlack).toHaveBeenCalledTimes(1);
    expect(mockSlack.mock.calls[0][0]).toContain('51');
    expect(mockCountDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: 'User',
        type: 'generic_add',
        reason: REFERRAL_REWARD_REASON,
        createdAt: { $gte: expect.any(Date) },
        _id: { $lt: 'tx1' },
      })
    );

    mockSlack.mockClear();
    mockCountDocuments.mockResolvedValue(49);
    await rewardInviterForFirstAnswer('friend1');
    mockCountDocuments.mockResolvedValue(51);
    await rewardInviterForFirstAnswer('friend1');
    expect(mockSlack).not.toHaveBeenCalled();
  });

  it('falls back to the schema default threshold when the setting is not stored', async () => {
    mockGetSettingsMap.mockResolvedValue({ ReferralFirstAnswerCredits: '1000' });
    mockCountDocuments.mockResolvedValue(50);
    await rewardInviterForFirstAnswer('friend1');
    expect(mockSlack).toHaveBeenCalledTimes(1);
  });

  it('never throws when a dependency fails', async () => {
    mockAddCredits.mockRejectedValue(new Error('db down'));
    await expect(rewardInviterForFirstAnswer('friend1')).resolves.toBeUndefined();
  });
});
