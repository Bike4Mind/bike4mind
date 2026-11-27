import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/common';

const refs = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, (req: unknown, res: unknown) => unknown>>,
  uses: {} as Record<string, unknown[]>,
  current: '',
}));
vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {
    use: (fn: unknown) => {
      (refs.uses[refs.current] ??= []).push(fn);
      return chain;
    },
  };
  for (const method of ['get', 'post']) {
    chain[method] = (...fns: unknown[]) => {
      (refs.handlers[refs.current] ??= {})[method] = fns[fns.length - 1] as (req: unknown, res: unknown) => unknown;
      return chain;
    };
  }
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (name: string) => ({ flag: name }),
}));

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  joinViaDomain: vi.fn(),
  listDomainSuggestions: vi.fn(),
  getSettingsValue: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  spaceRepository: {},
  userRepository: { findById: mocks.findUser },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  spaceService: { joinViaDomain: mocks.joinViaDomain, listDomainSuggestions: mocks.listDomainSuggestions },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: async () => ({}),
  getSettingsValue: mocks.getSettingsValue,
}));
vi.mock('@server/organizations/orgDomainClaims', () => ({
  isDomainJoinable: 'isDomainJoinable',
  joinableSpaceIdsForEmail: 'joinableSpaceIdsForEmail',
}));

refs.current = 'join';
await import('@pages/api/spaces/[id]/domain-join');
refs.current = 'suggestions';
await import('@pages/api/spaces/domain-suggestions');

const SPACE_ID = '65a1f77bcf86cd7994390010';

const call = async (route: 'join' | 'suggestions', method: 'get' | 'post') => {
  const { req, res } = createMocks({ method: method.toUpperCase() as 'GET', query: { id: SPACE_ID } });
  (req as unknown as { user: unknown }).user = { id: 'u1' };
  await refs.handlers[route][method](req, res);
  return res;
};

describe('Space domain join routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ id: 'u1', email: 'a@acme.com', emailVerified: true });
    mocks.getSettingsValue.mockReturnValue(undefined);
  });

  it('sits behind the EnableSpaces flag', () => {
    expect(refs.uses.join).toContainEqual({ flag: 'EnableSpaces' });
    expect(refs.uses.suggestions).toContainEqual({ flag: 'EnableSpaces' });
  });

  it('joins with a freshly read user, the default cap of 1000, and answers 204', async () => {
    const res = await call('join', 'post');
    expect(mocks.joinViaDomain).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', emailVerified: true }),
      { spaceId: SPACE_ID },
      expect.objectContaining({ limits: { spaceMaxMembers: 1000 }, isDomainJoinable: 'isDomainJoinable' })
    );
    expect(res.statusCode).toBe(204);
  });

  it('uses the configured member cap', async () => {
    mocks.getSettingsValue.mockReturnValue(7);
    await call('join', 'post');
    expect(mocks.joinViaDomain.mock.calls[0][2]).toMatchObject({ limits: { spaceMaxMembers: 7 } });
  });

  it('propagates the service refusal', async () => {
    mocks.joinViaDomain.mockRejectedValue(new NotFoundError('Space not found'));
    await expect(call('join', 'post')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists suggestions with no-store, and an empty list when the user is gone', async () => {
    mocks.listDomainSuggestions.mockResolvedValue([{ spaceId: SPACE_ID, spaceName: 'Team' }]);
    const res = await call('suggestions', 'get');
    expect(res._getJSONData()).toEqual({ suggestions: [{ spaceId: SPACE_ID, spaceName: 'Team' }] });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    mocks.findUser.mockResolvedValue(null);
    expect((await call('suggestions', 'get'))._getJSONData()).toEqual({ suggestions: [] });
  });
});
