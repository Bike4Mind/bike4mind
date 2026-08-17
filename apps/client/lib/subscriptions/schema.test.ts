import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
} from '@client/lib/subscriptions/constants';
import { OrgSubscriptionSubscribeSchema } from '@client/lib/subscriptions/schema';
import { describe, expect, it } from 'vitest';

const baseRequest = {
  priceId: 'price_test',
  callbackUrl: 'https://app.example.com/return',
  organizationId: 'org_test',
};

describe('OrgSubscriptionSubscribeSchema.quantity', () => {
  it('accepts an in-range integer seat count', () => {
    const result = OrgSubscriptionSubscribeSchema.safeParse({
      ...baseRequest,
      quantity: ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a non-integer seat count', () => {
    const result = OrgSubscriptionSubscribeSchema.safeParse({
      ...baseRequest,
      quantity: ORGANIZATION_SUBSCRIPTION_MIN_SEATS + 0.5,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a seat count below the platform minimum', () => {
    const result = OrgSubscriptionSubscribeSchema.safeParse({
      ...baseRequest,
      quantity: ORGANIZATION_SUBSCRIPTION_MIN_SEATS - 1,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a seat count above the platform maximum', () => {
    const result = OrgSubscriptionSubscribeSchema.safeParse({
      ...baseRequest,
      quantity: ORGANIZATION_SUBSCRIPTION_MAX_SEATS + 1,
    });

    expect(result.success).toBe(false);
  });
});
