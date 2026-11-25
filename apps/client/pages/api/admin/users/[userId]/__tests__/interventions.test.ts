import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const USER_ID = 'a'.repeat(24);
const ADMIN_ID = 'b'.repeat(24);
const DECISION_ID = 'c'.repeat(24);
const NOW = new Date('2026-11-24T10:00:00Z');

const h = vi.hoisted(() => ({
  routes: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  options: null as unknown,
  findUser: vi.fn(),
  findDecision: vi.fn(),
  release: vi.fn(),
  audit: vi.fn(),
  denySelf: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.options = options;
    const chain = {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => Promise<void>) => ((h.routes.get = fn), chain),
      post: (fn: (req: unknown, res: unknown) => Promise<void>) => ((h.routes.post = fn), chain),
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser },
  autoContainmentDecisionRepository: { findById: h.findDecision },
}));
vi.mock('@server/security/interventionRelease', () => ({ releaseInterventionDecision: h.release }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  denySelfAdminAction: h.denySelf,
  recordAdminActionFromRequest: h.audit,
}));
await import('../interventions');

const request = (method: 'GET' | 'POST', body?: unknown, userId = USER_ID) => {
  const { req, res } = createMocks({ method, body, query: { userId } });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin: true }, logger: { error: vi.fn() } });
  return { req, res };
};

const hold = {
  decisionId: DECISION_ID,
  detectionId: 'detection-1',
  tier: 'review',
  policyVersion: 1,
  reason: 'Automated review (policy v1)',
  appliedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  releasedAt: null,
  releasedBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.denySelf.mockRejectedValue(Object.assign(new Error('own account'), { statusCode: 403 }));
  h.findUser.mockResolvedValue({ id: USER_ID, email: 'user@example.com', interventionHolds: [hold] });
  h.findDecision.mockResolvedValue({ id: DECISION_ID, detectionId: 'detection-1', tier: 'review', userIds: [USER_ID] });
  h.release.mockResolvedValue([USER_ID]);
});

describe('/api/admin/users/[userId]/interventions', () => {
  it('is session-only, readable with support:read and releasable with users:moderate', () => {
    expect(h.options).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'support:read', POST: 'users:moderate' },
    });
  });

  it('lists the account holds', async () => {
    const { req, res } = request('GET');
    await h.routes.get(req, res);
    expect(res._getJSONData()).toMatchObject({ data: [{ decisionId: DECISION_ID, tier: 'review' }] });
  });

  it('releases that decision on this account only, as the signed-in admin, and audits it', async () => {
    const { req, res } = request('POST', { decisionId: DECISION_ID, reason: 'Verified by support' });
    await h.routes.post(req, res);

    expect(h.release).toHaveBeenCalledWith(
      expect.objectContaining({ id: DECISION_ID }),
      expect.objectContaining({ userIds: [USER_ID], by: ADMIN_ID, condition: 'admin_release' })
    );
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'user.intervention_hold.released', reason: 'Verified by support' })
    );
    expect(res._getJSONData()).toEqual({ released: [{ decisionId: DECISION_ID, userIds: [USER_ID] }] });
  });

  it('answers 404 for a decision that never named this account', async () => {
    h.findDecision.mockResolvedValue({ id: DECISION_ID, tier: 'review', userIds: ['someone-else'] });
    const { req, res } = request('POST', { decisionId: DECISION_ID, reason: 'Verified by support' });
    await expect(h.routes.post(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.release).not.toHaveBeenCalled();
  });

  it('audits nothing when the hold was already released', async () => {
    h.release.mockResolvedValue([]);
    const { req, res } = request('POST', { decisionId: DECISION_ID, reason: 'Verified by support' });
    await h.routes.post(req, res);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses an admin releasing their own account', async () => {
    const { req, res } = request('POST', { decisionId: DECISION_ID, reason: 'Verified by support' }, ADMIN_ID);
    await expect(h.routes.post(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.release).not.toHaveBeenCalled();
  });
});
