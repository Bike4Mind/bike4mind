// @vitest-environment node
/**
 * POST /api/v1/personas. `baseApi` is stubbed (no DB connect, no auth chain) but nextRouteForContract
 * is not, so body validation and the response drift check run for real. Everything that touches the
 * database lives behind the mocked personaAccounts helpers and repositories.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { PERSONA_ENDPOINT_OFF_CODE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  settings: { enabled: true, dailyLimit: 20, maxLive: 40, ttlDays: 1, emailDomain: null as string | null },
  existing: null as Record<string, unknown> | null,
  counts: { mintedLast24h: 0, live: 0 },
  findPersonaByName: vi.fn(),
  issuePersonaLoginCode: vi.fn(),
  deletePersonaAccount: vi.fn(),
  disableExpiredPersonas: vi.fn(),
  createUser: vi.fn(),
  recordAdminAction: vi.fn(),
  guard: vi.fn(),
  production: false,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = compose;
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@bike4mind/server-utils/utils/config', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/config')>()),
  isProduction: () => h.production,
}));
vi.mock('@server/services/hardDeleteUser', () => ({ hardDeleteUser: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.recordAdminAction }));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { updateOne: h.guard },
  withTransaction: (fn: () => unknown) => fn(),
  isTransientTransactionError: () => false,
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userService: { createUser: h.createUser } }));
vi.mock('@server/personas/personaAccounts', async () => {
  const actual = await vi.importActual<typeof import('@server/personas/personaAccounts')>(
    '@server/personas/personaAccounts'
  );
  return {
    ...actual,
    loadPersonaSettings: async () => h.settings,
    countPersonaCaps: async () => h.counts,
    findPersonaByName: h.findPersonaByName,
    issuePersonaLoginCode: h.issuePersonaLoginCode,
    deletePersonaAccount: h.deletePersonaAccount,
    disableExpiredPersonas: h.disableExpiredPersonas,
  };
});

const { default: handler } = await import('../index');

const OWNER_ID = '64b0000000000000000000a1';
const PERSONA_ID = '64b000000000000000000001';
const CODE = 'x'.repeat(43);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const developer = { id: OWNER_ID, tags: ['Developer'], isAdmin: false, isPersona: false, isBanned: false };

function fire(body: unknown = { name: 'alpha' }, user: Record<string, unknown> | null = developer) {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  Object.assign(req, { user, logger, headers: {} });
  return { req, res };
}

const call = (req: unknown, res: unknown) =>
  (handler as unknown as (request: unknown, response: unknown) => Promise<void>)(req, res);

async function post(...args: Parameters<typeof fire>) {
  const { req, res } = fire(...args);
  await call(req, res);
  return { res, body: res._getStatusCode() === 204 ? undefined : res._getJSONData() };
}

async function statusOf(run: Promise<unknown>): Promise<number> {
  try {
    await run;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 500;
  }
  throw new Error('expected the handler to throw');
}

const livePersona = (overrides: Record<string, unknown> = {}) => ({
  id: PERSONA_ID,
  username: 'persona-alpha-123',
  email: 'b4m-personaalpha-123-e2e@test.com',
  isPersona: true,
  isBanned: false,
  personaOwnerId: OWNER_ID,
  personaExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.production = false;
  h.settings = { enabled: true, dailyLimit: 20, maxLive: 40, ttlDays: 1, emailDomain: null };
  h.counts = { mintedLast24h: 0, live: 0 };
  h.findPersonaByName.mockResolvedValue(null);
  h.issuePersonaLoginCode.mockResolvedValue({ code: CODE, expiresAt: new Date('2026-11-10T12:05:00.000Z') });
  h.deletePersonaAccount.mockResolvedValue(undefined);
  h.disableExpiredPersonas.mockResolvedValue({ disabled: 0 });
  h.guard.mockResolvedValue({ matchedCount: 1 });
  h.recordAdminAction.mockResolvedValue(undefined);
  h.createUser.mockImplementation(async (params: { username: string; email: string }) => ({
    id: PERSONA_ID,
    username: params.username,
    email: params.email,
  }));
});

describe('POST /api/v1/personas', () => {
  describe('who may call', () => {
    it.each([
      ['a plain user', { ...developer, tags: [] }],
      ['a persona', { ...developer, isPersona: true }],
      ['a banned developer', { ...developer, isBanned: true }],
    ])('refuses %s with 403 before reading settings or minting', async (_label, user) => {
      expect(await statusOf(post({ name: 'alpha' }, user))).toBe(403);
      expect(h.createUser).not.toHaveBeenCalled();
      expect(h.issuePersonaLoginCode).not.toHaveBeenCalled();
    });

    it('allows an admin who is not developer-tagged', async () => {
      const { res } = await post({ name: 'alpha' }, { ...developer, tags: [], isAdmin: true });
      expect(res._getStatusCode()).toBe(201);
    });
  });

  it('answers 404 with the endpoint-off code while PersonaMintEnabled is off', async () => {
    h.settings = { ...h.settings, enabled: false };
    const { res, body } = await post();
    expect(res._getStatusCode()).toBe(404);
    expect(body).toEqual({ error: 'Not found', errorCode: PERSONA_ENDPOINT_OFF_CODE });
    expect(h.createUser).not.toHaveBeenCalled();
  });

  it('answers 503 when no identity can be built', async () => {
    h.production = true;
    h.settings = { ...h.settings, emailDomain: null };
    const { res } = await post();
    expect(res._getStatusCode()).toBe(503);
    expect(h.createUser).not.toHaveBeenCalled();
  });

  describe('fresh mint', () => {
    it('answers 201 with a login code and path, and never a token', async () => {
      const { res, body } = await post();

      expect(res._getStatusCode()).toBe(201);
      expect(body).toMatchObject({
        created: true,
        login_code: CODE,
        login_code_expires_at: '2026-11-10T12:05:00.000Z',
        login_path: `/api/personas/redeem?code=${CODE}`,
        persona: { id: PERSONA_ID, username: expect.stringMatching(/^persona-alpha-\d+$/) },
      });
      expect(body.login_path.startsWith('/api/personas/redeem?code=')).toBe(true);
      const wire = JSON.stringify(body);
      expect(wire).not.toMatch(/accessToken|refreshToken/);
      expect(h.issuePersonaLoginCode).toHaveBeenCalledWith(PERSONA_ID, expect.any(Date));
    });

    it('creates a flagged, credit-less, non-admin persona owned by the caller, and audits it', async () => {
      await post();
      const [params] = h.createUser.mock.calls[0];
      expect(params).toMatchObject({ isAdmin: false, initialCredits: 0, tags: [], allowReservedUsername: true });
      expect(params.record).toMatchObject({
        isPersona: true,
        isSynthetic: true,
        password: null,
        personaName: 'alpha',
        personaOwnerId: OWNER_ID,
      });
      expect(h.recordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'user.persona.created' })
      );
    });

    it('sweeps expired personas before counting the caps', async () => {
      await post();
      expect(h.disableExpiredPersonas).toHaveBeenCalled();
    });

    it('answers 409 when a concurrent mint wins the unique index', async () => {
      h.createUser.mockRejectedValue(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
      const { res } = await post();
      expect(res._getStatusCode()).toBe(409);
      expect(h.issuePersonaLoginCode).not.toHaveBeenCalled();
    });
  });

  describe('re-mint', () => {
    it('answers 200 with a fresh code for a live persona the caller already holds, creating nothing', async () => {
      h.findPersonaByName.mockResolvedValue(livePersona());
      const { res, body } = await post();

      expect(res._getStatusCode()).toBe(200);
      expect(body).toMatchObject({ created: false, login_code: CODE, persona: { id: PERSONA_ID } });
      expect(h.createUser).not.toHaveBeenCalled();
      expect(h.deletePersonaAccount).not.toHaveBeenCalled();
    });

    it('answers 409 when another user holds a live persona by that name', async () => {
      h.findPersonaByName.mockResolvedValue(livePersona({ personaOwnerId: 'someone-else' }));
      const { res } = await post();

      expect(res._getStatusCode()).toBe(409);
      expect(h.issuePersonaLoginCode).not.toHaveBeenCalled();
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it.each([
      ['banned', { isBanned: true }],
      ['expired', { personaExpiresAt: new Date(Date.now() - 1000) }],
    ])('deletes a %s persona, then mints a fresh one with 201', async (_label, overrides) => {
      const dead = livePersona(overrides);
      h.findPersonaByName.mockResolvedValueOnce(dead).mockResolvedValue(null);
      const { res, body } = await post();

      expect(h.deletePersonaAccount).toHaveBeenCalledWith(expect.anything(), dead, expect.any(String));
      expect(h.deletePersonaAccount.mock.invocationCallOrder[0]).toBeLessThan(h.createUser.mock.invocationCallOrder[0]);
      expect(res._getStatusCode()).toBe(201);
      expect(body.created).toBe(true);
    });

    it('deletes a dead persona held by another owner too, since it no longer holds the name', async () => {
      h.findPersonaByName
        .mockResolvedValueOnce(livePersona({ isBanned: true, personaOwnerId: 'someone-else' }))
        .mockResolvedValue(null);
      const { res } = await post();
      expect(h.deletePersonaAccount).toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(201);
    });
  });

  describe('caps', () => {
    it('answers 429 once the 24-hour mint cap is reached', async () => {
      h.counts = { mintedLast24h: 20, live: 0 };
      const { res } = await post();
      expect(res._getStatusCode()).toBe(429);
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('answers 429 once the live persona cap is reached', async () => {
      h.counts = { mintedLast24h: 0, live: 40 };
      const { res } = await post();
      expect(res._getStatusCode()).toBe(429);
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('rechecks the persisted kill switch before every name or cap decision', async () => {
      h.guard.mockResolvedValue({ matchedCount: 0 });
      const { res, body } = await post();
      expect(res._getStatusCode()).toBe(404);
      expect(body.errorCode).toBe(PERSONA_ENDPOINT_OFF_CODE);
      expect(h.findPersonaByName).not.toHaveBeenCalled();
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('checks the shared guard before returning an existing persona', async () => {
      h.findPersonaByName.mockResolvedValue(livePersona());
      await post();
      expect(h.guard).toHaveBeenCalledWith(
        { settingName: 'PersonaMintEnabled', settingValue: true },
        { $inc: { __v: 1 } }
      );
      expect(h.guard.mock.invocationCallOrder[0]).toBeLessThan(h.findPersonaByName.mock.invocationCallOrder[0]);
    });
  });

  describe('body fence', () => {
    it.each([
      ['the admin flag', { name: 'alpha', isAdmin: true }],
      ['credits', { name: 'alpha', initialCredits: 5_000_000 }],
      ['a chosen username', { name: 'alpha', username: 'qauser' }],
      ['a chosen email', { name: 'alpha', email: 'ceo@example.com' }],
    ])('rejects a body carrying %s (the error handler maps it to 422) before minting', async (_label, body) => {
      await expect(post(body)).rejects.toMatchObject({ name: 'ZodError' });
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it.each(['Admin', 'alpha-beta', '../x', 'a'.repeat(25), ''])('rejects the name %j', async name => {
      await expect(post({ name })).rejects.toMatchObject({ name: 'ZodError' });
      expect(h.createUser).not.toHaveBeenCalled();
    });
  });
});
