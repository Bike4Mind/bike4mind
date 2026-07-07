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
    apiClient: fakeApiClient({ websocketUrl: 'wss://x', wsCompletionUrl: 'wss://x/c', completionsUrl: 'https://x' }),
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

describe('buildLlmBackend — transport selection', () => {
  it('uses WebSocket transport when server config provides ws urls', async () => {
    const { deps, fakeWs, wsBackend } = makeDeps();
    const res = await buildLlmBackend(makeInput(), deps);

    expect(deps.connectWebSocket).toHaveBeenCalledWith('wss://x', expect.any(Function), expect.any(Function));
    expect(deps.installWebSocketToolExecutor).toHaveBeenCalledOnce();
    expect(deps.createWebSocketBackend).toHaveBeenCalledOnce();
    expect(deps.registerKeepHandlers).toHaveBeenCalledWith(fakeWs);
    expect(deps.clearWebSocketToolExecutor).not.toHaveBeenCalled();
    expect(deps.createServerBackend).not.toHaveBeenCalled();
    expect(res.wsManager).toBe(fakeWs);
    expect(res.llm).toBe(wsBackend);
    expect(res.modelInfo.id).toBe('m1');
  });

  it('falls back to SSE when the WebSocket fails to connect', async () => {
    const { deps, serverBackend } = makeDeps({
      connectWebSocket: vi.fn(async () => {
        throw new Error('socket disconnected');
      }),
    });
    const res = await buildLlmBackend(makeInput(), deps);

    expect(deps.clearWebSocketToolExecutor).toHaveBeenCalledOnce();
    expect(deps.createServerBackend).toHaveBeenCalledOnce();
    expect(deps.installWebSocketToolExecutor).not.toHaveBeenCalled();
    expect(deps.registerKeepHandlers).not.toHaveBeenCalled();
    expect(res.wsManager).toBeNull();
    expect(res.llm).toBe(serverBackend);
  });

  it('falls back to SSE when server config lacks ws urls (never attempts connect)', async () => {
    const { deps } = makeDeps();
    const res = await buildLlmBackend(makeInput({ apiClient: fakeApiClient({}) }), deps);

    expect(deps.connectWebSocket).not.toHaveBeenCalled();
    expect(deps.createServerBackend).toHaveBeenCalledOnce();
    expect(deps.clearWebSocketToolExecutor).toHaveBeenCalledOnce();
    expect(res.wsManager).toBeNull();
  });

  it('does not register Keep handlers on the SSE path', async () => {
    const { deps } = makeDeps();
    await buildLlmBackend(makeInput({ apiClient: fakeApiClient({}) }), deps);
    expect(deps.registerKeepHandlers).not.toHaveBeenCalled();
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
