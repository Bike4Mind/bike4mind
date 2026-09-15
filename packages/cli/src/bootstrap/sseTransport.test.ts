import { describe, it, expect, vi } from 'vitest';
import { createSseBackend, type SseTransportDeps } from './sseTransport.js';

const fakeBackend = { tag: 'sse-backend' } as never;

function makeDeps(over: Partial<SseTransportDeps<typeof fakeBackend>> = {}) {
  const deps: SseTransportDeps<typeof fakeBackend> = {
    createServerBackend: vi.fn(() => fakeBackend),
    clearWebSocketToolExecutor: vi.fn(),
    ...over,
  };
  return deps;
}

const fakeApiClient = (serverConfig: unknown) => ({ get: vi.fn(async () => serverConfig) }) as never;

describe('createSseBackend', () => {
  it('builds the backend with the server-config completions url', async () => {
    const deps = makeDeps();
    const apiClient = fakeApiClient({ sseCompletionsUrl: 'https://cc.example/api/ai/v1/completions' });

    const res = await createSseBackend({ apiClient, model: 'm1' }, deps);

    expect(deps.createServerBackend).toHaveBeenCalledWith({
      apiClient,
      model: 'm1',
      sseCompletionsUrl: 'https://cc.example/api/ai/v1/completions',
    });
    expect(deps.clearWebSocketToolExecutor).toHaveBeenCalledOnce();
    expect(res.llm).toBe(fakeBackend);
    expect(res.serverConfig.sseCompletionsUrl).toBe('https://cc.example/api/ai/v1/completions');
  });

  it('returns the realtime websocketUrl for feature modules to use', async () => {
    const deps = makeDeps();
    const res = await createSseBackend({ apiClient: fakeApiClient({ websocketUrl: 'wss://x' }), model: 'm1' }, deps);

    expect(res.serverConfig.websocketUrl).toBe('wss://x');
  });

  // Headless (-p) runs are unattended: a serverConfig blip must degrade to the
  // same-origin default rather than abort the run.
  it('falls back to the default completions path when the serverConfig fetch throws', async () => {
    const deps = makeDeps();
    const apiClient = {
      get: vi.fn(async () => {
        throw new Error('network down');
      }),
    } as never;

    const res = await createSseBackend({ apiClient, model: 'm1' }, deps);

    expect(deps.createServerBackend).toHaveBeenCalledWith(expect.objectContaining({ sseCompletionsUrl: undefined }));
    expect(deps.clearWebSocketToolExecutor).toHaveBeenCalledOnce();
    expect(res.llm).toBe(fakeBackend);
    expect(res.serverConfig).toEqual({});
  });

  it('tolerates a null serverConfig response', async () => {
    const deps = makeDeps();
    const res = await createSseBackend({ apiClient: fakeApiClient(null), model: 'm1' }, deps);

    expect(deps.createServerBackend).toHaveBeenCalledWith(expect.objectContaining({ sseCompletionsUrl: undefined }));
    expect(res.serverConfig).toEqual({});
  });
});
