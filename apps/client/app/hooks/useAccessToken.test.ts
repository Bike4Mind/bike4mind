import { describe, it, expect, beforeEach } from 'vitest';
import { useAccessToken } from './useAccessToken';

describe('useAccessToken store', () => {
  beforeEach(() => {
    // Start each test from a populated, logged-in-and-impersonating state so a
    // clear action has something to clear on every field (including the
    // returnToken/returnRefreshToken impersonation tokens).
    useAccessToken.setState({
      accessToken: 'access',
      refreshToken: 'refresh',
      returnToken: 'return',
      returnRefreshToken: 'return-refresh',
      mfaPending: true,
      expired: false,
      expiredReason: null,
    });
  });

  describe('markSessionExpired', () => {
    it('clears every token field and sets expired: true with reason "expired"', () => {
      useAccessToken.getState().markSessionExpired();

      expect(useAccessToken.getState()).toMatchObject({
        accessToken: null,
        refreshToken: null,
        returnToken: null,
        returnRefreshToken: null,
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
      // Intentionally PRESERVES the impersonation return tokens (unlike markSessionRevoked,
      // which clears them) - lock that divergence so a refactor can't silently drop it.
      expect(state.returnToken).toBe('return');
      expect(state.returnRefreshToken).toBe('return-refresh');
    });
  });

  describe('markSessionRevoked', () => {
    it('clears every token including impersonation return tokens, with reason "revoked"', () => {
      // The hard-revocation path (server-side tokenVersion kill-switch) must not leave an
      // admin's stashed return token behind - unlike forceLogoutTokens, which keeps it.
      useAccessToken.getState().markSessionRevoked();

      expect(useAccessToken.getState()).toMatchObject({
        accessToken: null,
        refreshToken: null,
        returnToken: null,
        returnRefreshToken: null,
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

  describe('re-auth clears a stale expiredReason', () => {
    it('setVerifiedTokens resets expiredReason after a prior forced logout', () => {
      // Without the reset, a 'revoked' value would linger with expired: false -
      // misleading any future consumer that reads expiredReason without the gate.
      useAccessToken.getState().forceLogoutTokens();
      expect(useAccessToken.getState().expiredReason).toBe('revoked');

      useAccessToken.getState().setVerifiedTokens('new-access', 'new-refresh');

      const state = useAccessToken.getState();
      expect(state.expired).toBe(false);
      expect(state.expiredReason).toBeNull();
    });
  });
});
