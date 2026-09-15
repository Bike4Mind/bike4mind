import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ImageModels, ModelBackend } from '@bike4mind/common';

/**
 * T9, the /api/models parity suite. The route delegates its fan-out to
 * getAvailableModels, so the real llm-adapters module stays unmocked and only the
 * two backends that reach the network are faked: LocalImage through axios and
 * Ollama through the global fetch its client is handed. Everything the parity
 * rows assert is therefore observed in the route's own response body.
 */

const mockGetEffectiveLLMApiKeys = vi.fn();
const mockCacheFindOne = vi.fn();
const mockCacheCreateOrUpdate = vi.fn();

vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: {},
  cacheRepository: {
    findOne: (...a: unknown[]) => mockCacheFindOne(...a),
    createOrUpdate: (...a: unknown[]) => mockCacheCreateOrUpdate(...a),
  },
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: (...a: unknown[]) => mockGetEffectiveLLMApiKeys(...a) },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));

// Strip the middleware chain (DB connect, auth, logging) so the test exercises
// the route body, matching the other pages/api suites.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));

vi.mock('axios', () => ({
  default: { get: vi.fn(async () => ({ data: [{ title: 'sd15.safetensors [x]', model_name: 'sd15' }] })) },
}));

const LOCAL_IMAGE_MODEL = 'local-image/sd15';
const PRIVATE_BFL_MODEL = ImageModels.FLUX_PRO_FILL;
const PUBLIC_BFL_MODEL = ImageModels.FLUX_PRO_1_1;

const noKeys = {
  openai: null,
  anthropic: null,
  gemini: null,
  bfl: null,
  ollama: null,
  xai: null,
  voyageai: null,
  imageGen: null,
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Ollama listing that names the host it came from, so a shared cache entry is visible as a wrong id. */
const ollamaModelId = (host: string) => `model-at-${host}`;

let hangOllama = false;

const { default: handler } = await import('@pages/api/models');
const { setModelPriceRowsProvider } = await import('@bike4mind/llm-adapters');

const savedSelfHost = process.env.B4M_SELF_HOST;

beforeEach(() => {
  vi.clearAllMocks();
  hangOllama = false;
  mockGetEffectiveLLMApiKeys.mockResolvedValue(noKeys);
  mockCacheFindOne.mockResolvedValue(null);
  mockCacheCreateOrUpdate.mockResolvedValue(undefined);
  delete process.env.B4M_SELF_HOST;
  // Also clears the llm-adapters module-level model cache, so each case re-runs
  // the fan-out instead of reusing the previous case's list.
  setModelPriceRowsProvider(null);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input instanceof URL ? input.href : input);
      if (hangOllama) return new Promise<Response>(() => {});
      const host = new URL(url).host;
      if (url.includes('/api/tags')) return jsonResponse({ models: [{ name: ollamaModelId(host) }] });
      if (url.includes('/api/show')) {
        return jsonResponse({ capabilities: ['tools'], model_info: { 'test.context_length': 4096 } });
      }
      return jsonResponse({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setModelPriceRowsProvider(null);
  if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
  else process.env.B4M_SELF_HOST = savedSelfHost;
});

async function callRoute(userId?: string) {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, {
    user: userId ? { id: userId } : undefined,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  });
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
  const body = JSON.parse(res._getData()) as { models: Array<{ id: string; backend: string; private?: boolean }> };
  return body.models;
}

describe('/api/models provider coverage', () => {
  /**
   * The route used to hand-build its ApiKeyTable, so a provider absent from that
   * literal was a provider no user could select - Kimi shipped that way and the
   * gap was invisible to a smoke test, because the two Bedrock-served Kimi ids
   * come from UndifferentiatedBedrockBackend and appeared regardless. The route
   * now goes through buildApiKeyTable; these cases hold that line.
   */
  // The positive case (a Moonshot key yields the five direct ids) lives in
  // llm-adapters' buildApiKeyTable.test.ts instead: this suite runs in a
  // browser-like environment where the OpenAI SDK refuses to construct, so no
  // SDK-backed backend can be instantiated here at all.
  it('lists no direct Kimi model without a Moonshot key', async () => {
    const models = await callRoute('user-1');
    expect(models.some(m => m.backend === ModelBackend.Kimi)).toBe(false);
  });

  it('offers Bedrock-served Kimi without any provider key, which is why it cannot stand in for the direct check', async () => {
    const models = await callRoute('user-1');
    expect(models.some(m => m.id === 'moonshotai.kimi-k2.5')).toBe(true);
  });
});

describe('/api/models parity with getAvailableModels', () => {
  it('filters private models out of the picker response', async () => {
    const models = await callRoute('user-1');

    expect(models.some(m => m.id === PRIVATE_BFL_MODEL)).toBe(false);
    // Control: the same always-constructed BFL listing still contributes.
    expect(models.some(m => m.id === PUBLIC_BFL_MODEL)).toBe(true);
    expect(models.every(m => !m.private)).toBe(true);
  });

  it('omits Bedrock and AWS under self-host and offers them otherwise', async () => {
    const hosted = await callRoute('user-1');
    expect(hosted.some(m => m.backend === ModelBackend.Bedrock)).toBe(true);
    expect(hosted.some(m => m.backend === ModelBackend.AWS)).toBe(true);

    process.env.B4M_SELF_HOST = 'true';
    setModelPriceRowsProvider(null);

    const selfHosted = await callRoute('user-1');
    expect(selfHosted.some(m => m.backend === ModelBackend.Bedrock)).toBe(false);
    expect(selfHosted.some(m => m.backend === ModelBackend.AWS)).toBe(false);
  });

  it('honors the per-backend timeout: a hung backend degrades instead of hanging the route', async () => {
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noKeys, ollama: 'http://hung:11434' });
    hangOllama = true;

    const models = await callRoute('user-1');

    expect(models.some(m => m.backend === ModelBackend.Ollama)).toBe(false);
    // The rest of the fan-out still answered: the deadline is per backend.
    expect(models.some(m => m.backend === ModelBackend.Bedrock)).toBe(true);
  });

  it('maps the imageGen key onto local-image, so local image models are not dropped', async () => {
    // B4M_SELF_HOST stays unset, which disables resolveListingKey's env fallback:
    // the model can only appear if the route normalized the key onto the backend.
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noKeys, imageGen: 'http://imagegen:7860' });

    const models = await callRoute('user-1');

    expect(models.some(m => m.id === LOCAL_IMAGE_MODEL)).toBe(true);
  });

  it('gives two callers with different Ollama base URLs different lists', async () => {
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noKeys, ollama: 'http://a:11434' });
    const first = await callRoute('user-a');

    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noKeys, ollama: 'http://b:11434' });
    const second = await callRoute('user-b');

    expect(first.some(m => m.id === ollamaModelId('a:11434'))).toBe(true);
    expect(second.some(m => m.id === ollamaModelId('b:11434'))).toBe(true);
    expect(second.some(m => m.id === ollamaModelId('a:11434'))).toBe(false);
  });
});

describe('/api/models cache identity', () => {
  it('caches an authenticated caller under its own user id', async () => {
    await callRoute('user-1');

    expect(mockCacheFindOne).toHaveBeenCalledWith({ key: 'model-list:user-1' });
    expect(mockCacheCreateOrUpdate).toHaveBeenCalledWith(expect.objectContaining({ key: 'model-list:user-1' }));
  });

  it('passes null down for an unauthenticated caller and keys it away from "system"', async () => {
    await callRoute();

    expect(mockGetEffectiveLLMApiKeys).toHaveBeenCalledWith(null, expect.anything());
    expect(mockCacheFindOne).toHaveBeenCalledWith({ key: 'model-list:anonymous' });
    expect(mockCacheCreateOrUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'model-list:system' }));
  });

  it('serves a cache hit without rebuilding the model list', async () => {
    mockCacheFindOne.mockResolvedValue({ result: { models: [{ id: 'cached-model' }] } });

    const models = await callRoute('user-1');

    expect(models).toEqual([{ id: 'cached-model' }]);
    expect(mockGetEffectiveLLMApiKeys).not.toHaveBeenCalled();
  });
});
