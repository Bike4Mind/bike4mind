import { describe, it, expect } from 'vitest';
import { isPolicyConsentRequired, POLICY_CONSENT_ALLOWLIST } from './consentGate';

describe('isPolicyConsentRequired — P0-B consent gate', () => {
  const notConsented = { aupAcceptedVersion: undefined };

  it('blocks a not-yet-consented user on a non-allowlisted path', () => {
    expect(isPolicyConsentRequired(notConsented, '/api/sessions', 'GET')).toBe(true);
    expect(isPolicyConsentRequired(notConsented, '/api/quests/123', 'POST')).toBe(true);
  });

  it('allows every allowlisted (path, method) pair so a new account can unlock itself', () => {
    for (const entry of POLICY_CONSENT_ALLOWLIST) {
      for (const method of entry.methods) {
        expect(isPolicyConsentRequired(notConsented, entry.path, method)).toBe(false);
      }
    }
    // startsWith semantics: the self-profile fetch and querystrings are covered
    expect(isPolicyConsentRequired(notConsented, '/api/users/abc123', 'GET')).toBe(false);
    expect(isPolicyConsentRequired(notConsented, '/api/identify?foo=bar', 'GET')).toBe(false);
  });

  it('blocks WRITE requests under a bootstrap prefix (method-scoped allowlist)', () => {
    // A GET on the users prefix is the only pre-consent need; the write surface under the same
    // prefix (profile update, self-delete, agent creation) must stay blocked until acceptance.
    expect(isPolicyConsentRequired(notConsented, '/api/users/abc123/update', 'POST')).toBe(true);
    expect(isPolicyConsentRequired(notConsented, '/api/users/abc123/delete', 'DELETE')).toBe(true);
    expect(isPolicyConsentRequired(notConsented, '/api/users/abc123/agents', 'POST')).toBe(true);
  });

  it('does NOT conflate singular /user/ with plural /users/', () => {
    // The recording endpoint is singular; a request to it must pass even though the profile
    // route (plural) is separately allowlisted.
    expect(isPolicyConsentRequired(notConsented, '/api/user/accept-policies', 'POST')).toBe(false);
  });

  it('allows a user who has already recorded acceptance (real or grandfathered)', () => {
    expect(isPolicyConsentRequired({ aupAcceptedVersion: 'v1' }, '/api/sessions', 'POST')).toBe(false);
    expect(isPolicyConsentRequired({ aupAcceptedVersion: 'grandfathered' }, '/api/sessions', 'POST')).toBe(false);
  });

  it('skips system/service accounts', () => {
    expect(isPolicyConsentRequired({ aupAcceptedVersion: undefined, isSystem: true }, '/api/sessions', 'GET')).toBe(
      false
    );
  });

  it('is a no-op when there is no authenticated user', () => {
    expect(isPolicyConsentRequired(undefined, '/api/sessions', 'GET')).toBe(false);
  });
});
