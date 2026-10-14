import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks, type RequestMethod } from 'node-mocks-http';

/**
 * Every route that requires recent verification, run through its real middleware chain (with the
 * real step-up gate and the real error handler) so the wire response is what is asserted.
 */

type Middleware = (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown;
type Route = ((req: unknown, res: unknown) => Promise<void>) & { options: { auth?: unknown } };

const h = vi.hoisted(() => ({
  findBySid: vi.fn(),
  setupMFA: vi.fn(),
  disableMFA: vi.fn(),
  regenerateBackupCodes: vi.fn(),
  startPasskeyRegistration: vi.fn(),
  removePasskey: vi.fn(),
  requestEmailChange: vi.fn(),
  passThrough: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  user: {
    id: 'user-1',
    email: 'owner@example.com',
    mfa: { totpEnabled: true } as { totpEnabled: boolean } | undefined,
  },
}));

vi.mock('@server/middlewares/baseApi', async () => {
  const { default: errorHandler } = await vi.importActual<typeof import('@server/middlewares/errorHandler')>(
    '@server/middlewares/errorHandler'
  );
  return {
    baseApi: (options: Record<string, unknown> = {}) => {
      const middlewares: Middleware[] = [];
      const finish = (...handlers: Middleware[]) => {
        const chain = [...middlewares, ...handlers];
        const route = async (req: unknown, res: unknown) => {
          try {
            for (const fn of chain) {
              let advanced = false;
              let failure: unknown;
              await fn(req, res, error => {
                advanced = true;
                failure = error;
              });
              if (failure) throw failure;
              if (!advanced) return;
            }
          } catch (error) {
            errorHandler(error, req as never, res as never);
          }
        };
        return Object.assign(route, { options });
      };
      const chain: Record<string, unknown> = {
        use: (mw: Middleware) => (middlewares.push(mw), chain),
        get: finish,
        post: finish,
        put: finish,
        delete: finish,
      };
      return chain;
    },
  };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Middleware) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: h.passThrough }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: h.passThrough }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
vi.mock('@server/utils/auditLog', () => ({ logAuditEvent: vi.fn(), EmailAuditEvents: {} }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('@server/auth/trustedDevice', () => ({ clearTrustedDeviceCookie: vi.fn() }));
vi.mock('@server/auth/issueSession', () => ({ issueBrowserSession: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  authSessionRepository: { findBySid: h.findBySid },
  userRepository: {
    findById: async () => h.user,
    findByIdWithMfaSecrets: async () => h.user,
  },
  adminSettingsRepository: { findBySettingName: async () => null },
  passkeyCredentialRepository: { remove: h.removePasskey, removeAllForUser: async () => 0, countByUser: async () => 0 },
  passkeyChallengeRepository: {},
  trustedDeviceRepository: { revokeAllForUser: async () => 0 },
  withTransaction: (fn: () => unknown) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: {
    setupMFA: h.setupMFA,
    disableMFA: h.disableMFA,
    userCanDisableMFA: () => true,
    regenerateBackupCodes: h.regenerateBackupCodes,
    startPasskeyRegistration: h.startPasskeyRegistration,
    resolvePasskeyRelyingParty: () => ({ rpID: 'app.example.com', rpName: 'Example', origin: 'https://x' }),
    userHasMFAConfigured: () => true,
  },
  userService: { revokeUserSessions: vi.fn(), requestEmailChange: h.requestEmailChange },
}));

import setupRoute from '@pages/api/auth/mfa/setup';
import verifySetupRoute from '@pages/api/auth/mfa/verify-setup';
import cancelSetupRoute from '@pages/api/auth/mfa/cancel-setup';
import disableRoute from '@pages/api/auth/mfa/disable';
import regenerateRoute from '@pages/api/auth/mfa/regenerate-backup-codes';
import registerOptionsRoute from '@pages/api/auth/mfa/passkey/register-options';
import deletePasskeyRoute from '@pages/api/auth/mfa/passkey/[id]';
import changeEmailRoute from '@pages/api/email/change';

const USER = h.user;

const call = async (
  route: unknown,
  { method = 'POST', body = {}, query = {}, user = { ...USER, sid: 'sid-1' } as object } = {}
) => {
  const { req, res } = createMocks({ method: method as RequestMethod, body, query, url: '/api/test' });
  Object.assign(req, { user, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  await (route as Route)(req, res);
  return res;
};

const stepUpAt = (at: Date | null) =>
  h.findBySid.mockResolvedValue({
    sid: 'sid-1',
    userId: 'user-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    stepUpAt: at,
  });

const GATED: Array<{
  name: string;
  route: unknown;
  method?: string;
  body?: object;
  query?: object;
  effect: ReturnType<typeof vi.fn>;
  notEnrolled?: boolean;
}> = [
  { name: 'POST /api/auth/mfa/setup', route: setupRoute, effect: h.setupMFA, notEnrolled: true },
  { name: 'POST /api/auth/mfa/disable', route: disableRoute, effect: h.disableMFA },
  { name: 'POST /api/auth/mfa/regenerate-backup-codes', route: regenerateRoute, effect: h.regenerateBackupCodes },
  {
    name: 'POST /api/auth/mfa/passkey/register-options',
    route: registerOptionsRoute,
    effect: h.startPasskeyRegistration,
  },
  {
    name: 'DELETE /api/auth/mfa/passkey/[id]',
    route: deletePasskeyRoute,
    method: 'DELETE',
    query: { id: 'pk-1' },
    effect: h.removePasskey,
  },
  {
    name: 'POST /api/email/change',
    route: changeEmailRoute,
    body: { newEmail: 'new@example.com' },
    effect: h.requestEmailChange,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.user.mfa = { totpEnabled: true };
  stepUpAt(null);
  h.setupMFA.mockResolvedValue({ secret: 's' });
  h.disableMFA.mockResolvedValue({ disabled: true });
  h.regenerateBackupCodes.mockResolvedValue({ backupCodes: ['a'] });
  h.startPasskeyRegistration.mockResolvedValue({ challenge: 'c' });
  h.removePasskey.mockResolvedValue(true);
  h.requestEmailChange.mockResolvedValue(undefined);
});

it.each([
  setupRoute,
  verifySetupRoute,
  cancelSetupRoute,
  disableRoute,
  regenerateRoute,
  registerOptionsRoute,
  deletePasskeyRoute,
  changeEmailRoute,
])('route %# accepts a browser session only (jwtOnly)', route => {
  expect((route as Route).options.auth).toBe('jwtOnly');
});

describe.each(GATED)('$name', ({ route, method, body, query, effect, notEnrolled }) => {
  beforeEach(() => {
    if (notEnrolled) h.user.mfa = undefined;
  });

  it('answers 403 step_up_required without recent verification', async () => {
    const res = await call(route, { method, body, query });
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ error: 'Recent verification required', code: 'step_up_required' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('answers 403 once the verification is older than the window', async () => {
    stepUpAt(new Date(Date.now() - 6 * 60 * 1000));
    expect((await call(route, { method, body, query }))._getStatusCode()).toBe(403);
    expect(effect).not.toHaveBeenCalled();
  });

  it('proceeds with recent verification', async () => {
    stepUpAt(new Date(Date.now() - 60 * 1000));
    const res = await call(route, { method, body, query });
    expect(res._getStatusCode()).toBe(200);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/mfa/setup during sign-in enrollment', () => {
  it('skips step-up for an mfaPending token (which carries no session id)', async () => {
    h.user.mfa = undefined;
    const res = await call(setupRoute, { user: { id: USER.id, mfaPending: true } });
    expect(res._getStatusCode()).toBe(200);
    expect(h.findBySid).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/mfa/passkey/register-options', () => {
  it('no longer needs an authenticator code in the body', async () => {
    stepUpAt(new Date());
    const res = await call(registerOptionsRoute, { body: {} });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ challenge: 'c' });
  });
});
