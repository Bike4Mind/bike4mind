import { describe, it, expect, vi, beforeEach } from 'vitest';

/** DELETE /api/personas/:id must only ever delete persona accounts, and only with the persona key. */

const KEY = 'p'.repeat(40);
const ID = '64b000000000000000000001';

const h = vi.hoisted(() => ({
  secret: { value: '' } as { value: string } | undefined,
  findById: vi.fn(),
  hardDeleteUser: vi.fn(),
  revokeUserSessions: vi.fn(),
  recordAdminAction: vi.fn(),
  baseApiOptions: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions.push(options);
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@bike4mind/server-utils/lib/entitlements/registry', () => ({ entitlementsForEmail: () => new Set() }));
vi.mock('@bike4mind/server-utils/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: () => Promise.resolve({ matched: false }),
}));
vi.mock('@server/services/hardDeleteUser', () => ({ hardDeleteUser: h.hardDeleteUser }));
vi.mock('sst', () => ({
  Resource: {
    get PERSONA_MINT_KEY() {
      return h.secret;
    },
  },
}));
vi.mock('@bike4mind/database', () => ({
  User: {},
  adminAuditLogRepository: {},
  adminSettingsRepository: {},
  authSessionRepository: {},
  realtimeConnectionRepository: {},
  userRepository: { findById: h.findById },
}));
vi.mock('@bike4mind/services', () => ({
  adminAuditService: { recordAdminAction: h.recordAdminAction },
  userService: { revokeUserSessions: h.revokeUserSessions },
}));

import handler from '../[id]';

const persona = { id: ID, username: 'persona-alpha-123', email: 'a@x.test', isPersona: true, isAdmin: false };

const del = async (id: string = ID, headers: Record<string, string> = { 'x-persona-mint-key': KEY }) => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  await handler(
    {
      method: 'DELETE',
      url: `/api/personas/${id}`,
      query: { id },
      headers,
      logger: { error: vi.fn(), log: vi.fn(), info: vi.fn(), warn: vi.fn() },
    } as never,
    { json, status } as never
  );
  return { json, status };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.secret = { value: KEY };
  h.findById.mockResolvedValue(persona);
  h.hardDeleteUser.mockResolvedValue({ result: true, subscriptionCancellation: null });
});

describe('DELETE /api/personas/:id', () => {
  it('answers 404 when the stage secret is unset', async () => {
    h.secret = undefined;
    const { status, json } = await del();
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'persona_endpoint_off' }));
    expect(h.hardDeleteUser).not.toHaveBeenCalled();
  });

  it('serves DELETE only, so any other verb is a 405 ahead of the DB connect', () => {
    expect(h.baseApiOptions[0]).toEqual(expect.objectContaining({ auth: false, allowedMethods: ['DELETE'] }));
  });

  it('marks a missing persona with its own code, distinct from the endpoint being off', async () => {
    h.findById.mockResolvedValue(null);
    const { json } = await del();
    expect(json).toHaveBeenCalledWith({ error: 'No persona account with that id', code: 'persona_not_found' });
  });

  it.each([
    ['no key', {}],
    ['a wrong key', { 'x-persona-mint-key': 'q'.repeat(40) }],
    ['a user API key', { authorization: 'Bearer b4m_live_0123456789abcdef' }],
  ])('refuses %s', async (_label, headers) => {
    const { status } = await del(ID, headers);
    expect(status).toHaveBeenCalledWith(401);
    expect(h.hardDeleteUser).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing account', null],
    ['an ordinary user', { ...persona, username: 'erik', isPersona: undefined }],
    ['a persona-named account without the flag', { ...persona, isPersona: undefined }],
    ['a flagged account whose username is not a persona username', { ...persona, username: 'erik' }],
    ['a persona with admin', { ...persona, isAdmin: true }],
  ])('refuses %s with the same 404', async (_label, account) => {
    h.findById.mockResolvedValue(account);
    const { status } = await del();
    expect(status).toHaveBeenCalledWith(404);
    expect(h.revokeUserSessions).not.toHaveBeenCalled();
    expect(h.hardDeleteUser).not.toHaveBeenCalled();
  });

  it('refuses an id that is not an ObjectId without a lookup', async () => {
    const { status } = await del('{"$ne":null}');
    expect(status).toHaveBeenCalledWith(404);
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('signs the persona out, deletes it and audits the delete in the transaction', async () => {
    const { status, json } = await del();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ deleted: true, id: ID });
    expect(h.revokeUserSessions).toHaveBeenCalledWith(ID, expect.anything());

    const [deletedId, context] = h.hardDeleteUser.mock.calls[0];
    expect(deletedId).toBe(ID);
    await context.recordInTransaction(persona, { canceled: [], failed: [] });
    expect(h.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.persona.deleted',
        actor: expect.objectContaining({ name: 'Persona mint key' }),
        target: expect.objectContaining({ id: ID }),
      }),
      expect.anything()
    );
  });

  it('aborts the delete if the account stopped being a persona before the transaction', async () => {
    await del();
    const [, context] = h.hardDeleteUser.mock.calls[0];
    h.findById.mockResolvedValue({ ...persona, isAdmin: true });
    await expect(context.assertInTransaction()).rejects.toThrow(/no longer a persona/);
  });
});
