import { CreditHolderType, isZodError } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getEffectiveLLMApiKeys,
  countTokens,
  generateEmbeddingBatch,
  generateEmbedding,
  getSettingsValue,
  recordUsage,
  reserve,
  refund,
  settle,
} = vi.hoisted(() => ({
  getEffectiveLLMApiKeys: vi.fn(),
  countTokens: vi.fn(),
  generateEmbeddingBatch: vi.fn(),
  generateEmbedding: vi.fn(),
  getSettingsValue: vi.fn(),
  recordUsage: vi.fn(),
  reserve: vi.fn(),
  refund: vi.fn(),
  settle: vi.fn(),
}));

// Contract-adapter mock, as in pages/api/ai/__tests__/sound-effects.test.ts: runs the contract's own
// request schema into `req.validated` so body validation stays under test.
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: { request: { parse: (body: unknown) => unknown } }) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        try {
          const route = h[(req as { method?: string }).method ?? 'GET'];
          if (!route) return;
          (req as { validated?: unknown }).validated = contract.request.parse((req as { body?: unknown }).body);
          return await route(req, res);
        } catch (err) {
          const status = isZodError(err)
            ? 422
            : typeof (err as { statusCode?: number })?.statusCode === 'number'
              ? (err as { statusCode: number }).statusCode
              : 500;
          (res as { status: (n: number) => { json: (b: unknown) => void } })
            .status(status)
            .json({ error: (err as Error)?.message });
        }
      },
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: {},
  usageEventRepository: { record: (...a: unknown[]) => recordUsage(...a) },
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: (...a: unknown[]) => getEffectiveLLMApiKeys(...a) },
}));
// The real resolver, provider mapping and auth-error guard, so the credential gate is the one
// production runs; only the network-facing factory and the tokenizer are stubbed.
vi.mock('@bike4mind/fab-pipeline', async importActual => {
  const modelDimensions: Record<string, number[]> = {
    'text-embedding-3-small': [1536],
    'voyage-3-large': [1024, 256, 512, 2048],
  };
  return {
    ...(await importActual<typeof import('@bike4mind/fab-pipeline')>()),
    EmbeddingFactory: class {
      createEmbeddingService(model: string) {
        const service = {
          generateEmbedding: (...a: unknown[]) => generateEmbedding(...a),
          getModelInfo: () => ({ provider: 'x', model, contextWindow: 8192, dimensions: modelDimensions[model] }),
        };
        // Voyage has no batch API in production either.
        return model.startsWith('voyage')
          ? service
          : { ...service, generateEmbeddingBatch: (...a: unknown[]) => generateEmbeddingBatch(...a) };
      }
    },
  };
});
vi.mock('@bike4mind/utils', () => ({
  createTokenizer: () => ({ countTokens: (...a: unknown[]) => countTokens(...a) }),
  getSettingsByNames: vi.fn(),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: (...a: unknown[]) => getSettingsValue(...a),
}));
vi.mock('@server/billing/reserveRequestCredits', () => ({
  reserveRequestCredits: (...a: unknown[]) => reserve(...a),
}));

import { EmbeddingAuthError } from '@bike4mind/fab-pipeline';
import handler from '../embeddings';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const run = async (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, logger: { error: vi.fn(), warn: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
};

const vectorOf = (width: number) => Array.from({ length: width }, (_, i) => (i === 0 ? 1 : 0));

describe('POST /api/v1/embeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-real', voyageai: 'pa-real' });
    countTokens.mockResolvedValue(5);
    generateEmbeddingBatch.mockImplementation(async (texts: string[]) => texts.map(() => vectorOf(1536)));
    getSettingsValue.mockReturnValue(true);
    recordUsage.mockResolvedValue(undefined);
    settle.mockImplementation(async (credits: number) => credits);
    reserve.mockResolvedValue({
      ownerId: 'u1',
      ownerType: CreditHolderType.User,
      reservedCredits: 1,
      refund,
      settle,
    });
  });

  it('returns an OpenAI-shaped list, one vector per input in order', async () => {
    const { status, body } = await run({ model: 'text-embedding-3-small', input: ['a', 'b'] });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      object: 'list',
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 },
    });
    expect(body.data.map((d: { index: number; object: string }) => [d.object, d.index])).toEqual([
      ['embedding', 0],
      ['embedding', 1],
    ]);
    expect(body.data[0].embedding).toHaveLength(1536);
    expect(generateEmbeddingBatch).toHaveBeenCalledWith(['a', 'b'], [5, 5]);
  });

  it('reserves the priced cost up front and settles the text-generation ledger type', async () => {
    await run({ model: 'text-embedding-3-small', input: 'hello' });

    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ requiredCredits: 1, enforceCredits: true, featureLabel: 'embeddings' })
    );
    expect(settle).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ type: 'text_generation_usage', inputTokens: 5, outputTokens: 0, source: 'api' })
    );
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'embedding', status: 'ok' }));
  });

  it('truncates to the requested width and base64-encodes on request', async () => {
    const { status, body } = await run({
      model: 'text-embedding-3-small',
      input: 'a',
      dimensions: 256,
      encoding_format: 'base64',
    });

    expect(status).toBe(200);
    const decoded = new Float32Array(new Uint8Array(Buffer.from(body.data[0].embedding, 'base64')).buffer);
    expect(decoded).toHaveLength(256);
    expect(decoded[0]).toBe(1);
  });

  it('forwards a Voyage published width to the provider instead of truncating', async () => {
    generateEmbedding.mockResolvedValue(vectorOf(512));

    const { status } = await run({ model: 'voyage-3-large', input: 'a', dimensions: 512 });

    expect(status).toBe(200);
    expect(generateEmbedding).toHaveBeenCalledWith('a', { outputDimension: 512 });
  });

  it('rejects a width the model cannot produce, before any spend', async () => {
    const { status, body } = await run({ model: 'text-embedding-3-small', input: 'a', dimensions: 4096 });

    expect(status).toBe(422);
    expect(body.error).toBe('text-embedding-3-small supports dimensions from 1 to 1536.');
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects an input past the model context window', async () => {
    countTokens.mockResolvedValueOnce(5).mockResolvedValueOnce(9000);

    const { status, body } = await run({ model: 'text-embedding-3-small', input: ['ok', 'huge'] });

    expect(status).toBe(422);
    expect(body.error).toContain('input[1] is 9000 tokens');
    expect(reserve).not.toHaveBeenCalled();
  });

  it('caps the input count so the response fits the Lambda payload limit', async () => {
    const { status, body } = await run({ model: 'text-embedding-3-small', input: Array(129).fill('a') });

    expect(status).toBe(422);
    expect(body.error).toBe(
      'At 1536 dimensions a request may carry at most 128 inputs; split the input into smaller requests.'
    );
  });

  it('503s provider_not_configured when the deployment holds no key for the model', async () => {
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'expired' });

    const { status, body } = await run({ model: 'text-embedding-3-small', input: 'a' });

    expect(status).toBe(503);
    expect(body.errorCode).toBe('provider_not_configured');
    expect(reserve).not.toHaveBeenCalled();
  });

  it('refunds and 502s when the provider fails', async () => {
    generateEmbeddingBatch.mockRejectedValue(new Error('upstream 500'));

    const { status } = await run({ model: 'text-embedding-3-small', input: 'a' });

    expect(status).toBe(502);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', creditsCharged: 0 }));
  });

  it('refunds and 401s provider_rejected when the provider refuses the key', async () => {
    generateEmbeddingBatch.mockRejectedValue(new EmbeddingAuthError('openai', 'revoked key'));

    const { status, body } = await run({ model: 'text-embedding-3-small', input: 'a' });

    expect(status).toBe(401);
    expect(body.errorCode).toBe('provider_rejected');
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown model and an empty input through the contract schema', async () => {
    expect((await run({ model: 'gpt-4o', input: 'a' })).status).toBe(422);
    expect((await run({ model: 'text-embedding-3-small', input: '' })).status).toBe(422);
    expect((await run({ model: 'text-embedding-3-small', input: [] })).status).toBe(422);
  });
});
