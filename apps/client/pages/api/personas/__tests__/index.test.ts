import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/personas mints test personas for QA bots with the per-stage PERSONA_MINT_KEY.
 * Every refusal here is a security property: no key = no endpoint, only the exact key works, the
 * body cannot pick a username, email, role, flag or credits, and the caps hold.
 */

const KEY = 'p'.repeat(40);

const h = vi.hoisted(() => ({
  secret: { value: '' } as { value: string } | undefined,
  production: false,
  settings: {} as Record<string, unknown>,
  mintedLast24h: 0,
  live: 0,
  createUser: vi.fn(),
  recordAdminAction: vi.fn(),
  issueSessionForRequest: vi.fn(),
  disableExpiredPersonas: vi.fn(),
  reserve: vi.fn(),
  domainGrants: new Set<string>(),
  partnerMatch: false as boolean | 'throws',
  baseApiOptions: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions.push(options);
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isProduction: () => h.production }));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@bike4mind/server-utils/lib/entitlements/registry', () => ({
  entitlementsForEmail: (email: string) =>
    h.domainGrants.has(email.slice(email.lastIndexOf('@') + 1)) ? new Set(['example:pro']) : new Set(),
}));
vi.mock('@bike4mind/server-utils/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: () =>
    h.partnerMatch === 'throws' ? Promise.reject(new Error('db down')) : Promise.resolve({ matched: h.partnerMatch }),
}));
vi.mock('@server/auth/issueSession', () => ({ issueSessionForRequest: h.issueSessionForRequest }));
vi.mock('@server/auth/tokenGenerator', () => ({ ACCESS_TOKEN_TTL_SECONDS: 1800 }));
vi.mock('sst', () => ({
  Resource: {
    get PERSONA_MINT_KEY() {
      return h.secret;
    },
  },
}));
vi.mock('@bike4mind/database', () => ({
  User: {
    countDocuments: () => Promise.resolve(h.live),
    find: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
  },
  adminAuditLogRepository: { countActionsSince: () => Promise.resolve(h.mintedLast24h) },
  adminSettingsRepository: {},
  authSessionRepository: {},
  realtimeConnectionRepository: {},
  userRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.reserve },
  withTransaction: (fn: () => unknown) => fn(),
  isTransientTransactionError: () => false,
}));
vi.mock('@bike4mind/services', () => ({
  adminAuditService: { recordAdminAction: h.recordAdminAction },
  authSessionService: { PERSONA_SESSION_IDLE_TTL_MS: 24 * 60 * 60 * 1000 },
  userService: { createUser: h.createUser, revokeUserSessions: vi.fn() },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: () => Promise.resolve({}),
  getSettingsValue: (name: string, _map: unknown, fallback: unknown) =>
    name in h.settings ? h.settings[name] : fallback,
}));
vi.mock('@server/personas/personaAccounts', async () => {
  const actual = await vi.importActual<typeof import('@server/personas/personaAccounts')>(
    '@server/personas/personaAccounts'
  );
  return { ...actual, disableExpiredPersonas: h.disableExpiredPersonas };
});

import handler from '../index';

const makeReq = (
  body: unknown = { name: 'alpha' },
  headers: Record<string, string> = { 'x-persona-mint-key': KEY }
) => ({
  method: 'POST',
  url: '/api/personas',
  query: {},
  body,
  headers,
  logger: { error: vi.fn(), log: vi.fn(), info: vi.fn(), warn: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};

const post = async (...args: Parameters<typeof makeReq>) => {
  const r = makeRes();
  await handler(makeReq(...args) as never, r.res);
  return r;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.secret = { value: KEY };
  h.production = false;
  h.settings = { PersonaMintEnabled: true };
  h.mintedLast24h = 0;
  h.live = 0;
  h.domainGrants = new Set();
  h.partnerMatch = false;
  h.reserve.mockResolvedValue({ success: true, expiresAt: new Date() });
  delete process.env.PERSONA_MINT_KEY;
  h.disableExpiredPersonas.mockResolvedValue({ disabled: 0 });
  h.createUser.mockImplementation(async (params: { username: string; email: string }) => ({
    id: '64b000000000000000000001',
    username: params.username,
    email: params.email,
    tokenVersion: 0,
  }));
  h.recordAdminAction.mockResolvedValue({});
  h.issueSessionForRequest.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', sid: 's1' });
});

describe('POST /api/personas', () => {
  describe('auth', () => {
    it.each([
      ['unset', undefined],
      ['the placeholder', { value: 'not-configured' }],
    ])('answers 404 when the stage secret is %s, so the endpoint does not exist', async (_label, secret) => {
      h.secret = secret;
      const { status, json } = await post();
      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Not found', code: 'persona_endpoint_off' });
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('answers 404 while PersonaMintEnabled is off, even with the right key', async () => {
      h.settings = {};
      const { status, json } = await post();
      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Not found', code: 'persona_endpoint_off' });
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('serves POST only, so any other verb is a 405 ahead of the DB connect', () => {
      expect(h.baseApiOptions[0]).toEqual(expect.objectContaining({ auth: false, allowedMethods: ['POST'] }));
    });

    it('refuses a request without the key header', async () => {
      const { status } = await post({ name: 'alpha' }, {});
      expect(status).toHaveBeenCalledWith(401);
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('refuses a wrong key', async () => {
      const { status } = await post({ name: 'alpha' }, { 'x-persona-mint-key': 'q'.repeat(40) });
      expect(status).toHaveBeenCalledWith(401);
    });

    it('refuses a normal user API key or session token, which never reach the persona key check', async () => {
      const { status } = await post(
        { name: 'alpha' },
        { authorization: 'Bearer b4m_live_0123456789abcdef', 'x-api-key': 'b4m_live_0123456789abcdef' }
      );
      expect(status).toHaveBeenCalledWith(401);
      expect(h.createUser).not.toHaveBeenCalled();
    });
  });

  describe('fence', () => {
    it.each([
      ['a role', { name: 'alpha', role: 'admin' }],
      ['the admin flag', { name: 'alpha', isAdmin: true }],
      ['credits', { name: 'alpha', initialCredits: 5_000_000 }],
      ['a chosen username', { name: 'alpha', username: 'erik' }],
      ['a chosen email', { name: 'alpha', email: 'ceo@example.com' }],
      ['isPersona: false', { name: 'alpha', isPersona: false }],
    ])('refuses a body carrying %s', async (_label, body) => {
      const { status } = await post(body);
      expect(status).toHaveBeenCalledWith(400);
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it.each(['Admin', 'alpha-beta', '../x', 'a'.repeat(25)])(
      'refuses the name %j, which would put the username outside persona-<name>-<digits>',
      async name => {
        const { status } = await post({ name });
        expect(status).toHaveBeenCalledWith(400);
        expect(h.createUser).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['a public mail provider', 'gmail.com', () => undefined],
      ['a domain with entitlement grants', 'partner.example', () => h.domainGrants.add('partner.example')],
      ['a partner signup rule domain', 'rule.example', () => (h.partnerMatch = true)],
      ['any domain when partner rules cannot be read', 'personas.example.com', () => (h.partnerMatch = 'throws')],
    ])('refuses on production when PersonaEmailDomain is %s', async (_label, domain, arrange) => {
      arrange();
      h.production = true;
      h.settings = { PersonaMintEnabled: true, PersonaEmailDomain: domain };
      const { status } = await post();
      expect(status).toHaveBeenCalledWith(503);
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('refuses on production while PersonaEmailDomain is unset', async () => {
      h.production = true;
      const { status } = await post();
      expect(status).toHaveBeenCalledWith(503);
      expect(h.createUser).not.toHaveBeenCalled();
    });
  });

  describe('caps', () => {
    it('refuses once the 24-hour mint cap is reached', async () => {
      h.mintedLast24h = 20;
      const { status } = await post();
      expect(status).toHaveBeenCalledWith(429);
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('refuses once the live persona cap is reached', async () => {
      h.settings = { PersonaMintEnabled: true, PersonaMaxLive: 3 };
      h.live = 3;
      const { status } = await post();
      expect(status).toHaveBeenCalledWith(429);
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('refuses when the atomic daily reservation is spent, so concurrent mints cannot overshoot the cap', async () => {
      h.reserve.mockResolvedValue({ success: false, expiresAt: new Date() });
      const { status } = await post();
      expect(status).toHaveBeenCalledWith(429);
      expect(h.reserve).toHaveBeenCalledWith(expect.any(String), 20, 24 * 60 * 60 * 1000);
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('sweeps expired personas before counting, so they free their live slot', async () => {
      await post();
      expect(h.disableExpiredPersonas).toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('mints a flagged, credit-less, non-admin persona with server-built identity', async () => {
      const { status } = await post();
      expect(status).toHaveBeenCalledWith(201);
      const [params] = h.createUser.mock.calls[0];
      expect(params.username).toMatch(/^persona-alpha-\d+$/);
      expect(params.email).toMatch(/^b4m-personaalpha-\d+-e2e@test\.com$/);
      expect(params).toMatchObject({ isAdmin: false, initialCredits: 0, tags: [], allowReservedUsername: true });
      expect(params.adminPermissions).toBeUndefined();
      expect(params.record).toMatchObject({ isPersona: true, isSynthetic: true, password: null });
      expect(params.record.personaExpiresAt).toBeInstanceOf(Date);
    });

    it('uses the configured domain on production', async () => {
      h.production = true;
      h.settings = { PersonaMintEnabled: true, PersonaEmailDomain: 'Personas.Example.com' };
      await post();
      expect(h.createUser.mock.calls[0][0].email).toBe('alpha@personas.example.com');
    });

    it('audits the mint as the persona key', async () => {
      await post();
      expect(h.recordAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.persona.created',
          actor: expect.objectContaining({ kind: 'script', name: 'Persona mint key' }),
          target: expect.objectContaining({ kind: 'user', id: '64b000000000000000000001' }),
          context: expect.objectContaining({ source: 'script' }),
        }),
        expect.anything()
      );
    });

    it('returns a persona-mint session for that account only, with a refresh token that dies within a day', async () => {
      const { json } = await post();
      const [req, userId, params] = h.issueSessionForRequest.mock.calls[0];
      expect(req).toBeTruthy();
      expect(userId).toBe('64b000000000000000000001');
      expect(params.createdVia).toBe('persona-mint');
      expect(params.refreshTtlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'at',
          refreshToken: 'rt',
          accessTokenExpiresInSeconds: 1800,
          user: expect.objectContaining({ id: '64b000000000000000000001', isPersona: true }),
        })
      );
    });

    it('caps the refresh token at the persona expiry when that is sooner than the idle TTL', async () => {
      h.settings = { PersonaMintEnabled: true, PersonaTtlDays: 1 / 48 };
      await post();
      const [, , params] = h.issueSessionForRequest.mock.calls[0];
      const expiresAt = h.createUser.mock.calls[0][0].record.personaExpiresAt as Date;
      expect(params.refreshTtlMs).toBeLessThanOrEqual(expiresAt.getTime() - Date.now());
      expect(params.refreshTtlMs).toBeLessThan(24 * 60 * 60 * 1000);
    });

    it('answers 409 when a concurrent mint wins the unique index', async () => {
      h.createUser.mockRejectedValue(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
      const { status } = await post();
      expect(status).toHaveBeenCalledWith(409);
      expect(h.issueSessionForRequest).not.toHaveBeenCalled();
    });

    it('answers 409 when that persona name already exists', async () => {
      h.createUser.mockRejectedValue(new Error('Email already in use'));
      const { status } = await post();
      expect(status).toHaveBeenCalledWith(409);
      expect(h.issueSessionForRequest).not.toHaveBeenCalled();
    });
  });
});
