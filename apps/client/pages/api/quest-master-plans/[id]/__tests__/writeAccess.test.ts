/**
 * Each plan-mutation route hands the caller's id to a repository write whose filter re-checks
 * owner/sharee and not-deleted (writableBy in QuestMasterPlanModel.ts). A null from that write is a
 * revoke or delete landing after verifyQuestPlanWriteAccess, and must surface as a 404 rather than a
 * 200 carrying `plan: null`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/common';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  postHandler: null as null | RouteHandler,
  repo: {
    addBlocker: vi.fn(),
    addDecision: vi.fn(),
    updateHandoff: vi.fn(),
    resolveBlocker: vi.fn(),
    updateReviewGate: vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>,
  verify: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({ questMasterPlanRepository: h.repo }));
vi.mock('@server/utils/questMasterPlanAccess', () => ({
  verifyQuestPlanWriteAccess: h.verify,
  QUEST_ID_PATTERN: /^[a-zA-Z0-9_.-]+$/,
}));

const USER = 'user-sharee';
const PLAN_ID = '64b7f0c2a1b2c3d4e5f60718';

const routes = [
  ['blockers', 'addBlocker', { description: 'stuck' }],
  ['decisions', 'addDecision', { description: 'd', rationale: 'r', madeBy: 'me' }],
  ['handoff', 'updateHandoff', { summary: 's', nextSteps: [], pendingDecisions: [], blockers: [] }],
  ['resolve-blocker', 'resolveBlocker', { blockerId: 'b1', resolution: 'done' }],
  ['review-gate', 'updateReviewGate', { questId: 'q1', subQuestId: 'sq1', reviewStatus: 'approved' }],
] as const;

describe.each(routes)('POST /api/quest-master-plans/[id]/%s', (route, method, body) => {
  let handler: RouteHandler;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.verify.mockResolvedValue({
      id: PLAN_ID,
      blockers: [{ id: 'b1' }],
      quests: [{ id: 'q1', subQuests: [{ id: 'sq1' }] }],
    });
    await import(`../${route}.ts`);
    handler = h.postHandler!;
  });

  const call = async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: PLAN_ID }, body });
    (req as unknown as { user: { id: string } }).user = { id: USER };
    await handler(req, res);
    return res;
  };

  it('passes the caller to the gated write', async () => {
    h.repo[method].mockResolvedValue({ id: PLAN_ID });

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(h.repo[method].mock.calls[0].slice(0, 2)).toEqual([PLAN_ID, USER]);
  });

  it('answers 404 when the gated write matches nothing', async () => {
    h.repo[method].mockResolvedValue(null);

    await expect(call()).rejects.toThrow(NotFoundError);
  });
});
