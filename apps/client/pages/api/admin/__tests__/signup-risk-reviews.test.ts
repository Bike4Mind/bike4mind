import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, SIGNUP_RISK_REVIEW_LIST_LIMIT } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  baseOptions: vi.fn(),
  findPending: vi.fn(),
  setState: vi.fn(),
  creditsSpent: vi.fn(),
  keysCreated: vi.fn(),
  record: vi.fn(),
  denySelf: vi.fn(),
  inTransaction: false,
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseOptions(options);
    const chain = {
      get: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        h.handlers.get = fn;
        return chain;
      },
      post: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        h.handlers.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findPendingRiskReviews: h.findPending, setRiskReviewState: h.setState },
  usageEventRepository: { creditsSpentByUsers: h.creditsSpent },
  userApiKeyRepository: { countCreatedByUserIds: h.keysCreated },
  withTransaction: async (fn: () => Promise<unknown>) => {
    h.inTransaction = true;
    try {
      return await fn();
    } finally {
      h.inTransaction = false;
    }
  },
}));
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.record,
  denySelfAdminAction: h.denySelf,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: `${id}@example.com` }),
}));
import '@pages/api/admin/signup-risk-reviews';

const ADMIN_ID = 'a'.repeat(24);
const USER_A = '1'.repeat(24);
const USER_B = '2'.repeat(24);
const REASON = 'Spam or bot cohort';

const request = (method: 'GET' | 'POST', body?: unknown, isAdmin = true) => {
  const { req, res } = createMocks({ method, body });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin }, logger: {} });
  return { req, res };
};

const pendingUser = (id: string, email: string, score: number) => ({
  id,
  email,
  username: `user-${id.slice(0, 4)}`,
  createdAt: new Date('2026-10-20T10:00:00Z'),
  riskScore: {
    score,
    signals: [{ signal: 'quickApiKey', points: 15, reason: 'First API key created 3 minutes after signup' }],
    computedAt: new Date('2026-10-20T11:00:00Z'),
    reviewState: 'pending',
  },
});

beforeEach(() => {
  h.findPending.mockReset().mockResolvedValue([]);
  h.setState.mockReset().mockResolvedValue(true);
  h.creditsSpent.mockReset().mockResolvedValue({});
  h.keysCreated.mockReset().mockResolvedValue({});
  h.record.mockReset().mockImplementation(async () => expect(h.inTransaction).toBe(true));
  h.denySelf.mockReset().mockRejectedValue(new Error('Admins cannot review their own account.'));
});

describe('signup risk review queue', () => {
  it('is session-only and admin-only for both reads and decisions', async () => {
    expect(h.baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] });

    const get = request('GET', undefined, false);
    await expect(h.handlers.get(get.req, get.res)).rejects.toThrow(/admin access required/i);
    const post = request('POST', { action: 'approve', userIds: [USER_A], reason: REASON }, false);
    await expect(h.handlers.post(post.req, post.res)).rejects.toThrow(/admin access required/i);

    expect(h.findPending).not.toHaveBeenCalled();
    expect(h.setState).not.toHaveBeenCalled();
  });

  it('lists pending accounts with their registrable domain, spend and key count', async () => {
    h.findPending.mockResolvedValue([
      pendingUser(USER_A, 'bot1@np.burner-example.com', 80),
      pendingUser(USER_B, 'jane@example.org', 55),
    ]);
    h.creditsSpent.mockResolvedValue({ [USER_A]: 1200 });
    h.keysCreated.mockResolvedValue({ [USER_A]: 3 });
    const { req, res } = request('GET');

    await h.handlers.get(req, res);

    expect(h.findPending).toHaveBeenCalledWith(SIGNUP_RISK_REVIEW_LIST_LIMIT + 1);
    expect(res._getHeaders()['cache-control']).toBe('private, no-store');
    const body = res._getJSONData();
    expect(body.truncated).toBe(false);
    expect(body.data).toMatchObject([
      { userId: USER_A, domain: 'burner-example.com', score: 80, creditsSpent: 1200, apiKeysCreated: 3 },
      { userId: USER_B, domain: 'example.org', score: 55, creditsSpent: 0, apiKeysCreated: 0 },
    ]);
    expect(body.data[0].signals[0]).toEqual({
      signal: 'quickApiKey',
      points: 15,
      reason: 'First API key created 3 minutes after signup',
    });
  });

  it('caps the list and says so', async () => {
    h.findPending.mockResolvedValue(
      Array.from({ length: SIGNUP_RISK_REVIEW_LIST_LIMIT + 1 }, (_, i) =>
        pendingUser(i.toString(16).padStart(24, '0'), `u${i}@example.com`, 60)
      )
    );
    const { req, res } = request('GET');

    await h.handlers.get(req, res);

    const body = res._getJSONData();
    expect(body.data).toHaveLength(SIGNUP_RISK_REVIEW_LIST_LIMIT);
    expect(body.truncated).toBe(true);
  });

  it('refuses a decision without a reason before writing', async () => {
    const { req, res } = request('POST', { action: 'approve', userIds: [USER_A] });

    await expect(h.handlers.post(req, res)).rejects.toThrow();
    expect(h.setState).not.toHaveBeenCalled();
  });

  it('approves each pending account with a strict audit entry in its own transaction', async () => {
    h.setState.mockImplementation(async (userId: string) => userId === USER_A);
    const { req, res } = request('POST', { action: 'approve', userIds: [USER_A, USER_B, USER_A], reason: REASON });

    await h.handlers.post(req, res);

    expect(h.setState.mock.calls).toEqual([
      [USER_A, 'pending', 'approved'],
      [USER_B, 'pending', 'approved'],
    ]);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(req, {
      action: 'user.signup_risk.approved',
      target: { kind: 'user', id: USER_A, displayName: `${USER_A}@example.com` },
      summary: 'approved a flagged signup',
      reason: REASON,
      changes: [{ field: 'riskScore.reviewState', before: 'pending', after: 'approved' }],
    });
    expect(res._getJSONData()).toEqual({ updatedUserIds: [USER_A], skippedUserIds: [USER_B], failedUserIds: [] });
  });

  it('keeps going when one account fails and reports it', async () => {
    const USER_C = '3'.repeat(24);
    h.setState.mockImplementation(async (userId: string) => {
      if (userId === USER_B) throw new Error('transaction aborted');
      return true;
    });
    const { req, res } = request('POST', { action: 'approve', userIds: [USER_A, USER_B, USER_C], reason: REASON });
    const error = vi.fn();
    Object.assign(req, { logger: { error } });

    await h.handlers.post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ updatedUserIds: [USER_A, USER_C], skippedUserIds: [], failedUserIds: [USER_B] });
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ userId: USER_B }));
  });

  it('reopens an approval back into the queue', async () => {
    const { req, res } = request('POST', { action: 'reopen', userIds: [USER_A], reason: REASON });

    await h.handlers.post(req, res);

    expect(h.setState).toHaveBeenCalledWith(USER_A, 'approved', 'pending');
    expect(h.record).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'user.signup_risk.reopened', reason: REASON })
    );
  });

  it("refuses to review the admin's own account and changes nothing", async () => {
    const { req, res } = request('POST', { action: 'approve', userIds: [USER_A, ADMIN_ID], reason: REASON });

    await expect(h.handlers.post(req, res)).rejects.toThrow(/own account/);
    expect(h.denySelf).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'user.signup_risk.denied', attempted: 'user.signup_risk.approved' })
    );
    expect(h.setState).not.toHaveBeenCalled();
  });
});
