// @vitest-environment node
/**
 * POST /api/ai/tavern-conversation runs the operations model on the platform key for the cast, each
 * turn and the background memory extraction, so each call must hold credits before the provider call
 * and settle after, and a credit refusal must surface as 422 instead of the canned fallback. The real meterPlatformCompletion + reserveRequestCredits
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
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  agentRepository: {
    shareable: { findAccessibleById: async () => null, findUpdateAccessById: async () => ({ id: 'a1' }) },
    getMemoryJournal: async () => [],
    appendMemory: vi.fn(),
  },
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
  agentMemoryService: {
    buildMemoryPromptSection: () => '',
    extractMemoriesFromConversation: async (
      _name: string,
      _personality: string,
      _history: unknown[],
      llmComplete: (msgs: unknown[], opts: unknown) => Promise<string>
    ) => {
      await llmComplete([{ role: 'user', content: 'extract' }], { maxTokens: 100 });
      return [];
    },
  },
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

const { default: handler } = await import('@pages/api/ai/tavern-conversation');

const CAST = [{ id: 'grimbold', name: 'Grimbold', sprite: 'host', personality: 'gruff' }];

async function callWithReq(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, {
    user: { id: 'u1', tags: [], groups: [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return { req: req as typeof req & { logger: { warn: ReturnType<typeof vi.fn> } }, res };
}

async function call(body: Record<string, unknown>) {
  return (await callWithReq(body)).res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 1 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb([JSON.stringify({ characters: CAST, speaker: 'grimbold', text: 'Ale?', style: 'speech' })]);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/ai/tavern-conversation metering', () => {
  it('holds and settles the cast generation', async () => {
    const res = await call({});

    expect(res._getJSONData().characters).toHaveLength(1);
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
  });

  it('holds and settles a turn', async () => {
    const res = await call({ characters: CAST, history: [] });

    expect(res._getJSONData()).toMatchObject({ speaker: 'grimbold', text: 'Ale?' });
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
  });

  it('holds and settles the background memory extraction as well as the turn', async () => {
    await call({ characters: CAST, history: [], agentIds: { grimbold: 'a1' } });

    await vi.waitFor(() => expect(m.settleHold).toHaveBeenCalledTimes(2));
    expect(m.hold).toHaveBeenCalledTimes(2);
    expect(m.complete).toHaveBeenCalledTimes(2);
  });

  it('logs a credit refusal on the memory extraction and stops before the next agent', async () => {
    const cast = [...CAST, { id: 'mira', name: 'Mira', sprite: 'bard', personality: 'wry' }];
    const refusal = insufficientCreditsError('You do not have enough credits.');
    m.hold.mockResolvedValueOnce({ ownerId: 'u1', ownerType: 'user', reservedCredits: 1 }).mockRejectedValue(refusal);

    const { req } = await callWithReq({ characters: cast, history: [], agentIds: { grimbold: 'a1', mira: 'a2' } });

    await vi.waitFor(() =>
      expect(req.logger.warn).toHaveBeenCalledWith('Memory extraction failed (non-fatal):', refusal)
    );
    expect(m.hold).toHaveBeenCalledTimes(2);
    expect(m.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cast', {}],
    ['turn', { characters: CAST, history: [] }],
  ])('surfaces a credit refusal on the %s as 422 and never calls the provider', async (_mode, body) => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call(body)).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('refunds the hold and falls back when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    const res = await call({ characters: CAST, history: [] });

    expect(res._getJSONData()).toMatchObject({ speaker: 'grimbold' });
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
  });
});
