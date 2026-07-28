import { AuthTokenGeneratorService, isTokenVersionCurrent, isTokenTypeAcceptable } from './AuthTokenGeneratorService';
import jwt from 'jsonwebtoken';

const makeService = () =>
  new AuthTokenGeneratorService({
    accessTokenSecret: 'test-access-secret',
    refreshTokenSecret: 'test-refresh-secret',
    accessTokenExpiresIn: '1h',
    refreshTokenExpiresIn: '7d',
  });

describe('AuthTokenGeneratorService', () => {
  it('sign + verify round-trip returns expected claims', () => {
    const svc = makeService();
    const { accessToken } = svc.createAccessToken('user-123', 0, { role: 'admin' });
    const payload = svc.verifyToken(accessToken);
    expect(payload.id).toBe('user-123');
    expect(payload.role).toBe('admin');
  });

  it('verify with wrong secret throws', () => {
    const svc = makeService();
    const wrongSvc = new AuthTokenGeneratorService({
      accessTokenSecret: 'wrong-secret',
      refreshTokenSecret: 'wrong-refresh-secret',
      accessTokenExpiresIn: '1h',
      refreshTokenExpiresIn: '7d',
    });
    const { accessToken } = svc.createAccessToken('user-123', 0);
    expect(() => wrongSvc.verifyToken(accessToken)).toThrow();
  });

  it('verifyRefreshToken round-trip returns userId', () => {
    const svc = makeService();
    const refreshToken = svc.createRefreshToken('user-456', 0);
    const result = svc.verifyRefreshToken(refreshToken);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-456');
  });

  it('verifyRefreshToken with wrong secret returns null', () => {
    const svc = makeService();
    const wrongSvc = new AuthTokenGeneratorService({
      accessTokenSecret: 'wrong-secret',
      refreshTokenSecret: 'wrong-refresh-secret',
      accessTokenExpiresIn: '1h',
      refreshTokenExpiresIn: '7d',
    });
    const refreshToken = svc.createRefreshToken('user-456', 0);
    const result = wrongSvc.verifyRefreshToken(refreshToken);
    expect(result).toBeNull();
  });

  describe('mfaPending tokens are rejected on the refresh path (MFA bypass regression)', () => {
    // In production accessTokenSecret === refreshTokenSecret (both Config.JWT_SECRET),
    // so a token signed for the access path also verifies on the refresh path. The
    // mfaPending access token (issued after the first factor, before TOTP) must NOT be
    // exchangeable for a full session at /api/auth/refreshToken or /api/oauth/refresh.
    const SHARED = 'shared-jwt-secret';
    const sharedSecretService = () =>
      new AuthTokenGeneratorService({
        accessTokenSecret: SHARED,
        refreshTokenSecret: SHARED,
        accessTokenExpiresIn: '10m',
        refreshTokenExpiresIn: '30d',
      });

    it('rejects a mfaPending token even though it is signed with the shared secret', () => {
      const svc = sharedSecretService();
      const mfaPendingToken = jwt.sign({ id: 'user-123', mfaPending: true, tokenVersion: 0 }, SHARED, {
        algorithm: 'HS256',
        expiresIn: '10m',
      });
      expect(svc.verifyRefreshToken(mfaPendingToken)).toBeNull();
    });

    it('rejects a mfaPending token on the previous-secret rotation branch too', () => {
      const svc = sharedSecretService();
      const previousSecret = 'previous-shared-secret';
      const mfaPendingToken = jwt.sign({ id: 'user-123', mfaPending: true, tokenVersion: 0 }, previousSecret, {
        algorithm: 'HS256',
        expiresIn: '10m',
      });
      expect(svc.verifyRefreshToken(mfaPendingToken, previousSecret)).toBeNull();
    });

    it('still accepts a legitimate refresh token (no over-rejection)', () => {
      const svc = sharedSecretService();
      const refreshToken = svc.createRefreshToken('user-123', 0);
      const result = svc.verifyRefreshToken(refreshToken);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-123');
    });

    it('rejects a refresh token signed with a non-HS256 algorithm (algorithm pinning)', () => {
      const svc = sharedSecretService();
      // A token forged/signed with a different algorithm must not verify.
      const hs384Token = jwt.sign({ id: 'user-123', tokenVersion: 0 }, SHARED, { algorithm: 'HS384' });
      expect(svc.verifyRefreshToken(hs384Token)).toBeNull();
    });
  });

  describe('token-type claim (access vs refresh separation)', () => {
    // In production accessTokenSecret === refreshTokenSecret, so before the `typ` claim an
    // access token verified fine on the refresh path and could be exchanged for a full
    // session. The claim closes that; typ-less legacy tokens stay valid (self-expiring grace).
    const SHARED = 'shared-jwt-secret';
    const sharedSecretService = () =>
      new AuthTokenGeneratorService({
        accessTokenSecret: SHARED,
        refreshTokenSecret: SHARED,
        accessTokenExpiresIn: '7d',
        refreshTokenExpiresIn: '30d',
      });

    it('stamps typ=access on access tokens', () => {
      const svc = makeService();
      const { accessToken } = svc.createAccessToken('user-1', 0);
      expect((svc.verifyToken(accessToken) as { typ?: string }).typ).toBe('access');
    });

    it('stamps typ=refresh on refresh tokens', () => {
      const svc = makeService();
      const refreshToken = svc.createRefreshToken('user-1', 0);
      expect((jwt.decode(refreshToken) as { typ?: string }).typ).toBe('refresh');
    });

    it('rejects an access token replayed on the refresh path (shared secret)', () => {
      const svc = sharedSecretService();
      const { accessToken } = svc.createAccessToken('user-1', 0);
      expect(svc.verifyRefreshToken(accessToken)).toBeNull();
    });

    it('rejects an access-typed token on the previous-secret rotation branch too', () => {
      const svc = sharedSecretService();
      const previousSecret = 'previous-shared-secret';
      // Signed with the OLD secret so only the rotation fallback verifies it - the typ
      // check must run on that recovered payload, not just the primary-secret path.
      const rotatedAccess = jwt.sign({ id: 'user-1', tokenVersion: 0, typ: 'access' }, previousSecret, {
        algorithm: 'HS256',
        expiresIn: '7d',
      });
      expect(svc.verifyRefreshToken(rotatedAccess, previousSecret)).toBeNull();
    });

    it('still accepts a legacy typ-less refresh token (self-expiring grace)', () => {
      const svc = sharedSecretService();
      const legacyRefresh = jwt.sign({ id: 'user-1', tokenVersion: 0 }, SHARED, {
        algorithm: 'HS256',
        expiresIn: '30d',
      });
      const result = svc.verifyRefreshToken(legacyRefresh);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
    });
  });

  describe('tokenVersion kill switch', () => {
    it('embeds tokenVersion in the access token and surfaces it on verify', () => {
      const svc = makeService();
      const { accessToken } = svc.createAccessToken('user-123', 2);
      const payload = svc.verifyToken(accessToken);
      expect(payload.tokenVersion).toBe(2);
    });

    it('embeds tokenVersion in the refresh token and returns it from verifyRefreshToken', () => {
      const svc = makeService();
      const refreshToken = svc.createRefreshToken('user-456', 3);
      const result = svc.verifyRefreshToken(refreshToken);
      expect(result).not.toBeNull();
      expect(result!.tokenVersion).toBe(3);
    });
  });

  describe('isTokenTypeAcceptable', () => {
    it('accepts a token whose typ matches the expected path', () => {
      expect(isTokenTypeAcceptable('access', 'access')).toBe(true);
      expect(isTokenTypeAcceptable('refresh', 'refresh')).toBe(true);
    });

    it('rejects a token whose typ is the wrong path (the confusion guard)', () => {
      expect(isTokenTypeAcceptable('access', 'refresh')).toBe(false);
      expect(isTokenTypeAcceptable('refresh', 'access')).toBe(false);
    });

    // A token with no typ (issued before the claim existed) is honored on either path
    // so live sessions aren't logged out - it ages out within its TTL.
    it('accepts a typ-less legacy token on either path (self-expiring grace)', () => {
      expect(isTokenTypeAcceptable(undefined, 'access')).toBe(true);
      expect(isTokenTypeAcceptable(undefined, 'refresh')).toBe(true);
    });

    it('rejects an unexpected typ value', () => {
      expect(isTokenTypeAcceptable('bogus', 'access')).toBe(false);
    });

    // Only a literally-absent claim (undefined) is the grace case. A null, empty-string,
    // or object typ is a malformed/forged token and must be rejected - the guard is
    // strict-equality, not truthiness, so these do not slip through as "legacy".
    it('rejects null / empty-string / object typ (not treated as the legacy grace case)', () => {
      expect(isTokenTypeAcceptable(null, 'access')).toBe(false);
      expect(isTokenTypeAcceptable('', 'access')).toBe(false);
      expect(isTokenTypeAcceptable({}, 'access')).toBe(false);
    });
  });

  describe('impersonation marker survives a refresh', () => {
    // Regression: createRefreshToken previously ignored additionalPayload entirely, so an
    // impersonated session that refreshed its access token silently lost impersonatedBy and
    // logout.ts's "don't revoke the real customer" guard stopped applying.
    it('createAccessToken embeds additionalPayload in BOTH the access and refresh token', () => {
      const svc = makeService();
      const { accessToken, refreshToken } = svc.createAccessToken('customer-1', 0, { impersonatedBy: 'admin-9' });

      expect(svc.verifyToken(accessToken).impersonatedBy).toBe('admin-9');
      expect(svc.verifyRefreshToken(refreshToken)!.impersonatedBy).toBe('admin-9');
    });

    it('createRefreshToken embeds additionalPayload directly', () => {
      const svc = makeService();
      const refreshToken = svc.createRefreshToken('customer-1', 0, { impersonatedBy: 'admin-9' });
      expect(svc.verifyRefreshToken(refreshToken)!.impersonatedBy).toBe('admin-9');
    });

    it('a non-impersonated refresh token carries no impersonatedBy claim', () => {
      const svc = makeService();
      const { refreshToken } = svc.createAccessToken('user-123', 0);
      expect(svc.verifyRefreshToken(refreshToken)!.impersonatedBy).toBeUndefined();
    });
  });

  describe('isTokenVersionCurrent', () => {
    // A token with no embedded version (issued before the field existed) must
    // still pass against a default user (version 0) - otherwise every live
    // session is logged out on deploy.
    it('treats a missing payload version as 0 (no mass logout on deploy)', () => {
      expect(isTokenVersionCurrent(undefined, 0)).toBe(true);
    });

    // ...but once that user's version is bumped, the legacy token is rejected.
    it('rejects a missing payload version against a bumped user', () => {
      expect(isTokenVersionCurrent(undefined, 1)).toBe(false);
    });

    it('accepts matching versions', () => {
      expect(isTokenVersionCurrent(2, 2)).toBe(true);
    });

    it('rejects a stale token version', () => {
      expect(isTokenVersionCurrent(1, 2)).toBe(false);
    });

    it('normalizes a missing user version to 0', () => {
      expect(isTokenVersionCurrent(0, undefined)).toBe(true);
      expect(isTokenVersionCurrent(1, undefined)).toBe(false);
    });
  });

  describe('secret rotation honors tokenVersion', () => {
    it('verifies a token signed with the previous secret and preserves its embedded version', () => {
      const previousSecret = 'previous-access-secret';
      const svc = makeService();
      // Token signed with the OLD secret (simulating a recent rotation).
      const legacyToken = jwt.sign({ id: 'user-789', tokenVersion: 5 }, previousSecret, { expiresIn: '1h' });

      // Current secret fails, previous-secret fallback succeeds and the version survives.
      const payload = svc.verifyToken(legacyToken, previousSecret);
      expect(payload.id).toBe('user-789');
      expect(payload.tokenVersion).toBe(5);

      // The kill-switch check runs on the recovered payload regardless of which
      // secret verified the signature.
      expect(isTokenVersionCurrent(payload.tokenVersion, 5)).toBe(true);
      expect(isTokenVersionCurrent(payload.tokenVersion, 6)).toBe(false);
    });
  });
});
