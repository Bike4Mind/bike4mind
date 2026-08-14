import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next?.() }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { signAccessToken: () => 'full-access' },
}));

const mockSetRefreshCookie = vi.fn();
vi.mock('@server/auth/refreshCookie', () => ({ setRefreshCookie: (...a: any[]) => mockSetRefreshCookie(...a) }));
vi.mock('@server/auth/sessionDevice', () => ({ buildSessionDevice: () => ({}) }));

const mockLogAuthAudit = vi.fn((..._args: any[]) => Promise.resolve());
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: any[]) => mockLogAuthAudit(...a) }));

const mockConsumeTrustedDevice = vi.fn();
vi.mock('@server/auth/trustedDevice', () => ({
  consumeTrustedDevice: (...a: any[]) => mockConsumeTrustedDevice(...a),
  trustedDevicesAllowed: () => Promise.resolve(settingsValues.allowTrustedDevices !== false),
}));

// Settings are read through getSettingsValue; drive both flags from one map.
const settingsValues: Record<string, unknown> = {};
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(() => Promise.resolve({})),
  getSettingsValue: (key: string) => settingsValues[key],
}));

const mockJwtVerify = vi.fn();
const mockJwtSign = vi.fn((..._args: any[]) => 'mfa-pending-token');
vi.mock('jsonwebtoken', () => ({
  default: { verify: (...a: any[]) => mockJwtVerify(...a), sign: (...a: any[]) => mockJwtSign(...a) },
}));

vi.mock('@server/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: vi.fn(() =>
    Promise.resolve({ matched: false, entitlements: new Set(), signupCredits: 0 })
  ),
}));

const mockFindByEmail = vi.fn();
const mockValidateNonce = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: vi.fn() },
  registrationInviteRepository: {},
  subscriberRepository: {},
  creditTransactionRepository: {},
  userRepository: { findByEmail: (...a: any[]) => mockFindByEmail(...a), count: vi.fn(), update: vi.fn() },
  pendingOtcTokenRepository: { validateAndRotateNonce: (...a: any[]) => mockValidateNonce(...a) },
  authSessionRepository: {},
}));

const mockUserHasMFA = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: {
    verifyPendingOTC: vi.fn(() => Promise.resolve(true)),
    registerViaOTC: vi.fn(),
  },
  creditService: { addCredits: vi.fn() },
  mfaService: { userHasMFAConfigured: (...a: any[]) => mockUserHasMFA(...a) },
  authSessionService: {
    issueSession: vi.fn().mockResolvedValue({ accessToken: 'full-access', refreshToken: 'full-refresh', sid: 'sid' }),
  },
}));

import handler from '@pages/api/otc/verify';

const EMAIL = 'someone@example.com';

function makeReqRes(cookie?: string) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).body = { email: EMAIL, code: '123456', pendingToken: 'pending-token' };
  (req as any).ip = '127.0.0.1';
  (req as any).socket = { remoteAddress: '127.0.0.1' };
  (req as any).headers = { 'user-agent': 'test', ...(cookie ? { cookie } : {}) };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  mockJwtVerify.mockReturnValue({
    email: EMAIL,
    otcHash: 'hash',
    attempts: 0,
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: 'jti-1',
  });
  return { req, res };
}

const LIVE_TRUST = { id: 'device-1', label: 'Chrome on macOS', expiresAt: new Date(Date.now() + 86_400_000) };

/**
 * The trust window only ever suppresses the SECOND factor. These cases pin the two
 * properties that make that safe: the emailed code is always still required, and a
 * trust can never stand in for MFA *enrollment*.
 */
describe('/api/otc/verify - trusted device', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(settingsValues)) delete settingsValues[key];
    mockValidateNonce.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue({ id: 'user-1', tokenVersion: 3, emailVerified: true });
    mockConsumeTrustedDevice.mockResolvedValue(null);
    mockUserHasMFA.mockReturnValue(true);
  });

  it('challenges for MFA when no trusted device is presented', async () => {
    const { req, res } = makeReqRes();

    await handler(req, res);

    const body = res._getJSONData();
    expect(body.mfaRequired).toBe(true);
    expect(body.refreshToken).toBeUndefined();
  });

  it('skips the MFA challenge and mints a full session for a live trusted device', async () => {
    mockConsumeTrustedDevice.mockResolvedValue(LIVE_TRUST);
    const { req, res } = makeReqRes('b4m_td=abc.def');

    await handler(req, res);

    const body = res._getJSONData();
    expect(body.mfaRequired).toBeUndefined();
    expect(body.accessToken).toBe('full-access');
    // The refresh token rides an HttpOnly cookie, never the response body.
    expect(body.refreshToken).toBeUndefined();
    expect(mockSetRefreshCookie).toHaveBeenCalledWith(expect.anything(), 'full-refresh');
    expect(mockConsumeTrustedDevice).toHaveBeenCalledWith(expect.anything(), 'user-1');
  });

  it('records the skip in the audit trail', async () => {
    mockConsumeTrustedDevice.mockResolvedValue(LIVE_TRUST);
    const { req, res } = makeReqRes('b4m_td=abc.def');

    await handler(req, res);

    const events = mockLogAuthAudit.mock.calls.map(([, payload]: any[]) => payload.event);
    expect(events).toContain('trusted_device_used');
  });

  it('ignores an existing trust the moment the admin switch is turned off', async () => {
    settingsValues.allowTrustedDevices = false;
    mockConsumeTrustedDevice.mockResolvedValue(LIVE_TRUST);
    const { req, res } = makeReqRes('b4m_td=abc.def');

    await handler(req, res);

    expect(res._getJSONData().mfaRequired).toBe(true);
    // Not even looked up - the switch short-circuits before the cookie is read.
    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
  });

  it('cannot stand in for MFA enrollment when the admin enforces MFA', async () => {
    settingsValues.enforceMFA = true;
    mockUserHasMFA.mockReturnValue(false);
    mockConsumeTrustedDevice.mockResolvedValue(LIVE_TRUST);
    const { req, res } = makeReqRes('b4m_td=abc.def');

    await handler(req, res);

    // Enrollment is still demanded; a remembered device does not buy a way around it.
    expect(res._getJSONData().mfaSetupRequired).toBe(true);
  });

  it('is never consulted for a user without MFA configured', async () => {
    mockUserHasMFA.mockReturnValue(false);
    const { req, res } = makeReqRes('b4m_td=abc.def');

    await handler(req, res);

    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
    expect(res._getJSONData().accessToken).toBe('full-access');
  });

  it('still requires a valid emailed code - a trusted device alone is not a credential', async () => {
    mockValidateNonce.mockResolvedValue(false); // replayed / bad pending token
    mockConsumeTrustedDevice.mockResolvedValue(LIVE_TRUST);
    const { req, res } = makeReqRes('b4m_td=abc.def');

    await expect(handler(req, res)).rejects.toThrow('Invalid code.');
    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
  });
});
