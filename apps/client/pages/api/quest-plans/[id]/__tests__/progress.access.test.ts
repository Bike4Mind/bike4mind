/**
 * updateQuestProgress re-checks owner/sharee and not-deleted in its write filter (writableBy in
 * QuestMasterPlanModel.ts). A null from it is a revoke or delete landing after
 * verifyQuestPlanWriteAccess, and must surface as a 404 rather than a 200 carrying `plan: null`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/common';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  patchHandler: null as null | RouteHandler,
  updateQuestProgress: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    patch: (...fns: RouteHandler[]) => {
      h.patchHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => undefined }));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({
  questMasterPlanRepository: { updateQuestProgress: h.updateQuestProgress },
}));
vi.mock('@server/utils/questMasterPlanAccess', () => ({ verifyQuestPlanWriteAccess: h.verify }));

await import('../progress');

const USER = 'user-sharee';
const PLAN_ID = '64b7f0c2a1b2c3d4e5f60718';

const call = async () => {
  const { req, res } = createMocks({
    method: 'PATCH',
    query: { id: PLAN_ID },
    body: { questId: 'q1', subQuestId: 'sq1', status: 'in_progress' },
  });
  (req as unknown as { user: { id: string } }).user = { id: USER };
  await h.patchHandler!(req, res);
  return res;
};

describe('PATCH /api/quest-plans/[id]/progress write-time re-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.verify.mockResolvedValue({ id: PLAN_ID, quests: [{ id: 'q1', subQuests: [{ id: 'sq1' }] }] });
  });

  it('passes the caller to the gated write', async () => {
    h.updateQuestProgress.mockResolvedValue({ id: PLAN_ID, metrics: {} });

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(h.updateQuestProgress).toHaveBeenCalledWith(
      PLAN_ID,
      USER,
      'q1',
      'sq1',
      expect.objectContaining({ status: 'in_progress' }),
      { autoResumeIfPaused: true }
    );
  });

  it('answers 404 when the gated write matches nothing', async () => {
    h.updateQuestProgress.mockResolvedValue(null);

    await expect(call()).rejects.toThrow(NotFoundError);
  });
});
