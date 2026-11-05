import { describe, expect, it, vi } from 'vitest';
import { hostLaunchers, LocalServerSupervisor, type Launchers, type ServerHandle } from './LocalServerSupervisor';
import { observedKvCacheType, observedLaunchVars } from './observedOllama';

type Exit = { code: number | null; signal: NodeJS.Signals | null; stopped: boolean };

function handle(apiKey?: string) {
  let settle: (exit: Exit) => void = () => {};
  const exited = new Promise<Exit>(resolve => (settle = resolve));
  const fake = {
    pid: 4321,
    running: true,
    exited,
    ...(apiKey ? { apiKey } : {}),
    log: () => ['starting', 'Error: listen tcp 127.0.0.1:11500: bind: address already in use'],
    stop: vi.fn(async () => {
      fake.running = false;
      settle({ code: 0, signal: null, stopped: true });
    }),
    exit: (exit: Exit) => {
      fake.running = false;
      settle(exit);
    },
  };
  return fake satisfies ServerHandle;
}

function supervisor(start: Launchers['start'], program: Launchers['program'] = async () => ({ path: '/bin/x' })) {
  const changed = vi.fn();
  const warn = vi.fn();
  const instance = new LocalServerSupervisor({ launchers: { program, start }, logger: { warn }, changed });
  return { instance, changed, warn };
}

const OLLAMA = { runtime: 'ollama' as const, port: 11500, settings: { kvCacheType: 'q8_0' as const } };

describe('LocalServerSupervisor', () => {
  it('owns a server it started, with the settings it started with, until it stops it', async () => {
    const child = handle();
    const { instance, changed } = supervisor(async () => child);
    expect(instance.owned('a')).toBeNull();
    await instance.start('a', OLLAMA);
    expect(instance.owned('a')).toEqual({
      runtime: 'ollama',
      port: 11500,
      pid: 4321,
      settings: { kvCacheType: 'q8_0' },
    });
    expect(instance.busy('a')).toBeNull();
    expect(instance.headers('a')).toBeNull();
    await expect(instance.start('a', OLLAMA)).rejects.toThrow('Ollama is already running.');
    await instance.stop('a');
    expect(child.stop).toHaveBeenCalledTimes(1);
    expect(instance.owned('a')).toBeNull();
    expect(instance.problem('a')).toBeNull();
    expect(changed).toHaveBeenCalledWith('a');
  });

  it('gives the router key only while the router runs', async () => {
    const child = handle('k-zz');
    const { instance } = supervisor(async () => child);
    await instance.start('r', { runtime: 'llama-server', port: 8090, settings: { modelsDir: '/m' } });
    expect(instance.headers('r')).toEqual({ authorization: 'Bearer k-zz' });
    child.exit({ code: 1, signal: null, stopped: false });
    await vi.waitFor(() => expect(instance.headers('r')).toBeNull());
  });

  it('does not count a server that is no longer running as its own', async () => {
    const child = handle();
    const { instance } = supervisor(async () => child);
    await instance.start('a', OLLAMA);
    child.running = false;
    expect(instance.owned('a')).toBeNull();
  });

  it('keeps why a server stopped on its own, with its last log line, and says so', async () => {
    const child = handle();
    const { instance, changed, warn } = supervisor(async () => child);
    await instance.start('a', OLLAMA);
    changed.mockClear();
    child.exit({ code: 1, signal: null, stopped: false });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('a'));
    expect(instance.owned('a')).toBeNull();
    expect(instance.problem('a')).toBe(
      'Ollama stopped (code 1): Error: listen tcp 127.0.0.1:11500: bind: address already in use'
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ollama stopped (code 1)'));
  });

  it('keeps why a start failed, and clears it on the next start', async () => {
    const start = vi.fn<Launchers['start']>().mockRejectedValueOnce(new Error('port 11500 is in use'));
    const { instance } = supervisor(start);
    await expect(instance.start('a', OLLAMA)).rejects.toThrow('port 11500 is in use');
    expect(instance.problem('a')).toBe('port 11500 is in use');
    expect(instance.busy('a')).toBeNull();
    start.mockResolvedValueOnce(handle());
    await instance.start('a', OLLAMA);
    expect(instance.problem('a')).toBeNull();
  });

  it('starts nothing when the program cannot be found', async () => {
    const start = vi.fn<Launchers['start']>();
    const { instance } = supervisor(start, async () => ({ problem: 'Desktop could not find Ollama.' }));
    await expect(instance.start('a', OLLAMA)).rejects.toThrow('Desktop could not find Ollama.');
    expect(start).not.toHaveBeenCalled();
  });

  it('is busy while starting, and a stop then cancels the start', async () => {
    let signal: AbortSignal | undefined;
    const start = vi.fn<Launchers['start']>(
      (_program, _request, abort) =>
        new Promise((_resolve, reject) => {
          signal = abort;
          abort.addEventListener('abort', () => reject(abort.reason));
        })
    );
    const { instance } = supervisor(start);
    const starting = instance.start('a', OLLAMA);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(instance.busy('a')).toBe('starting');
    await instance.stop('a');
    await expect(starting).rejects.toThrow('Stopped before it was ready.');
    expect(instance.owned('a')).toBeNull();
    expect(instance.busy('a')).toBeNull();
    expect(instance.problem('a')).toBeNull();
  });

  it('stops every server it runs, and nothing it does not', async () => {
    const a = handle();
    const b = handle();
    const start = vi.fn<Launchers['start']>().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const { instance } = supervisor(start);
    await instance.start('a', OLLAMA);
    await instance.start('b', { ...OLLAMA, port: 11501 });
    await instance.stop('never-started');
    await instance.stopAll();
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });
});

describe('hostLaunchers', () => {
  it('asks for a models folder before looking for llama-server, and runs the one entered', async () => {
    const launchers = hostLaunchers({});
    expect(await launchers.program('llama-server', {})).toEqual({
      problem: 'Enter the folder of GGUF models for llama-server to serve.',
    });
    expect(await launchers.program('llama-server', { modelsDir: '/m', binaryPath: '/opt/llama/llama-server' })).toEqual(
      { path: '/opt/llama/llama-server' }
    );
  });
});

describe('observed Ollama settings', () => {
  it('keeps only the launch variables that are set', () => {
    expect(
      observedLaunchVars({
        OLLAMA_KV_CACHE_TYPE: ' q8_0 ',
        OLLAMA_NUM_PARALLEL: '4',
        OLLAMA_CONTEXT_LENGTH: '65536',
        OLLAMA_HOST: '0.0.0.0',
        HOME: '/root',
      })
    ).toEqual({ OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_NUM_PARALLEL: '4', OLLAMA_CONTEXT_LENGTH: '65536' });
    expect(observedLaunchVars({})).toEqual({});
  });

  it('sizes with a priced quantized type unless flash attention is off', () => {
    expect(observedKvCacheType({ OLLAMA_KV_CACHE_TYPE: 'q8_0' })).toBe('q8_0');
    expect(observedKvCacheType({ OLLAMA_KV_CACHE_TYPE: 'q4_0', OLLAMA_FLASH_ATTENTION: '1' })).toBe('q4_0');
    expect(observedKvCacheType({ OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: 'false' })).toBeUndefined();
    expect(observedKvCacheType({ OLLAMA_KV_CACHE_TYPE: 'f16' })).toBeUndefined();
    expect(observedKvCacheType({})).toBeUndefined();
  });
});
