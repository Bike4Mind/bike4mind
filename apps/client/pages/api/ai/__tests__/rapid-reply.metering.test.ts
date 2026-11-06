// @vitest-environment node
/**
 * POST /api/ai/rapid-reply runs an admin-mapped fast model on the platform key. It is best-effort
 * (every refusal is a 200 {success:false}), but it must hold credits before the call, settle after,
 * refund on a provider throw, truncate its input, and meter toggle-bypass sessions like any other.
 * The real meterPlatformCompletion + reserveRequestCredits run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  enforce: true,
  rapidReplyEnabled: true,
  hasMapping: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  record: vi.fn(async () => undefined),
  complete: vi.fn(),
  send: vi.fn(async () => undefined),
  saveResult: vi.fn(async () => undefined),
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
vi.mock('@bike4mind/server-utils/utils/sessionAccess', () => ({ assertSessionAccess: vi.fn() }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  adminSettingsRepository: {
    getSettingsValue: async (name: string) => (name === 'EnableRapidReply' ? m.rapidReplyEnabled : undefined),
  },
  apiKeyRepository: {},
  rapidReplyMappingRepository: {
    findByMainModel: async () =>
      m.hasMapping
        ? { id: 'map1', enabled: true, rapidModelId: 'rapid-model', systemPrompt: 'ack it', maxTokens: 50 }
        : null,
  },
  rapidReplyResultRepository: { create: m.saveResult },
  questRepository: { findById: async () => null },
  Connection: {},
  usageEventRepository: { record: m.record },
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
  getSettingsValue: (name: string) => (name === 'enforceCredits' ? m.enforce : undefined),
  getSettingsByNames: async () => ({}),
  ClientMessageSender: class {},
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
vi.mock('@bike4mind/services/llm/StatusManager', () => ({
  StatusManager: class {
    sendRapidReplyUpdate = m.send;
  },
}));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({
  loadModelConfigurations: async () => [],
  createModelAdmission: () => ({ admits: async () => true, assert: async () => undefined }),
}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 1000 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));

const MODEL = {
  id: 'rapid-model',
  type: 'text',
  backend: 'openai',
  pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
};
// Partial: the metered backend sizes its hold with the real llm-adapters output-budget helpers.
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  buildApiKeyTable: () => ({}),
  getAvailableModels: async () => [MODEL],
}));
vi.mock('@server/rapidReply/resolveRapidModel', () => ({
  resolveRapidModel: () => ({ status: 'ready', modelId: MODEL.id, llm: { complete: m.complete } }),
}));

const { default: handler } = await import('@pages/api/ai/rapid-reply');

async function call(body: Record<string, unknown> = {}, user: Record<string, unknown> = {}) {
  const { req, res } = createMocks({
    method: 'POST',
    body: { message: 'summarize my quarterly report', model: 'main-model', ...body },
  });
  Object.assign(req, {
    user: { id: 'u1', tags: [], groups: [], ...user },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.rapidReplyEnabled = true;
  m.hasMapping = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 1 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['On it, pulling up your quarterly report.']);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/ai/rapid-reply metering', () => {
  it('soft-fails a zero-credit caller with insufficient_credits and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ success: false, reason: 'insufficient_credits' });
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.saveResult).not.toHaveBeenCalled();
  });

  it('reserves before the call and settles the priced usage once', async () => {
    const res = await call();

    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'rapid-model',
        costUsd: expect.closeTo(200 * 1e-6 + 10 * 2e-6, 12),
        inputTokens: 200,
        outputTokens: 10,
      })
    );
    expect(m.release).not.toHaveBeenCalled();
  });

  it('caps the provider output at 50 tokens through maxTokens', async () => {
    await call();

    expect(m.complete.mock.calls[0][2]).toMatchObject({ maxTokens: 50 });
  });

  it('releases the hold when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    const res = await call();

    expect(res._getJSONData()).toMatchObject({ success: false, error: 'provider down' });
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
  });

  it('truncates an oversize message to 4,000 chars before the provider sees it', async () => {
    const res = await call({ message: 'y'.repeat(10_000) });

    expect(res._getJSONData()).toMatchObject({ success: true });
    const messages = m.complete.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(messages.find(msg => msg.role === 'user')?.content).toHaveLength(4_000);
  });

  it('soft-fails a missing message without reserving or calling the provider', async () => {
    const res = await call({ message: undefined });

    expect(res._getJSONData()).toEqual({ success: false, reason: 'invalid_message' });
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('meters a session that bypasses the feature toggle', async () => {
    m.rapidReplyEnabled = false;
    m.hasMapping = false;

    const res = await call({ isOpti: true }, { tags: ['opti'] });

    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
  });

  it('soft-fails a zero-credit toggle-bypass session without calling the provider', async () => {
    m.rapidReplyEnabled = false;
    m.hasMapping = false;
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    const res = await call({ isOpti: true }, { tags: ['opti'] });

    expect(res._getJSONData()).toEqual({ success: false, reason: 'insufficient_credits' });
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('runs without any hold when credits are not enforced', async () => {
    m.enforce = false;

    const res = await call();

    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(m.complete).toHaveBeenCalledOnce();
    expect(m.hold).not.toHaveBeenCalled();
  });
});
