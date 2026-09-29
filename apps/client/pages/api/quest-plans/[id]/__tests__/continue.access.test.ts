/**
 * continueInSession re-checks owner/sharee and not-deleted in its write filter, so a revoke or
 * delete landing after the route's own check surfaces as a typed error from the repository. The
 * route must answer that as the refusal it is, not as a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, NotFoundError } from '@bike4mind/utils';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  postHandler: null as null | RouteHandler,
  planFindById: vi.fn(),
  continueInSession: vi.fn(),
  planUpdate: vi.fn(),
  questCreate: vi.fn(),
  sessionFindById: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (...fns: RouteHandler[]) => {
      h.postHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => undefined }));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => undefined }));
vi.mock('@bike4mind/services', () => ({ sessionService: { createSession: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  projectRepository: {},
  fabFileRepository: {},
  sessionRepository: { findById: h.sessionFindById, delete: vi.fn() },
  questRepository: { create: h.questCreate },
  questMasterPlanRepository: {
    findById: h.planFindById,
    continueInSession: h.continueInSession,
    update: h.planUpdate,
  },
}));

await import('../continue');

const USER = 'user-sharee';
const PLAN_ID = '64b7f0c2a1b2c3d4e5f60718';
const SESSION_ID = '64b7f0c2a1b2c3d4e5f60719';

const call = async () => {
  const { req, res } = createMocks({ method: 'POST', query: { id: PLAN_ID }, body: { sessionId: SESSION_ID } });
  (req as unknown as { user: { id: string } }).user = { id: USER };
  await h.postHandler!(req, res);
  return res;
};

describe('POST /api/quest-plans/[id]/continue write-time re-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sessionFindById.mockResolvedValue({ id: SESSION_ID, userId: USER });
    h.planFindById.mockResolvedValue({
      id: PLAN_ID,
      userId: 'user-owner',
      sharedWith: [USER],
      notebookId: SESSION_ID,
      state: 'paused',
      goal: 'Goal',
    });
  });

  it('answers 403 and does not auto-resume when access was revoked before the write', async () => {
    h.continueInSession.mockRejectedValue(new ForbiddenError('Access denied'));

    const res = await call();

    expect(res._getStatusCode()).toBe(403);
    expect(h.planUpdate).not.toHaveBeenCalled();
    expect(h.questCreate).not.toHaveBeenCalled();
  });

  it('answers 404 when the plan was deleted before the write', async () => {
    h.continueInSession.mockRejectedValue(new NotFoundError('Quest plan not found'));

    const res = await call();

    expect(res._getStatusCode()).toBe(404);
  });

  it('auto-resumes a paused plan with a targeted write after the gated one', async () => {
    h.continueInSession.mockResolvedValue({ id: PLAN_ID, state: 'paused', goal: 'Goal', metrics: {} });
    h.questCreate.mockResolvedValue({ id: 'q1', prompt: 'p' });

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(h.continueInSession).toHaveBeenCalledWith(PLAN_ID, SESSION_ID, USER);
    expect(h.planUpdate).toHaveBeenCalledWith({ id: PLAN_ID, state: 'active' });
  });
});
