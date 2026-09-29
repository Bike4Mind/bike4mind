import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  planFindById: vi.fn(),
  planUpdate: vi.fn(),
  continueInSession: vi.fn(),
  sessionFindById: vi.fn(),
  questCreate: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: () => ({
      post: (...fns: ((req: unknown, res: unknown) => Promise<unknown>)[]) => {
        h.handler = fns[fns.length - 1];
        return {};
      },
    }),
  }),
}));

vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ sessionService: { createSession: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({
  questMasterPlanRepository: {
    findById: h.planFindById,
    update: h.planUpdate,
    continueInSession: h.continueInSession,
  },
  sessionRepository: { findById: h.sessionFindById },
  questRepository: { create: h.questCreate },
  agentRepository: {},
  projectRepository: {},
  fabFileRepository: {},
}));

await import('../continue');

const PLAN_ID = '64b000000000000000000001';
const SESSION_ID = '64b000000000000000000002';
const OTHER_SESSION_ID = '64b000000000000000000003';

describe('POST /api/quest-plans/[id]/continue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sessionFindById.mockResolvedValue({ id: SESSION_ID, userId: 'user-1' });
    h.continueInSession.mockResolvedValue({ id: PLAN_ID, goal: 'Goal', metrics: {} });
    h.questCreate.mockResolvedValue({ id: 'quest-1', prompt: 'p' });
  });

  it('resumes a paused plan by writing only its state, never the read-time notebookId', async () => {
    // A whole-doc write would put back every read-time field, e.g. a notebookId a concurrent
    // request had already swapped via atomicUpdateNotebookId.
    h.planFindById.mockResolvedValue({
      id: PLAN_ID,
      goal: 'Goal',
      userId: 'user-1',
      state: 'paused',
      notebookId: OTHER_SESSION_ID,
    });
    const json = vi.fn();

    await h.handler!(
      { user: { id: 'user-1' }, query: { id: PLAN_ID }, body: { sessionId: SESSION_ID } },
      { json, status: vi.fn(() => ({ json })) }
    );

    expect(h.planUpdate).toHaveBeenCalledTimes(1);
    expect(h.planUpdate).toHaveBeenCalledWith({ id: PLAN_ID, state: 'active' });
    expect(h.continueInSession).toHaveBeenCalledWith(PLAN_ID, SESSION_ID, 'user-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, sessionId: SESSION_ID }));
  });
});
