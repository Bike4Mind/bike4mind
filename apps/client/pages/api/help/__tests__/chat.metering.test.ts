// @vitest-environment node
/**
 * POST /api/help/chat runs a route-picked model on the platform key, so it must hold credits
 * before retrieval (which embeds the question) and the completion, then settle the reported usage.
 * The real meterPlatformCompletion + reserveRequestCredits run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { getEmbeddingModelCost, insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  enforce: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  settle: vi.fn(),
  complete: vi.fn(),
  search: vi.fn(),
  recordOperationalUsage: vi.fn(),
  findOrg: vi.fn(),
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
  organizationRepository: { findById: m.findOrg },
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
  recordOperationalUsage: m.recordOperationalUsage,
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

const MODEL = { id: 'ops-model', type: 'text', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => [MODEL],
  getLlmByModel: () => ({ complete: m.complete }),
}));
vi.mock('@server/help/retrieval', () => ({ searchHelpContext: m.search }));

const { default: handler } = await import('@pages/api/help/chat');

async function call(extra: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'POST', body: { question: 'How do I share a notebook?' } });
  Object.assign(req, {
    user: { id: 'u1' },
    ...extra,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 50 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.search.mockResolvedValue({ context: '## Docs', relevantArticles: [], method: 'keyword' });
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['Use the Share button.']);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/help/chat metering', () => {
  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.search).not.toHaveBeenCalled();
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
    expect(res._getStatusCode()).toBe(500);
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

  it('records the retrieval query embedding once, billed through recordOperationalUsage', async () => {
    m.search.mockResolvedValue({
      context: '## Docs',
      relevantArticles: [],
      method: 'vector',
      embedding: { model: 'text-embedding-3-small', provider: 'openai', inputTokens: 7 },
    });

    await call();

    expect(m.recordOperationalUsage).toHaveBeenCalledOnce();
    expect(m.recordOperationalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'embedding',
        model: 'text-embedding-3-small',
        inputTokens: 7,
        costUsd: getEmbeddingModelCost('text-embedding-3-small', 7),
        forceCreditBilling: true,
      }),
      expect.anything()
    );
  });

  it('caps the response with the maxTokens option the adapters read', async () => {
    await call();
    expect(m.complete.mock.calls[0][2]).toMatchObject({ maxTokens: 1000 });
    expect(m.complete.mock.calls[0][2]).not.toHaveProperty('max_tokens');
  });

  describe('embedding charge owner', () => {
    beforeEach(() => {
      m.search.mockResolvedValue({
        context: '## Docs',
        relevantArticles: [],
        method: 'vector',
        embedding: { model: 'text-embedding-3-small', provider: 'openai', inputTokens: 7 },
      });
    });

    it('bills the org that holds the reservation', async () => {
      const org = { id: 'o1' };
      m.findOrg.mockResolvedValue(org);
      m.hold.mockResolvedValue({ ownerId: 'o1', ownerType: 'Organization', reservedCredits: 50 });

      await call({ user: { id: 'u1', organizationId: 'o1' } });

      expect(m.findOrg).toHaveBeenCalledWith('o1');
      expect(m.recordOperationalUsage.mock.calls[0][0].organization).toBe(org);
    });

    it('bills the user, not their org seat, for a user-billed API key', async () => {
      m.enforce = false;

      await call({
        user: { id: 'u1', organizationId: 'o1' },
        apiKeyInfo: { billingOwnerType: 'User', organizationId: 'o1' },
      });

      expect(m.findOrg).not.toHaveBeenCalled();
      expect(m.recordOperationalUsage.mock.calls[0][0].organization).toBeNull();
    });
  });

  it('records no embedding when retrieval did not embed', async () => {
    await call();
    expect(m.recordOperationalUsage).not.toHaveBeenCalled();
  });
});
