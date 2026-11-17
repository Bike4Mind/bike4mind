import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockFindOne = vi.fn();
const mockFindById = vi.fn();
const mockFindEndUser = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: {
    findOne: (filter: unknown) => ({ select: () => ({ lean: () => mockFindOne(filter) }) }),
    findById: (id: unknown) => ({ select: () => ({ lean: () => mockFindById(id) }) }),
  },
  platformEndUserRepository: { findByProviderEndUserId: (id: string) => mockFindEndUser(id) },
}));

import handler from '../by-provider-id';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const DIGEST = 'ab'.repeat(32);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/users/by-provider-id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOne.mockResolvedValue(null);
    mockFindById.mockResolvedValue(null);
    mockFindEndUser.mockResolvedValue(null);
  });

  it('gates through adminApi with JWT auth, admin scope and support:read for GET', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'support:read' },
    });
  });

  it.each([{}, { id: 'not-hex' }, { id: 'ab'.repeat(12) }, { id: 'g'.repeat(64) }])(
    'rejects a malformed identifier %j with 400',
    async query => {
      const res = await call(query as Record<string, string>);
      expect(res._getStatusCode()).toBe(400);
      expect(mockFindOne).not.toHaveBeenCalled();
    }
  );

  it('returns the account the identifier belongs to, matching case-insensitively', async () => {
    mockFindOne.mockResolvedValue({ _id: 'u1', name: 'Ada', username: 'ada', email: 'ada@example.com' });

    const res = await call({ id: ` ${DIGEST.toUpperCase()} ` });

    expect(mockFindOne).toHaveBeenCalledWith({ providerEndUserId: DIGEST });
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData()).toEqual({
      kind: 'user',
      id: 'u1',
      name: 'Ada',
      username: 'ada',
      email: 'ada@example.com',
    });
    expect(mockFindEndUser).not.toHaveBeenCalled();
  });

  it('falls back to a platform end user and names the platform account', async () => {
    const firstSeenAt = new Date('2026-11-01T00:00:00Z');
    const lastSeenAt = new Date('2026-11-02T00:00:00Z');
    mockFindEndUser.mockResolvedValue({
      providerEndUserId: DIGEST,
      keyOwnerId: 'owner-1',
      apiKeyId: 'key-1',
      endUserId: 'customer_42',
      firstSeenAt,
      lastSeenAt,
    });
    mockFindById.mockResolvedValue({ _id: 'owner-1', name: 'Platform', username: 'platform', email: undefined });

    const res = await call({ id: DIGEST });

    expect(mockFindEndUser).toHaveBeenCalledWith(DIGEST);
    expect(mockFindById).toHaveBeenCalledWith('owner-1');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      kind: 'platformEndUser',
      account: { id: 'owner-1', name: 'Platform', username: 'platform', email: null },
      endUserId: 'customer_42',
      apiKeyId: 'key-1',
      firstSeenAt: firstSeenAt.toISOString(),
      lastSeenAt: lastSeenAt.toISOString(),
    });
  });

  it('still resolves a platform end user whose owning account is gone, with account null', async () => {
    mockFindEndUser.mockResolvedValue({
      providerEndUserId: DIGEST,
      keyOwnerId: 'owner-1',
      endUserId: 'customer_42',
      firstSeenAt: new Date('2026-11-01T00:00:00Z'),
      lastSeenAt: new Date('2026-11-02T00:00:00Z'),
    });

    const res = await call({ id: DIGEST });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      kind: 'platformEndUser',
      account: null,
      endUserId: 'customer_42',
      apiKeyId: null,
    });
  });

  it('answers 404 when no account carries the identifier', async () => {
    await expect(call({ id: DIGEST })).rejects.toThrow('No account has this provider end-user identifier');
  });
});
