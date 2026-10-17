// @vitest-environment node
/**
 * POST /api/sessions/semantic-search runs query expansion, embeddings and a re-rank on platform
 * keys. A credit pre-flight refuses a caller who cannot pay before any of them, and every call
 * settles through recordOperationalUsage with forceCreditBilling (which owns the debit itself).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { getEmbeddingModelCost, insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  enforce: true,
  complete: vi.fn(),
  embed: vi.fn(),
  record: vi.fn(),
  findOrg: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (h: unknown) => h }) }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: async () => 'text-embedding-3-small' },
  apiKeyRepository: {},
  usageEventRepository: { record: async () => undefined },
  creditTransactionRepository: {},
  organizationRepository: { findById: m.findOrg },
  userRepository: {},
  sessionRepository: {
    findSessionIdsByUserId: async () => ['s1'],
    find: async () => [{ id: 's1', name: 'Bike trip' }],
  },
}));
vi.mock('@bike4mind/database/content', () => ({
  Quest: { find: () => ({ lean: async () => [{ sessionId: 's1', prompt: 'bike trip plans', reply: 'Go to Paris' }] }) },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({
  EmbeddingFactory: class {
    createEmbeddingService = () => ({ generateEmbedding: m.embed });
  },
  getProviderFromModel: () => 'openai',
  resolveEmbeddingWithKeylessFallback: (model: string) => ({ config: {}, missing: undefined, model }),
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({ openai: 'sk-test' }) },
  recordOperationalUsage: m.record,
  // The balance gate (unit-tested in assertOwnerHasCredits.test.ts), reduced to its contract.
  assertOwnerHasCredits: (owner: { currentCredits?: number }) => {
    if (!((owner.currentCredits ?? 0) > 0)) throw insufficientCreditsError('Insufficient credits');
  },
  organizationService: { isCurrentOrgMember: () => true },
  creditService: { isMemberAtOrOverCap: () => false, MEMBER_CREDIT_CAP_MESSAGE: 'cap' },
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ isCreditsEnforced: async () => m.enforce }));

type Llm = { complete: (...args: unknown[]) => Promise<void> };
const noop = async () => undefined;
// Each fake service makes one provider call through the adapter it was given, as the real ones do.
vi.mock('@bike4mind/services/llm/SmallLLMService', () => ({
  SmallLLMService: class {
    constructor(private adapters: { llm: Llm }) {}
    async expandQuery() {
      await this.adapters.llm.complete('ops-model', [], {}, noop);
      return { data: { corrected: 'bike trip', keywords: ['bike', 'trip'] } };
    }
  },
}));
vi.mock('@bike4mind/services/llm/reranker', () => ({
  ReRankService: class {
    constructor(private adapters: { llm: Llm }) {}
    async reRank(_query: string, candidates: Array<{ id: string }>) {
      await this.adapters.llm.complete('ops-model', [], {}, noop);
      return candidates.map(c => ({ id: c.id, relevanceScore: 8, finalScore: 0.9 }));
    }
  },
}));

const MODEL = { id: 'ops-model', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({ modelId: MODEL.id, modelInfo: MODEL, llm: { complete: m.complete } }),
  },
}));

const { default: handler } = await import('@pages/api/sessions/semantic-search');

const QUERY = 'bike trip';

async function call(currentCredits: number, organizationId?: string, apiKeyInfo?: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body: { query: QUERY, useReRanking: true } });
  Object.assign(req, {
    user: { id: 'u1', currentCredits, organizationId },
    apiKeyInfo,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

const recorded = (feature: string) => m.record.mock.calls.map(([p]) => p).filter(p => p.feature === feature);

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.embed.mockResolvedValue([1, 0, 0]);
  m.record.mockResolvedValue(undefined);
  m.findOrg.mockResolvedValue(null);
  // Expansion reports 100/20 tokens, the re-rank 300/40.
  m.complete
    .mockImplementationOnce(async (_m, _msgs, _o, cb) => cb(['{}'], { inputTokens: 100, outputTokens: 20 }))
    .mockImplementationOnce(async (_m, _msgs, _o, cb) => cb(['[]'], { inputTokens: 300, outputTokens: 40 }));
});

describe('POST /api/sessions/semantic-search metering', () => {
  it('refuses a zero-credit caller with 422 before any provider call', async () => {
    await expect(call(0)).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.embed).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('settles every platform call once, with forced credit billing', async () => {
    const res = await call(100);

    expect(res._getStatusCode()).toBe(200);
    expect(recorded('operations')).toEqual([
      expect.objectContaining({
        model: 'ops-model',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: expect.closeTo(100 * 1e-6 + 20 * 2e-6, 12),
        forceCreditBilling: true,
      }),
      expect.objectContaining({
        model: 'ops-model',
        inputTokens: 300,
        outputTokens: 40,
        costUsd: expect.closeTo(300 * 1e-6 + 40 * 2e-6, 12),
        forceCreditBilling: true,
      }),
    ]);
    const messageTokens = Math.ceil('bike trip plans\n\nGo to Paris'.length / 4);
    const queryTokens = Math.ceil(QUERY.length / 4);
    expect(recorded('embedding')).toEqual([
      expect.objectContaining({
        model: 'text-embedding-3-small',
        inputTokens: queryTokens,
        costUsd: getEmbeddingModelCost('text-embedding-3-small', queryTokens),
        forceCreditBilling: true,
      }),
      expect.objectContaining({
        model: 'text-embedding-3-small',
        inputTokens: messageTokens,
        costUsd: getEmbeddingModelCost('text-embedding-3-small', messageTokens),
        forceCreditBilling: true,
      }),
    ]);
  });

  it('reads the org once and gates on its pool', async () => {
    m.findOrg.mockResolvedValue({ id: 'o1', currentCredits: 0 });

    await expect(call(100, 'o1')).rejects.toMatchObject({ statusCode: 422 });
    expect(m.findOrg).toHaveBeenCalledOnce();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('bills a user-billed API key to the user, not the org seat', async () => {
    m.findOrg.mockResolvedValue({ id: 'o1', currentCredits: 0 });

    const res = await call(100, 'o1', { billingOwnerType: 'User', organizationId: 'o1' });

    expect(res._getStatusCode()).toBe(200);
    expect(m.findOrg).not.toHaveBeenCalled();
    expect(m.record.mock.calls.every(([p]) => p.organization === null)).toBe(true);
  });

  it('bills an org-billed API key to its org', async () => {
    m.findOrg.mockResolvedValue({ id: 'o2', currentCredits: 50 });

    const res = await call(0, undefined, { billingOwnerType: 'Organization', organizationId: 'o2' });

    expect(res._getStatusCode()).toBe(200);
    expect(m.findOrg).toHaveBeenCalledWith('o2');
    expect(m.record.mock.calls.every(([p]) => p.organization?.id === 'o2')).toBe(true);
  });

  it('tags every event of one search with the same per-request id, distinct across searches', async () => {
    await call(100);
    const first = new Set(m.record.mock.calls.map(([p]) => p.requestId));
    m.complete.mockResolvedValue(undefined);
    await call(100);
    const all = new Set(m.record.mock.calls.map(([p]) => p.requestId));

    expect(first.size).toBe(1);
    expect(first.has('u1')).toBe(false);
    expect(all.size).toBe(2);
  });

  it('does not refuse a zero-credit caller when credits are not enforced', async () => {
    m.enforce = false;

    const res = await call(0);

    expect(res._getStatusCode()).toBe(200);
    expect(m.embed).toHaveBeenCalled();
  });
});
