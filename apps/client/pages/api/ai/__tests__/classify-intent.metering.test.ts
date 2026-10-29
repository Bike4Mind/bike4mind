// @vitest-environment node
/**
 * POST /api/ai/classify-intent runs the admin-configured classifier cascade on platform keys, so
 * it must hold credits before the cascade and settle every call it reports after.
 * The real meterPlatformCompletion + reserveRequestCredits run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';
import { usdToCredits } from '@bike4mind/utils';

const m = vi.hoisted(() => ({
  quotaAdmission: vi.fn(),
  quotaRelease: vi.fn(),
  enforce: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  settle: vi.fn(),
  complete: vi.fn(),
  cached: vi.fn(),
  canThink: false,
  fallbackModels: [] as string[],
  unpricedModelIds: [] as string[],
  freeModelIds: [] as string[],
  zeroPricedModelIds: [] as string[],
  disabledModelIds: [] as string[],
}));

vi.mock('@server/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: m.quotaAdmission }));

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
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  adminSettingsRepository: {
    getSettingsValue: async () => ({
      intentClassifier: {
        enabled: true,
        shadowMode: true,
        primaryModel: 'ops-model',
        fallbackModels: m.fallbackModels,
      },
    }),
  },
  apiKeyRepository: {},
  usageEventRepository: { record: async () => undefined },
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
  getSettingsValue: (name: string) => (name === 'enforceCredits' ? m.enforce : undefined),
}));
vi.mock('@bike4mind/services', () => ({
  creditService: { holdCredits: m.hold, releaseCreditHold: m.release, settleCreditHold: m.settleHold },
  organizationService: {},
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
  latchUsage: (u: Record<string, number>, info?: Record<string, number>) => {
    if (info?.inputTokens) u.inputTokens = info.inputTokens;
    if (info?.outputTokens) u.outputTokens = info.outputTokens;
  },
}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 1000 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));
vi.mock('@server/billing/meterPlatformCompletion', async importOriginal => {
  const real = await importOriginal<typeof import('@server/billing/meterPlatformCompletion')>();
  return {
    ...real,
    settleCompletion: (...args: Parameters<typeof real.settleCompletion>) => {
      m.settle(args[2]);
      return real.settleCompletion(...args);
    },
  };
});

const MODEL = { id: 'ops-model', type: 'text', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@bike4mind/llm-adapters', async () => {
  const { geminiThinkingOutputCap, usesGeminiThinkingOutputCap } =
    await import('../../../../../../b4m-core/llm-adapters/src/thinkingParams');
  return {
    geminiThinkingOutputCap,
    usesGeminiThinkingOutputCap,
    getAvailableModels: async () =>
      ['ops-model', ...m.fallbackModels].map(id => ({
        ...(m.canThink ? { ...MODEL, backend: 'gemini', can_think: true, max_tokens: 20000 } : MODEL),
        id,
        pricing: m.unpricedModelIds.includes(id)
          ? {}
          : m.zeroPricedModelIds.includes(id)
            ? { 200_000: { input: 0, output: 0 } }
            : MODEL.pricing,
        freeToRun: m.freeModelIds.includes(id),
        disabled: m.disabledModelIds.includes(id),
      })),
  };
});
// The classifier is the provider seam here: m.complete stands in for the whole cascade.
vi.mock('@bike4mind/services/llm/intentClassifier', () => ({
  // An empty cascade is the route's cache-only probe; m.cached answers it, as the real cache would.
  classifyIntent: (input: unknown, adapters: { resolveCascade?: () => string[] }) =>
    adapters.resolveCascade?.().length === 0 ? m.cached(input) : m.complete(input, adapters),
  buildIntentClassifierMessages: () => [{ role: 'user', content: 'classify' }],
  INTENT_CLASSIFIER_MAX_TOKENS: 300,
  INTENT_CLASSIFIER_CALLS_PER_MODEL: 2,
  CascadeExhaustedError: class extends Error {
    attempts = [];
    constructor(
      public usage: Array<{
        modelId: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      }> = []
    ) {
      super('cascade exhausted');
    }
  },
}));

const { default: handler } = await import('@pages/api/ai/classify-intent');
const { CascadeExhaustedError } = await import('@bike4mind/services/llm/intentClassifier');

async function call(user: Record<string, unknown> = { id: 'u1' }) {
  const { req, res } = createMocks({ method: 'POST', body: { message: 'what is the weather in Paris?' } });
  Object.assign(req, { user, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.quotaAdmission.mockResolvedValue({ release: m.quotaRelease });
  m.quotaRelease.mockResolvedValue(undefined);
  m.enforce = true;
  m.canThink = false;
  m.fallbackModels = [];
  m.unpricedModelIds = [];
  m.freeModelIds = [];
  m.zeroPricedModelIds = [];
  m.disabledModelIds = [];
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 50 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.cached.mockRejectedValue(new Error('intentClassifier: cascade is empty'));
  m.complete.mockImplementation(async (_input: unknown, adapters: { resolveCascade: () => string[] }) => {
    const modelId = adapters.resolveCascade()[0];
    return {
      useAgent: true,
      confidence: 0.9,
      reason: 'needs live data',
      signals: [],
      classifierModel: modelId,
      latencyMs: 5,
      cacheHit: false,
      earlyExited: false,
      usage: [{ modelId, inputTokens: 200, outputTokens: 10 }],
    };
  });
});

describe('POST /api/ai/classify-intent metering', () => {
  it('refuses quota exhaustion before probing the cache or calling a provider', async () => {
    m.quotaAdmission.mockRejectedValueOnce(Object.assign(new Error('token quota'), { statusCode: 429 }));
    await expect(call()).rejects.toMatchObject({ statusCode: 429 });
    expect(m.cached).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
  });

  it('holds a quota slot until the classifier finishes and releases it after a provider failure', async () => {
    m.complete.mockImplementationOnce(async () => {
      expect(m.quotaRelease).not.toHaveBeenCalled();
      throw new Error('provider down');
    });
    await call();
    expect(m.quotaAdmission).toHaveBeenCalledWith(expect.objectContaining({ user: { id: 'u1' } }), { holdSlot: true });
    expect(m.quotaRelease).toHaveBeenCalledOnce();
  });

  it.each(['ops-model', 'fallback-model'])(
    'skips unpriced %s while retaining the priced candidate and its hold',
    async modelId => {
      m.fallbackModels = ['fallback-model'];
      m.unpricedModelIds = [modelId];
      const runnable = modelId === 'ops-model' ? 'fallback-model' : 'ops-model';

      expect((await call())._getStatusCode()).toBe(200);

      const classifierAdapters = m.complete.mock.calls[0][1] as { resolveCascade: () => string[] };
      expect(classifierAdapters.resolveCascade()).toEqual([runnable]);
      expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ model: runnable }));
      expect(m.hold.mock.calls[0][0].requiredCredits).toBe(usdToCredits((1000 * 1e-6 + 300 * 2e-6) * 2));
    }
  );

  it('refuses an entirely unpriced cascade before any hold or provider call', async () => {
    m.fallbackModels = ['fallback-model'];
    m.unpricedModelIds = ['ops-model', 'fallback-model'];

    await expect(call()).rejects.toMatchObject({ statusCode: 403 });
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('keeps a priced primary when a disabled fallback cannot run', async () => {
    m.fallbackModels = ['fallback-model'];
    m.disabledModelIds = ['fallback-model'];

    expect((await call())._getStatusCode()).toBe(200);

    const classifierAdapters = m.complete.mock.calls[0][1] as { resolveCascade: () => string[] };
    expect(classifierAdapters.resolveCascade()).toEqual(['ops-model']);
  });

  it('refuses a catalog-disabled classifier model before reserving or calling the provider', async () => {
    m.disabledModelIds = ['ops-model'];

    await expect(call()).rejects.toMatchObject({ statusCode: 400 });
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('admits an unpriced model when credits are not enforced', async () => {
    m.enforce = false;
    m.unpricedModelIds = ['ops-model'];

    expect((await call())._getStatusCode()).toBe(200);
    expect(m.complete).toHaveBeenCalledOnce();
    expect(m.hold).not.toHaveBeenCalled();
  });

  it('admits an explicitly free unpriced model without a hold', async () => {
    m.unpricedModelIds = ['ops-model'];
    m.freeModelIds = ['ops-model'];

    expect((await call())._getStatusCode()).toBe(200);
    expect(m.complete).toHaveBeenCalledOnce();
    expect(m.hold).not.toHaveBeenCalled();
  });

  it('admits an explicitly free zero-priced model without a hold', async () => {
    m.zeroPricedModelIds = ['ops-model'];
    m.freeModelIds = ['ops-model'];

    expect((await call())._getStatusCode()).toBe(200);
    expect(m.complete).toHaveBeenCalledOnce();
    expect(m.hold).not.toHaveBeenCalled();
  });

  it('refuses zero prices unless the model is explicitly free', async () => {
    m.zeroPricedModelIds = ['ops-model'];

    await expect(call()).rejects.toMatchObject({ statusCode: 403 });
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });

  it.each(['cacheReadInputTokens', 'cacheCreationInputTokens'] as const)(
    'prices cache-only %s from a failed cascade instead of the ceiling',
    async field => {
      m.complete.mockRejectedValue(new CascadeExhaustedError([{ modelId: 'ops-model', [field]: 100 }]));

      expect((await call())._getStatusCode()).toBe(503);

      const usd = 100 * (field === 'cacheReadInputTokens' ? 1e-7 : 1.25e-6);
      expect(m.settle).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ usd: expect.closeTo(usd, 12), [field]: 100 })
      );
      expect(m.release).not.toHaveBeenCalled();
    }
  );

  it('charges a funded caller the priced usage once', async () => {
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settle).toHaveBeenCalledOnce();
    expect(m.settle).toHaveBeenCalledWith({
      model: 'ops-model',
      provider: 'openai',
      usd: expect.closeTo(200 * 1e-6 + 10 * 2e-6, 12),
      inputTokens: 200,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(m.settleHold).toHaveBeenCalledOnce();
    expect(res._getJSONData().decision).not.toHaveProperty('usage');
  });

  it('charges a call that reported no usage its own ceiling', async () => {
    m.complete.mockResolvedValue({
      useAgent: false,
      confidence: 0.5,
      reason: 'early exit',
      signals: [],
      classifierModel: 'ops-model',
      latencyMs: 5,
      cacheHit: false,
      earlyExited: true,
      usage: [{ modelId: 'ops-model' }],
    });

    await call();

    // estimateInputTokens is stubbed to 1000 input tokens; the ceiling is the full 300 output tokens.
    expect(m.settle).toHaveBeenCalledWith(
      expect.objectContaining({ usd: expect.closeTo(1000 * 1e-6 + 300 * 2e-6, 12) })
    );
  });

  it('reserves Gemini thinking headroom for every classifier attempt', async () => {
    m.canThink = true;

    await call();

    const perAttemptUsd = 1000 * 1e-6 + (300 + 16000) * 2e-6;
    expect(m.hold.mock.calls[0][0].requiredCredits).toBeCloseTo(usdToCredits(perAttemptUsd * 2), 12);
  });

  it('refunds the hold when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    const res = await call();
    expect(res._getStatusCode()).toBe(500);
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
  });

  it('settles the usage of a failed cascade instead of refunding the hold', async () => {
    m.complete.mockRejectedValue(
      new CascadeExhaustedError([{ modelId: 'ops-model', inputTokens: 200, outputTokens: 10 }])
    );

    const res = await call();

    expect(res._getStatusCode()).toBe(503);
    expect(m.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'ops-model',
        usd: expect.closeTo(200 * 1e-6 + 10 * 2e-6, 12),
        inputTokens: 200,
        outputTokens: 10,
      })
    );
    expect(m.release).not.toHaveBeenCalled();
  });

  it('refunds the hold when a failed cascade reached no provider', async () => {
    m.complete.mockRejectedValue(new CascadeExhaustedError([]));

    const res = await call();

    expect(res._getStatusCode()).toBe(503);
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledOnce();
  });

  it('serves a cache hit without a hold, a settle or a usage event', async () => {
    m.cached.mockResolvedValue({
      useAgent: true,
      confidence: 0.9,
      reason: 'needs live data',
      signals: [],
      classifierModel: 'ops-model',
      latencyMs: 1,
      cacheHit: true,
      earlyExited: false,
      usage: [],
    });

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().decision).toMatchObject({ cacheHit: true, useAgent: true });
    expect(res._getJSONData().decision).not.toHaveProperty('usage');
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it('rejects a moderated user with 403 even when the answer is cached', async () => {
    m.cached.mockResolvedValue({
      useAgent: true,
      confidence: 0.9,
      reason: 'needs live data',
      signals: [],
      classifierModel: 'ops-model',
      latencyMs: 1,
      cacheHit: true,
      earlyExited: false,
      usage: [],
    });

    await expect(call({ id: 'u1', isModerated: true })).rejects.toMatchObject({ statusCode: 403 });
    expect(m.cached).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
  });

  it('refunds instead of settling a zero-cost classification', async () => {
    m.complete.mockResolvedValue({
      useAgent: false,
      confidence: 0.5,
      reason: 'r',
      signals: [],
      classifierModel: 'ops-model',
      latencyMs: 5,
      cacheHit: false,
      earlyExited: false,
      usage: [],
    });

    await call();

    expect(m.settle).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledOnce();
  });

  it('runs without any hold when credits are not enforced', async () => {
    m.enforce = false;

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.complete).toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.settleHold).not.toHaveBeenCalled();
  });
});
