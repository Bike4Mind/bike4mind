import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSettingsValue = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args) },
}));

import { CURRENT_POLICY_VERSION } from '@bike4mind/common';
import { creditPurchaseTermsMetadata, termsConsentSessionParams } from './termsConsent';

describe('termsConsentSessionParams', () => {
  beforeEach(() => mockGetSettingsValue.mockReset());

  it('requires terms and names the buyer while the setting is on', async () => {
    mockGetSettingsValue.mockResolvedValue(true);

    await expect(termsConsentSessionParams('user_1')).resolves.toEqual({
      consent_collection: { terms_of_service: 'required' },
      client_reference_id: 'user_1',
    });
    expect(mockGetSettingsValue).toHaveBeenCalledWith('requireCheckoutTermsConsent');
  });

  it.each([false, undefined, null])('adds nothing while the setting is %s', async value => {
    mockGetSettingsValue.mockResolvedValue(value);

    await expect(termsConsentSessionParams('user_1')).resolves.toEqual({});
  });
});

describe('creditPurchaseTermsMetadata', () => {
  beforeEach(() => mockGetSettingsValue.mockReset());

  it('adds nothing while the setting is off, whatever the client sent', async () => {
    mockGetSettingsValue.mockResolvedValue(false);

    await expect(creditPurchaseTermsMetadata(undefined)).resolves.toEqual({});
    await expect(creditPurchaseTermsMetadata(true)).resolves.toEqual({});
  });

  it('returns the current terms version while the setting is on and terms were accepted', async () => {
    mockGetSettingsValue.mockResolvedValue(true);

    await expect(creditPurchaseTermsMetadata(true)).resolves.toEqual({ termsAcceptedVersion: CURRENT_POLICY_VERSION });
  });

  it.each([undefined, false])('refuses with 400 while the setting is on and acceptedTerms is %s', async accepted => {
    mockGetSettingsValue.mockResolvedValue(true);

    await expect(creditPurchaseTermsMetadata(accepted)).rejects.toMatchObject({ statusCode: 400 });
  });
});
