// @vitest-environment node
/** DELETE /api/v1/personas/{id}: only ever deletes a persona the caller may manage; all else is 404. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  deletePersonaAccount: vi.fn(),
  loadPersonaSettings: vi.fn(),
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
    chain.delete = compose;
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@bike4mind/server-utils/utils/config', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/config')>()),
  isProduction: () => false,
}));
vi.mock('@bike4mind/server-utils/services/hardDeleteUser', () => ({ hardDeleteUser: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: h.findById } }));
vi.mock('@bike4mind/services', () => ({ adminAuditService: {}, userService: {} }));
vi.mock('@server/personas/personaAccounts', async () => {
  const actual = await vi.importActual<typeof import('@server/personas/personaAccounts')>(
    '@server/personas/personaAccounts'
  );
  return { ...actual, deletePersonaAccount: h.deletePersonaAccount, loadPersonaSettings: h.loadPersonaSettings };
});

const { default: handler } = await import('../[id]');

const OWNER_ID = '64b0000000000000000000a1';
const PERSONA_ID = '64b000000000000000000001';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const developer = { id: OWNER_ID, tags: ['Developer'], isAdmin: false, isPersona: false, isBanned: false };
const persona = {
  id: PERSONA_ID,
  username: 'persona-alpha-123',
  email: 'a@x.test',
  isPersona: true,
  isAdmin: false,
  adminPermissions: [],
  personaOwnerId: OWNER_ID,
};

async function del(id: string = PERSONA_ID, user: Record<string, unknown> = developer) {
  const { req, res } = createMocks({ method: 'DELETE', query: { id } });
  Object.assign(req, { user, logger, headers: {} });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- next-connect handlers are untyped at this seam
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findById.mockResolvedValue(persona);
  h.deletePersonaAccount.mockResolvedValue(undefined);
  h.loadPersonaSettings.mockResolvedValue({ enabled: true });
});

describe('DELETE /api/v1/personas/{id}', () => {
  it('refuses a caller who may not mint personas with 403', async () => {
    await expect(del(PERSONA_ID, { ...developer, tags: [] })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.deletePersonaAccount).not.toHaveBeenCalled();
  });

  it('refuses a persona caller with 403', async () => {
    await expect(del(PERSONA_ID, { ...developer, isPersona: true })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('answers 404 with the off code and looks nothing up while minting is switched off', async () => {
    h.loadPersonaSettings.mockResolvedValue({ enabled: false });
    const res = await del();
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'persona_endpoint_off' });
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('answers 204 and deletes a persona the caller minted', async () => {
    const res = await del();
    expect(res._getStatusCode()).toBe(204);
    expect(h.deletePersonaAccount).toHaveBeenCalledWith(expect.anything(), persona, expect.any(String));
  });

  it('lets an admin delete a persona another user minted', async () => {
    h.findById.mockResolvedValue({ ...persona, personaOwnerId: 'someone-else' });
    const res = await del(PERSONA_ID, { ...developer, tags: [], isAdmin: true });
    expect(res._getStatusCode()).toBe(204);
    expect(h.deletePersonaAccount).toHaveBeenCalled();
  });

  it.each([
    ['a non-ObjectId id', 'not-an-id', persona],
    ['a missing account', PERSONA_ID, null],
    ['an ordinary user', PERSONA_ID, { ...persona, username: 'qauser', isPersona: undefined }],
    ['a persona-named account without the flag', PERSONA_ID, { ...persona, isPersona: undefined }],
    ['a flagged account with a non-persona username', PERSONA_ID, { ...persona, username: 'qauser' }],
    ['a persona with admin', PERSONA_ID, { ...persona, isAdmin: true }],
    ['a persona another user minted, for a non-admin caller', PERSONA_ID, { ...persona, personaOwnerId: 'other' }],
    ['a persona with no recorded owner, for a non-admin caller', PERSONA_ID, { ...persona, personaOwnerId: null }],
  ])('answers 404 and deletes nothing for %s', async (_label, id, account) => {
    h.findById.mockResolvedValue(account);
    const res = await del(id);
    expect(res._getStatusCode()).toBe(404);
    expect(h.deletePersonaAccount).not.toHaveBeenCalled();
  });

  it('does not look the id up at all when it is not an ObjectId', async () => {
    await del('not-an-id');
    expect(h.findById).not.toHaveBeenCalled();
  });
});
