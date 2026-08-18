import { describe, it, expect, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { buildLlmBackend, resolveModelInfo, type BuildLlmBackendDeps } from './buildLlmBackend.js';
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
