import { describe, it, expect } from 'vitest';
import { decideConsent, grantCovers } from './oauthConsent';

describe('grantCovers', () => {
  it('is true only when every requested scope is granted', () => {
    expect(grantCovers(['openid', 'profile'], ['openid'])).toBe(true);
    expect(grantCovers(['openid'], ['openid', 'profile'])).toBe(false);
    expect(grantCovers([], [])).toBe(true);
  });
});

describe('decideConsent', () => {
  const rp = { isRelyingParty: true, requestedScopes: ['openid', 'profile'], forceConsent: false };

  it('first-party clients never prompt', () => {
    expect(
      decideConsent({
        isRelyingParty: false,
        requestedScopes: ['openid'],
        grantedScopes: null,
        consentGiven: false,
        forceConsent: false,
      })
    ).toBe('mint');
  });

  it('relying-party with no grant requires consent', () => {
    expect(decideConsent({ ...rp, grantedScopes: null, consentGiven: false })).toBe('consent_required');
  });

  it('relying-party with a covering grant mints silently (remembered consent)', () => {
    expect(decideConsent({ ...rp, grantedScopes: ['openid', 'profile'], consentGiven: false })).toBe('mint');
  });

  it('relying-party re-prompts when requested scopes escalate beyond the grant', () => {
    expect(decideConsent({ ...rp, grantedScopes: ['openid'], consentGiven: false })).toBe('consent_required');
  });

  it('relying-party mints when the user just consented', () => {
    expect(decideConsent({ ...rp, grantedScopes: null, consentGiven: true })).toBe('mint');
  });

  it('prompt=consent forces a re-prompt even with a covering grant', () => {
    expect(
      decideConsent({ ...rp, grantedScopes: ['openid', 'profile'], consentGiven: false, forceConsent: true })
    ).toBe('consent_required');
  });
});
