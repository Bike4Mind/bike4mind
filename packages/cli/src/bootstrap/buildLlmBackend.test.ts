import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import type { OllamaBackend } from '@bike4mind/llm-adapters';
import {
  attachLocalModels,
  buildLlmBackend,
  defaultLlmBackendDeps,
  resolveHeadlessModel,
  resolveModelInfo,
  type BuildLlmBackendDeps,
} from './buildLlmBackend.js';
import { createMockConfig } from '../test-utils/mocks.js';
import { logger } from '../utils/Logger.js';
import { modelSavePatch } from '../utils/performModelSwitch.js';

const model = (id: string) => ({ id }) as ModelInfo;

/** An Ollama with one model, llama3:8b trained at 8K, answering over an injected fetch; records each chat body. */
function fakeOllamaFetch() {
  const chatRequests: { url: string; body: Record<string, unknown> }[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'llama3:8b', model: 'llama3:8b' }] });
    if (url.endsWith('/api/show'))
      return json({ capabilities: ['completion'], model_info: { 'llama.context_length': 8192 } });
    if (url.endsWith('/api/chat')) {
      chatRequests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return json({ message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1, done: true, done_reason: 'stop' });
    }
    return json({});
  }) as typeof globalThis.fetch;
  return { fetch, chatRequests };
}

/** Minimal backend exposing only what buildLlmBackend touches: getModelInfo + currentModel. */
function fakeBackend(models: ModelInfo[]) {
  return { currentModel: models[0]?.id ?? 'none', getModelInfo: async () => models } as never;
}

/** A fully-spied deps object; override individual members per test. */
function makeDeps(over: Partial<BuildLlmBackendDeps> = {}) {
  const fakeWs = { tag: 'ws' };
  const serverBackend = fakeBackend([model('m1')]);
  const deps: BuildLlmBackendDeps = {
    connectWebSocket: vi.fn(async () => fakeWs as never),
    clearWebSocketToolExecutor: vi.fn(),
    createServerBackend: vi.fn(() => serverBackend),
    createOllamaBackend: vi.fn(() => fakeBackend([model('ollama1')])),
    createOpenAICompatibleBackend: vi.fn(() => fakeBackend([])),
    createMultiBackend: vi.fn((_s, sm, routes: { models: ModelInfo[] }[]) =>
      fakeBackend([...sm, ...routes.flatMap(route => route.models)])
    ),
    loadModelServers: vi.fn(async () => ({ servers: [], problem: null })),
    detectOllama: vi.fn(async () => null),
    ...over,
  };
  return { deps, fakeWs, serverBackend };
}

const fakeApiClient = (serverConfig: unknown) => ({ get: vi.fn(async () => serverConfig) }) as never;

function makeInput(over: Record<string, unknown> = {}) {
  return {
    config: createMockConfig({ defaultModel: 'm1' }),
    apiClient: fakeApiClient({ websocketUrl: 'wss://x', wsCompletionUrl: 'wss://x/c', sseCompletionsUrl: 'https://x' }),
    tokenGetter: async () => 'token',
    startupLog: [] as string[],
    ...over,
  };
}

describe('resolveModelInfo', () => {
  it('returns the requested default model when present', () => {
    expect(resolveModelInfo([model('a'), model('b')], 'b').id).toBe('b');
  });
  it('falls back to the first model when the requested one is unavailable', () => {
    expect(resolveModelInfo([model('a'), model('b')], 'missing').id).toBe('a');
  });
});

describe('buildLlmBackend, a saved `local:` default', () => {
  it('fails instead of starting on a hosted model when its server is no longer saved', async () => {
    const { deps } = makeDeps();
    const config = createMockConfig({ defaultModel: 'local:srv-abc:qwen-small' });
    await expect(buildLlmBackend(makeInput({ config }), deps)).rejects.toThrow(
      'The default model qwen-small is on a model server that is not saved in Desktop any more, so it was not replaced by another model.'
    );
  });

  it('fails for a `local:` runtime the CLI cannot chat with', async () => {
    const { deps } = makeDeps();
    const config = createMockConfig({ defaultModel: 'local:llama-server:qwen-small' });
    await expect(buildLlmBackend(makeInput({ config }), deps)).rejects.toThrow(
      /Model "local:llama-server:qwen-small" is on a local runtime the CLI cannot chat with/
    );
  });
});

describe('buildLlmBackend — SSE-only completions', () => {
  it('always uses SSE and opens no socket when no WS-consuming feature is enabled', async () => {
    const { deps, serverBackend } = makeDeps();
    const res = await buildLlmBackend(makeInput(), deps);

    expect(deps.connectWebSocket).not.toHaveBeenCalled();
    expect(deps.clearWebSocketToolExecutor).toHaveBeenCalledOnce();
    expect(deps.createServerBackend).toHaveBeenCalledOnce();
    expect(res.wsManager).toBeNull();
    expect(res.llm).toBe(serverBackend);
    expect(res.modelInfo.id).toBe('m1');
  });

  it('passes the server-config sseCompletionsUrl through to the SSE backend', async () => {
    const { deps } = makeDeps();
    await buildLlmBackend(
      makeInput({ apiClient: fakeApiClient({ sseCompletionsUrl: 'https://cc.example/api/ai/v1/completions' }) }),
      deps
    );
    expect(deps.createServerBackend).toHaveBeenCalledWith(
      expect.objectContaining({ sseCompletionsUrl: 'https://cc.example/api/ai/v1/completions' })
    );
  });

  it('still builds an SSE backend when the serverConfig fetch fails', async () => {
    const { deps, serverBackend } = makeDeps();
    const apiClient = {
      get: vi.fn(async () => {
        throw new Error('network down');
      }),
    } as never;
    const res = await buildLlmBackend(makeInput({ apiClient }), deps);

    expect(deps.createServerBackend).toHaveBeenCalledWith(expect.objectContaining({ sseCompletionsUrl: undefined }));
    expect(deps.clearWebSocketToolExecutor).toHaveBeenCalledOnce();
    expect(res.llm).toBe(serverBackend);
    expect(res.wsManager).toBeNull();
  });
});

describe('buildLlmBackend — feature-event socket', () => {
  const tavernConfig = () => createMockConfig({ defaultModel: 'm1', features: { tavern: true } });

  // Completions moved to SSE, but Tavern's activity stream still needs the
  // socket - without it /tavern silently shows "No activity yet" forever.
  it('connects the socket when a WS-consuming feature is enabled', async () => {
    const { deps, fakeWs, serverBackend } = makeDeps();
    const res = await buildLlmBackend(makeInput({ config: tavernConfig() }), deps);

    expect(deps.connectWebSocket).toHaveBeenCalledWith('wss://x', expect.any(Function), expect.any(Function));
    expect(res.wsManager).toBe(fakeWs);
    // Completions still go over SSE, and server-side tool execution stays off.
    expect(res.llm).toBe(serverBackend);
    expect(deps.clearWebSocketToolExecutor).toHaveBeenCalledOnce();
  });

  it('skips the socket when the server advertises no websocketUrl', async () => {
    const { deps } = makeDeps();
    const res = await buildLlmBackend(
      makeInput({ config: tavernConfig(), apiClient: fakeApiClient({ sseCompletionsUrl: 'https://x' }) }),
      deps
    );

    expect(deps.connectWebSocket).not.toHaveBeenCalled();
    expect(res.wsManager).toBeNull();
  });

  it('degrades to no socket instead of failing startup when the connect throws', async () => {
    const { deps, serverBackend } = makeDeps({
      connectWebSocket: vi.fn(async () => {
        throw new Error('socket refused');
      }),
    });
    const res = await buildLlmBackend(makeInput({ config: tavernConfig() }), deps);

    expect(res.wsManager).toBeNull();
    expect(res.llm).toBe(serverBackend);
  });
});

describe('buildLlmBackend — Ollama multiplexing', () => {
  it('wraps the backend with a MultiLlmBackend when an ollama host is provided', async () => {
    const multi = fakeBackend([model('m1'), model('ollama1')]);
    const { deps } = makeDeps({
      createOllamaBackend: vi.fn(() => fakeBackend([model('ollama1')])),
      createMultiBackend: vi.fn(() => multi),
    });
    const startupLog: string[] = [];
    const res = await buildLlmBackend(
      makeInput({ apiClient: fakeApiClient({}), startupLog, ollamaHost: 'http://localhost:11434' }),
      deps
    );

    expect(deps.createOllamaBackend).toHaveBeenCalledWith('http://localhost:11434');
    expect(deps.createMultiBackend).toHaveBeenCalledOnce();
    expect(res.llm).toBe(multi);
    expect(startupLog.some(l => l.includes('Ollama'))).toBe(true);
    expect(res.modelInfo.id).toBe('m1');
  });

  it.each([
    ['http://localhost:11434', true],
    ['http://[::1]:11434', true],
    ['http://127.0.0.1:11500', false],
    ['http://gpu-box:11434', false],
  ])("gives %s Desktop's model settings: %s", async (ollamaHost, applies) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-wiring-'));
    const file = path.join(dir, 'model-settings.json');
    await writeFile(
      file,
      JSON.stringify({
        models: { 'local:ollama:llama3:8b': { keepAlive: 14400, context: { mode: 'fixed', tokens: 4096 } } },
      })
    );
    vi.stubEnv('B4M_DESKTOP_MODEL_SETTINGS', file);
    try {
      const { fetch, chatRequests } = fakeOllamaFetch();
      const { deps } = makeDeps({
        createOllamaBackend: vi.fn((host, options) =>
          defaultLlmBackendDeps.createOllamaBackend(host, { ...options, fetch })
        ),
      });
      await buildLlmBackend(makeInput({ apiClient: fakeApiClient({}), ollamaHost }), deps);
      const ollama = vi.mocked(deps.createOllamaBackend).mock.results[0].value as OllamaBackend;
      await ollama.complete('llama3:8b', [{ role: 'user', content: 'hi' }] as never, { stream: false }, async () => {});

      expect(chatRequests).toHaveLength(1);
      expect(chatRequests[0].url).toBe(`${ollamaHost}/api/chat`);
      const body = chatRequests[0].body;
      expect(body.model).toBe('llama3:8b');
      expect((body.options as { num_ctx?: number }).num_ctx).toBe(applies ? 4096 : 8192);
      expect(body.keep_alive).toBe(applies ? 14400 : undefined);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a context change mid-session to the log file only, never to the console under ink', async () => {
    let numCtx = 4096;
    const warnToFile = vi.spyOn(logger, 'warnToFile').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ollama = defaultLlmBackendDeps.createOllamaBackend('http://127.0.0.1:11434', {
        fetch: fakeOllamaFetch().fetch,
        requestSettings: async () => ({ numCtx }),
      }) as OllamaBackend;
      await ollama.getModelInfo();
      numCtx = 16384;
      await ollama.complete('llama3:8b', [{ role: 'user', content: 'hi' }] as never, { stream: false }, async () => {});

      expect(warnToFile).toHaveBeenCalledOnce();
      expect(warnToFile.mock.calls[0][0]).toContain('context change applies after restart');
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      warnToFile.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it('uses the host saved by `b4m models` when no flag or env names one', async () => {
    vi.stubEnv('B4M_OLLAMA_HOST', '');
    try {
      const { deps } = makeDeps();
      const config = createMockConfig({ defaultModel: 'ollama1', ollamaHost: 'http://127.0.0.1:11500' });
      const res = await buildLlmBackend(makeInput({ config, apiClient: fakeApiClient({}) }), deps);

      expect(deps.createOllamaBackend).toHaveBeenCalledWith('http://127.0.0.1:11500');
      expect(res.modelInfo.id).toBe('ollama1');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  const downOllama = () =>
    ({
      currentModel: 'none',
      getModelInfo: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    }) as never;

  it('starts on the server models alone and says Ollama is unreachable when its listing rejects', async () => {
    const ollama = downOllama();
    const { deps } = makeDeps({ createOllamaBackend: vi.fn(() => ollama) });
    const startupLog: string[] = [];

    const res = await buildLlmBackend(
      makeInput({ apiClient: fakeApiClient({}), startupLog, ollamaHost: 'http://localhost:11434' }),
      deps
    );

    expect(deps.createMultiBackend).toHaveBeenCalledWith(
      expect.anything(),
      [model('m1')],
      [{ backend: ollama, models: [] }],
      'm1'
    );
    expect(startupLog.some(l => l.includes('Ollama at http://localhost:11434 is unreachable: fetch failed'))).toBe(
      true
    );
    expect(startupLog.some(l => l.includes('ollama pull'))).toBe(false);
    expect(res.modelInfo.id).toBe('m1');
  });

  it('names an unreachable Ollama when neither the server nor Ollama has models', async () => {
    const { deps } = makeDeps({
      createServerBackend: vi.fn(() => fakeBackend([])),
      createOllamaBackend: vi.fn(downOllama),
    });

    const build = buildLlmBackend(
      makeInput({ apiClient: fakeApiClient({}), ollamaHost: 'http://localhost:11434' }),
      deps
    );

    await expect(build).rejects.toThrow('Ollama at http://localhost:11434 is unreachable: fetch failed');
    await expect(build).rejects.not.toThrow('ollama pull');
  });

  it('keeps the pull hint when Ollama answers with no models', async () => {
    const { deps } = makeDeps({ createOllamaBackend: vi.fn(() => fakeBackend([])) });
    const startupLog: string[] = [];

    await buildLlmBackend(
      makeInput({ apiClient: fakeApiClient({}), startupLog, ollamaHost: 'http://localhost:11434' }),
      deps
    );

    expect(startupLog.some(l => l.includes('No models found in Ollama at http://localhost:11434'))).toBe(true);
    expect(startupLog.some(l => l.includes('unreachable'))).toBe(false);
  });

  it('stops waiting on a saved host that never answers and starts on the server models', async () => {
    vi.stubEnv('B4M_OLLAMA_HOST', '');
    try {
      const hung = { currentModel: 'none', getModelInfo: () => new Promise<never>(() => undefined) } as never;
      const { deps } = makeDeps({ createOllamaBackend: vi.fn(() => hung) });
      const startupLog: string[] = [];
      const config = createMockConfig({ defaultModel: 'm1', ollamaHost: 'gpu-box' });

      const res = await buildLlmBackend(
        makeInput({ config, apiClient: fakeApiClient({}), startupLog, ollamaListingTimeoutMs: 20 }),
        deps
      );

      expect(deps.createOllamaBackend).toHaveBeenCalledWith('http://gpu-box:11434');
      expect(startupLog.some(l => l.includes('Ollama at http://gpu-box:11434 is unreachable: no answer within'))).toBe(
        true
      );
      expect(res.modelInfo.id).toBe('m1');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('buildLlmBackend, detecting a running Ollama', () => {
  const DETECTED = 'http://127.0.0.1:11434';
  const detecting = (over: Record<string, unknown> = {}) =>
    makeInput({ apiClient: fakeApiClient({}), detectOllama: true, ...over });

  beforeEach(() => {
    vi.stubEnv('B4M_OLLAMA_HOST', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['the flag', { ollamaHost: 'http://flag-box:11434' }, undefined, 'http://flag-box:11434'],
    ['B4M_OLLAMA_HOST', {}, 'env-box', 'http://env-box:11434'],
    [
      'the saved config',
      { config: createMockConfig({ defaultModel: 'm1', ollamaHost: 'saved-box' }) },
      undefined,
      'http://saved-box:11434',
    ],
  ])('uses the host from %s and does not probe', async (_source, over, env, expected) => {
    if (env) vi.stubEnv('B4M_OLLAMA_HOST', env);
    const { deps } = makeDeps({ detectOllama: vi.fn(async () => DETECTED) });

    await buildLlmBackend(detecting(over), deps);

    expect(deps.detectOllama).not.toHaveBeenCalled();
    expect(deps.createOllamaBackend).toHaveBeenCalledOnce();
    expect(deps.createOllamaBackend).toHaveBeenCalledWith(expected);
  });

  it('attaches the Ollama it detects when no host is configured', async () => {
    const { deps } = makeDeps({ detectOllama: vi.fn(async () => DETECTED) });
    const startupLog: string[] = [];

    const res = await buildLlmBackend(detecting({ startupLog }), deps);

    expect(deps.createOllamaBackend).toHaveBeenCalledWith(DETECTED);
    expect(res.models.map(m => m.id)).toEqual(['m1', 'ollama1']);
    expect(startupLog).toContain('\u{1f999} Self-hosted Ollama: 1 model(s) added to picker');
  });

  it('adds nothing and warns nothing when no Ollama answers', async () => {
    const { deps, serverBackend } = makeDeps();
    const startupLog: string[] = [];

    const res = await buildLlmBackend(detecting({ startupLog }), deps);

    expect(deps.detectOllama).toHaveBeenCalledOnce();
    expect(deps.createOllamaBackend).not.toHaveBeenCalled();
    expect(res.llm).toBe(serverBackend);
    expect(startupLog).toEqual([]);
  });

  it('gives up on a probe that never settles at its deadline and aborts it', async () => {
    let probeSignal: AbortSignal | undefined;
    const detectOllama = vi.fn((signal: AbortSignal) => {
      probeSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const { deps, serverBackend } = makeDeps({ detectOllama });
    const startupLog: string[] = [];
    const started = Date.now();

    const res = await buildLlmBackend(detecting({ startupLog, ollamaDetectTimeoutMs: 30 }), deps);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(probeSignal?.aborted).toBe(true);
    expect(deps.createOllamaBackend).not.toHaveBeenCalled();
    expect(res.llm).toBe(serverBackend);
    expect(startupLog).toEqual([]);
  });

  it('starts on the server models when the probe throws', async () => {
    const { deps, serverBackend } = makeDeps({
      detectOllama: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    const startupLog: string[] = [];

    const res = await buildLlmBackend(detecting({ startupLog }), deps);

    expect(res.llm).toBe(serverBackend);
    expect(startupLog).toEqual([]);
  });

  it('reports the detected host and its model ids to the caller, and nothing when it was configured', async () => {
    const detected = makeDeps({ detectOllama: vi.fn(async () => DETECTED) });
    expect((await buildLlmBackend(detecting(), detected.deps)).detectedOllama).toEqual({
      host: DETECTED,
      modelIds: new Set(['ollama1']),
    });

    const flagged = makeDeps({ detectOllama: vi.fn(async () => DETECTED) });
    const res = await buildLlmBackend(detecting({ ollamaHost: 'http://flag-box:11434' }), flagged.deps);
    expect(res.detectedOllama).toBeNull();
  });

  it('does not offer a detected model whose id the server lists, so the server model keeps its id', async () => {
    const { deps } = makeDeps({
      detectOllama: vi.fn(async () => DETECTED),
      createOllamaBackend: vi.fn(() => fakeBackend([model('m1'), model('ollama1')])),
    });

    const res = await buildLlmBackend(detecting(), deps);

    const routes = vi.mocked(deps.createMultiBackend).mock.calls[0][2];
    expect(routes.flatMap(r => r.models.map(m => m.id))).toEqual(['ollama1']);
    expect((await res.llm.getModelInfo()).map(m => m.id)).toEqual(['m1', 'ollama1']);
    expect(res.detectedOllama?.modelIds).toEqual(new Set(['ollama1']));
    expect(modelSavePatch({ id: 'm1' }, createMockConfig({}), res.detectedOllama)).toEqual({ defaultModel: 'm1' });
  });

  it('attaches nothing when every detected model is also a server model', async () => {
    const { deps, serverBackend } = makeDeps({
      detectOllama: vi.fn(async () => DETECTED),
      createOllamaBackend: vi.fn(() => fakeBackend([model('m1')])),
    });
    const startupLog: string[] = [];

    const res = await buildLlmBackend(detecting({ startupLog }), deps);

    expect(res.llm).toBe(serverBackend);
    expect(res.detectedOllama).toBeNull();
    expect(startupLog).toEqual([]);
  });

  it('keeps a configured host routing a model the server also lists', async () => {
    const { deps } = makeDeps({
      createOllamaBackend: vi.fn(() => fakeBackend([model('m1'), model('ollama1')])),
    });

    await buildLlmBackend(detecting({ ollamaHost: 'http://flag-box:11434' }), deps);

    const routes = vi.mocked(deps.createMultiBackend).mock.calls[0][2];
    expect(routes.flatMap(r => r.models.map(m => m.id))).toEqual(['m1', 'ollama1']);
  });

  it('still lists and saves a detected model the server does not list', async () => {
    const { deps } = makeDeps({ detectOllama: vi.fn(async () => DETECTED) });

    const res = await buildLlmBackend(detecting(), deps);

    expect((await res.llm.getModelInfo()).map(m => m.id)).toEqual(['m1', 'ollama1']);
    expect(modelSavePatch({ id: 'ollama1' }, createMockConfig({}), res.detectedOllama)).toEqual({
      defaultModel: 'ollama1',
      ollamaHost: DETECTED,
      localDefaultModel: 'ollama1',
    });
  });

  it('gives a detected host a short listing deadline instead of the saved-host one', async () => {
    const hang = { currentModel: 'x', getModelInfo: () => new Promise<never>(() => undefined) } as never;
    const { deps, serverBackend } = makeDeps({
      detectOllama: vi.fn(async () => DETECTED),
      createOllamaBackend: vi.fn(() => hang),
    });
    const startupLog: string[] = [];
    const started = Date.now();

    const res = await buildLlmBackend(
      detecting({ startupLog, ollamaListingTimeoutMs: 60_000, ollamaDetectedListingTimeoutMs: 30 }),
      deps
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.llm).toBe(serverBackend);
    expect(res.detectedOllama).toBeNull();
    expect(startupLog).toEqual([]);
  });

  it('does not attach or warn about a detected Ollama with no models pulled', async () => {
    const empty = fakeBackend([]);
    const { deps, serverBackend } = makeDeps({
      detectOllama: vi.fn(async () => DETECTED),
      createOllamaBackend: vi.fn(() => empty),
    });
    const startupLog: string[] = [];

    const res = await buildLlmBackend(detecting({ startupLog }), deps);

    expect(res.llm).toBe(serverBackend);
    expect(res.detectedOllama).toBeNull();
    expect(startupLog).toEqual([]);
  });

  it('still warns about a configured Ollama with no models pulled', async () => {
    const { deps } = makeDeps({ createOllamaBackend: vi.fn(() => fakeBackend([])) });
    const startupLog: string[] = [];

    await buildLlmBackend(detecting({ startupLog, ollamaHost: 'http://flag-box:11434' }), deps);

    expect(startupLog.join('\n')).toContain('No models found in Ollama at http://flag-box:11434');
  });

  it('does not probe unless asked to', async () => {
    const { deps } = makeDeps({ detectOllama: vi.fn(async () => DETECTED) });

    await buildLlmBackend(makeInput({ apiClient: fakeApiClient({}) }), deps);

    expect(deps.detectOllama).not.toHaveBeenCalled();
    expect(deps.createOllamaBackend).not.toHaveBeenCalled();
  });
});

describe('defaultLlmBackendDeps.detectOllama', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answering = (version: unknown) =>
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return String(input).endsWith('/api/version')
        ? new Response(JSON.stringify(version), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('not found', { status: 404 });
    });

  it('returns the default loopback address when Ollama answers there', async () => {
    const fetchMock = answering({ version: '0.12.0' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(defaultLlmBackendDeps.detectOllama(new AbortController().signal)).resolves.toBe(
      'http://127.0.0.1:11434'
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([input]) => String(input).startsWith('http://127.0.0.1:11434/'))).toBe(true);
  });

  it('cancels requests still in flight when its signal aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      )
    );
    const abort = new AbortController();
    const started = Date.now();
    const probe = defaultLlmBackendDeps.detectOllama(abort.signal);

    abort.abort();

    // The probe's own timeout is 1.5s; settling sooner means the abort reached fetch.
    await expect(probe).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('returns null when nothing listens there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    await expect(defaultLlmBackendDeps.detectOllama(new AbortController().signal)).resolves.toBeNull();
  });
});

describe('attachLocalModels', () => {
  it('lists the server models alone when no Ollama host or model server is configured', async () => {
    vi.stubEnv('B4M_OLLAMA_HOST', '');
    try {
      const { deps } = makeDeps();
      const server = fakeBackend([model('m1')]);
      const res = await attachLocalModels(server, createMockConfig({ defaultModel: 'm1' }), {}, deps);
      expect(res).toMatchObject({ llm: server, models: [model('m1')], ollamaHost: null, warnings: [] });
      expect(deps.createOllamaBackend).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveHeadlessModel', () => {
  const HOST = 'http://127.0.0.1:11434';
  const listed = { ollamaHost: HOST, ollamaListingFailed: false };

  it('uses the default model when it is listed', () => {
    expect(resolveHeadlessModel([model('a'), model('b')], { defaultModel: 'b' }, listed)).toEqual({
      modelInfo: model('b'),
      warning: null,
    });
  });

  it('refuses to switch away from the model `b4m models use` chose', () => {
    const config = { defaultModel: 'qwen2.5:0.5b', localDefaultModel: 'qwen2.5:0.5b' };
    expect(() => resolveHeadlessModel([model('hosted')], config, listed)).toThrow(
      /Model "qwen2\.5:0\.5b" is not available from the server or from Ollama at http:\/\/127\.0\.0\.1:11434/
    );
  });

  it('refuses to switch away from any default when Ollama could not list its models', () => {
    expect(() =>
      resolveHeadlessModel([model('hosted')], { defaultModel: 'mine' }, { ...listed, ollamaListingFailed: true })
    ).toThrow(/Model "mine" is not available/);
  });

  it('falls back with a warning from a hosted default the server no longer offers', () => {
    const config = { defaultModel: 'retired-hosted', localDefaultModel: 'qwen2.5:0.5b' };
    expect(resolveHeadlessModel([model('a')], config, listed)).toEqual({
      modelInfo: model('a'),
      warning: 'Model "retired-hosted" is not available; using "a".',
    });
  });

  it('never falls back from a `local:` default, even without an Ollama host', () => {
    const none = { ollamaHost: null, ollamaListingFailed: false };
    const config = { defaultModel: 'local:srv-abc:qwen-small' };
    expect(() => resolveHeadlessModel([model('hosted')], config, none)).toThrow(
      /Model "local:srv-abc:qwen-small" is on a local runtime the CLI cannot chat with/
    );
    expect(() => resolveHeadlessModel([model('hosted')], config, listed)).toThrow(/local:srv-abc:qwen-small/);
  });

  it('falls back silently, as before, without an Ollama host', () => {
    const none = { ollamaHost: null, ollamaListingFailed: false };
    expect(resolveHeadlessModel([model('a')], { defaultModel: 'gone' }, none)).toEqual({
      modelInfo: model('a'),
      warning: null,
    });
  });
});

describe('buildLlmBackend — model resolution', () => {
  it('falls back to the first available model when the default is missing', async () => {
    const { deps } = makeDeps();
    const res = await buildLlmBackend(makeInput({ config: createMockConfig({ defaultModel: 'nonexistent' }) }), deps);
    // SSE backend exposes [m1]; nonexistent -> first
    expect(res.modelInfo.id).toBe('m1');
    expect(res.llm.currentModel).toBe('m1');
  });
});
