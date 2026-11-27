import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, MODERATION_PAGE_READ, missingAdminPermissionMessage } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), listByUser: vi.fn(), findByClientIds: vi.fn() }));

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock()
);
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) },
  oauthClientSignInRepository: { listByUser: (...a: unknown[]) => mocks.listByUser(...a) },
  oauthClientRepository: { findByClientIds: (...a: unknown[]) => mocks.findByClientIds(...a) },
}));

import handler from '../oauth-apps';

const USER_ID = 'b'.repeat(24);
const SIGNUP_CLIENT = 'b4m_alpha_11111111';
const OTHER_CLIENT = 'b4m_beta_22222222';

const call = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: USER_ID, ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const row = (clientId: string, first: string, last: string) => ({
  clientId,
  firstSignInAt: new Date(first),
  lastSignInAt: new Date(last),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID, signupClientId: SIGNUP_CLIENT });
  mocks.listByUser.mockResolvedValue([]);
  mocks.findByClientIds.mockResolvedValue(new Map());
});

describe('GET /api/admin/users/[userId]/oauth-apps', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN] and MODERATION_PAGE_READ for GET', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[]; adminPermissions?: unknown } })
      ._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
    expect(config?.adminPermissions).toEqual({ GET: MODERATION_PAGE_READ });
  });

  it('refuses a delegate without a moderation read permission with 403 before reading anything', async () => {
    const delegate = { id: 'u2', isAdmin: false, adminPermissions: ['credits:adjust'] };
    await expect(call({}, delegate).promise).rejects.toMatchObject({
      statusCode: 403,
      message: missingAdminPermissionMessage(MODERATION_PAGE_READ),
    });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('rejects a malformed user id with 400 and a missing user with 404', async () => {
    await expect(call({ userId: 'nope' }).promise).rejects.toMatchObject({ statusCode: 400 });
    mocks.findById.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });

  it('resolves the signup client and app names with one batched lookup, keeping the sign-in order', async () => {
    mocks.listByUser.mockResolvedValue([
      row(OTHER_CLIENT, '2026-11-01T00:00:00.000Z', '2026-11-20T00:00:00.000Z'),
      row(SIGNUP_CLIENT, '2026-10-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
    ]);
    mocks.findByClientIds.mockResolvedValue(
      new Map([
        [SIGNUP_CLIENT, { name: 'Alpha' }],
        [OTHER_CLIENT, { name: 'Beta' }],
      ])
    );
    const { res, promise } = call();
    await promise;

    expect(mocks.findByClientIds).toHaveBeenCalledTimes(1);
    expect(mocks.findByClientIds).toHaveBeenCalledWith([SIGNUP_CLIENT, OTHER_CLIENT]);
    expect(res._getJSONData()).toEqual({
      signupClient: { clientId: SIGNUP_CLIENT, name: 'Alpha' },
      apps: [
        {
          clientId: OTHER_CLIENT,
          name: 'Beta',
          firstSignInAt: '2026-11-01T00:00:00.000Z',
          lastSignInAt: '2026-11-20T00:00:00.000Z',
        },
        {
          clientId: SIGNUP_CLIENT,
          name: 'Alpha',
          firstSignInAt: '2026-10-01T00:00:00.000Z',
          lastSignInAt: '2026-11-02T00:00:00.000Z',
        },
      ],
    });
  });

  it('returns a null name for a deleted client', async () => {
    mocks.listByUser.mockResolvedValue([row(OTHER_CLIENT, '2026-11-01T00:00:00.000Z', '2026-11-20T00:00:00.000Z')]);
    const { res, promise } = call();
    await promise;
    const body = res._getJSONData() as { signupClient: { name: string | null }; apps: { name: string | null }[] };
    expect(body.signupClient).toEqual({ clientId: SIGNUP_CLIENT, name: null });
    expect(body.apps[0].name).toBeNull();
  });

  it('returns no signup client for an unattributed user', async () => {
    mocks.findById.mockResolvedValue({ id: USER_ID, signupClientId: null });
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData()).toEqual({ signupClient: null, apps: [] });
  });

  it('returns null names without looking clients up for a moderator lacking support:read', async () => {
    mocks.listByUser.mockResolvedValue([row(OTHER_CLIENT, '2026-11-01T00:00:00.000Z', '2026-11-20T00:00:00.000Z')]);
    const moderator = { id: 'u3', isAdmin: false, adminPermissions: ['users:moderate'] };
    const { res, promise } = call({}, moderator);
    await promise;
    const body = res._getJSONData() as { signupClient: { name: string | null }; apps: { name: string | null }[] };
    expect(mocks.findByClientIds).not.toHaveBeenCalled();
    expect(body.signupClient).toEqual({ clientId: SIGNUP_CLIENT, name: null });
    expect(body.apps[0].name).toBeNull();
  });

  it('resolves names for a delegate holding support:read', async () => {
    mocks.findByClientIds.mockResolvedValue(new Map([[SIGNUP_CLIENT, { name: 'Alpha' }]]));
    const delegate = { id: 'u4', isAdmin: false, adminPermissions: ['users:moderate', 'support:read'] };
    const { res, promise } = call({}, delegate);
    await promise;
    expect(mocks.findByClientIds).toHaveBeenCalledTimes(1);
    expect((res._getJSONData() as { signupClient: { name: string } }).signupClient.name).toBe('Alpha');
  });
});
