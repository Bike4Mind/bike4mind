import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getSettingsMap: vi.fn(),
  countUsers: vi.fn(),
  countSubscribed: vi.fn(),
  aggregate: vi.fn(),
  find: vi.fn(),
}));

vi.mock('@bike4mind/common', () => ({ CreditHolderType: { User: 'User' } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  CREDIT_BALANCE_EVENT_TYPES: [
    'purchase',
    'subscription',
    'generic_add',
    'generic_deduct',
    'transfer_credit',
    'received_credit',
  ],
  User: { countDocuments: m.countUsers },
  CreditTransaction: { aggregate: m.aggregate, find: m.find },
  referralSubscriptionRewardRepository: { countSubscribedFriends: m.countSubscribed },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: m.getSettingsMap,
  getSettingsValue: (key: string, settings: Record<string, string>, fallback = 0) => Number(settings[key] ?? fallback),
}));
vi.mock('@bike4mind/server-utils/referrals/firstAnswerReward', () => ({ REFERRAL_REWARD_REASON: 'referral_reward' }));

import { CREDIT_BALANCE_EVENT_TYPES } from '@bike4mind/database';
import { getInviterSummary } from './inviterSummary';

const NOW = new Date('2026-11-10T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const findChain = (rows: unknown[]) => {
  const chain = { sort: vi.fn(), limit: vi.fn(), select: vi.fn(), lean: vi.fn() };
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  chain.lean.mockResolvedValue(rows);
  return chain;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getSettingsMap.mockResolvedValue({ ReferralFirstAnswerCredits: '1000' });
  m.countUsers.mockResolvedValueOnce(5).mockResolvedValueOnce(3);
  m.countSubscribed.mockResolvedValue(1);
  m.aggregate.mockResolvedValue([
    { _id: 'referral_reward', total: 13000 },
    { _id: 'referral_reward_takeback', total: 3000 },
  ]);
  m.find.mockReturnValue(findChain([]));
});

describe('getInviterSummary', () => {
  it('stays hidden and reads nothing while all three reward amounts are 0', async () => {
    m.getSettingsMap.mockResolvedValue({
      ReferralFirstAnswerCredits: '0',
      ReferralFirstPaymentCredits: '0',
      ReferralSecondPaymentCredits: '0',
    });

    expect(await getInviterSummary('inviter1', NOW)).toEqual({
      enabled: false,
      invited: 0,
      active: 0,
      subscribed: 0,
      creditsEarned: 0,
      recentRewards: [],
    });
    expect(m.countUsers).not.toHaveBeenCalled();
    expect(m.aggregate).not.toHaveBeenCalled();
  });

  it('reads the reward amounts past the settings cache so an admin switch shows at once', async () => {
    await getInviterSummary('inviter1', NOW);

    expect(m.getSettingsMap).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ skipCache: true }));
  });

  it('is enabled as soon as any one reward amount is above 0', async () => {
    m.getSettingsMap.mockResolvedValue({ ReferralSecondPaymentCredits: '6000' });
    expect((await getInviterSummary('inviter1', NOW)).enabled).toBe(true);
  });

  it('counts invited and active friends of this inviter, leaving out synthetic and deleted accounts', async () => {
    const summary = await getInviterSummary('inviter1', NOW);

    expect(summary).toMatchObject({ invited: 5, active: 3, subscribed: 1 });
    const friends = { referredByUserId: 'inviter1', isSynthetic: { $ne: true }, deletedAt: null };
    expect(m.countUsers).toHaveBeenNthCalledWith(1, friends);
    expect(m.countUsers).toHaveBeenNthCalledWith(2, {
      ...friends,
      emailVerified: true,
      firstValueAt: { $ne: null },
    });
    expect(m.countSubscribed).toHaveBeenCalledWith('inviter1');
  });

  it('reports credits earned as rewards granted minus rewards taken back', async () => {
    expect((await getInviterSummary('inviter1', NOW)).creditsEarned).toBe(10000);
  });

  it('never reports negative credits earned', async () => {
    m.aggregate.mockResolvedValue([{ _id: 'referral_reward_takeback', total: 500 }]);
    expect((await getInviterSummary('inviter1', NOW)).creditsEarned).toBe(0);
  });

  it('scopes the ledger reads to the inviter own balance-event rows so the partial index serves them', async () => {
    await getInviterSummary('inviter1', NOW);
    const scope = {
      ownerId: 'inviter1',
      ownerType: 'User',
      type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] },
    };
    expect(m.aggregate.mock.calls[0][0][0].$match).toMatchObject(scope);
    expect(m.find.mock.calls[0][0]).toMatchObject({ ...scope, reason: 'referral_reward' });
    expect(m.find.mock.calls[1][0]).toMatchObject({ ...scope, reason: 'referral_reward_takeback' });
  });

  describe('recent rewards net of take-backs', () => {
    const granted = new Date(NOW.getTime() - 2 * DAY_MS);
    const reward = (id: string, credits: number, invoiceId?: string) => ({
      _id: { toString: () => id },
      credits,
      createdAt: granted,
      ...(invoiceId ? { metadata: { invoiceId } } : {}),
    });
    const takeback = (credits: number, invoiceId: string) => ({ credits: -credits, metadata: { invoiceId } });
    const setup = (rewards: unknown[], takebacks: unknown[]) =>
      m.find.mockReturnValueOnce(findChain(rewards)).mockReturnValueOnce(findChain(takebacks));

    it('reduces a reward by a partial take-back on the same invoice', async () => {
      setup([reward('tx1', 6000, 'in_1')], [takeback(2000, 'in_1')]);
      expect((await getInviterSummary('inviter1', NOW)).recentRewards.map(r => r.credits)).toEqual([4000]);
    });

    it('drops a reward that was taken back in full', async () => {
      setup([reward('tx1', 6000, 'in_1'), reward('tx2', 3000, 'in_2')], [takeback(6000, 'in_1')]);
      expect((await getInviterSummary('inviter1', NOW)).recentRewards.map(r => r.id)).toEqual(['tx2']);
    });

    it('leaves a first-answer reward with no invoice untouched', async () => {
      setup([reward('tx1', 1000)], [takeback(1000, 'in_1')]);
      expect((await getInviterSummary('inviter1', NOW)).recentRewards.map(r => r.credits)).toEqual([1000]);
    });
  });

  it('lists recent usable rewards with a 90 day expiry and only looks back 14 days', async () => {
    const granted = new Date(NOW.getTime() - 2 * DAY_MS);
    m.find.mockReturnValue(findChain([{ _id: { toString: () => 'tx1' }, credits: 6000, createdAt: granted }]));

    const summary = await getInviterSummary('inviter1', NOW);

    expect(summary.recentRewards).toEqual([
      {
        id: 'tx1',
        credits: 6000,
        grantedAt: granted.toISOString(),
        expiresAt: new Date(granted.getTime() + 90 * DAY_MS).toISOString(),
      },
    ]);
    expect(m.find.mock.calls[0][0].createdAt.$gte).toEqual(new Date(NOW.getTime() - 14 * DAY_MS));
  });
});
