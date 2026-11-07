import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostLaunchers, spillEnv } from './LocalServerSupervisor';

const mocks = vi.hoisted(() => ({
  startOllamaServe: vi.fn(async (_options: { env?: NodeJS.ProcessEnv }) => ({ pid: 1 })),
  runtimeEnv: vi.fn((_env: NodeJS.ProcessEnv | undefined) => undefined),
  startRouter: vi.fn(async () => ({ pid: 2 })),
}));

vi.mock('@bike4mind/local-models', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/local-models')>()),
  startOllamaServe: mocks.startOllamaServe,
  LlamaServerRuntime: class {
    constructor(options: { env?: NodeJS.ProcessEnv }) {
      mocks.runtimeEnv(options.env);
    }
    startRouter = mocks.startRouter;
  },
}));

vi.mock('../chat/tools/userPath', () => ({
  resolveUserPath: async () => '/usr/bin',
  findOnPath: async () => null,
}));

const SPILL = 'GGML_CUDA_ENABLE_UNIFIED_MEMORY';
const signal = new AbortController().signal;

beforeEach(() => vi.clearAllMocks());

describe('spillEnv', () => {
  it('lets the GPU spill into shared memory on a unified-memory computer only', () => {
    expect(spillEnv({ HOME: '/h' }, true)).toEqual({ HOME: '/h', [SPILL]: '1' });
    expect(spillEnv({ HOME: '/h' }, false)).toEqual({ HOME: '/h' });
  });

  it('honors the opt-out and a value the user set', () => {
    expect(spillEnv({ B4M_DISABLE_GPU_SPILL: '1' }, true)[SPILL]).toBeUndefined();
    expect(spillEnv({ [SPILL]: '0' }, true)[SPILL]).toBe('0');
  });
});

describe('hostLaunchers.start', () => {
  it('starts Ollama and llama-server with spill on a unified-memory computer', async () => {
    const launchers = hostLaunchers({ env: { HOME: '/h' }, unifiedMemory: async () => true });
    await launchers.start('/bin/ollama', { runtime: 'ollama', port: 11500, settings: {} }, signal);
    await launchers.start(
      '/bin/llama-server',
      { runtime: 'llama-server', port: 8090, settings: { modelsDir: '/m' } },
      signal
    );
    expect(mocks.startOllamaServe.mock.calls[0][0].env).toMatchObject({ PATH: '/usr/bin', [SPILL]: '1' });
    expect(mocks.runtimeEnv.mock.calls[0][0]).toMatchObject({ PATH: '/usr/bin', [SPILL]: '1' });
  });

  it('adds no spill on a discrete GPU, or when the hardware probe fails', async () => {
    for (const unifiedMemory of [async () => false, () => Promise.reject(new Error('no probe'))]) {
      const launchers = hostLaunchers({ env: { HOME: '/h' }, unifiedMemory });
      await launchers.start('/bin/ollama', { runtime: 'ollama', port: 11500, settings: {} }, signal);
    }
    for (const [options] of mocks.startOllamaServe.mock.calls) expect(options.env?.[SPILL]).toBeUndefined();
  });
});
