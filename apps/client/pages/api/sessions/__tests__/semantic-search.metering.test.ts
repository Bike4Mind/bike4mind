// @vitest-environment node
/**
 * POST /api/sessions/semantic-search runs query expansion, embeddings and a re-rank on platform
 * keys. A credit pre-flight refuses a caller who cannot pay before any of them, and every call
 * settles text calls through the real completion wrapper, and reserves each embedding input.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { getEmbeddingModelCost, insufficientCreditsError } from '@bike4mind/common';

const { quotaAdmission, quotaRelease } = vi.hoisted(() => {
  const release = vi.fn().mockResolvedValue(undefined);
  return { quotaAdmission: vi.fn().mockResolvedValue({ release }), quotaRelease: release };
});
vi.mock('@server/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: quotaAdmission }));

const m = vi.hoisted(() => ({
  enforce: true,
  complete: vi.fn(),
  embed: vi.fn(),
  record: vi.fn(),
  reserveEmbedding: vi.fn(),
  settleEmbedding: vi.fn(),
  refundEmbedding: vi.fn(),
  findOrg: vi.fn(),
  meter: vi.fn(),
  settle: vi.fn(),
  reserveText: vi.fn(),
  realReranking: false,
  refund: vi.fn(),
  realExpansion: false,
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
  // No samples and no settings rows: the spend cap reads defaults and never refuses here.
  newAccountSpendCapAdapters: {
    adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
    personalSpendSince: async () => [],
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
vi.mock('@bike4mind/services', async () => ({
  meterCompletionBackend: (await import('@bike4mind/services/billing/completionMeter')).meterCompletionBackend,
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({ openai: 'sk-test' }) },
  recordOperationalUsage: m.record,
  // The balance gate (unit-tested in assertOwnerHasCredits.test.ts), reduced to its contract.
  assertOwnerHasCredits: (owner: { currentCredits?: number }) => {
    if (!((owner.currentCredits ?? 0) > 0)) throw insufficientCreditsError('Insufficient credits');
  },
  organizationService: { isCurrentOrgMember: () => true },
  creditService: { isMemberAtOrOverCap: () => false, MEMBER_CREDIT_CAP_MESSAGE: 'cap' },
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  isCreditsEnforced: async () => m.enforce,
  reserveCompletionCredits: m.reserveEmbedding,
  settleCompletion: m.settleEmbedding,
  createRequestCompletionMeter: (req: unknown, label: string, options: unknown) => {
    m.meter(req, label, options);
    return m.reserveText;
  },
}));

type Llm = { complete: (...args: unknown[]) => Promise<void> };
const noop = async () => undefined;
// Each fake service makes one provider call through the adapter it was given, as the real ones do.
vi.mock('@bike4mind/services/llm/SmallLLMService', async importOriginal => {
  const { SmallLLMService: ActualSmallLLMService } =
    await importOriginal<typeof import('@bike4mind/services/llm/SmallLLMService')>();
  return {
    SmallLLMService: class extends ActualSmallLLMService {
      constructor(private testAdapters: { llm: Llm }) {
        super({ ...testAdapters, modelId: 'ops-model' });
      }
      async expandQuery(query: string, options: { timeoutMs: number }) {
        if (m.realExpansion)
          return new ActualSmallLLMService({ ...this.testAdapters, modelId: 'ops-model' }).expandQuery(query, options);
        await this.testAdapters.llm.complete('ops-model', [], {}, noop);
        return { data: { corrected: 'bike trip', keywords: ['bike', 'trip'] } };
      }
    },
  };
});
vi.mock('@bike4mind/services/llm/reranker', async importOriginal => {
  const { ReRankService: ActualReRankService } =
    await importOriginal<typeof import('@bike4mind/services/llm/reranker')>();
  return {
    ReRankService: class {
      constructor(private adapters: { llm: Llm }) {}
      async reRank(_query: string, candidates: Array<{ id: string }>) {
        if (m.realReranking)
          return new ActualReRankService({ ...this.adapters, modelId: 'ops-model' }).reRank(
            _query,
            candidates.map(candidate => ({ ...candidate, snippet: 'bike', cosineSimilarity: 1 }))
          );
        await this.adapters.llm.complete('ops-model', [], {}, noop);
        return candidates.map(c => ({ id: c.id, relevanceScore: 8, finalScore: 0.9 }));
      }
    },
  };
});

const MODEL = { id: 'ops-model', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({ modelId: MODEL.id, modelInfo: MODEL, llm: { complete: m.complete } }),
  },
}));

const { default: handler } = await import('@pages/api/sessions/semantic-search');

const QUERY = 'bike trip';

async function call(
  currentCredits: number,
  organizationId?: string,
  apiKeyInfo?: Record<string, unknown>,
  useReRanking = true
) {
  const { req, res } = createMocks({ method: 'POST', body: { query: QUERY, useReRanking } });
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
  m.realExpansion = false;
  m.realReranking = false;
  m.reserveText.mockResolvedValue({ settle: m.settle, refund: m.refund });
  m.settle.mockResolvedValue(1);
  m.refund.mockResolvedValue(undefined);
  m.embed.mockResolvedValue([1, 0, 0]);
  m.record.mockResolvedValue(undefined);
  m.reserveEmbedding.mockResolvedValue({ refund: m.refundEmbedding });
  m.refundEmbedding.mockResolvedValue(undefined);
  m.settleEmbedding.mockImplementation(async (_reservation, _req, usage) => {
    m.record({ feature: 'embedding', ...usage, costUsd: usage.usd });
    return 1;
  });
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
    expect(m.settle.mock.calls.map(([usage]) => usage)).toEqual([
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 300, outputTokens: 40 },
    ]);
    expect(recorded('operations')).toEqual([]);
    expect(m.meter).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'u1' }) }),
      'semantic search expansion',
      { systemModel: true }
    );
    const messageTokens = Math.ceil('bike trip plans\n\nGo to Paris'.length / 4);
    const queryTokens = Math.ceil(QUERY.length / 4);
    expect(recorded('embedding')).toEqual([
      expect.objectContaining({
        model: 'text-embedding-3-small',
        inputTokens: queryTokens,
        costUsd: getEmbeddingModelCost('text-embedding-3-small', queryTokens),
      }),
      expect.objectContaining({
        model: 'text-embedding-3-small',
        inputTokens: messageTokens,
        costUsd: getEmbeddingModelCost('text-embedding-3-small', messageTokens),
      }),
    ]);
  });

  it('settles timed-out expansion attempts when their provider promises finish later', async () => {
    vi.useFakeTimers();
    m.realExpansion = true;
    m.complete.mockReset();
    m.complete.mockImplementation(async (_model, _messages, _options, callback) => {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      await callback(['{"corrected":"bike trip","keywords":["bike"]}'], { inputTokens: 100, outputTokens: 20 });
    });
    try {
      const response = call(100, undefined, undefined, false);
      await vi.advanceTimersByTimeAsync(6_001);
      expect((await response)._getStatusCode()).toBe(200);
      expect(m.complete).toHaveBeenCalledTimes(2);
      expect(m.settle).not.toHaveBeenCalled();
      expect(quotaRelease).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(7_000);
      expect(m.settle).toHaveBeenCalledTimes(2);
      expect(quotaRelease).toHaveBeenCalledTimes(1);
      expect(m.settle).toHaveBeenNthCalledWith(1, { inputTokens: 100, outputTokens: 20 });
      expect(m.settle).toHaveBeenNthCalledWith(2, { inputTokens: 100, outputTokens: 20 });
      expect(m.refund).not.toHaveBeenCalled();
      expect(recorded('operations')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a real expansion service credit refusal without a provider call', async () => {
    m.realExpansion = true;
    m.reserveText.mockRejectedValue(insufficientCreditsError('Cannot reserve expansion'));

    await expect(call(100)).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.embed).not.toHaveBeenCalled();
  });

  it('propagates a real reranker credit refusal instead of accepting its cosine fallback', async () => {
    m.realReranking = true;
    m.reserveText.mockResolvedValueOnce({ settle: m.settle, refund: m.refund });
    m.reserveText.mockRejectedValue(insufficientCreditsError('Cannot reserve rerank'));

    await expect(call(100)).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).toHaveBeenCalledOnce();
    expect(m.settle).toHaveBeenCalledOnce();
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
    expect(m.reserveEmbedding.mock.calls.every(([req]) => req.apiKeyInfo.billingOwnerType === 'User')).toBe(true);
  });

  it('bills an org-billed API key to its org', async () => {
    m.findOrg.mockResolvedValue({ id: 'o2', currentCredits: 50 });

    const res = await call(0, undefined, { billingOwnerType: 'Organization', organizationId: 'o2' });

    expect(res._getStatusCode()).toBe(200);
    expect(m.findOrg).toHaveBeenCalledWith('o2');
    expect(m.reserveEmbedding.mock.calls.every(([req]) => req.apiKeyInfo.organizationId === 'o2')).toBe(true);
  });

  it('reserves each embedding before the provider and stops when a later input cannot be funded', async () => {
    m.reserveEmbedding.mockResolvedValueOnce({ refund: m.refundEmbedding });
    m.reserveEmbedding.mockRejectedValueOnce(insufficientCreditsError('Insufficient credits'));

    await expect(call(100, undefined, undefined, false)).rejects.toMatchObject({ statusCode: 422 });
    expect(m.reserveEmbedding).toHaveBeenCalledBefore(m.embed);
    expect(m.embed).toHaveBeenCalledOnce();
    expect(m.settleEmbedding).toHaveBeenCalledOnce();
    expect(m.reserveEmbedding).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ user: expect.objectContaining({ id: 'u1' }) }),
      getEmbeddingModelCost('text-embedding-3-small', Buffer.byteLength(QUERY, 'utf8')),
      'semantic search embedding'
    );
  });

  it('refunds an embedding hold when its provider fails', async () => {
    m.embed.mockRejectedValue(new Error('embedding unavailable'));

    expect((await call(100))._getStatusCode()).toBe(500);
    expect(m.refundEmbedding).toHaveBeenCalledOnce();
    expect(m.settleEmbedding).not.toHaveBeenCalled();
  });

  it('does not refuse a zero-credit caller when credits are not enforced', async () => {
    m.enforce = false;

    const res = await call(0);

    expect(res._getStatusCode()).toBe(200);
    expect(m.embed).toHaveBeenCalled();
  });
});

it('enforces the API completion quota before invoking the model', async () => {
  const refusal = new Error('completion quota exhausted');
  quotaAdmission.mockRejectedValueOnce(refusal);
  await expect(call(1000)).rejects.toBe(refusal);
  expect(quotaAdmission).toHaveBeenCalledWith(expect.objectContaining({ user: expect.any(Object) }), {
    holdSlot: true,
  });
  expect(m.embed).not.toHaveBeenCalled();
});
