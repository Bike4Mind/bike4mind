// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  settings: vi.fn(),
  findByMainModel: vi.fn(),
  generate: vi.fn(),
  save: vi.fn(),
  findResultByQuestId: vi.fn(),
  findResultsBySession: vi.fn(),
  deleteResult: vi.fn(),
  process: vi.fn(),
  questFindById: vi.fn(),
}));

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain: Record<string, unknown> & Route = Object.assign(
      async (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (fn: Route) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));
vi.mock('@bike4mind/database/ai', () => ({
  rapidReplyAuditLogRepository: { createLog: vi.fn(async () => null) },
  rapidReplyPromptRepository: { findByModelPair: vi.fn(async () => []) },
  rapidReplyMappingRepository: { findByMainModel: h.findByMainModel },
}));
vi.mock('@bike4mind/database/infra', () => ({ adminSettingsRepository: { getSettingsValue: h.settings } }));
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { create: vi.fn(async () => ({ id: 'session-1' })), delete: vi.fn() },
  rapidReplyResultRepository: {
    findByQuestId: h.findResultByQuestId,
    findBySessionId: h.findResultsBySession,
    delete: h.deleteResult,
  },
}));
vi.mock('@bike4mind/services/llm', () => ({
  ChatCompletionProcess: class {
    db = {
      quests: {
        create: vi.fn(async () => ({ id: 'quest-1' })),
        findById: h.questFindById,
        find: vi.fn(async () => []),
        delete: vi.fn(),
      },
    };
    process = h.process;
  },
}));
vi.mock('@bike4mind/utils', () => ({ SQSService: vi.fn() }));
vi.mock('@bike4mind/server-utils/auth/turnAuth', () => ({ requestTurnAuth: vi.fn(() => ({})) }));
vi.mock('@bike4mind/server-utils/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: vi.fn(() => ({})),
  getSharedTokenizer: vi.fn(),
}));
vi.mock('@server/rapidReply/generateRapidReply', () => ({
  generateRapidReply: h.generate,
  saveRapidReplyResult: h.save,
}));
vi.mock('@bike4mind/server-utils/billing/meterPlatformCompletion', () => ({ createRequestCompletionMeter: vi.fn() }));

import testRun from '../test';

const MAIN_REPLY = 'A long main-model answer. '.repeat(50);
const mapping = {
  id: 'm1',
  mainModelId: 'main-a',
  rapidModelId: 'rapid-a',
  enabled: true,
  systemPrompt: 'ack it',
  maxTokens: 10,
  maxLatency: 2000,
  usageCount: 1,
};

const run = async (body: Record<string, unknown> = { mainModelId: 'main-a', testInput: 'Hello there' }) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, {
    user: { id: 'admin-1', isAdmin: true, email: 'a@example.com' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await (testRun as unknown as Route)(req, res);
  return res._getJSONData();
};

beforeEach(() => {
  vi.clearAllMocks();
  h.settings.mockImplementation(async (key: string) =>
    key === 'EnableRapidReply' ? true : { maxAcceptableLatency: 2000 }
  );
  h.findByMainModel.mockResolvedValue(mapping);
  h.generate.mockResolvedValue({ status: 'generated', content: 'On it.', modelId: 'rapid-a', latency: 300 });
  h.findResultsBySession.mockResolvedValue([{ id: 'result-1' }]);
  h.process.mockResolvedValue(undefined);
  h.questFindById.mockResolvedValue({
    id: 'quest-1',
    reply: MAIN_REPLY,
    promptMeta: { performance: { firstTokenTime: 2112, firstChunkTime: 2000 } },
  });
});

describe('rapid reply admin test run', () => {
  it('reports the saved rapid reply result, and the main model timing separately', async () => {
    h.findResultByQuestId.mockResolvedValue({ rapidResponse: { content: 'On it.', latency: 300, ttfvt: 300 } });

    const data = await run();

    expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({ mapping, message: 'Hello there' }));
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ questId: 'quest-1', sessionId: 'session-1' }));
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.process.mock.invocationCallOrder[0]);
    expect(h.process.mock.calls[0][0].body.message).toBe('Hello there');
    expect(data.success).toBe(true);
    expect(data.testResults.rapidReplyTest).toMatchObject({ success: true, response: 'On it.', responseLength: 6 });
    expect(data.testResults.performance).toMatchObject({
      latency: 300,
      ttfvt: 300,
      mainModelTtfvt: 2112,
      latencyCheck: { passed: true },
    });
    expect(h.deleteResult).toHaveBeenCalledWith('result-1');
  });

  it('fails without reporting the main reply when no rapid reply result was saved', async () => {
    h.findResultByQuestId.mockResolvedValue(null);

    const data = await run();

    expect(data.success).toBe(false);
    expect(data.testResults.rapidReplyTest).toMatchObject({ success: false, response: null });
    expect(data.testResults.rapidReplyTest.error).toContain('No rapid reply result was saved');
    expect(data.testResults.performance).toMatchObject({ latency: 0, ttfvt: 0, latencyCheck: { passed: false } });
    expect(JSON.stringify(data)).not.toContain('main-model answer');
  });

  it('fails with a clear message and skips the main run when the rapid model cannot run', async () => {
    h.generate.mockResolvedValue({ status: 'skipped', reason: 'model_unavailable' });

    const data = await run();

    expect(data.success).toBe(false);
    expect(data.testResults.rapidReplyTest.error).toContain('rapid-a is not available');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.process).not.toHaveBeenCalled();
  });

  it('keeps the rapid result when the main model run fails', async () => {
    h.findResultByQuestId.mockResolvedValue({ rapidResponse: { content: 'On it.', latency: 300, ttfvt: 300 } });
    h.process.mockRejectedValue(new Error('main down'));

    const data = await run();

    expect(data.success).toBe(true);
    expect(data.testResults.rapidReplyTest.response).toBe('On it.');
    expect(data.testResults.performance).toMatchObject({ mainModelError: 'main down' });
    expect(data.recommendations.join(' ')).toContain('The main model run failed: main down');
  });
  it('reports an empty rapid response and never starts the main run', async () => {
    h.generate.mockResolvedValue({ status: 'skipped', reason: 'empty_response' });

    const data = await run();

    expect(data.success).toBe(false);
    expect(data.testResults.rapidReplyTest.error).toContain('returned an empty response');
    expect(data.testResults.performance.latencyCheck.passed).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.process).not.toHaveBeenCalled();
  });

  it('reports a persistence failure and never runs the main model without its rapid result', async () => {
    h.save.mockRejectedValueOnce(new Error('Rapid result write failed'));

    const data = await run();

    expect(data.success).toBe(false);
    expect(data.testResults.rapidReplyTest).toMatchObject({
      response: null,
      error: 'Rapid result write failed',
    });
    expect(h.process).not.toHaveBeenCalled();
    expect(h.deleteResult).toHaveBeenCalledWith('result-1');
  });
});
