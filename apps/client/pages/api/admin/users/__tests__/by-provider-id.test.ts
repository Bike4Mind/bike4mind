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
vi.mock('@bike4mind/database', () => ({
  User: {
    findOne: (filter: unknown) => ({ select: () => ({ lean: () => mockFindOne(filter) }) }),
  },
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
    expect(res._getJSONData()).toEqual({ id: 'u1', name: 'Ada', username: 'ada', email: 'ada@example.com' });
  });

  it('answers 404 when no account carries the identifier', async () => {
    await expect(call({ id: DIGEST })).rejects.toThrow('No account has this provider end-user identifier');
  });
});
