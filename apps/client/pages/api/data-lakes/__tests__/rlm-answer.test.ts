import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockResolveAccessibleLakes, mockBuildDataLakeTools, mockGetEffectiveLLMApiKeys, mockAgentRun } = vi.hoisted(
  () => ({
    mockResolveAccessibleLakes: vi.fn(),
    mockBuildDataLakeTools: vi.fn(),
    mockGetEffectiveLLMApiKeys: vi.fn(),
    mockAgentRun: vi.fn(),
  })
);

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: unknown, _res: unknown) => undefined }));
vi.mock('@server/dataLakes', () => ({ resolveAccessibleLakes: mockResolveAccessibleLakes }));
// The seam under test: whatever credential the route resolves lands here.
vi.mock('@server/tavern/rlm/tools', () => ({ buildDataLakeTools: mockBuildDataLakeTools }));
vi.mock('@server/tavern/rlm/dataLakeReplPrompts', () => ({ REPL_TOOL_SYSTEM_PROMPT: 'repl-prompt' }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, apiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn(async () => [{ id: 'global.anthropic.claude-sonnet-4-6' }]),
  getLlmByModel: vi.fn(() => ({})),
}));
vi.mock('@bike4mind/agents', () => ({
  ReActAgent: class {
    run = mockAgentRun;
  },
  ReplSession: class {
    setTools = vi.fn();
    getUsage = () => ({ executions: 0, subLlmCalls: 0, totalCostUsd: 0 });
    dispose = vi.fn();
  },
  BudgetExceededError: class extends Error {},
  makeCodeExecuteTool: vi.fn(() => ({ name: 'code_execute' })),
}));

import handler from '../rlm-answer';

type Json = Record<string, unknown>;

function makeReqRes(headers: Record<string, string>) {
  const res = {
    statusCode: 200,
    body: undefined as Json | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Json) {
      this.body = payload;
      return this;
    },
  };
  const req = {
    headers,
    body: { query: 'who contradicts whom?' },
    user: { id: 'user-1' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { req, res };
}

const call = (headers: Record<string, string>) => {
  const { req, res } = makeReqRes(headers);
  // The mocked baseApi chain returns the raw handler, so `.post` IS the function.
  return (handler as unknown as (r: unknown, s: unknown) => Promise<unknown>)(req, res).then(() => res);
};

describe('POST /api/data-lakes/rlm-answer - in-REPL retrieval credential', () => {
  const originalLocalApiKey = process.env.B4M_LOCAL_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.B4M_LOCAL_API_KEY;
    mockResolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ anthropic: 'sk-test' });
    mockBuildDataLakeTools.mockReturnValue({});
    mockAgentRun.mockResolvedValue({
      finalAnswer: 'ok',
      steps: [],
      completionInfo: { iterations: 1, toolCalls: 0, reachedMaxIterations: false },
    });
  });

  afterEach(() => {
    if (originalLocalApiKey === undefined) delete process.env.B4M_LOCAL_API_KEY;
    else process.env.B4M_LOCAL_API_KEY = originalLocalApiKey;
  });

  const forwardedHeaders = () => mockBuildDataLakeTools.mock.calls[0][0].authHeaders;

  it('forwards a browser/JWT caller own Authorization header into the REPL tools', async () => {
    const res = await call({ authorization: 'Bearer caller.jwt.token' });

    expect(res.statusCode).toBe(200);
    expect(forwardedHeaders()).toEqual({ authorization: 'Bearer caller.jwt.token' });
    expect(forwardedHeaders()['x-api-key']).toBeUndefined();
  });

  it('forwards an api-key caller own key into the REPL tools', async () => {
    const res = await call({ 'x-api-key': 'b4m_caller_key' });

    expect(res.statusCode).toBe(200);
    expect(forwardedHeaders()).toEqual({ 'x-api-key': 'b4m_caller_key' });
  });

  it('fails closed when the request carries no forwardable credential', async () => {
    const res = await call({ cookie: 'session=1' });

    expect(res.statusCode).toBe(401);
    expect(mockBuildDataLakeTools).not.toHaveBeenCalled();
  });

  // The trap this route used to sit in: the credential-less path 500'd, and setting
  // B4M_LOCAL_API_KEY was the obvious way to "fix" it - which would have run every
  // in-REPL retrieval as that key's principal instead of the caller's.
  it('never substitutes B4M_LOCAL_API_KEY for the caller identity', async () => {
    process.env.B4M_LOCAL_API_KEY = 'b4m_shared_service_key';

    const credentialless = await call({ cookie: 'session=1' });
    expect(credentialless.statusCode).toBe(401);
    expect(mockBuildDataLakeTools).not.toHaveBeenCalled();

    const jwtCaller = await call({ authorization: 'Bearer caller.jwt.token' });
    expect(jwtCaller.statusCode).toBe(200);
    expect(forwardedHeaders()).toEqual({ authorization: 'Bearer caller.jwt.token' });
    expect(JSON.stringify(forwardedHeaders())).not.toContain('b4m_shared_service_key');
  });
});
