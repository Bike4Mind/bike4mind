import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import bcrypt from 'bcryptjs';

// Mock all external dependencies before importing the route handler.
const mockFindByEmail = vi.fn();
const mockUpdate = vi.fn();
const mockValidateAndRotateNonce = vi.fn();
const mockConsumeOtherCodes = vi.fn();
const mockVerifyPendingOTC = vi.fn();
const mockRegisterViaOTC = vi.fn();
const mockUserHasMFA = vi.fn();
const mockCountPasskeys = vi.fn();
const mockJwtVerify = vi.fn();
const mockJwtSign = vi.fn();

class UnprocessableEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnprocessableEntityError';
  }
}

// Mirrors the real class shape (statusCode + additionalInfo) - the handler's registration
// catch does `instanceof HTTPError` and mutates `additionalInfo`, so the mock must support both.
class HTTPError extends Error {
  constructor(
    public statusCode: number,
    message?: string,
    public additionalInfo?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HTTPError';
  }
}

class InternalServerError extends HTTPError {
  constructor(message?: string, additionalInfo?: Record<string, unknown>) {
    super(500, message, additionalInfo);
    this.name = 'InternalServerError';
  }
}

vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  return {
    ...actual,
    AuthEvents: { LOGIN: 'login', REGISTER: 'register' },
    UnprocessableEntityError,
    HTTPError,
    InternalServerError,
    // Used by entitlements/registry.ts (reached transitively via the verify handler).
    parseInternalStaffDomains: (raw?: string) => [
      ...new Set(
        (raw ?? '')
          .split(',')
          .map(d => d.trim().toLowerCase())
          .filter(Boolean)
      ),
    ],
    // Pure serializer; mirror its toJSON normalization (secret-stripping shape is covered
    // by toSafeUser.test.ts). These tests are about enumeration resistance, not the shape.
    redactUserSecretsForSelf: (user: { toJSON?: () => unknown } | null | undefined) =>
      user && typeof user.toJSON === 'function' ? user.toJSON() : user,
  };
});

// Pulled in transitively by signupDomainGrant; the partner mock never matches a rule with a subscription.
vi.mock('@server/subscriptions/grantIndividualAdminSubscription', () => ({
  grantIndividualAdminSubscription: vi.fn(),
}));

vi.mock('@server/auth/networkMeta', () => ({
  recordSignupNetwork: vi.fn(),
  recordLoginEvent: vi.fn(),
  readNetworkMeta: vi.fn(() => ({})),
}));
// The per-network signup caps are covered in signupNetworkLimits.test.ts and pages/api/otc/__tests__/verify.test.ts.
vi.mock('@server/auth/signupNetworkLimits', () => ({
  assertSignupNetworkWithinLimits: vi.fn().mockResolvedValue(undefined),
  createSignupRiskCollector: vi.fn(() => vi.fn()),
}));
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh: vi.fn(async () => 'queued') }));
vi.mock('@server/auth/signupRiskScore', () => ({ refreshSignupRiskScore: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: vi.fn(async () => ({ success: true, count: 1, expiresAt: new Date() })),
    tryAddWithinLimitFixedWindow: vi.fn(async () => ({ success: true, count: 0, expiresAt: new Date() })),
  },
  userRepository: {
    findByEmail: (...a: unknown[]) => mockFindByEmail(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
  pendingOtcTokenRepository: {
    validateAndRotateNonce: (...a: unknown[]) => mockValidateAndRotateNonce(...a),
    consumeOtherCodes: (...a: unknown[]) => mockConsumeOtherCodes(...a),
  },
  adminSettingsRepository: { findBySettingName: vi.fn(async () => null) },
  partnerSignupRuleRepository: { findActiveRules: vi.fn(async () => []) },
  registrationInviteRepository: {},
  subscriberRepository: {},
  creditTransactionRepository: {},
  creditLotRepository: {},
  authSessionRepository: {},
  oauthClientRepository: {},
  passkeyCredentialRepository: { countByUser: (...a: unknown[]) => mockCountPasskeys(...a) },
}));

vi.mock('@bike4mind/services', () => ({
  userService: {
    verifyPendingOTC: (...a: unknown[]) => mockVerifyPendingOTC(...a),
    registerViaOTC: (...a: unknown[]) => mockRegisterViaOTC(...a),
  },
  mfaService: { userHasMFAConfigured: (...a: unknown[]) => mockUserHasMFA(...a) },
  authSessionService: {
    issueSession: vi.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh', sid: 'sid' }),
  },
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn().mockReturnValue(false), // enforceMFA = false
}));

// baseApi passes the final handler straight through (skips middleware).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => () => {} }));
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { createAccessToken: () => ({ accessToken: 'access', refreshToken: 'refresh' }) },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
  isE2EEnabled: () => false,
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
const mockEmitSignup = vi.fn().mockResolvedValue([]);
vi.mock('@server/analytics/signupEvents', () => ({
  emitSignupForSourceProducts: (...a: unknown[]) => mockEmitSignup(...a),
  stableEventId: (...parts: string[]) => parts.join(':'),
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
vi.mock('jsonwebtoken', () => ({
  default: { verify: (...a: unknown[]) => mockJwtVerify(...a), sign: (...a: unknown[]) => mockJwtSign(...a) },
}));

const validToken = (over: Record<string, unknown> = {}) => ({
  email: 'user@example.com',
  attempts: 0,
  exp: Math.floor(Date.now() / 1000) + 600,
  jti: 'nonce-1',
  ...over,
});

describe('/api/otc/verify — enumeration resistance', () => {
  let handler: (...a: unknown[]) => unknown;
  let mockRes: {
    json: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
    getHeader: ReturnType<typeof vi.fn>;
  };
  // Minimal Set-Cookie accumulator so setRefreshCookie's get/append/set cycle works on the stub.
  let sentCookies: string[];

  const makeReq = (body: Record<string, unknown>) => ({
    body,
    headers: {},
    socket: {},
    ip: '127.0.0.1',
    logger: { error: vi.fn() },
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockJwtSign.mockReturnValue('reissued-token');
    mockValidateAndRotateNonce.mockResolvedValue({ otcHash: '$2a$hash', riskSignals: [] });
    mockUserHasMFA.mockReturnValue(false);
    mockCountPasskeys.mockResolvedValue(0);
    sentCookies = [];
    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn((name: string, value: string | string[]) => {
        if (name === 'Set-Cookie') sentCookies = Array.isArray(value) ? value.map(String) : [String(value)];
      }),
      getHeader: vi.fn((name: string) => (name === 'Set-Cookie' && sentCookies.length ? sentCookies : undefined)),
    };
    const mod = await import('@pages/api/otc/verify');
    handler = mod.default;
  });

  // The core invariant: NOTHING reads account existence before a correct code, so
  // no pre-success path can differ between an existing and a non-existent email.

  it('does NOT consult account existence on a wrong code', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(false);

    await handler(makeReq({ email: 'user@example.com', code: '000000', pendingToken: 'tok' }), mockRes);

    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(422);
    const body = mockRes.json.mock.calls[0][0];
    expect(body.error).toMatch(/Invalid code\. 4 attempts remaining\./);
    expect(body.pendingToken).toBe('reissued-token');
  });

  it('leaves the other live codes for the address alone on a wrong code', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(false);

    await handler(makeReq({ email: 'user@example.com', code: '000000', pendingToken: 'tok' }), mockRes);

    expect(mockConsumeOtherCodes).not.toHaveBeenCalled();
  });

  it('retires every other live code for the address once a code is proven', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue({
      id: 'u1',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tokenVersion: 0,
      toJSON: () => ({ id: 'u1', username: 'bob' }),
    });

    await handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes);

    const [, , rotatedNonce] = mockValidateAndRotateNonce.mock.calls[0];
    expect(mockConsumeOtherCodes).toHaveBeenCalledWith('user@example.com', rotatedNonce);
    expect(mockRes.status).toHaveBeenCalledWith(200);
  });

  it('throws a generic "Invalid code." (no existence read) for a missing token', async () => {
    await expect(handler(makeReq({ email: 'user@example.com', code: '123456' }), mockRes)).rejects.toThrow(
      'Invalid code.'
    );
    expect(mockFindByEmail).not.toHaveBeenCalled();
  });

  it('throws a generic "Invalid code." (no existence read) for a malformed token', async () => {
    mockJwtVerify.mockImplementation(() => {
      throw new Error('bad jwt');
    });
    await expect(
      handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes)
    ).rejects.toThrow('Invalid code.');
    expect(mockFindByEmail).not.toHaveBeenCalled();
  });

  it('verify checks the code against the server-side record', async () => {
    mockJwtVerify.mockReturnValue(validToken({ otcHash: 'token-hash' }));
    mockValidateAndRotateNonce.mockResolvedValue({ otcHash: 'server-hash', riskSignals: [] });
    mockVerifyPendingOTC.mockResolvedValue(false);

    await handler(makeReq({ email: 'user@example.com', code: '00000000', pendingToken: 'tok' }), mockRes);

    expect(mockValidateAndRotateNonce).toHaveBeenCalledWith('user@example.com', 'nonce-1', expect.any(String));
    expect(mockVerifyPendingOTC).toHaveBeenCalledWith('00000000', 'server-hash');
  });

  it('a token without a server-side record is rejected', async () => {
    // A token minted with a code hash inside it, before the hash moved to the server record.
    mockJwtVerify.mockReturnValue(validToken({ otcHash: await bcrypt.hash('12345678', 4) }));
    mockValidateAndRotateNonce.mockResolvedValue(null);
    mockVerifyPendingOTC.mockImplementation((code: string, hash: string) => bcrypt.compare(code, hash));

    await expect(
      handler(makeReq({ email: 'user@example.com', code: '12345678', pendingToken: 'tok' }), mockRes)
    ).rejects.toThrow('Invalid code.');
    expect(mockVerifyPendingOTC).not.toHaveBeenCalled();
    expect(mockFindByEmail).not.toHaveBeenCalled();
  });

  describe.each([true, null, undefined])('reissued token payload shape (%s)', challengeVerified => {
    const signedPayloads = () => mockJwtSign.mock.calls.map(([payload]) => payload as Record<string, unknown>);
    const expectPayloadShape = () => {
      expect(signedPayloads().length).toBeGreaterThan(0);
      for (const payload of signedPayloads()) {
        expect(Object.keys(payload).sort()).toEqual(['attempts', 'challengeVerified', 'email', 'jti']);
        expect(payload.challengeVerified).toBe(challengeVerified === true ? true : null);
      }
    };

    beforeEach(() => {
      mockJwtVerify.mockReturnValue(validToken({ otcHash: 'token-hash', challengeVerified }));
      mockFindByEmail.mockResolvedValue(null);
    });

    it('on a wrong code', async () => {
      mockVerifyPendingOTC.mockResolvedValue(false);
      await handler(makeReq({ email: 'user@example.com', code: '00000000', pendingToken: 'tok' }), mockRes);
      expectPayloadShape();
    });

    it('when registration is required', async () => {
      mockVerifyPendingOTC.mockResolvedValue(true);
      await handler(makeReq({ email: 'user@example.com', code: '12345678', pendingToken: 'tok' }), mockRes);
      expect(mockRes.json.mock.calls[0][0].registrationRequired).toBe(true);
      expectPayloadShape();
    });

    it('when registration fails', async () => {
      mockVerifyPendingOTC.mockResolvedValue(true);
      mockRegisterViaOTC.mockRejectedValue(new HTTPError(400, 'This username is already registered'));
      await expect(
        handler(
          makeReq({ email: 'user@example.com', code: '12345678', username: 'taken', pendingToken: 'tok' }),
          mockRes
        )
      ).rejects.toThrow();
      expectPayloadShape();
    });
  });

  it('throws a generic "Invalid code." (no existence read) for a stale/replayed nonce', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockValidateAndRotateNonce.mockResolvedValue(null);
    await expect(
      handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes)
    ).rejects.toThrow('Invalid code.');
    expect(mockFindByEmail).not.toHaveBeenCalled();
  });

  // `signup` means a new account, and this suite owns the returning-user path. The emit sits
  // after the existingUser branch returns, so the guard is structural - move it, or add a
  // second call site on the login path, and every returning login would report itself as a
  // signup to whichever product its cookies name. Consent is granted here on purpose: the gate
  // is not what should be stopping this, the branch is.
  it('does not report a signup when the code proves a returning user', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue({
      id: 'u1',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tokenVersion: 0,
      toJSON: () => ({ id: 'u1', username: 'bob' }),
    });
    const req = makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' });
    (req as any).headers = {
      ...((req as any).headers ?? {}),
      cookie: `b4m-first-touch=${encodeURIComponent(JSON.stringify({ source: 'widgets' }))}; b4m_consent=granted`,
    };

    await handler(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockEmitSignup).not.toHaveBeenCalled();
  });

  it('logs in an existing user on a correct code (existence checked only AFTER verification)', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue({
      id: 'u1',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tokenVersion: 0,
      toJSON: () => ({ id: 'u1', username: 'bob' }),
    });

    await handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes);

    expect(mockVerifyPendingOTC).toHaveBeenCalled();
    expect(mockFindByEmail).toHaveBeenCalledWith('user@example.com');
    expect(mockRes.status).toHaveBeenCalledWith(200);
    const body = mockRes.json.mock.calls[0][0];
    expect(body).toMatchObject({ id: 'u1', username: 'bob', accessToken: 'access' });
    // The refresh token is delivered as an HttpOnly cookie, never in the JSON body.
    expect(body.refreshToken).toBeUndefined();
    expect(sentCookies.join(';')).toContain('b4m_rt=refresh');
    // Serialized via toJSON - no raw Mongoose internals / select:false fields.
    expect(body.password).toBeUndefined();
  });

  // Rollout: a 6-digit code issued just before 8-digit codes shipped must still work while its token
  // is live, and only by matching the hash stored for that token's nonce.
  describe('legacy 6-digit codes', () => {
    beforeEach(() => {
      // What verifyPendingOTC does (see verifyOTC.test.ts): a bcrypt compare with no length check.
      mockVerifyPendingOTC.mockImplementation((code: string, hash: string) => bcrypt.compare(code, hash));
      mockFindByEmail.mockResolvedValue({
        id: 'u1',
        isSystem: false,
        isBanned: false,
        emailVerified: true,
        tokenVersion: 0,
        toJSON: () => ({ id: 'u1', username: 'bob' }),
      });
    });

    it('signs in with a 6-digit code that matches a live token', async () => {
      mockJwtVerify.mockReturnValue(validToken());
      mockValidateAndRotateNonce.mockResolvedValue({ otcHash: await bcrypt.hash('012345', 4), riskSignals: [] });

      await handler(makeReq({ email: 'user@example.com', code: '012345', pendingToken: 'tok' }), mockRes);

      expect(mockValidateAndRotateNonce).toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('rejects a 6-digit code against an 8-digit token as a wrong guess', async () => {
      mockJwtVerify.mockReturnValue(validToken());
      mockValidateAndRotateNonce.mockResolvedValue({ otcHash: await bcrypt.hash('01234567', 4), riskSignals: [] });

      await handler(makeReq({ email: 'user@example.com', code: '012345', pendingToken: 'tok' }), mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(422);
      expect(mockFindByEmail).not.toHaveBeenCalled();
    });

    it('rejects a 6-digit code whose token nonce is no longer live', async () => {
      mockJwtVerify.mockReturnValue(validToken());
      mockValidateAndRotateNonce.mockResolvedValue(null);

      await expect(
        handler(makeReq({ email: 'user@example.com', code: '012345', pendingToken: 'tok' }), mockRes)
      ).rejects.toThrow('Invalid code.');
      expect(mockFindByEmail).not.toHaveBeenCalled();
    });
  });

  it('registers a new user on a correct code with a username', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    mockRegisterViaOTC.mockResolvedValue({ id: 'new1', tokenVersion: 0 });

    await handler(
      makeReq({ email: 'user@example.com', code: '123456', username: 'newbie', pendingToken: 'tok' }),
      mockRes
    );

    expect(mockRegisterViaOTC).toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(200);
    const body = mockRes.json.mock.calls[0][0];
    expect(body).toMatchObject({ user: { id: 'new1' }, accessToken: 'access' });
  });

  it('correct code + no account + NO username → registrationRequired with a re-issued token (no register yet)', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);

    await handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes);

    // Must NOT create the account until a username is supplied...
    expect(mockRegisterViaOTC).not.toHaveBeenCalled();
    // ...and must signal the client to collect one, handing back a fresh token to continue with.
    expect(mockRes.status).toHaveBeenCalledWith(200);
    const body = mockRes.json.mock.calls[0][0];
    expect(body.registrationRequired).toBe(true);
    expect(body.registrationAllowed).toBe(false);
    expect(body.email).toBe('user@example.com');
    expect(typeof body.pendingToken).toBe('string');
    // Enumeration-safe: no refresh token / session is issued at this stage.
    expect(body.refreshToken).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
  });

  it('mfaRequired response has NO refreshToken — prevents MFA bypass via /api/auth/refreshToken', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockUserHasMFA.mockReturnValue(true);
    mockJwtSign.mockReturnValue('mfa-access-token');
    mockFindByEmail.mockResolvedValue({
      id: 'u1',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tokenVersion: 0,
      mfa: { totpEnabled: true },
      toJSON: () => ({ id: 'u1' }),
    });

    await handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    const body = mockRes.json.mock.calls[0][0];
    expect(body.mfaRequired).toBe(true);
    expect(body.passkeyAvailable).toBe(false);
    expect(body.accessToken).toBe('mfa-access-token');
    // Critical: no refreshToken - a client can't exchange it for a full session
    // by POSTing to /api/auth/refreshToken before completing MFA.
    expect(body.refreshToken).toBeUndefined();
  });

  it('flags passkeyAvailable on the MFA challenge when the user has enrolled a passkey', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockUserHasMFA.mockReturnValue(true);
    mockCountPasskeys.mockResolvedValue(2);
    mockFindByEmail.mockResolvedValue({
      id: 'u1',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tokenVersion: 0,
      mfa: { totpEnabled: true },
      toJSON: () => ({ id: 'u1' }),
    });

    await handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes);

    expect(mockCountPasskeys).toHaveBeenCalledWith('u1');
    expect(mockRes.json.mock.calls[0][0]).toMatchObject({ mfaRequired: true, passkeyAvailable: true });
  });

  it('mfaSetupRequired response has NO refreshToken', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockUserHasMFA.mockReturnValue(false);
    // enforceMFA = true for this call only. Keyed on the setting name because the OTC limit
    // settings are read first; vi.clearAllMocks() keeps implementations, so restore it after.
    const { getSettingsValue } = await import('@bike4mind/utils');
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'enforceMFA');
    onTestFinished(() => {
      vi.mocked(getSettingsValue).mockReturnValue(false);
    });
    mockJwtSign.mockReturnValue('mfa-setup-access-token');
    mockFindByEmail.mockResolvedValue({
      id: 'u2',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tokenVersion: 0,
      mfa: null,
      toJSON: () => ({ id: 'u2' }),
    });

    await handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    const body = mockRes.json.mock.calls[0][0];
    expect(body.mfaSetupRequired).toBe(true);
    expect(body.refreshToken).toBeUndefined();
  });

  // Registration failures happen AFTER the single-use nonce was rotated, so the
  // handler must hand back a re-issued token carrying the rotated nonce - otherwise every
  // retry fails the nonce check as a generic "Invalid code." and the user is stranded.

  it('re-issues a pending token (rotated nonce, attempts+1) when registration fails post-rotation', async () => {
    mockJwtVerify.mockReturnValue(validToken({ attempts: 1 }));
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    mockRegisterViaOTC.mockRejectedValue(new HTTPError(400, 'This username is already registered'));

    await expect(
      handler(makeReq({ email: 'user@example.com', code: '123456', username: 'taken', pendingToken: 'tok' }), mockRes)
    ).rejects.toMatchObject({
      message: 'This username is already registered',
      additionalInfo: { pendingToken: 'reissued-token' },
    });

    // The re-issued token must carry the nonce the DB was just rotated TO (or the retry fails
    // the nonce check), an INCREMENTED attempt count (username collisions are attacker-varying
    // input - an uncapped re-issue would be a username-enumeration loop), and NO exp in the
    // payload (jwt.sign throws when both payload.exp and options.expiresIn are set).
    const rotatedToNonce = mockValidateAndRotateNonce.mock.calls[0][2];
    const [payload] = mockJwtSign.mock.calls[0];
    expect(payload).toMatchObject({ email: 'user@example.com', jti: rotatedToNonce, attempts: 2 });
    expect(payload).not.toHaveProperty('exp');
  });

  it('re-issues on a NON-HTTP registration failure too, wrapped as a generic 500', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    mockRegisterViaOTC.mockRejectedValue(new Error('connection reset by mongo'));

    const req = makeReq({ email: 'user@example.com', code: '123456', username: 'newbie', pendingToken: 'tok' });
    // Generic message only - the raw DB error must not reach the client - but the re-issued
    // token still must, or a transient server fault strands the user exactly like the bug.
    await expect(handler(req, mockRes)).rejects.toMatchObject({
      name: 'InternalServerError',
      message: 'Registration failed. Please try again.',
      additionalInfo: { pendingToken: 'reissued-token' },
    });
    // The real cause is preserved in the server log.
    expect(req.logger.error).toHaveBeenCalled();
  });

  // Post-rotation, the presented token can never validate again - so once the code is
  // proven, best-effort bookkeeping (analytics, emailVerified, device history) must never
  // 500 the response, or the user is stranded on a SUCCESS.

  it('still logs in when the analytics write fails (best-effort, post-rotation)', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    const { logEvent } = await import('@bike4mind/server-utils/utils/analyticsLog');
    vi.mocked(logEvent).mockRejectedValueOnce(new Error('analytics db down'));
    mockFindByEmail.mockResolvedValue({
      id: 'u1',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tokenVersion: 0,
      toJSON: () => ({ id: 'u1' }),
    });

    const req = makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' });
    await handler(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json.mock.calls[0][0]).toMatchObject({ id: 'u1', accessToken: 'access' });
    expect(req.logger.error).toHaveBeenCalled();
  });

  it('still logs in when the emailVerified bookkeeping write fails', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockUpdate.mockRejectedValueOnce(new Error('write timeout'));
    mockFindByEmail.mockResolvedValue({
      id: 'u1',
      isSystem: false,
      isBanned: false,
      emailVerified: false,
      tokenVersion: 0,
      toJSON: () => ({ id: 'u1' }),
    });

    const req = makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' });
    await handler(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json.mock.calls[0][0]).toMatchObject({ id: 'u1', accessToken: 'access' });
  });

  it('still completes a registration when the analytics write fails', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    mockRegisterViaOTC.mockResolvedValue({ id: 'new1', tokenVersion: 0 });
    const { logEvent } = await import('@bike4mind/server-utils/utils/analyticsLog');
    vi.mocked(logEvent).mockRejectedValueOnce(new Error('analytics db down'));

    const req = makeReq({ email: 'user@example.com', code: '123456', username: 'newbie', pendingToken: 'tok' });
    await handler(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json.mock.calls[0][0]).toMatchObject({ user: { id: 'new1' }, accessToken: 'access' });
  });

  it('rejects a banned account only after the code is verified', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue({ id: 'u2', isSystem: false, isBanned: true, toJSON: () => ({}) });

    await handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(403);
  });
});
