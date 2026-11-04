import {
  EMBEDDING_MODEL_IDS,
  getEmbeddingModelCapabilities,
  ListEmbeddingModelsResponseSchema,
} from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getKeys, registered } = vi.hoisted(() => ({
  getKeys: vi.fn(),
  registered: { value: ['openai'] as string[] },
}));
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => {
    let callback: (req: unknown, res: unknown) => unknown;
    const handler = (req: unknown, res: unknown) => callback(req, res);
    return Object.assign(handler, {
      get: (route: typeof callback) => {
        callback = route;
        return handler;
      },
    });
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, apiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: getKeys } }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/services/llm/embeddingProviders', () => ({
  getEmbeddingProviderRegistry: () => ({
    ids: () => registered.value,
    get: (provider: string) =>
      registered.value.includes(provider)
        ? { models: EMBEDDING_MODEL_IDS.filter(model => getEmbeddingModelCapabilities(model).provider === provider) }
        : undefined,
  }),
}));

import handler from '../embedding-models';
const run = async () => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'u1' }, logger: {} });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return ListEmbeddingModelsResponseSchema.parse(res._getJSONData());
};

describe('GET /api/v1/embedding-models', () => {
  beforeEach(() => {
    registered.value = ['openai'];
    getKeys.mockReset().mockResolvedValue({ openai: 'sk-real' });
  });

  it('lists only registered providers with dimensions, limits and pricing', async () => {
    const { models } = await run();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(model => model.provider === 'openai')).toBe(true);
    expect(models.find(model => model.id === 'text-embedding-3-small')).toMatchObject({
      object: 'embedding_model',
      dimensions: { kind: 'range', min: 1, native: 1536 },
      max_input_tokens: 8192,
      supports_input_type: false,
      pricing: { usd_per_million_input_tokens: 0.02 },
    });
    expect(getKeys).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when no providers are registered', async () => {
    registered.value = [];
    expect((await run()).models).toEqual([]);
  });

  it('does not hide a credential lookup failure behind an empty list', async () => {
    getKeys.mockRejectedValueOnce(new Error('credentials unavailable'));
    await expect(run()).rejects.toThrow('credentials unavailable');
  });
});
