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

describe('OrgSubscriptionSubscribeSchema.callbackUrl', () => {
  const baseSeats = { ...baseRequest, quantity: ORGANIZATION_SUBSCRIPTION_MIN_SEATS };

  it('accepts an absolute https callbackUrl', () => {
    const result = OrgSubscriptionSubscribeSchema.safeParse({
      ...baseSeats,
      callbackUrl: 'https://app.example.com/settings/billing',
    });

    expect(result.success).toBe(true);
  });

  it('accepts an origin-only callbackUrl with no trailing path', () => {
    // OrganizationBillingSection sends window.location.origin on purpose (CloudFront 403s
    // deep paths, so the real destination is stashed in sessionStorage) - requiring a path
    // here would break that flow.
    const result = OrgSubscriptionSubscribeSchema.safeParse({
      ...baseSeats,
      callbackUrl: 'https://app.example.com',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a relative path', () => {
    const result = OrgSubscriptionSubscribeSchema.safeParse({ ...baseSeats, callbackUrl: '/settings/billing' });

    expect(result.success).toBe(false);
  });

  it('rejects a string that is not a URL', () => {
    const result = OrgSubscriptionSubscribeSchema.safeParse({ ...baseSeats, callbackUrl: 'not a url' });

    expect(result.success).toBe(false);
  });
});
