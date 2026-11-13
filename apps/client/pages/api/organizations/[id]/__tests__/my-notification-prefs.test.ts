import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  findById: vi.fn(),
  getForUser: vi.fn(),
  upsertForUser: vi.fn(),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, (fn: Handler) => unknown> = {};
  for (const method of ['get', 'put']) {
    chain[method] = (fn: Handler) => {
      mocks.handlers[method] = fn;
      return chain;
    };
  }
  return {
    baseApi: (options: unknown) => {
      mocks.baseApiOptions = options;
      return chain;
    },
  };
});
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: mocks.findById } }));
vi.mock('@bike4mind/database', () => ({
  orgAdminNotificationPrefRepository: { getForUser: mocks.getForUser, upsertForUser: mocks.upsertForUser },
}));

import '@pages/api/organizations/[id]/my-notification-prefs';

const org = {
  id: 'org1',
  userId: 'owner1',
  personal: false,
  adminUserIds: ['manager1', 'removed1'],
  users: [{ userId: 'manager1' }, { userId: 'member1' }],
};

const call = async (method: 'get' | 'put', user: { id: string; isAdmin?: boolean }, body?: unknown) => {
  const { req, res } = createMocks({ method: method.toUpperCase() as 'GET' | 'PUT', query: { id: 'org1' }, body });
  (req as unknown as { user: unknown }).user = user;
  try {
    await mocks.handlers[method](req, res);
    return { status: res._getStatusCode(), json: res._getJSONData() };
  } catch (error) {
    const { statusCode, status } = error as { statusCode?: number; status?: number };
    return { status: statusCode ?? status, json: null };
  }
};

describe('/api/organizations/[id]/my-notification-prefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue(org);
    mocks.getForUser.mockResolvedValue(null);
  });

  it('accepts browser sessions only, never API keys', () => {
    expect(mocks.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('reports role defaults: the owner is opted in, a manager opted out', async () => {
    expect((await call('get', { id: 'owner1' })).json).toMatchObject({ role: 'owner', kinds: { low_balance: true } });
    expect((await call('get', { id: 'manager1' })).json).toMatchObject({
      role: 'manager',
      kinds: { low_balance: false },
    });
  });

  it("saves only the caller's own row", async () => {
    mocks.getForUser.mockResolvedValue({ kinds: { low_balance: true } });

    const { status, json } = await call('put', { id: 'manager1' }, { kinds: { low_balance: true } });

    expect(status).toBe(200);
    expect(mocks.upsertForUser).toHaveBeenCalledWith('org1', 'manager1', { low_balance: true });
    expect(json.kinds.low_balance).toBe(true);
  });

  it.each([
    ['a plain member', { id: 'member1' }],
    ['an appointed admin with no member row', { id: 'removed1' }],
    ['a platform admin outside the org', { id: 'staff1', isAdmin: true }],
  ])('answers %s with 404', async (_label, user) => {
    expect((await call('put', user, { kinds: { low_balance: true } })).status).toBe(404);
    expect(mocks.upsertForUser).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown kind', { kinds: { nope: true } }],
    ['a userId in the body', { kinds: {}, userId: 'owner1' }],
    ['a non-boolean value', { kinds: { low_balance: 'yes' } }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await call('put', { id: 'owner1' }, body)).status).toBe(400);
    expect(mocks.upsertForUser).not.toHaveBeenCalled();
  });
});
