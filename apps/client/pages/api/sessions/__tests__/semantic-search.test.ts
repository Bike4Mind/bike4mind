import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@server/utils/untrustedCompletionQuota', () => ({
  admitRequestCompletion: vi.fn().mockResolvedValue({ release: async () => {} }),
}));

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const {
  mockGetEffectiveLLMApiKeys,
  mockGetSettingsValue,
  mockGetProviderFromModel,
  mockGenerateEmbedding,
  baseApiOptions,
} = vi.hoisted(() => ({
  mockGetEffectiveLLMApiKeys: vi.fn(),
  mockGetSettingsValue: vi.fn(),
  mockGetProviderFromModel: vi.fn(),
  mockGenerateEmbedding: vi.fn(),
  baseApiOptions: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: Record<string, unknown>) => {
    baseApiOptions.push(options);
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.post = compose;
    return chain;
  },
  methodNotAllowedHandler: () => () => undefined,
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
  organizationRepository: {},
  usageEventRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  // No samples and no settings rows: the spend cap reads defaults and never refuses here.
  newAccountSpendCapAdapters: {
    adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
    personalSpendSince: async () => [],
  },
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  isCreditsEnforced: async () => false,
  createRequestCompletionMeter: vi.fn(),
  reserveCompletionCredits: async () => ({ refund: vi.fn() }),
  settleCompletion: vi.fn(),
}));
vi.mock('@bike4mind/database/content', () => ({ Quest: { find: vi.fn(() => ({ lean: async () => [] })) } }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys },
  // Metering is covered in semantic-search.metering.test.ts.
  recordOperationalUsage: vi.fn(async () => undefined),
  meterCompletionBackend: (llm: unknown) => llm,
  creditService: {},
  organizationService: {},
}));
vi.mock('@bike4mind/services/llm/SmallLLMService', () => ({
  // Query expansion is best-effort behind a try/catch; throwing exercises its keyword fallback
  // and keeps these tests on the provider-resolution path.
  SmallLLMService: class {
    expandQuery() {
      throw new Error('expansion unavailable in test');
    }
  },
}));
vi.mock('@bike4mind/services/llm/reranker', () => ({
  ReRankService: class {},
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn(async () => ({ modelId: 'm', llm: {} })) },
}));

import { BedrockEmbeddingModel, ModelBackend } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import handler from '@pages/api/sessions/semantic-search';

// The legacy URL serves the v1 contract handler, so the real request validation and defaults run.
const run = async (body: Record<string, unknown> = { query: 'where did we discuss onboarding' }) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, {
    user: { id: 'u1' },
    logger: { updateMetadata: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
};

// #1122: this route resolved the embedding provider through an if/else-if chain ending in a
// catch-all `else` that returned 400 "Unsupported embedding provider". Bedrock reached that arm
// even though the admin dropdown offers Bedrock embedders and the vectorize pipeline accepts
// them, so a corpus that ingested fine failed on every session search.
describe('POST /api/sessions/semantic-search embedding provider resolution', () => {
  const savedLambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    mockGetSettingsValue.mockResolvedValue(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2);
    mockGetProviderFromModel.mockReturnValue(ModelBackend.Bedrock);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({});
    // This route runs in the Next server Lambda. hasKeylessCloudEmbedder wants positive evidence
    // of an execution role, so the hosted runtime is stated rather than inherited from the test
    // process - which has none, and would otherwise read as "cannot reach Bedrock".
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'some-stage-frontendServer';
  });
  afterEach(() => {
    if (savedLambdaName === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = savedLambdaName;
  });

  it('accepts a Bedrock model on an environment holding no provider key at all', async () => {
    const res = await run();

    expect(res._getStatusCode()).not.toBe(400);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('does not describe a keyless provider as unsupported', async () => {
    const res = await run();

    expect(res._getData()).not.toContain('Unsupported embedding provider');
  });

  it('still rejects a keyed provider whose credential is genuinely absent, on self-host', async () => {
    // Self-host has no AWS role, so there is nothing to fall back TO and the actionable error
    // naming the provider is the only useful answer. This is the half of the old guard that
    // survives the keyless-fallback change.
    const originalSelfHost = process.env.B4M_SELF_HOST;
    process.env.B4M_SELF_HOST = 'true';
    try {
      mockGetProviderFromModel.mockReturnValue(ModelBackend.OpenAI);
      mockGetSettingsValue.mockResolvedValue('text-embedding-3-small');
      const res = await run();

      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData()).toEqual(expect.objectContaining({ error: expect.stringContaining('OpenAI') }));
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    } finally {
      if (originalSelfHost === undefined) delete process.env.B4M_SELF_HOST;
      else process.env.B4M_SELF_HOST = originalSelfHost;
    }
  });

  it('embeds with the keyless model instead of 400ing when a cloud stage has no credential', async () => {
    // The vectorizer already fell back to Bedrock when it wrote this stage's corpus, so refusing
    // the query answers from a space nothing was written into.
    mockGetProviderFromModel.mockReturnValue(ModelBackend.OpenAI);
    mockGetSettingsValue.mockResolvedValue('text-embedding-3-small');
    const res = await run();

    expect(res._getStatusCode()).not.toBe(400);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('still passes a present credential through to the factory', async () => {
    mockGetProviderFromModel.mockReturnValue(ModelBackend.OpenAI);
    mockGetSettingsValue.mockResolvedValue('text-embedding-3-small');
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-present' });
    const res = await run();

    expect(res._getStatusCode()).not.toBe(400);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/sessions/semantic-search request contract', () => {
  it('requires a notebook scope from an API key', () => {
    expect(baseApiOptions[0]).toMatchObject({ auth: true, requiredScopes: ['notebooks:read', 'notebooks:write'] });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    mockGetSettingsValue.mockResolvedValue(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2);
    mockGetProviderFromModel.mockReturnValue(ModelBackend.Bedrock);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({});
  });

  it.each([{}, { query: '' }, { query: '   ' }, { query: 'ok', topK: 0 }, { query: 'ok', minSimilarity: 2 }])(
    'rejects %j before any embedding is generated',
    async body => {
      await expect(run(body)).rejects.toBeDefined();
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    }
  );
});
