// @vitest-environment node
/**
 * POST /api/files/generate-smart-name runs the operations model on the platform key. It swallows
 * provider errors into a fallback name, but insufficient credits must surface as a 422.
 * The real meterPlatformCompletion + reserveRequestCredits run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  enforce: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  settle: vi.fn(),
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
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
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
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({
  loadModelConfigurations: async () => [],
  createModelAdmission: () => ({ admits: async () => true, assert: async () => undefined }),
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

const MODEL = { id: 'ops-model', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@client/services/operationsModelService', () => ({
  getEffectiveApiKeyByBackend: async () => 'sk-test',
  OperationsModelService: {
    getOperationsModel: async () => ({ modelId: MODEL.id, modelInfo: MODEL, llm: { complete: m.complete } }),
  },
}));
vi.mock('@bike4mind/llm-adapters', () => ({ getLlmByModel: () => ({ complete: m.complete }) }));

const { default: handler } = await import('@pages/api/files/generate-smart-name');

async function call() {
  const { req, res } = createMocks({ method: 'POST', body: { prompt: 'name this pasted text', fileType: 'text' } });
  Object.assign(req, { user: { id: 'u1' }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 50 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['meeting-notes']);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/files/generate-smart-name metering', () => {
  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });

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
    });
    expect(m.settleHold).toHaveBeenCalledOnce();
  });

  it('refunds the hold when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    const res = await call();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().name).toMatch(/^pasted-text-/);
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
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
