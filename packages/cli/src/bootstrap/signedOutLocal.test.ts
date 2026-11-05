import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../auth/ApiClient.js';
import { createMockConfig } from '../test-utils/mocks.js';
import { buildLlmBackend, defaultLlmBackendDeps, type BuildLlmBackendDeps } from './buildLlmBackend.js';
import { NoLocalModelsError, signedOutCloudModelMessage, signedOutNoMatchMessage } from './signedOutLocal.js';

const CLOUD = 'https://cloud.example.test';
const OLLAMA = 'http://127.0.0.1:11434';
const LOCAL_MODEL = 'qwen3.5:4b';

const json = (body: unknown) =>
  new Response(`${JSON.stringify(body)}\n`, { status: 200, headers: { 'content-type': 'application/json' } });

/** An Ollama on the default loopback address; `models` empty means running with nothing pulled. */
function ollamaFetch(models: string[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    switch (url.pathname) {
      case '/api/version':
        return json({ version: '0.12.0' });
      case '/api/tags':
        return json({ models: models.map(name => ({ name, model: name, size: 1, digest: 'd', details: {} })) });
      case '/api/show':
        return json({ capabilities: ['completion'], model_info: { 'qwen3.context_length': 32768 } });
      case '/api/chat':
        return json({
          model: LOCAL_MODEL,
          created_at: new Date(0).toISOString(),
          message: { role: 'assistant', content: 'hello from ollama' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 3,
          eval_count: 4,
        });
      default:
        return new Response('not found', { status: 404 });
    }
  });
}

const tokenStore = { getAuthTokens: async () => null } as never;

/** Real transports, minus Desktop's saved servers, which live in the developer's home directory. */
const deps: BuildLlmBackendDeps = {
  ...defaultLlmBackendDeps,
  loadModelServers: async () => ({ servers: [], problem: null }),
};

function signedOutInput(over: Record<string, unknown> = {}) {
  return {
    config: createMockConfig({ defaultModel: 'claude-opus-4', apiConfig: { customUrl: CLOUD, endpointChosen: true } }),
    apiClient: ApiClient.whileSignedOut(tokenStore),
    tokenGetter: async () => null,
    startupLog: [] as string[],
    detectOllama: true,
    ...over,
  };
}

let nodeRequests: string[];

beforeEach(() => {
  vi.stubEnv('B4M_OLLAMA_HOST', '');
  nodeRequests = [];
  const record =
    (scheme: string) =>
    (...args: unknown[]): never => {
      nodeRequests.push(`${scheme}:${String(args[0])}`);
      throw new Error('network is off in this test');
    };
  vi.spyOn(http, 'request').mockImplementation(record('http'));
  vi.spyOn(https, 'request').mockImplementation(record('https'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signed-out start', () => {
  it('reaches a local chat without a single request to the cloud', async () => {
    const fetchMock = ollamaFetch([LOCAL_MODEL]);
    vi.stubGlobal('fetch', fetchMock);
    const input = signedOutInput();

    const { llm, models, modelInfo, wsManager } = await buildLlmBackend(input, deps);
    let reply = '';
    await llm.complete(modelInfo.id, [{ role: 'user', content: 'hi' }], { stream: false }, async text => {
      reply += text.join('');
    });

    expect(models.map(model => model.id)).toEqual([LOCAL_MODEL]);
    expect(modelInfo.id).toBe(LOCAL_MODEL);
    expect(reply).toContain('hello from ollama');
    expect(wsManager).toBeNull();
    const urls = fetchMock.mock.calls.map(([request]) => String(request instanceof Request ? request.url : request));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter(url => !url.startsWith(`${OLLAMA}/`))).toEqual([]);
    expect(urls.some(url => url.startsWith(CLOUD))).toBe(false);
    expect(nodeRequests).toEqual([]);
    expect(input.startupLog.join('\n')).toContain('Default model claude-opus-4 is not a local model; using qwen3.5:4b');
  });

  it('refuses every Bike4Mind request on the signed-out client without sending it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const apiClient = ApiClient.whileSignedOut(tokenStore);

    expect(apiClient.signedOut).toBe(true);
    await expect(apiClient.get('/api/settings/serverConfig')).rejects.toThrow(
      'Not signed in, so /api/settings/serverConfig was not sent to Bike4Mind. Run /login to sign in.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nodeRequests).toEqual([]);
  });
});

describe('picking a cloud model while signed out', () => {
  it('answers with how to sign in instead of reaching the cloud', async () => {
    const fetchMock = ollamaFetch([LOCAL_MODEL]);
    vi.stubGlobal('fetch', fetchMock);
    const { llm } = await buildLlmBackend(signedOutInput(), deps);
    fetchMock.mockClear();

    await expect(llm.complete('claude-opus-4', [{ role: 'user', content: 'hi' }], {}, async () => {})).rejects.toThrow(
      signedOutCloudModelMessage('claude-opus-4')
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nodeRequests).toEqual([]);
    expect(signedOutCloudModelMessage('claude-opus-4')).toBe(
      'claude-opus-4 is a Bike4Mind cloud model and needs you to be signed in. Run /login to sign in and use Bike4Mind cloud models.'
    );
  });

  it('says how to sign in when /model names nothing local', () => {
    expect(signedOutNoMatchMessage('sonnet')).toBe(
      'No local model matches "sonnet". Cloud models are not listed while you are signed out. Run /login to sign in and use Bike4Mind cloud models.'
    );
  });
});

describe('signed out with no local model', () => {
  const failure = async (input = signedOutInput()) => {
    const error = await buildLlmBackend(input, deps).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(NoLocalModelsError);
    return error as NoLocalModelsError;
  };

  it('says how to start or install Ollama, or sign in, when nothing answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const error = await failure();

    expect(error.reason).toBe(
      'No local model found. Start Ollama (open the Ollama app or run "ollama serve"), or install it from https://ollama.com/download, then pull a model: ollama pull qwen3.5'
    );
    expect(error.message).toContain('sign in: run b4m, then /login');
    expect(nodeRequests).toEqual([]);
  });

  it('says to pull a model when Ollama runs with none', async () => {
    vi.stubGlobal('fetch', ollamaFetch([]));

    const error = await failure();

    expect(error.reason).toBe(
      `No local model found: Ollama at ${OLLAMA} has no models. Pull one with: ollama pull qwen3.5`
    );
  });

  it('says to start a configured Ollama that does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    const config = createMockConfig({ defaultModel: 'claude-opus-4', ollamaHost: 'http://gpu-box:11434' });

    const error = await failure(signedOutInput({ config }));

    expect(error.reason).toMatch(
      /^No local model found: Ollama at http:\/\/gpu-box:11434 is not answering \(.+\)\. Start it/
    );
  });
});

describe('signed in', () => {
  it('still reads the server config and builds the server backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    const serverBackend = { currentModel: 'm1', getModelInfo: async () => [{ id: 'm1' }] } as never;
    const get = vi.fn(async () => ({ sseCompletionsUrl: `${CLOUD}/api/ai/v1/completions` }));
    const createServerBackend = vi.fn(() => serverBackend);

    const result = await buildLlmBackend(signedOutInput({ apiClient: { signedOut: false, get } as never }), {
      ...deps,
      createServerBackend,
    });

    expect(get).toHaveBeenCalledWith('/api/settings/serverConfig');
    expect(createServerBackend).toHaveBeenCalledWith(
      expect.objectContaining({ sseCompletionsUrl: `${CLOUD}/api/ai/v1/completions` })
    );
    expect(result.llm).toBe(serverBackend);
    expect(result.modelInfo.id).toBe('m1');
  });
});
