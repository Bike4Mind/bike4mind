import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  denial: vi.fn(),
  loadCharter: vi.fn(),
  enroll: vi.fn(),
  resolveBackend: vi.fn(),
  runWakeCycle: vi.fn(),
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
vi.mock('@bike4mind/server-utils/deepAgent/contributedToolbelts', () => ({}));
vi.mock('@bike4mind/server-utils/deepAgent/wakeMetering', () => ({ userAiAccessDenial: mocks.denial }));
vi.mock('@bike4mind/server-utils/deepAgent/enroll', () => ({ enrollDeepAgent: mocks.enroll }));
vi.mock('@bike4mind/server-utils/deepAgent/store', () => ({
  MongoDeepAgentStore: class {
    loadCharter = mocks.loadCharter;
  },
}));
vi.mock('@bike4mind/server-utils/deepAgent/llmSteps', () => ({ LlmWakeSteps: class {} }));
vi.mock('@bike4mind/server-utils/deepAgent/toolMaterializer', () => ({ createDeepAgentToolMaterializer: vi.fn() }));
vi.mock('@bike4mind/server-utils/deepAgent/resolveBackend', () => ({
  DEFAULT_WAKE_MODEL_ID: 'wake-model',
  resolveDeepAgentBackend: mocks.resolveBackend,
}));
vi.mock('@bike4mind/server-utils/deepAgent/missions', () => ({ loadLinkedAgentContext: vi.fn() }));
vi.mock('@bike4mind/server-utils/deepAgent/missionSessionBridge', () => ({ bridgeWakeToSession: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/thinkingVisibility', () => ({ resolveThinkingVisibilityForUserId: vi.fn() }));
vi.mock('@bike4mind/agents', () => ({
  createReActRunAct: vi.fn(),
  noopRunAct: vi.fn(),
  runWakeCycle: mocks.runWakeCycle,
}));

import handler from '../spin';

const SUSPENDED = 'Your account is suspended.';

const call = async (user: unknown, body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = user;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.denial.mockResolvedValue(SUSPENDED);
  mocks.loadCharter.mockResolvedValue({ identity: { ownerUserId: 'owner-1' } });
});

describe('POST /api/deep-agent/spin account standing', () => {
  it('refuses a re-wake for a restricted mission owner before any backend is built', async () => {
    const res = await call({ id: 'admin-1', isAdmin: true }, { agentId: 'agent-1' });

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: SUSPENDED });
    expect(mocks.denial).toHaveBeenCalledWith('owner-1');
    expect(mocks.resolveBackend).not.toHaveBeenCalled();
    expect(mocks.runWakeCycle).not.toHaveBeenCalled();
  });

  it('refuses a restricted caller before enrolling a new agent', async () => {
    const res = await call({ id: 'dev-1', tags: ['developer'] }, {});

    expect(res._getStatusCode()).toBe(403);
    expect(mocks.denial).toHaveBeenCalledWith('dev-1');
    expect(mocks.enroll).not.toHaveBeenCalled();
    expect(mocks.resolveBackend).not.toHaveBeenCalled();
  });

  it('lets a healthy owner through to the wake', async () => {
    mocks.denial.mockResolvedValue(null);
    mocks.resolveBackend.mockResolvedValue(null);

    const res = await call({ id: 'admin-1', isAdmin: true }, { agentId: 'agent-1' });

    expect(mocks.resolveBackend).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(500);
  });
});
