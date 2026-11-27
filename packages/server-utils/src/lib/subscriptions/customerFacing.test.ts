import { describe, it, expect } from 'vitest';
import { SubscriptionOwnerType, SubscriptionSource, type ISubscription } from './types';
import { subscriptionToUserSubscription } from '../userSubscriptions/types';
import { toCustomerFacingSubscription } from './customerFacing';

const row = {
  id: 'sub-1',
  ownerType: SubscriptionOwnerType.User,
  ownerId: 'user-1',
  subscriptionId: 'sub_123',
  priceId: 'price_1',
  status: 'active',
  source: SubscriptionSource.AdminGrant,
  grantedBy: 'admin-1',
  grantedReason: 'comp',
  acquisition: { first: { source: 'ad' }, last: { source: 'ad' } },
  canceledAt: null,
  periodStartsAt: new Date('2026-01-01'),
  periodEndsAt: new Date('2026-02-01'),
  quantity: 3,
  paymentFailureNotifiedInvoiceIds: ['in_1'],
  nonPaymentCancelNotifiedAt: new Date('2026-01-15'),
  billingNoticeKeys: ['unpaid:sub_123'],
  stripeCustomerId: 'cus_1',
  lastSyncedAt: new Date('2026-01-02'),
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  _id: 'oid',
  __v: 0,
} as unknown as ISubscription & { id: string; createdAt: Date; updatedAt: Date };

const WITHHELD = [
  'grantedBy',
  'grantedReason',
  'acquisition',
  'paymentFailureNotifiedInvoiceIds',
  'nonPaymentCancelNotifiedAt',
  'billingNoticeKeys',
  'stripeCustomerId',
  'lastSyncedAt',
  '_id',
  '__v',
];

describe('toCustomerFacingSubscription', () => {
  it('keeps the display fields and drops grant, billing-notice and Stripe customer fields', () => {
    const out = toCustomerFacingSubscription(row) as Record<string, unknown>;
    expect(out).toMatchObject({
      id: 'sub-1',
      priceId: 'price_1',
      status: 'active',
      source: 'admin_grant',
      quantity: 3,
    });
    for (const key of WITHHELD) expect(out).not.toHaveProperty(key);
  });

  it('does not carry a field the model gains later', () => {
    const out = toCustomerFacingSubscription({ ...row, futureInternalField: 'x' } as typeof row);
    expect(out).not.toHaveProperty('futureInternalField');
  });
});

describe('subscriptionToUserSubscription', () => {
  it('maps ownerId to userId, drops ownerId/ownerType and the withheld fields', () => {
    const out = subscriptionToUserSubscription(row) as unknown as Record<string, unknown>;
    expect(out.userId).toBe('user-1');
    expect(out).not.toHaveProperty('ownerId');
    expect(out).not.toHaveProperty('ownerType');
    for (const key of WITHHELD) expect(out).not.toHaveProperty(key);
  });
});
