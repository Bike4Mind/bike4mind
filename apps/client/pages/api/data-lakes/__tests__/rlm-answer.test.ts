import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenError, TooManyRequestsError, insufficientCreditsError } from '@bike4mind/common';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const {
  mockAdmitRequestCompletion,
  mockQuotaRelease,
  mockResolveAccessibleLakes,
  mockBuildDataLakeTools,
  mockGetEffectiveLLMApiKeys,
  mockAgentRun,
  mockAgentCtor,
  mockReplSessionCtor,
  mockRecordReplSandboxUnavailable,
  meter,
} = vi.hoisted(() => ({
  mockAdmitRequestCompletion: vi.fn(),
  mockQuotaRelease: vi.fn(),
  mockResolveAccessibleLakes: vi.fn(),
  mockBuildDataLakeTools: vi.fn(),
  mockGetEffectiveLLMApiKeys: vi.fn(),
  mockAgentRun: vi.fn(),
  mockAgentCtor: vi.fn(),
  // Captures the options the route asks for. The executor it picks is the
  // whole security posture of this endpoint, so it has to be observable.
  mockReplSessionCtor: vi.fn(),
  mockRecordReplSandboxUnavailable: vi.fn(),
  meter: {
    denied: new Set<string>(),
    refund: vi.fn(),
    reserve: vi.fn(),
    settle: vi.fn(),
    replCostUsd: 0,
    replPromptTokens: 0,
    replCompletionTokens: 0,
    // The agent's running totals, read by the route when agent.run throws.
    checkpoint: { totalInputTokens: 0, totalOutputTokens: 0 },
  },
}));
mockAdmitRequestCompletion.mockImplementation(async () => ({ release: mockQuotaRelease }));
vi.mock('@server/utils/untrustedCompletionQuota', () => ({
  admitRequestCompletion: mockAdmitRequestCompletion,
}));

meter.reserve.mockImplementation(async () => ({ reservedCredits: 10, refund: meter.refund }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ blockedAtZeroTierLimit: (n: number) => n }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown) => undefined,
}));
vi.mock('@server/dataLakes', () => ({ resolveAccessibleLakes: mockResolveAccessibleLakes }));
// The seam under test: whatever credential the route resolves lands here.
vi.mock('@server/tavern/rlm/tools', () => ({ buildDataLakeTools: mockBuildDataLakeTools }));
vi.mock('@server/tavern/rlm/dataLakeReplPrompts', () => ({ REPL_TOOL_SYSTEM_PROMPT: 'repl-prompt' }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, apiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => [
    { id: 'global.anthropic.claude-sonnet-4-6', type: 'text', pricing: { 200_000: { input: 3e-6, output: 15e-6 } } },
  ]),
  getLlmByModel: vi.fn(() => ({})),
}));
vi.mock('@bike4mind/agents', () => ({
  ReActAgent: class {
    constructor(context: unknown) {
      mockAgentCtor(context);
    }
    run = mockAgentRun;
    toCheckpoint = () => meter.checkpoint;
  },
  ReplSession: class {
    constructor(opts: unknown) {
      mockReplSessionCtor(opts);
    }
    setTools = vi.fn();
    getUsage = () => ({
      executions: 0,
      subLlmCalls: 0,
      totalCostUsd: meter.replCostUsd,
      promptTokens: meter.replPromptTokens,
      completionTokens: meter.replCompletionTokens,
    });
    dispose = vi.fn();
  },
  BudgetExceededError: class extends Error {},
  makeCodeExecuteTool: vi.fn(() => ({ name: 'code_execute' })),
  recordReplSandboxUnavailable: mockRecordReplSandboxUnavailable,
}));

vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 1000 }));
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'none') }));
// Balance mechanics are covered in meterPlatformCompletion.test.ts; this pins the route's call order.
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: async () => ({
    admits: async (id: string) => !meter.denied.has(id),
    assert: async (id: string) => {
      if (meter.denied.has(id)) throw new ForbiddenError(`Model "${id}" is not accessible and no fallback available`);
    },
  }),
  reserveCompletionCredits: (...args: unknown[]) => meter.reserve(...args),
  completionUsd: (_model: unknown, u: { inputTokens?: number; outputTokens?: number }) =>
    (u.inputTokens ?? 0) * 0.001 + (u.outputTokens ?? 0) * 0.002,
  settleCompletion: (_reservation: unknown, _req: unknown, charge: unknown) => meter.settle(charge),
}));

import { getAvailableModels } from '@bike4mind/llm-adapters';
import handler from '../rlm-answer';
import { SUB_LLM_HTTP_TIMEOUT_MS } from '@server/tavern/rlm/timeouts';

type Json = Record<string, unknown>;

function makeReqRes(headers: Record<string, string>, body: Json = { query: 'who contradicts whom?' }) {
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
    body,
    user: { id: 'user-1' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { req, res };
}

const call = (headers: Record<string, string>, body?: Json) => {
  const { req, res } = makeReqRes(headers, body);
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

  it("runs the agent at the caller's thinking visibility", async () => {
    const res = await call({ authorization: 'Bearer caller.jwt.token' });

    expect(res.statusCode).toBe(200);
    expect(mockAgentCtor).toHaveBeenCalledWith(expect.objectContaining({ thinkingVisibility: 'none' }));
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

describe('POST /api/data-lakes/rlm-answer - metering', () => {
  const MODEL = 'global.anthropic.claude-sonnet-4-6';

  beforeEach(() => {
    vi.clearAllMocks();
    meter.denied.clear();
    meter.replCostUsd = 0.25;
    meter.replPromptTokens = 0;
    meter.replCompletionTokens = 0;
    meter.checkpoint = { totalInputTokens: 0, totalOutputTokens: 0 };
    mockResolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ anthropic: 'sk-test' });
    mockBuildDataLakeTools.mockReturnValue({});
    mockAgentRun.mockResolvedValue({
      finalAnswer: 'ok',
      steps: [],
      completionInfo: {
        iterations: 2,
        toolCalls: 1,
        reachedMaxIterations: false,
        totalInputTokens: 1000,
        totalOutputTokens: 300,
      },
    });
  });

  it('refuses a zero-credit caller with 422 and never runs the agent', async () => {
    meter.reserve.mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits.'));

    await expect(call({ authorization: 'Bearer t' })).rejects.toMatchObject({ statusCode: 422 });
    expect(mockAgentRun).not.toHaveBeenCalled();
  });

  it('403s a model the user is not admitted to, before reserving or running the agent', async () => {
    meter.denied.add(MODEL);

    await expect(call({ authorization: 'Bearer t' })).rejects.toMatchObject({ statusCode: 403 });
    expect(meter.reserve).not.toHaveBeenCalled();
    expect(mockAgentRun).not.toHaveBeenCalled();
  });

  it('400s an explicit model missing from the catalog instead of substituting one', async () => {
    await expect(call({ authorization: 'Bearer t' }, { query: 'q', model: 'not-a-model' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(meter.reserve).not.toHaveBeenCalled();
    expect(mockAgentRun).not.toHaveBeenCalled();
  });

  it('skips a refused default and runs the next admitted fallback', async () => {
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      { id: MODEL, pricing: { 200_000: { input: 3e-6, output: 15e-6 } } },
      { id: 'other-sonnet', type: 'text', pricing: { 200_000: { input: 3e-6, output: 15e-6 } } },
    ] as never);
    meter.denied.add(MODEL);

    const res = await call({ authorization: 'Bearer t' });

    expect(res.statusCode).toBe(200);
    expect(res.body?.model).toBe('other-sonnet');
  });

  it('never falls back to a non-text model', async () => {
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      { id: MODEL, type: 'text', pricing: { 200_000: { input: 3e-6, output: 15e-6 } } },
      { id: 'an-image-model', type: 'image' },
    ] as never);
    meter.denied.add(MODEL);

    await expect(call({ authorization: 'Bearer t' })).rejects.toMatchObject({ statusCode: 403 });
    expect(meter.reserve).not.toHaveBeenCalled();
  });

  it('403s only when no fallback candidate is admitted', async () => {
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      { id: MODEL, pricing: { 200_000: { input: 3e-6, output: 15e-6 } } },
      { id: 'other-sonnet', type: 'text', pricing: { 200_000: { input: 3e-6, output: 15e-6 } } },
    ] as never);
    meter.denied.add(MODEL);
    meter.denied.add('other-sonnet');

    await expect(call({ authorization: 'Bearer t' })).rejects.toMatchObject({ statusCode: 403 });
    expect(meter.reserve).not.toHaveBeenCalled();
  });

  it('sizes the root ceiling on the execution budget, since a turn may run many tool calls', async () => {
    await call({ authorization: 'Bearer t' }, { query: 'q', budget: { max_executions: 10, max_cost_usd: 1 } });
    await call({ authorization: 'Bearer t' }, { query: 'q', budget: { max_executions: 100, max_cost_usd: 1 } });

    const [few, many] = meter.reserve.mock.calls.map(c => c[1] as number);
    // 90 more executions, each re-read by up to 4 turns at 3000 tokens, at $3/MTok.
    expect(many - few).toBeCloseTo(90 * 4 * 3000 * 3e-6, 6);
  });

  it('charges the root ceiling when a completed run reports no root usage', async () => {
    mockAgentRun.mockResolvedValueOnce({
      finalAnswer: 'ok',
      steps: [],
      completionInfo: { iterations: 1, toolCalls: 0, reachedMaxIterations: false },
    });

    await call({ authorization: 'Bearer t' });

    const reservedUsd = meter.reserve.mock.calls[0][1] as number;
    // The reservation is the root ceiling plus the $5 default sub-LLM budget.
    expect(meter.settle).toHaveBeenCalledWith(expect.objectContaining({ usd: reservedUsd - 5 + 0.25 }));
  });

  it('reserves the root provider output cap including Gemini thinking headroom', async () => {
    const thinkingModel = {
      id: 'gemini-test',
      type: 'text',
      backend: 'gemini',
      can_think: true,
      max_tokens: 65536,
      pricing: { 200_000: { input: 3e-6, output: 15e-6 } },
    };
    vi.mocked(getAvailableModels).mockResolvedValueOnce([thinkingModel as never]);

    await call(
      { authorization: 'Bearer jwt' },
      { query: 'Compare the evidence', model: thinkingModel.id, max_iterations: 1 }
    );

    const rootInputTokens = 1000 + 4 * 2 * (4096 + 16000) + 4 * 25 * 3000;
    expect(meter.reserve.mock.calls[0][1]).toBeCloseTo(5 + rootInputTokens * 3e-6 + (4096 + 16000) * 15e-6);
  });

  it('reserves the root ceiling plus the whole sub-LLM budget', async () => {
    await call({ authorization: 'Bearer t' });

    // The default budget is the $5 hard cap; the root ceiling sits on top of it.
    expect(meter.reserve.mock.calls[0][1]).toBeGreaterThan(5);
  });

  it('settles root usage plus sub-LLM spend', async () => {
    const res = await call({ authorization: 'Bearer t' });

    expect(res.statusCode).toBe(200);
    expect(meter.reserve).toHaveBeenCalledBefore(mockAgentRun);
    expect(meter.settle).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(/^rlm-answer-/),
      model: MODEL,
      usd: 1000 * 0.001 + 300 * 0.002 + 0.25,
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    });
  });

  it.each(['success', 'failure'] as const)('records root cache and sub-LLM tokens after %s', async outcome => {
    meter.replPromptTokens = 10_000;
    meter.replCompletionTokens = 500;
    const rootUsage = {
      totalInputTokens: 1000,
      totalOutputTokens: 300,
      totalCacheReadTokens: 200,
      totalCacheWriteTokens: 50,
    };
    if (outcome === 'failure') {
      meter.checkpoint = rootUsage;
      mockAgentRun.mockRejectedValueOnce(new Error('provider down'));
    } else {
      mockAgentRun.mockResolvedValueOnce({ finalAnswer: 'ok', steps: [], completionInfo: rootUsage });
    }

    await call({ 'x-api-key': 'personal-key' });

    expect(meter.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 11_000,
        outputTokens: 800,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
      })
    );
  });

  it('settles the root turns that completed plus sub-LLM spend when the agent throws', async () => {
    meter.checkpoint = { totalInputTokens: 4000, totalOutputTokens: 500 };
    mockAgentRun.mockRejectedValueOnce(new Error('provider down'));

    const res = await call({ authorization: 'Bearer t' });

    expect(res.statusCode).toBe(500);
    expect(meter.settle).toHaveBeenCalledWith(
      expect.objectContaining({ usd: 4000 * 0.001 + 500 * 0.002 + 0.25, inputTokens: 4000, outputTokens: 500 })
    );
  });

  it('refunds in full when the sandbox cannot be constructed', async () => {
    mockReplSessionCtor.mockImplementationOnce(() => {
      throw new Error('No native build was found for isolated-vm');
    });

    await call({ authorization: 'Bearer t' });

    expect(meter.refund).toHaveBeenCalledTimes(1);
    expect(meter.settle).not.toHaveBeenCalled();
  });

  it('refunds in full when agent setup throws after the reservation', async () => {
    mockBuildDataLakeTools.mockImplementationOnce(() => {
      throw new Error('tool wiring failed');
    });

    await expect(call({ authorization: 'Bearer t' })).rejects.toThrow('tool wiring failed');
    expect(meter.refund).toHaveBeenCalledTimes(1);
    expect(meter.settle).not.toHaveBeenCalled();
    expect(mockAgentRun).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/rlm-answer - completion quotas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    meter.denied.clear();
    mockResolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ anthropic: 'sk-test' });
    mockBuildDataLakeTools.mockReturnValue({});
    mockAgentRun.mockResolvedValue({
      finalAnswer: 'ok',
      steps: [],
      completionInfo: {
        iterations: 1,
        toolCalls: 0,
        reachedMaxIterations: false,
        totalInputTokens: 10,
        totalOutputTokens: 1,
      },
    });
  });

  it('checks the request credential before any provider setup or credit reservation', async () => {
    mockAdmitRequestCompletion.mockRejectedValueOnce(
      new TooManyRequestsError('Token quota exceeded', { errorCode: 'token_rate_limit_exceeded', retryAfter: 12 })
    );

    await expect(call({ 'x-api-key': 'test-key' })).rejects.toMatchObject({
      statusCode: 429,
      additionalInfo: { errorCode: 'token_rate_limit_exceeded', retryAfter: 12 },
    });
    expect(mockGetEffectiveLLMApiKeys).not.toHaveBeenCalled();
    expect(meter.reserve).not.toHaveBeenCalled();
    expect(mockAgentRun).not.toHaveBeenCalled();
    expect(mockQuotaRelease).not.toHaveBeenCalled();
  });

  it('passes a JWT request to the credential-aware admission helper', async () => {
    await call({ authorization: 'Bearer jwt' });
    expect(mockAdmitRequestCompletion).toHaveBeenCalledWith(expect.objectContaining({ user: { id: 'user-1' } }), {
      holdSlot: true,
    });
    expect(mockAgentRun).toHaveBeenCalledOnce();
  });

  it('holds its slot until the agent and usage settlement finish', async () => {
    const { req, res } = makeReqRes({ 'x-api-key': 'test-key' });
    const apiKeyRequest = { ...req, apiKeyInfo: { keyId: 'key-1' } };
    let finishRun: (result: unknown) => void = () => undefined;
    mockAgentRun.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRun = resolve;
        })
    );
    const pending = (handler as unknown as (request: unknown, response: unknown) => Promise<unknown>)(
      apiKeyRequest,
      res
    );
    await vi.waitFor(() => expect(mockAgentRun).toHaveBeenCalled());
    expect(mockAdmitRequestCompletion).toHaveBeenCalledWith(apiKeyRequest, { holdSlot: true });
    expect(mockQuotaRelease).not.toHaveBeenCalled();
    finishRun({ finalAnswer: 'ok', steps: [], completionInfo: { iterations: 1, toolCalls: 0 } });
    await pending;
    expect(meter.settle).toHaveBeenCalledBefore(mockQuotaRelease);
    expect(mockQuotaRelease).toHaveBeenCalledOnce();
  });

  it('releases its slot when provider setup throws', async () => {
    mockGetEffectiveLLMApiKeys.mockRejectedValueOnce(new Error('provider settings unavailable'));
    await expect(call({ 'x-api-key': 'test-key' })).rejects.toThrow('provider settings unavailable');
    expect(mockQuotaRelease).toHaveBeenCalledOnce();
  });

  it('releases its slot after a failed agent run is settled', async () => {
    mockAgentRun.mockRejectedValueOnce(new Error('provider unavailable'));
    const response = await call({ 'x-api-key': 'test-key' });
    expect(response.statusCode).toBe(500);
    expect(meter.settle).toHaveBeenCalledBefore(mockQuotaRelease);
    expect(mockQuotaRelease).toHaveBeenCalledOnce();
  });
});
