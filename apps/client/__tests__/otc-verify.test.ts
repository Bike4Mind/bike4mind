import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing the route handler.
const mockFindByEmail = vi.fn();
const mockUpdate = vi.fn();
const mockValidateAndRotateNonce = vi.fn();
const mockVerifyPendingOTC = vi.fn();
const mockRegisterViaOTC = vi.fn();
const mockUserHasMFA = vi.fn();
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

vi.mock('@bike4mind/common', () => ({
  AuthEvents: { LOGIN: 'login', REGISTER: 'register' },
  UnprocessableEntityError,
  HTTPError,
  InternalServerError,
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findByEmail: (...a: unknown[]) => mockFindByEmail(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
  pendingOtcTokenRepository: {
    validateAndRotateNonce: (...a: unknown[]) => mockValidateAndRotateNonce(...a),
  },
  adminSettingsRepository: {},
  registrationInviteRepository: {},
  subscriberRepository: {},
  creditTransactionRepository: {},
}));

vi.mock('@bike4mind/services', () => ({
  userService: {
    verifyPendingOTC: (...a: unknown[]) => mockVerifyPendingOTC(...a),
    registerViaOTC: (...a: unknown[]) => mockRegisterViaOTC(...a),
  },
  mfaService: { userHasMFAConfigured: (...a: unknown[]) => mockUserHasMFA(...a) },
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
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { createAccessToken: () => ({ accessToken: 'access', refreshToken: 'refresh' }) },
}));
vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
vi.mock('jsonwebtoken', () => ({
  default: { verify: (...a: unknown[]) => mockJwtVerify(...a), sign: (...a: unknown[]) => mockJwtSign(...a) },
}));

const validToken = (over: Record<string, unknown> = {}) => ({
  email: 'user@example.com',
  otcHash: '$2a$hash',
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
  };

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
    mockValidateAndRotateNonce.mockResolvedValue(true);
    mockUserHasMFA.mockReturnValue(false);
    mockRes = { json: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), setHeader: vi.fn() };
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

  it('throws a generic "Invalid code." (no existence read) for a stale/replayed nonce', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockValidateAndRotateNonce.mockResolvedValue(false);
    await expect(
      handler(makeReq({ email: 'user@example.com', code: '123456', pendingToken: 'tok' }), mockRes)
    ).rejects.toThrow('Invalid code.');
    expect(mockFindByEmail).not.toHaveBeenCalled();
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
    expect(body).toMatchObject({ id: 'u1', username: 'bob', accessToken: 'access', refreshToken: 'refresh' });
    // Serialized via toJSON - no raw Mongoose internals / select:false fields.
    expect(body.password).toBeUndefined();
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
    expect(body.accessToken).toBe('mfa-access-token');
    // Critical: no refreshToken - a client can't exchange it for a full session
    // by POSTing to /api/auth/refreshToken before completing MFA.
    expect(body.refreshToken).toBeUndefined();
  });

  it('mfaSetupRequired response has NO refreshToken', async () => {
    mockJwtVerify.mockReturnValue(validToken());
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockUserHasMFA.mockReturnValue(false);
    // enforceMFA = true for this call only - vi.clearAllMocks() clears calls, not
    // implementations, so a non-Once override here would leak into every later test.
    const { getSettingsValue } = await import('@bike4mind/utils');
    vi.mocked(getSettingsValue).mockReturnValueOnce(true);
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
    const { logEvent } = await import('@server/utils/analyticsLog');
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
    const { logEvent } = await import('@server/utils/analyticsLog');
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
