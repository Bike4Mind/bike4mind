import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAccessToken, useIsFullyAuthenticated } from './useAccessToken';

describe('useAccessToken store', () => {
  beforeEach(() => {
    // Start each test from a populated, logged-in-and-impersonating state so a
    // clear action has something to clear on every field.
    useAccessToken.setState({
      accessToken: 'access',
      impersonating: true,
      hasSession: true,
      mfaPending: true,
      expired: false,
      expiredReason: null,
    });
  });

  describe('markSessionExpired', () => {
    it('clears the session and sets expired: true with reason "expired"', () => {
      useAccessToken.getState().markSessionExpired();

      expect(useAccessToken.getState()).toMatchObject({
        accessToken: null,
        impersonating: false,
        hasSession: false,
        mfaPending: false,
        expired: true,
        expiredReason: 'expired',
      });
    });

    it('applies the clear in a single store write', () => {
      // The cross-tab race hinged on this being ONE set(): two
      // writes (resetTokens() then setState({ expired: true })) emitted two
      // localStorage/storage events, letting a background tab briefly observe
      // expired: false and redirect to a plain /login. Each set() notifies
      // subscribers exactly once, so a single notification proves a single write.
      let writes = 0;
      const unsubscribe = useAccessToken.subscribe(() => {
        writes += 1;
      });

      useAccessToken.getState().markSessionExpired();
      unsubscribe();

      expect(writes).toBe(1);
    });
  });

  describe('forceLogoutTokens', () => {
    it('marks the session revoked (distinct from an expiry) for a security-forced logout', () => {
      // A 3-strike MFA lockout clears tokens with reason "revoked" so the cross-tab
      // listener surfaces session_revoked instead of session_expired.
      useAccessToken.getState().forceLogoutTokens();

      const state = useAccessToken.getState();
      expect(state.accessToken).toBeNull();
      expect(state.expired).toBe(true);
      expect(state.expiredReason).toBe('revoked');
      // Intentionally leaves the impersonation flag alone (unlike markSessionRevoked, which
      // clears it): an MFA lockout is the impersonated user's failure, not the admin's, and the
      // admin's HttpOnly return cookie is still valid. Lock that divergence.
      expect(state.impersonating).toBe(true);
    });
  });

  describe('markSessionRevoked', () => {
    it('clears the session including the impersonation flag, with reason "revoked"', () => {
      // The hard-revocation path (server-side tokenVersion kill-switch) must not leave the
      // session looking like a live impersonation - unlike forceLogoutTokens, which keeps it.
      useAccessToken.getState().markSessionRevoked();

      expect(useAccessToken.getState()).toMatchObject({
        accessToken: null,
        impersonating: false,
        hasSession: false,
        mfaPending: false,
        expired: true,
        expiredReason: 'revoked',
      });
    });

    it('applies the clear in a single store write', () => {
      // Same cross-tab atomicity invariant as markSessionExpired: one set() = one storage
      // event, so a background tab can't observe a transient intermediate state.
      let writes = 0;
      const unsubscribe = useAccessToken.subscribe(() => {
        writes += 1;
      });

      useAccessToken.getState().markSessionRevoked();
      unsubscribe();

      expect(writes).toBe(1);
    });
  });

  describe('useIsFullyAuthenticated', () => {
    it('is false during the mfaPending window even though an access token is present', () => {
      useAccessToken.setState({ accessToken: 'mfa-token', mfaPending: true });
      const { result } = renderHook(() => useIsFullyAuthenticated());
      expect(result.current).toBe(false);
    });

    it('is false with no access token', () => {
      useAccessToken.setState({ accessToken: null, mfaPending: false });
      const { result } = renderHook(() => useIsFullyAuthenticated());
      expect(result.current).toBe(false);
    });

    it('flips to true the instant MFA verification clears mfaPending (gated queries auto-run)', () => {
      useAccessToken.setState({ accessToken: 'mfa-token', mfaPending: true });
      const { result } = renderHook(() => useIsFullyAuthenticated());
      expect(result.current).toBe(false);

      act(() => useAccessToken.getState().setVerifiedSession('verified-token'));
      expect(result.current).toBe(true);
    });
  });

  describe('re-auth clears a stale expiredReason', () => {
    it('setVerifiedSession resets expiredReason after a prior forced logout', () => {
      // Without the reset, a 'revoked' value would linger with expired: false -
      // misleading any future consumer that reads expiredReason without the gate.
      useAccessToken.getState().forceLogoutTokens();
      expect(useAccessToken.getState().expiredReason).toBe('revoked');

      useAccessToken.getState().setVerifiedSession('new-access');

      const state = useAccessToken.getState();
      expect(state.expired).toBe(false);
      expect(state.expiredReason).toBeNull();
    });
  });
});
