// @vitest-environment node
/**
 * POST /api/ai/barkeep-chat runs the operations model on the platform key, so it must hold credits
 * before the provider call, settle the reported usage after, refund on a throw, and surface a credit
 * refusal as 422 instead of the canned 500. The real meterPlatformCompletion + reserveRequestCredits
 * run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';

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
vi.mock('@bike4mind/server-utils/utils/errors', () => ({ ensureTavernAccess: vi.fn() }));
vi.mock('@server/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  apiKeyRepository: {},
  adminSettingsRepository: {},
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
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));

const MODEL = { id: 'ops-model', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: async () => [MODEL],
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({ modelId: MODEL.id, modelInfo: MODEL, llm: { complete: m.complete } }),
  },
}));

const { default: handler } = await import('@pages/api/ai/barkeep-chat');

async function call() {
  const { req, res } = createMocks({ method: 'POST', body: { userMessage: 'Any rumors?' } });
  Object.assign(req, {
    user: { id: 'u1', tags: [], groups: [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 1 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['Aye, the guard is jumpy tonight.']);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/ai/barkeep-chat metering', () => {
  it('holds before the provider call and settles the priced usage once', async () => {
    const res = await call();

    expect(res._getJSONData()).toEqual({ reply: 'Aye, the guard is jumpy tonight.' });
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'ops-model', costUsd: expect.closeTo(200 * 1e-6 + 10 * 2e-6, 12) })
    );
    expect(m.release).not.toHaveBeenCalled();
  });

  it('refunds the hold when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    const res = await call();

    expect(res._getStatusCode()).toBe(500);
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
  });

  it('surfaces a credit refusal as 422 and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('runs without any hold when credits are not enforced', async () => {
    m.enforce = false;

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.hold).not.toHaveBeenCalled();
  });
});
