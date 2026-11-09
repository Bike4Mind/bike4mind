import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostLaunchers, spillEnv } from './LocalServerSupervisor';

const mocks = vi.hoisted(() => ({
  startOllamaServe: vi.fn(async (_options: { env?: NodeJS.ProcessEnv }) => ({ pid: 1 })),
  runtimeEnv: vi.fn((_env: NodeJS.ProcessEnv | undefined) => undefined),
  startRouter: vi.fn(async () => ({ pid: 2 })),
  warning: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock('@bike4mind/local-models', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/local-models')>()),
  startOllamaServe: mocks.startOllamaServe,
  LlamaServerRuntime: class {
    constructor(options: { env?: NodeJS.ProcessEnv }) {
      mocks.runtimeEnv(options.env);
    }
    startRouter = mocks.startRouter;
    warning = mocks.warning;
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

  it("keeps llama-server's --fit-target 512 MiB above its default on an Intel GPU only", async () => {
    const vendors = [
      async () => 'intel' as const,
      async () => 'nvidia' as const,
      async () => null,
      undefined,
      () => Promise.reject(new Error('no probe')),
    ];
    for (const gpuVendor of vendors) {
      const launchers = hostLaunchers({ env: { HOME: '/h' }, gpuVendor });
      await launchers.start(
        '/bin/llama-server',
        { runtime: 'llama-server', port: 8090, settings: { modelsDir: '/m', flashAttention: 'on' } },
        signal
      );
    }
    expect(mocks.startRouter.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      { port: 8090, flashAttention: 'on', fitTargetMiB: 1536, signal },
      { port: 8090, flashAttention: 'on', fitTargetMiB: undefined, signal },
      { port: 8090, flashAttention: 'on', fitTargetMiB: undefined, signal },
      { port: 8090, flashAttention: 'on', fitTargetMiB: undefined, signal },
      { port: 8090, flashAttention: 'on', fitTargetMiB: undefined, signal },
    ]);
  });

  it("carries the binary's warning, such as a GPU build that lists no GPU, on llama-server's handle", async () => {
    const launchers = hostLaunchers({ env: { HOME: '/h' } });
    const config = { runtime: 'llama-server' as const, port: 8090, settings: { modelsDir: '/m' } };
    expect(await launchers.start('/bin/llama-server', config, signal)).toEqual({ pid: 2 });
    mocks.warning.mockResolvedValueOnce('runs on the CPU');
    expect(await launchers.start('/bin/llama-server', config, signal)).toEqual({ pid: 2, warning: 'runs on the CPU' });
  });

  it('adds no spill on a discrete GPU, or when the hardware probe fails', async () => {
    for (const unifiedMemory of [async () => false, () => Promise.reject(new Error('no probe'))]) {
      const launchers = hostLaunchers({ env: { HOME: '/h' }, unifiedMemory });
      await launchers.start('/bin/ollama', { runtime: 'ollama', port: 11500, settings: {} }, signal);
    }
    for (const [options] of mocks.startOllamaServe.mock.calls) expect(options.env?.[SPILL]).toBeUndefined();
  });
});
