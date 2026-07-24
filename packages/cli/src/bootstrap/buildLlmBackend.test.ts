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
  const wsBackend = fakeBackend([model('m1'), model('m2')]);
  const serverBackend = fakeBackend([model('m1')]);
  const deps: BuildLlmBackendDeps = {
    connectWebSocket: vi.fn(async () => fakeWs as never),
    installWebSocketToolExecutor: vi.fn(),
    clearWebSocketToolExecutor: vi.fn(),
    createWebSocketBackend: vi.fn(() => wsBackend),
    createServerBackend: vi.fn(() => serverBackend),
    registerKeepHandlers: vi.fn(),
    createOllamaBackend: vi.fn(() => fakeBackend([model('ollama1')])),
    createMultiBackend: vi.fn((_s, _o, sm, om) => fakeBackend([...sm, ...om])),
    ...over,
  };
  return { deps, fakeWs, wsBackend, serverBackend };
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

describe('buildLlmBackend — SSE-only transport', () => {
  it('always uses SSE and never attempts a WebSocket connection', async () => {
    const { deps, serverBackend } = makeDeps();
    const res = await buildLlmBackend(makeInput(), deps);

    expect(deps.connectWebSocket).not.toHaveBeenCalled();
    expect(deps.installWebSocketToolExecutor).not.toHaveBeenCalled();
    expect(deps.createWebSocketBackend).not.toHaveBeenCalled();
    expect(deps.registerKeepHandlers).not.toHaveBeenCalled();
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
    expect(res.llm).toBe(serverBackend);
    expect(res.wsManager).toBeNull();
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
    // WebSocket backend exposes [m1, m2]; nonexistent -> first
    expect(res.modelInfo.id).toBe('m1');
    expect(res.llm.currentModel).toBe('m1');
  });
});
