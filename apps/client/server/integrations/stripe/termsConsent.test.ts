import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSettingsValue = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args) },
}));

import { termsConsentSessionParams } from './termsConsent';

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
