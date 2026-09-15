import { describe, it, expect } from 'vitest';
import { getLoginErrorMessage } from './loginErrorMessages';

describe('getLoginErrorMessage (surface SSO failures)', () => {
  it('returns undefined when there is no error code', () => {
    expect(getLoginErrorMessage(null)).toBeUndefined();
    expect(getLoginErrorMessage(undefined)).toBeUndefined();
    expect(getLoginErrorMessage('')).toBeUndefined();
  });

  it('maps the okta_setup_failed code (the QA case) to a specific message', () => {
    const msg = getLoginErrorMessage('okta_setup_failed');
    expect(msg).toMatch(/okta/i);
    expect(msg).toMatch(/unavailable|administrator/i);
  });

  it('maps known SAML / flow codes to specific messages', () => {
    expect(getLoginErrorMessage('saml_auth_failed')).toMatch(/saml/i);
    expect(getLoginErrorMessage('email_required')).toMatch(/email/i);
    expect(getLoginErrorMessage('missing_state')).toMatch(/session expired/i);
  });

  it('maps the account-linking gate codes to dedicated, distinct guidance', () => {
    const mismatch = getLoginErrorMessage('account_link_email_mismatch');
    const needsVerify = getLoginErrorMessage('account_link_requires_verification');
    // mismatch steers the user to sign in with their existing method first
    expect(mismatch).toMatch(/already exists/i);
    expect(mismatch).toMatch(/existing method/i);
    // verification case steers the user to verify their email
    expect(needsVerify).toMatch(/verify your email/i);
    // the two codes must not collapse to the same message, and neither is the generic fallback
    expect(mismatch).not.toBe(needsVerify);
    expect(mismatch).not.toBe('Sign-in failed. Please try again or use another method.');
    expect(needsVerify).not.toBe('Sign-in failed. Please try again or use another method.');
  });

  it('maps the session_expired code to a specific message', () => {
    // Emitted by the API 401 interceptor when a mid-session token refresh fails
    // and the user is redirected to /login instead of being stranded.
    const msg = getLoginErrorMessage('session_expired');
    expect(msg).toMatch(/session has expired/i);
    expect(msg).not.toBe('Sign-in failed. Please try again or use another method.');
  });

  it('maps the session_revoked code to a distinct security-logout message', () => {
    // Surfaced cross-tab when a session is revoked (e.g. the 3-strike MFA lockout)
    // rather than merely expired - must not collapse to the session_expired wording.
    const msg = getLoginErrorMessage('session_revoked');
    expect(msg).toMatch(/signed out for security/i);
    expect(msg).not.toBe(getLoginErrorMessage('session_expired'));
    expect(msg).not.toBe('Sign-in failed. Please try again or use another method.');
  });

  it('falls back to a generic message for an unknown but non-empty code (never silent)', () => {
    expect(getLoginErrorMessage('some_new_code_we_dont_know')).toBe(
      'Sign-in failed. Please try again or use another method.'
    );
  });
});
