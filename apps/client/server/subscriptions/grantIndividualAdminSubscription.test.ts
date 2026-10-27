import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  creditService: { addCreditsWithLedgerRow: (...a: unknown[]) => mockAddCredits(...a) },
}));

vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  withTransaction: (fn: (session: unknown) => Promise<unknown>) => fn(undefined),
}));

const mockCreate = vi.fn();
const mockFindByPriceId = vi.fn();
const mockFindNonTerminalSubs = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: {
    create: (...a: unknown[]) => mockCreate(...a),
    findUserSubscriptionByPriceId: (...a: unknown[]) => mockFindByPriceId(...a),
    findNonTerminalSubscriptionsByOwner: (...a: unknown[]) => mockFindNonTerminalSubs(...a),
  },
}));

import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { grantIndividualAdminSubscription } from './grantIndividualAdminSubscription';

const plan = SUBSCRIPTION_PLANS[0];

const params = {
  userId: 'user-1',
  priceId: plan.priceId,
  durationMonths: 3,
  grantedBy: 'partner-rule:rule-1',
  grantedReason: 'partner signup rule partner.example',
};

describe('grantIndividualAdminSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByPriceId.mockResolvedValue(null);
    mockFindNonTerminalSubs.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ id: 'sub-1' });
    mockAddCredits.mockResolvedValue({ creditHolder: { currentCredits: 500 }, creditTransactionId: 'tx-ind' });
  });

  it('creates an admin-grant row and adds plan credits times months', async () => {
    const result = await grantIndividualAdminSubscription(params);

    expect(result).toMatchObject({
      status: 'granted',
      priceId: plan.priceId,
      credits: plan.credits * 3,
      subscriptionId: expect.stringMatching(/^admin_grant_/),
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: SubscriptionOwnerType.User,
        ownerId: 'user-1',
        priceId: plan.priceId,
        status: 'active',
        source: SubscriptionSource.AdminGrant,
        grantedBy: 'partner-rule:rule-1',
        grantedReason: 'partner signup rule partner.example',
        quantity: 1,
        subscriptionId: expect.stringMatching(/^admin_grant_/),
      })
    );
    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user-1', credits: plan.credits * 3, type: 'subscription' }),
      expect.anything()
    );
    if (result.status === 'granted') {
      expect(result.periodEndsAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('omits grantedReason when none is given', async () => {
    await grantIndividualAdminSubscription({ ...params, grantedReason: undefined });

    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('grantedReason');
  });

  it('reports already_active without writing anything', async () => {
    mockFindByPriceId.mockResolvedValue({ status: 'active' });

    expect(await grantIndividualAdminSubscription(params)).toEqual({ status: 'already_active' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('hands the ledger row id to onGranted', async () => {
    const onGranted = vi.fn();

    await grantIndividualAdminSubscription({ ...params, onGranted });

    expect(onGranted).toHaveBeenCalledWith({ credits: plan.credits * 3, creditTransactionId: 'tx-ind' });
  });

  it('reports the post-grant balance', async () => {
    const result = await grantIndividualAdminSubscription(params);

    expect(result).toMatchObject({ status: 'granted', currentCredits: 500 });
  });

  it('uses the given subscriptionId on the row and sends no transactionId to addCredits', async () => {
    const result = await grantIndividualAdminSubscription({ ...params, subscriptionId: 'partner_grant_rule-1_user-1' });

    expect(result).toMatchObject({ status: 'granted', subscriptionId: 'partner_grant_rule-1_user-1' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'partner_grant_rule-1_user-1' }));
    expect(mockAddCredits.mock.calls[0][0]).not.toHaveProperty('transactionId');
  });

  it('reports already_granted without adding credits when the given subscriptionId is a duplicate', async () => {
    mockCreate.mockRejectedValue({ code: 11000 });

    expect(
      await grantIndividualAdminSubscription({ ...params, subscriptionId: 'partner_grant_rule-1_user-1' })
    ).toEqual({
      status: 'already_granted',
    });
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('rethrows a duplicate-key error when no subscriptionId was given', async () => {
    mockCreate.mockRejectedValue({ code: 11000 });

    await expect(grantIndividualAdminSubscription(params)).rejects.toMatchObject({ code: 11000 });
  });

  it('rethrows a non-duplicate error even when a subscriptionId was given', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));

    await expect(
      grantIndividualAdminSubscription({ ...params, subscriptionId: 'partner_grant_rule-1_user-1' })
    ).rejects.toThrow('db down');
  });

  it('ignores other active plans by default (the admin route keeps its per-price check)', async () => {
    mockFindNonTerminalSubs.mockResolvedValue([{ priceId: 'price_other', status: 'active' }]);

    expect((await grantIndividualAdminSubscription(params)).status).toBe('granted');
    expect(mockFindNonTerminalSubs).not.toHaveBeenCalled();
  });

  it('with skipIfAnyActiveIndividual, reports already_active for an active subscription on any price', async () => {
    mockFindNonTerminalSubs.mockResolvedValue([{ priceId: 'price_other', status: 'active' }]);

    expect(await grantIndividualAdminSubscription({ ...params, skipIfAnyActiveIndividual: true })).toEqual({
      status: 'already_active',
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it.each(['trialing', 'past_due'])(
    'with skipIfAnyActiveIndividual, reports already_active for a %s subscription',
    async status => {
      mockFindNonTerminalSubs.mockResolvedValue([{ priceId: 'price_other', status }]);

      expect(await grantIndividualAdminSubscription({ ...params, skipIfAnyActiveIndividual: true })).toEqual({
        status: 'already_active',
      });
      expect(mockFindNonTerminalSubs).toHaveBeenCalledWith(SubscriptionOwnerType.User, params.userId);
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it('reports unknown_plan without writing anything', async () => {
    expect(await grantIndividualAdminSubscription({ ...params, priceId: 'price_nope' })).toEqual({
      status: 'unknown_plan',
    });
    expect(mockFindByPriceId).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('lets unexpected errors throw', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));

    await expect(grantIndividualAdminSubscription(params)).rejects.toThrow('db down');
  });
});
