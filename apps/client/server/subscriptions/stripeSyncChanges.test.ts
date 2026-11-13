import { describe, expect, it } from 'vitest';
import { stripeMirrorFields } from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { stripeSyncChanges } from './stripeSyncChanges';

const endedAt = new Date('2026-11-01T00:00:00Z');
const mirror = stripeMirrorFields({
  currency: 'usd',
  customer: 'cus_test',
  cancel_at: null,
  cancel_at_period_end: false,
  trial_end: null,
  ended_at: endedAt.getTime() / 1000,
  items: { data: [] },
});

describe('stripeSyncChanges effective end', () => {
  it('includes an effective-end change in the sync preview and audit receipt', () => {
    const after = {
      ...mirror,
      status: 'canceled' as const,
      priceId: 'price_test',
      quantity: 1,
      periodStartsAt: new Date('2026-10-01T00:00:00Z'),
      periodEndsAt: new Date('2026-12-01T00:00:00Z'),
      canceledAt: endedAt,
    };
    const before = {
      ...after,
      ownerId: 'owner',
      ownerType: SubscriptionOwnerType.User,
      source: SubscriptionSource.Stripe,
      endedAt: undefined,
    };
    expect(stripeSyncChanges({ before, after })).toEqual([
      { field: 'endedAt', before: null, after: endedAt.toISOString() },
    ]);
    expect(stripeSyncChanges({ before: { ...before, endedAt }, after })).toEqual([]);
  });
});
