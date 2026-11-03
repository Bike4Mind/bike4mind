import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCustomersUpdate = vi.fn();
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    customers: {
      update: (...args: unknown[]) => mockCustomersUpdate(...args),
    },
  },
}));

import {
  accountAgeMetadata,
  backfillCustomerSignupMetadata,
  paymentRiskMetadata,
  signupNetworkMetadata,
} from './riskMetadata';

const NOW = new Date('2026-06-15T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

const fullSignup = {
  ip: '203.0.113.7',
  userAgent: 'agent',
  asn: 16509,
  asnOrg: 'hosting',
  country: 'DE',
  isDatacenter: true,
  capturedAt: NOW,
};

const logger = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mockCustomersUpdate.mockResolvedValue({ id: 'cus_1' });
});

describe('signupNetworkMetadata', () => {
  it('sends the ASN, the datacenter flag and the country as strings', () => {
    expect(signupNetworkMetadata({ signupMeta: fullSignup })).toEqual({
      signup_asn: '16509',
      signup_is_datacenter: 'true',
      signup_country: 'DE',
    });
  });

  it('is empty for an account that predates signup network capture', () => {
    expect(signupNetworkMetadata({})).toEqual({});
    expect(signupNetworkMetadata({ signupMeta: null })).toEqual({});
  });

  it('leaves out each field the capture did not record', () => {
    expect(
      signupNetworkMetadata({ signupMeta: { ...fullSignup, asn: null, isDatacenter: null, country: null } })
    ).toEqual({});
    expect(signupNetworkMetadata({ signupMeta: { ...fullSignup, isDatacenter: false, asn: null } })).toEqual({
      signup_is_datacenter: 'false',
      signup_country: 'DE',
    });
  });

  it('never includes the IP address or the user agent', () => {
    const metadata = signupNetworkMetadata({ signupMeta: fullSignup });
    expect(JSON.stringify(metadata)).not.toContain('203.0.113.7');
    expect(JSON.stringify(metadata)).not.toContain('agent');
  });
});

describe('accountAgeMetadata', () => {
  it('rounds the age down to whole hours', () => {
    const createdAt = new Date(NOW.getTime() - 2 * HOUR_MS - 59 * 60 * 1000);
    expect(accountAgeMetadata({ createdAt }, NOW)).toEqual({ account_age_hours: '2' });
  });

  it('is 0 for an account younger than an hour', () => {
    const createdAt = new Date(NOW.getTime() - 5 * 60 * 1000);
    expect(accountAgeMetadata({ createdAt }, NOW)).toEqual({ account_age_hours: '0' });
  });

  it('accepts a string creation time', () => {
    const createdAt = new Date(NOW.getTime() - 48 * HOUR_MS).toISOString();
    expect(accountAgeMetadata({ createdAt }, NOW)).toEqual({ account_age_hours: '48' });
  });

  it('treats a missing, unreadable or future creation time as brand new', () => {
    expect(accountAgeMetadata({}, NOW)).toEqual({ account_age_hours: '0' });
    expect(accountAgeMetadata({ createdAt: 'not a date' }, NOW)).toEqual({ account_age_hours: '0' });
    expect(accountAgeMetadata({ createdAt: new Date(NOW.getTime() + HOUR_MS) }, NOW)).toEqual({
      account_age_hours: '0',
    });
  });
});

describe('paymentRiskMetadata', () => {
  it('combines the age with the signup fields', () => {
    const createdAt = new Date(NOW.getTime() - 30 * 24 * HOUR_MS);
    expect(paymentRiskMetadata({ createdAt, signupMeta: fullSignup }, NOW)).toEqual({
      account_age_hours: '720',
      signup_asn: '16509',
      signup_is_datacenter: 'true',
      signup_country: 'DE',
    });
  });

  it('sends only the age when there is no signup capture', () => {
    expect(paymentRiskMetadata({ createdAt: NOW }, NOW)).toEqual({ account_age_hours: '0' });
  });
});

describe('backfillCustomerSignupMetadata', () => {
  it('merges the signup fields onto the customer', async () => {
    await backfillCustomerSignupMetadata({ customerId: 'cus_1', user: { signupMeta: fullSignup } }, logger);

    expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_1', {
      metadata: { signup_asn: '16509', signup_is_datacenter: 'true', signup_country: 'DE' },
    });
  });

  it('makes no call when the account has nothing to send', async () => {
    await backfillCustomerSignupMetadata({ customerId: 'cus_1', user: {} }, logger);

    expect(mockCustomersUpdate).not.toHaveBeenCalled();
  });

  it('makes no call when the customer already carries the same fields', async () => {
    await backfillCustomerSignupMetadata(
      {
        customerId: 'cus_1',
        user: { signupMeta: fullSignup },
        existingMetadata: { signup_asn: '16509', signup_is_datacenter: 'true', signup_country: 'DE', type: 'User' },
      },
      logger
    );

    expect(mockCustomersUpdate).not.toHaveBeenCalled();
  });

  it('updates when the customer is missing one of the fields', async () => {
    await backfillCustomerSignupMetadata(
      {
        customerId: 'cus_1',
        user: { signupMeta: fullSignup },
        existingMetadata: { signup_asn: '16509', type: 'User' },
      },
      logger
    );

    expect(mockCustomersUpdate).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows a Stripe failure so the purchase goes on', async () => {
    mockCustomersUpdate.mockRejectedValue(new Error('stripe down'));

    await expect(
      backfillCustomerSignupMetadata({ customerId: 'cus_1', user: { signupMeta: fullSignup } }, logger)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      stripeCustomerId: 'cus_1',
      error: 'stripe down',
    });
  });
});
