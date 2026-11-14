// @vitest-environment node
/**
 * POST /api/ai/optimize-input runs the operations model on the platform key, so it must hold credits
 * before the call, settle the priced usage after, refund on a provider throw, and bound its input.
 * The real meterPlatformCompletion + reserveRequestCredits run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ChatModels,
  DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
  insufficientCreditsError,
  ModelBackend,
  TooManyRequestsError,
  type ModelInfo,
} from '@bike4mind/common';

const m = vi.hoisted(() => ({
  enforce: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  record: vi.fn(async () => undefined),
  complete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const handlers: Mw[] = [];
    const api = {
      use: (mw: Mw) => (handlers.push(mw), api),
      post: (h: Mw) => async (req: unknown, res: unknown) => {
        for (const mw of [...handlers, h]) {
          let advanced = false;
          await mw(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      },
    };
    return api;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ blockedAtZeroTierLimit: (n: number) => n }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@bike4mind/server-utils/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  adminSettingsRepository: {},
  apiKeyRepository: {},
  usageEventRepository: { record: m.record },
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
  getSettingsValue: (name: string) => (name === 'enforceCredits' ? m.enforce : undefined),
}));
vi.mock('@bike4mind/services', async () => ({
  meterCompletionBackend: (await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services'))
    .meterCompletionBackend,
  creditService: { holdCredits: m.hold, releaseCreditHold: m.release, settleCreditHold: m.settleHold },
  organizationService: {},
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
  latchUsage: (u: Record<string, number>, info?: Record<string, number>) => {
    if (info?.inputTokens) u.inputTokens = info.inputTokens;
    if (info?.outputTokens) u.outputTokens = info.outputTokens;
  },
}));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({
  loadModelConfigurations: async () => [],
  createModelAdmission: () => ({ admits: async () => true, assert: async () => undefined }),
}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 1000 }));
vi.mock('@bike4mind/server-utils/entitlements/index', () => ({ getUserEntitlements: vi.fn() }));

const MODEL = { id: 'ops-model', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({ modelId: MODEL.id, modelInfo: MODEL, llm: { complete: m.complete } }),
  },
}));

const { default: handler, optimizeCompletionOptions } = await import('@pages/api/ai/optimize-input');

async function call(body: Record<string, unknown> = { text: 'make this better' }) {
  const { req, res } = createMocks({ method: 'POST', body });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  Object.assign(req, { user: { id: 'u1' }, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return Object.assign(res, { logger });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 50 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['A clearer prompt.']);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/ai/optimize-input metering', () => {
  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('surfaces the free-tier daily cap as its 429 without logging an error', async () => {
    m.hold.mockRejectedValue(
      new TooManyRequestsError('Daily free-tier credit limit reached. Try again tomorrow.', {
        errorCode: DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
        retryAfter: 3600,
      })
    );
    const { req, res } = createMocks({ method: 'POST', body: { text: 'make this better' } });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    Object.assign(req, { user: { id: 'u1' }, logger });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
    await expect((handler as any)(req, res)).rejects.toMatchObject({
      statusCode: 429,
      additionalInfo: { errorCode: DAILY_FREE_LIMIT_REACHED_ERROR_CODE },
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('reserves before the call and settles the priced usage once', async () => {
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().optimizedText).toBe('A clearer prompt.');
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'ops-model',
        costUsd: expect.closeTo(200 * 1e-6 + 10 * 2e-6, 12),
        inputTokens: 200,
        outputTokens: 10,
      })
    );
    expect(m.release).not.toHaveBeenCalled();
  });

  it('releases the hold when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    const res = await call();

    expect(res._getStatusCode()).toBe(500);
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
  });

  it('runs without any hold when credits are not enforced', async () => {
    m.enforce = false;

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.complete).toHaveBeenCalledOnce();
    expect(m.hold).not.toHaveBeenCalled();
  });

  it('rejects text over the cap with 400 before any hold or provider call', async () => {
    const res = await call({ text: 'x'.repeat(16_001) });

    expect(res._getStatusCode()).toBe(400);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('accepts text exactly at the cap', async () => {
    const res = await call({ text: 'x'.repeat(16_000) });

    expect(res._getStatusCode()).toBe(200);
    expect(m.complete).toHaveBeenCalledOnce();
  });

  it.each([
    ['an unknown style', { text: 'hello', style: 'shouty' }],
    ['a non-positive maxLength', { text: 'hello', maxLength: -5 }],
  ])('rejects %s with 400 before any hold or provider call', async (_label, body) => {
    const res = await call(body);

    expect(res._getStatusCode()).toBe(400);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('still answers 400 for missing text without touching credits', async () => {
    const res = await call({});

    expect(res._getStatusCode()).toBe(400);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('logs the model id, stop reason and error class when the model returns no text', async () => {
    m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
      await cb([''], { inputTokens: 200, outputTokens: 134, stopReason: 'length' });
    });

    const res = await call({ text: 'secret prompt text' });

    expect(res._getStatusCode()).toBe(500);
    expect(res.logger.error).toHaveBeenCalledOnce();
    const [, fields, wrapped] = res.logger.error.mock.calls[0];
    expect(fields).toEqual({
      modelId: 'ops-model',
      errorName: 'EmptyOptimizationError',
      errorMessage: expect.stringContaining('stopReason: length'),
      stopReason: 'length',
    });
    expect((wrapped as Error).cause).toMatchObject({ name: 'EmptyOptimizationError', modelId: 'ops-model' });
    expect(JSON.stringify(res.logger.error.mock.calls)).not.toContain('secret prompt text');
  });

  it('logs the provider error class and message and keeps it as the cause', async () => {
    class ProviderError extends Error {
      override name = 'ProviderError';
    }
    const providerError = new ProviderError('400 unsupported parameter');
    m.complete.mockRejectedValue(providerError);

    const res = await call();

    expect(res._getStatusCode()).toBe(500);
    const [, fields, wrapped] = res.logger.error.mock.calls[0];
    expect(fields).toMatchObject({
      modelId: 'ops-model',
      errorName: 'ProviderError',
      errorMessage: '400 unsupported parameter',
      stopReason: null,
    });
    expect((wrapped as Error).cause).toBe(providerError);
  });

  it('sends the answer-sized budget to a model that does not reason', async () => {
    await call();

    expect(m.complete.mock.calls[0][2]).toMatchObject({ maxTokens: 134, temperature: 0.3 });
    expect(m.complete.mock.calls[0][2]).not.toHaveProperty('reasoningEffort');
  });
});

describe('optimizeCompletionOptions', () => {
  it('reserves reasoning headroom and asks for the lowest effort on a model that reasons in its budget', () => {
    const options = optimizeCompletionOptions(
      { id: ChatModels.GPT5_6_LUNA, backend: ModelBackend.OpenAI } as ModelInfo,
      undefined
    );

    expect(options).toEqual({ maxTokens: 134 + 2_000, temperature: 0.3, reasoningEffort: 'low' });
  });

  it('keeps the answer cap bounded by maxLength for a plain model', () => {
    const plain = { id: 'plain-model', backend: ModelBackend.OpenAI } as ModelInfo;

    expect(optimizeCompletionOptions(plain, 30)).toEqual({ maxTokens: 60, temperature: 0.3 });
    expect(optimizeCompletionOptions(plain, 10_000)).toEqual({ maxTokens: 800, temperature: 0.3 });
  });
});
