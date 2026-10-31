import { describe, it, expect, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import {
  attachOllama,
  buildLlmBackend,
  resolveHeadlessModel,
  resolveModelInfo,
  type BuildLlmBackendDeps,
} from './buildLlmBackend.js';
import { createMockConfig } from '../test-utils/mocks.js';

const model = (id: string) => ({ id }) as ModelInfo;

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
    createMultiBackend: vi.fn((_s, _o, sm, om) => fakeBackend([...sm, ...om])),
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
  it('fails instead of starting on a hosted model when the default is not listed', async () => {
    const { deps } = makeDeps();
    const config = createMockConfig({ defaultModel: 'local:srv-abc:qwen-small' });
    await expect(buildLlmBackend(makeInput({ config }), deps)).rejects.toThrow(
      /Model "local:srv-abc:qwen-small" is on a local model server/
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

    expect(deps.createMultiBackend).toHaveBeenCalledWith(expect.anything(), ollama, [model('m1')], [], 'm1');
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

describe('attachOllama', () => {
  it('lists the server models alone when no Ollama host is configured', async () => {
    vi.stubEnv('B4M_OLLAMA_HOST', '');
    try {
      const { deps } = makeDeps();
      const server = fakeBackend([model('m1')]);
      const res = await attachOllama(server, createMockConfig({ defaultModel: 'm1' }), {}, deps);
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
      /Model "local:srv-abc:qwen-small" is on a local model server/
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
