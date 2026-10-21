import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { getAvailableModels, setModelPriceRowsProvider } from './index';
import { OpenAIBackend } from './openaiBackend';

// The real OllamaBackend against a stubbed fetch, so the listing failure travels
// the same path a down Ollama host does in production.
const OLLAMA_KEYS = { ollama: 'http://ollama.test:11434' };
const fetchMock = vi.fn<typeof fetch>();

const hasLlama = (ms: ModelInfo[]) => ms.some(m => String(m.id) === 'llama3.2:latest');

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const ollamaUp = async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/api/tags')) return json({ models: [{ name: 'llama3.2:latest' }] });
  if (url.endsWith('/api/show')) return json({ capabilities: ['completion'], model_info: {} });
  throw new Error(`unexpected request ${url}`);
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // Also resets the module-level model cache, so each case re-runs the fan-out.
  setModelPriceRowsProvider(null);
  vi.stubEnv('B4M_SELF_HOST', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setModelPriceRowsProvider(null);
});

describe('getAvailableModels with a real Ollama listing', () => {
  it('reports a failed Ollama listing and caches it for the retry TTL, not the full TTL', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const failures: ModelBackend[][] = [];
    const onFailedListings = (backends: readonly ModelBackend[]) => failures.push([...backends]);

    const degraded = await getAvailableModels(OLLAMA_KEYS, { onFailedListings });
    expect(degraded.some(m => m.backend === ModelBackend.Ollama)).toBe(false);

    // A cached degraded list replays the failure it was built with.
    await getAvailableModels(OLLAMA_KEYS, { onFailedListings });
    expect(failures).toEqual([[ModelBackend.Ollama], [ModelBackend.Ollama]]);

    // 60s sits between the 30s retry TTL and the 5-minute full TTL.
    fetchMock.mockImplementation(ollamaUp);
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start + 60_000);

    const recovered = await getAvailableModels(OLLAMA_KEYS, { onFailedListings });
    expect(hasLlama(recovered)).toBe(true);
    expect(failures.at(-1)).toEqual([]);
  });

  it('serves the degraded list from cache until the 30s retry TTL lapses', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await getAvailableModels(OLLAMA_KEYS);
    const fetchesWhileDown = fetchMock.mock.calls.length;

    now.mockReturnValue(start + 29_000);
    await getAvailableModels(OLLAMA_KEYS);
    expect(fetchMock).toHaveBeenCalledTimes(fetchesWhileDown);

    fetchMock.mockImplementation(ollamaUp);
    now.mockReturnValue(start + 31_000);
    const recovered = await getAvailableModels(OLLAMA_KEYS);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchesWhileDown);
    expect(hasLlama(recovered)).toBe(true);
  });

  it('warns with the message alone for a down Ollama, and errors for a static backend', async () => {
    const warn = vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await getAvailableModels(OLLAMA_KEYS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ModelBackend.Ollama), 'fetch failed');
    expect(error).not.toHaveBeenCalled();

    vi.spyOn(OpenAIBackend.prototype, 'getModelInfo').mockRejectedValue(new Error('boom'));
    await getAvailableModels({ [ModelBackend.OpenAI]: 'sk-test' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(ModelBackend.OpenAI), expect.any(Error));
  });

  it('still returns the models when onFailedListings throws, fresh or cached', async () => {
    const error = vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation(ollamaUp);
    const onFailedListings = () => {
      throw new Error('callback bug');
    };

    const fresh = await getAvailableModels(OLLAMA_KEYS, { onFailedListings });
    const cached = await getAvailableModels(OLLAMA_KEYS, { onFailedListings });

    for (const models of [fresh, cached]) {
      expect(hasLlama(models)).toBe(true);
    }
    expect(error).toHaveBeenCalledTimes(2);
  });
});
