import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalog, resolveDefaultModel, selectUsableModels } from './ModelCatalog';

function wireModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude 4.5 Sonnet',
    type: 'text',
    backend: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    ...overrides,
  };
}

describe('selectUsableModels', () => {
  it("carries the model's output ceiling from the catalog's max_tokens", () => {
    expect(selectUsableModels([wireModel({ max_tokens: 16_384 })])[0]).toMatchObject({ maxOutputTokens: 16_384 });
    expect(selectUsableModels([wireModel()])[0]).not.toHaveProperty('maxOutputTokens');
  });

  it('keeps only text models that can call tools', () => {
    const models = selectUsableModels([
      wireModel(),
      wireModel({ id: 'dall-e-3', type: 'image' }),
      wireModel({ id: 'text-no-tools', supportsTools: false }),
      wireModel({ id: 'text-tools-unstated', supportsTools: undefined }),
    ]);

    expect(models.map(model => model.id)).toEqual(['claude-sonnet-4-5-20250929']);
  });

  it('falls back to the id when the server sent no display name', () => {
    expect(selectUsableModels([wireModel({ id: 'qwen3.5', name: '' })])[0]).toMatchObject({
      id: 'qwen3.5',
      name: 'qwen3.5',
    });
  });

  it('treats a non-array payload as no models rather than throwing', () => {
    expect(selectUsableModels(undefined)).toEqual([]);
    expect(selectUsableModels({ models: [] })).toEqual([]);
  });
});

describe('resolveDefaultModel', () => {
  it('prefers the requested model when the deployment offers it', () => {
    const models = selectUsableModels([wireModel({ id: 'a' }), wireModel({ id: 'b' })]);
    expect(resolveDefaultModel(models, 'b')).toBe('b');
  });

  it('falls back to the first model the server listed, never to a second hardcoded guess', () => {
    const models = selectUsableModels([wireModel({ id: 'a' }), wireModel({ id: 'b' })]);
    expect(resolveDefaultModel(models, 'not-here')).toBe('a');
  });

  it('answers null when the deployment offers nothing', () => {
    expect(resolveDefaultModel([], 'anything')).toBeNull();
  });
});

describe('ModelCatalog', () => {
  let get: ReturnType<typeof vi.fn>;
  let environmentUrl: string;
  let catalog: ModelCatalog;

  beforeEach(() => {
    get = vi.fn().mockResolvedValue({ models: [wireModel(), wireModel({ id: 'dall-e-3', type: 'image' })] });
    environmentUrl = 'http://localhost:3000';
    catalog = new ModelCatalog({
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => ({ get }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => environmentUrl,
    });
  });

  it('serves a second read from cache', async () => {
    expect((await catalog.list()).models.map(model => model.id)).toEqual(['claude-sonnet-4-5-20250929']);
    await catalog.list();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('refetches when the environment changed, so one server never shows another one models', async () => {
    await catalog.list();
    environmentUrl = 'https://hosted.example.com';

    expect(catalog.cached()).toBeNull();
    await catalog.list();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('refetches on force, which is what the picker retry needs', async () => {
    await catalog.list();
    await catalog.list(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  // A network blip must not be cached as "this server has no models" for the rest of the TTL.
  it('reports a failed lookup as an error and retries on the next read', async () => {
    get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const failed = await catalog.list();
    expect(failed.models).toEqual([]);
    expect(failed.error).toMatch(/could not load/i);
    expect(catalog.cached()).toBeNull();

    expect((await catalog.list()).models).toHaveLength(1);
  });

  // Distinct from the case above: the server answered, and genuinely has nothing to offer.
  it('reports an empty catalog without an error', async () => {
    get.mockResolvedValueOnce({ models: [] });
    expect(await catalog.list()).toEqual({ models: [] });
  });

  it('refuses to guess while signed out', async () => {
    catalog = new ModelCatalog({
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => environmentUrl,
    });

    expect((await catalog.list()).error).toMatch(/sign in/i);
  });
});
