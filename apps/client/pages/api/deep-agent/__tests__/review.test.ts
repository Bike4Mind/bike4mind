import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  denial: vi.fn(),
  loadCharter: vi.fn(),
  resolveBackend: vi.fn(),
  runReviewWake: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/server-utils/deepAgent/wakeMetering', () => ({ userAiAccessDenial: mocks.denial }));
vi.mock('@bike4mind/server-utils/deepAgent/store', () => ({
  MongoDeepAgentStore: class {
    loadCharter = mocks.loadCharter;
  },
}));
vi.mock('@bike4mind/server-utils/deepAgent/reviewWake', () => ({
  createLlmReviewStep: vi.fn(),
  runReviewWake: mocks.runReviewWake,
}));
vi.mock('@bike4mind/server-utils/deepAgent/missionSessionBridge', () => ({ bridgeReviewToSession: vi.fn() }));
vi.mock('@bike4mind/server-utils/deepAgent/resolveBackend', () => ({
  DEFAULT_WAKE_MODEL_ID: 'wake-model',
  resolveDeepAgentBackend: mocks.resolveBackend,
}));

import handler from '../review';

const SUSPENDED = 'Your account is suspended.';
const BODY = { agentId: 'agent-1', episodeId: 'episode-1' };

const call = async (user: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body: BODY });
  (req as Record<string, unknown>).user = user;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.denial.mockResolvedValue(SUSPENDED);
  mocks.loadCharter.mockResolvedValue({ identity: { ownerUserId: 'owner-1' } });
});

describe('POST /api/deep-agent/review account standing', () => {
  it('refuses a restricted mission owner before any reviewer model call', async () => {
    const res = await call({ id: 'admin-1', isAdmin: true });

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: SUSPENDED });
    expect(mocks.denial).toHaveBeenCalledWith('owner-1');
    expect(mocks.resolveBackend).not.toHaveBeenCalled();
    expect(mocks.runReviewWake).not.toHaveBeenCalled();
  });

  it('lets an owner in good standing through to the review', async () => {
    mocks.denial.mockResolvedValue(null);
    mocks.resolveBackend.mockResolvedValue({ llm: {}, modelId: 'wake-model' });
    mocks.runReviewWake.mockResolvedValue({ verdict: { verdict: 'approve' }, tierAdvanced: false });

    const res = await call({ id: 'owner-1', tags: ['developer'] });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.runReviewWake).toHaveBeenCalledTimes(1);
  });
});
