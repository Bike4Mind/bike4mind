import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const {
  mockResolveAccessibleLakes,
  mockBuildDataLakeTools,
  mockGetEffectiveLLMApiKeys,
  mockAgentRun,
  mockReplSessionCtor,
  mockRecordReplSandboxUnavailable,
} = vi.hoisted(() => ({
  mockResolveAccessibleLakes: vi.fn(),
  mockBuildDataLakeTools: vi.fn(),
  mockGetEffectiveLLMApiKeys: vi.fn(),
  mockAgentRun: vi.fn(),
  // Captures the options the route asks for. The executor it picks is the
  // whole security posture of this endpoint, so it has to be observable.
  mockReplSessionCtor: vi.fn(),
  mockRecordReplSandboxUnavailable: vi.fn(),
}));

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
    constructor(opts: unknown) {
      mockReplSessionCtor(opts);
    }
    setTools = vi.fn();
    getUsage = () => ({ executions: 0, subLlmCalls: 0, totalCostUsd: 0 });
    dispose = vi.fn();
  },
  BudgetExceededError: class extends Error {},
  makeCodeExecuteTool: vi.fn(() => ({ name: 'code_execute' })),
  recordReplSandboxUnavailable: mockRecordReplSandboxUnavailable,
}));

import handler from '../rlm-answer';
import { SUB_LLM_HTTP_TIMEOUT_MS } from '@server/tavern/rlm/timeouts';

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

/**
 * The endpoint runs LLM-authored JavaScript in the process that holds the
 * platform's credentials, so which executor it asks for IS its security
 * posture. These pin that choice and the refusal behaviour when the sandbox
 * cannot be built, both of which are otherwise invisible to every other test
 * in this file.
 */
describe('POST /api/data-lakes/rlm-answer - REPL sandbox posture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ anthropic: 'sk-test' });
    mockBuildDataLakeTools.mockReturnValue({});
    mockAgentRun.mockResolvedValue({
      finalAnswer: 'ok',
      steps: [],
      completionInfo: { iterations: 1, toolCalls: 0, reachedMaxIterations: false },
    });
  });

  it('runs guest code in an isolated-vm isolate, never a shared-realm backend', async () => {
    const res = await call({ authorization: 'Bearer caller.jwt.token' });

    expect(res.statusCode).toBe(200);
    expect(mockReplSessionCtor).toHaveBeenCalledTimes(1);
    expect(mockReplSessionCtor.mock.calls[0][0]).toMatchObject({ executor: 'isolated' });
  });

  it("caps a single code_execute step well below the route's own request timeout", async () => {
    // The REPL-level caps (isolate timeout + host deadline) only mean anything
    // if they fire BEFORE the 55s request abort. Set above it and a stalled step
    // costs the caller the whole request instead of costing the agent one
    // observation it can see and route around.
    await call({ authorization: 'Bearer caller.jwt.token' });

    const { perCallTimeoutMs } = mockReplSessionCtor.mock.calls[0][0] as { perCallTimeoutMs: number };
    expect(perCallTimeoutMs).toBeGreaterThan(0);
    expect(perCallTimeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('gives subAgentQuery a dispatch floor equal to its own HTTP rung', async () => {
    // The bound a tool gets is min(toolTimeoutMs, run time left), so it decays
    // across a run and crosses under SUB_LLM_HTTP_TIMEOUT_MS about 7s in. Past
    // that the dispatcher would abandon the await mid-generation: the
    // reservation settles after getUsage() has been snapshotted and the session
    // disposed, so the spend is booked where nobody reads it. The floor makes
    // the executor refuse instead. Asserted against the constant, not a
    // literal, so the two cannot drift apart.
    await call({ authorization: 'Bearer caller.jwt.token' });

    expect(mockReplSessionCtor.mock.calls[0][0]).toMatchObject({
      executorOptions: { toolMinBudgetMs: { subAgentQuery: SUB_LLM_HTTP_TIMEOUT_MS } },
    });
  });

  it('refuses the request when the sandbox cannot be constructed, rather than falling back', async () => {
    // A missing native addon is the realistic cause. The endpoint must fail
    // closed: no agent run, no guest code next to the credentials.
    mockReplSessionCtor.mockImplementationOnce(() => {
      throw new Error('No native build was found for isolated-vm');
    });

    const res = await call({ authorization: 'Bearer caller.jwt.token' });

    expect(res.statusCode).toBe(503);
    expect(mockAgentRun).not.toHaveBeenCalled();
    // The reason must not leak the internal error text to the caller.
    expect(JSON.stringify(res.body)).not.toContain('native build');
    // A 503 reads as transient to everything upstream, so the metric is the
    // only thing that distinguishes "the addon is missing from this build".
    expect(mockRecordReplSandboxUnavailable).toHaveBeenCalledWith('rlm-answer', expect.anything());
  });

  it('emits nothing on the happy path, so the alarm tracks the degrade and not traffic', async () => {
    await call({ authorization: 'Bearer caller.jwt.token' });

    expect(mockRecordReplSandboxUnavailable).not.toHaveBeenCalled();
  });
});
