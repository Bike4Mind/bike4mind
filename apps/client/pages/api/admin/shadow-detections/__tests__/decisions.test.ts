import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, INTERVENTION_BULK_RELEASE_LIMIT } from '@bike4mind/common';

const ADMIN_ID = 'a'.repeat(24);
const DETECTION_ID = 'b'.repeat(24);
const DECISION_ID = 'c'.repeat(24);
const REASON = 'Rolling back the review tier';

const h = vi.hoisted(() => ({
  routes: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  options: null as unknown,
  list: vi.fn(),
  findById: vi.fn(),
  listActiveByTier: vi.fn(),
  release: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
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
  autoContainmentDecisionRepository: {
    listForDetection: h.list,
    findById: h.findById,
    listActiveByTier: h.listActiveByTier,
  },
}));
vi.mock('@server/security/interventionRelease', () => ({ releaseInterventionDecision: h.release }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.audit,
}));
await import('../decisions');

const request = (method: 'GET' | 'POST', options: { body?: unknown; query?: Record<string, string> } = {}) => {
  const { req, res } = createMocks({ method, body: options.body, query: options.query });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin: true }, logger: { error: vi.fn() } });
  return { req, res };
};

const decision = (id: string, userIds = ['u1']) => ({ id, detectionId: DETECTION_ID, tier: 'review', userIds });

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue([]);
  h.release.mockImplementation(
    async (released: { userIds: string[] }, input: { actor: { id: string }; onSkip: (id: string) => void }) => {
      released.userIds.filter(id => id === input.actor.id).forEach(input.onSkip);
      return released.userIds.filter(id => id !== input.actor.id);
    }
  );
});

describe('/api/admin/shadow-detections/decisions', () => {
  it('is session-only, readable with support:read and releasable with users:moderate', () => {
    expect(h.options).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'support:read', POST: 'users:moderate' },
    });
  });

  it('rejects an invalid detection id', async () => {
    const { req, res } = request('GET', { query: { detectionId: 'nope' } });
    await expect(h.routes.get(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('releases one decision as the acting admin, auditing each released account', async () => {
    h.findById.mockResolvedValue(decision(DECISION_ID, ['u1', ADMIN_ID]));
    const { req, res } = request('POST', { body: { decisionId: DECISION_ID, reason: REASON } });

    await h.routes.post(req, res);

    expect(h.release).toHaveBeenCalledWith(
      expect.objectContaining({ id: DECISION_ID }),
      expect.objectContaining({
        actor: expect.objectContaining({ id: ADMIN_ID }),
        by: ADMIN_ID,
        condition: 'admin_release',
        reason: REASON,
      })
    );
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(res._getJSONData()).toEqual({
      released: [{ decisionId: DECISION_ID, userIds: ['u1'], skippedUserIds: [ADMIN_ID] }],
    });
  });

  it('answers 404 for an unknown or Contain decision', async () => {
    h.findById.mockResolvedValue({ ...decision(DECISION_ID), tier: 'contain' });
    const { req, res } = request('POST', { body: { decisionId: DECISION_ID, reason: REASON } });
    await expect(h.routes.post(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.release).not.toHaveBeenCalled();
  });

  it('rolls back a tier, capped at the bulk limit', async () => {
    h.listActiveByTier.mockResolvedValue([decision('d1'), decision('d2', ['u2', 'u3'])]);
    const { req, res } = request('POST', { body: { tier: 'review', reason: REASON } });

    await h.routes.post(req, res);

    expect(h.listActiveByTier).toHaveBeenCalledWith('review', INTERVENTION_BULK_RELEASE_LIMIT);
    expect(h.audit).toHaveBeenCalledTimes(3);
    expect(res._getJSONData()).toEqual({
      released: [
        { decisionId: 'd1', userIds: ['u1'], skippedUserIds: [] },
        { decisionId: 'd2', userIds: ['u2', 'u3'], skippedUserIds: [] },
      ],
    });
  });

  it('never rolls back the Contain tier', async () => {
    const { req, res } = request('POST', { body: { tier: 'contain', reason: REASON } });
    await expect(h.routes.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });
});
