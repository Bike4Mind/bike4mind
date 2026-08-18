import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockGetEffectiveLLMApiKeys, mockGetSettingsValue, mockGetProviderFromModel, mockGenerateEmbedding } =
  vi.hoisted(() => ({
    mockGetEffectiveLLMApiKeys: vi.fn(),
    mockGetSettingsValue: vi.fn(),
    mockGetProviderFromModel: vi.fn(),
    mockGenerateEmbedding: vi.fn(),
  }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
// getProviderFromModel is stubbed so a test can choose the provider; resolveEmbeddingConfig is
// the real one, because which credential a provider needs is the behaviour under test.
vi.mock('@bike4mind/fab-pipeline', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/fab-pipeline')>()),
  getProviderFromModel: mockGetProviderFromModel,
  EmbeddingFactory: class {
    createEmbeddingService() {
      return { generateEmbedding: mockGenerateEmbedding };
    }
  },
}));
vi.mock('@bike4mind/utils', () => ({
  computeCosineSimilarity: () => 0.9,
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: { getSettingsValue: mockGetSettingsValue },
  sessionRepository: { find: vi.fn(async () => []) },
}));
vi.mock('@bike4mind/database/content', () => ({ Quest: { find: vi.fn(() => ({ lean: async () => [] })) } }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys },
  // Query expansion is best-effort behind a try/catch; throwing exercises its keyword fallback
  // and keeps these tests on the provider-resolution path.
  SmallLLMService: class {
    expandQuery() {
      throw new Error('expansion unavailable in test');
    }
  },
  ReRankService: class {},
}));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn(async () => ({ modelId: 'm', llm: {} })) },
}));

import { BedrockEmbeddingModel, ModelBackend } from '@bike4mind/common';
import handler from '@pages/api/sessions/semantic-search';

const makeReq = () =>
  ({
    user: { id: 'u1' },
    body: { query: 'where did we discuss onboarding' },
    logger: { updateMetadata: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as never;

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.json = vi.fn(() => res);
  res.status = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
};

// #1122: this route resolved the embedding provider through an if/else-if chain ending in a
// catch-all `else` that returned 400 "Unsupported embedding provider". Bedrock reached that arm
// even though the admin dropdown offers Bedrock embedders and the vectorize pipeline accepts
// them, so a corpus that ingested fine failed on every session search.
describe('POST /api/sessions/semantic-search embedding provider resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    mockGetSettingsValue.mockResolvedValue(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2);
    mockGetProviderFromModel.mockReturnValue(ModelBackend.Bedrock);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({});
  });

  it('accepts a Bedrock model on an environment holding no provider key at all', async () => {
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('does not describe a keyless provider as unsupported', async () => {
    const res = makeRes();

    await handler(makeReq(), res);

    const bodies = res.json.mock.calls.map(c => JSON.stringify(c[0]));
    expect(bodies.some(b => b.includes('Unsupported embedding provider'))).toBe(false);
  });

  it('still rejects a keyed provider whose credential is genuinely absent', async () => {
    // The fix is about keyless providers, not about making every missing credential silent.
    mockGetProviderFromModel.mockReturnValue(ModelBackend.OpenAI);
    mockGetSettingsValue.mockResolvedValue('text-embedding-3-small');
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('OpenAI') }));
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('still passes a present credential through to the factory', async () => {
    mockGetProviderFromModel.mockReturnValue(ModelBackend.OpenAI);
    mockGetSettingsValue.mockResolvedValue('text-embedding-3-small');
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-present' });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });
});
