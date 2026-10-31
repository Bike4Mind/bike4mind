// @vitest-environment node
/**
 * POST /api/projects/:id/invites: drives the real baseApi chain with the real outbound gate (same approach as
 * tools/__tests__/tools.test.ts) so a moderated or untrusted account is refused before the handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockResolveTrust, mockUserFindById, handlerReached } = vi.hoisted(() => ({
  mockResolveTrust: vi.fn(),
  mockUserFindById: vi.fn(),
  handlerReached: vi.fn(),
}));

const USER = { id: 'user-1', _id: 'user-1', username: 'jules', tokenVersion: 0, isBanned: false };

vi.mock('@server/utils/apiKeyTrust', () => ({
  resolveApiKeyTrust: (...a: unknown[]) => mockResolveTrust(...a),
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockUserFindById(...a) }),
    cacheRepository: {
      tryIncrementWithinLimitFixedWindow: async (_key: string, _limit: number, windowMs: number) => ({
        success: true,
        count: 1,
        expiresAt: new Date(Date.now() + windowMs),
      }),
    },
    projectRepository: { findById: handlerReached },
    inviteRepository: { create: handlerReached },
  };
});

vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, _res: any, next: any) => {
      if (!req.user) req.user = USER;
      next();
    },
  };
});

import handler from '../invites';

// any: next-connect handlers take Express req/res; node-mocks-http mocks are not structurally those.
async function post(user: object) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/projects/507f1f77bcf86cd799439033/invites',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], recipients: ['a@example.com'] },
    },
    { eventEmitter: EventEmitter }
  );
  (req as any).user = user;
  await (handler as (req: any, res: any) => unknown)(req, res);
  return res;
}

describe('POST /api/projects/:id/invites outbound gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTrust.mockResolvedValue({ assessment: { status: 'trusted' }, settings: {} });
    mockUserFindById.mockResolvedValue(USER);
  });

  it('403s a moderated account before the handler runs', async () => {
    const res = await post({ ...USER, isModerated: true });

    expect(res._getStatusCode()).toBe(403);
    expect(handlerReached).not.toHaveBeenCalled();
  });

  it('403s an untrusted account with the account-trust error code', async () => {
    mockResolveTrust.mockResolvedValue({
      assessment: { status: 'untrusted', reason: 'not_yet_trusted', trustedAfter: new Date('2099-01-01T00:00:00Z') },
      settings: {},
    });
    const res = await post(USER);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'account_trust_required' });
    expect(handlerReached).not.toHaveBeenCalled();
  });
});
