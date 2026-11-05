import { describe, expect, it, vi } from 'vitest';
import { hostProcessProbe, sameStartTime, type ProcessProbe } from './adoptedServers';
import { hostLaunchers, LocalServerSupervisor, type Launchers, type ServerHandle } from './LocalServerSupervisor';
import { observedFlashAttention, observedKvCacheType, observedLaunchVars, observedPrefill } from './observedOllama';

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

  it('stops a server whose start finishes after a stop cancelled it, and keeps nothing', async () => {
    const child = handle();
    let signal: AbortSignal | undefined;
    const start = vi.fn<Launchers['start']>(
      (_program, _request, abort) =>
        new Promise(resolve => {
          signal = abort;
          abort.addEventListener('abort', () => resolve(child));
        })
    );
    const { instance } = supervisor(start);
    const starting = instance.start('a', OLLAMA);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await instance.stop('a');
    await expect(starting).rejects.toThrow('Stopped before it was ready.');
    expect(child.stop).toHaveBeenCalledTimes(1);
    expect(child.running).toBe(false);
    expect(instance.owned('a')).toBeNull();
    expect(instance.busy('a')).toBeNull();
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

describe('LocalServerSupervisor after Desktop exits without stopping its servers', () => {
  function memoryFile(contents: string | null = null) {
    const file = {
      contents,
      read: async () => file.contents,
      write: async (next: string) => {
        file.contents = next;
      },
    };
    return file;
  }

  /** Processes by pid with their start times; a signal ends one. */
  function processes(starts: Record<number, string>, listening = true) {
    const running = new Map(Object.entries(starts).map(([pid, start]) => [Number(pid), start]));
    const signals: [number, string][] = [];
    const probe: ProcessProbe = {
      startTime: async pid => running.get(pid) ?? null,
      listening: async () => listening,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        running.delete(pid);
      },
    };
    return { probe, running, signals };
  }

  const listed = (file: { contents: string | null }) => JSON.parse(file.contents ?? '{}').servers;
  const RECORD = {
    id: 'a',
    runtime: 'ollama',
    pid: 4321,
    startTime: '1700000000:555',
    port: 11500,
    startedAt: '2026-11-04T00:00:00.000Z',
    settings: { kvCacheType: 'q8_0' },
  };

  function adopter(file: ReturnType<typeof memoryFile>, probe: ProcessProbe) {
    const changed = vi.fn();
    const warn = vi.fn();
    const start = vi.fn<Launchers['start']>(async () => handle());
    const instance = new LocalServerSupervisor({
      launchers: { program: async () => ({ path: '/bin/x' }), start },
      logger: { warn },
      changed,
      records: file,
      processes: probe,
      adoptedTiming: { pollMs: 10, stopTimeoutMs: 50 },
    });
    return { instance, warn };
  }

  it('lists a server it starts, with what it started it with, until it stops it', async () => {
    const file = memoryFile();
    const { instance } = adopter(file, processes({ 4321: '1700000000:555' }).probe);
    await instance.start('a', OLLAMA);
    expect(listed(file)).toEqual([{ ...RECORD, startedAt: expect.any(String) }]);
    await instance.stop('a');
    expect(listed(file)).toEqual([]);
  });

  it('takes back a server an earlier run started, with the settings it started with, and can stop it', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const { probe, signals } = processes({ 4321: '1700000001:555' });
    const { instance } = adopter(file, probe);
    await instance.adopt(() => true);
    expect(instance.owned('a')).toEqual({
      runtime: 'ollama',
      port: 11500,
      pid: 4321,
      settings: { kvCacheType: 'q8_0' },
    });
    expect(listed(file)).toEqual([RECORD]);
    await instance.stop('a');
    expect(signals).toEqual([[4321, 'SIGTERM']]);
    expect(instance.owned('a')).toBeNull();
    expect(listed(file)).toEqual([]);
  });

  it("keeps a router's key, so requests to the router it takes back still get in", async () => {
    const router = { ...RECORD, runtime: 'llama-server', settings: { modelsDir: '/m' }, apiKey: 'k-zz' };
    const file = memoryFile(JSON.stringify({ version: 1, servers: [router] }));
    const { instance } = adopter(file, processes({ 4321: RECORD.startTime }).probe);
    await instance.adopt(() => true);
    expect(instance.headers('a')).toEqual({ authorization: 'Bearer k-zz' });
  });

  it('never takes one back on its pid alone, and drops the records it does not take', async () => {
    const records = [
      { ...RECORD, id: 'reused', pid: 1 },
      { ...RECORD, id: 'gone', pid: 2 },
      { ...RECORD, id: 'unread', pid: 3 },
      { ...RECORD, id: 'refused', pid: 4 },
    ];
    const file = memoryFile(JSON.stringify({ version: 1, servers: records }));
    const { probe } = processes({ 1: '1700000000:999', 4: RECORD.startTime });
    const { instance } = adopter(file, probe);
    await instance.adopt(record => record.id !== 'refused');
    for (const { id } of records) expect(instance.owned(id)).toBeNull();
    expect(listed(file)).toEqual([]);

    const quiet = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const notListening = adopter(quiet, processes({ 4321: RECORD.startTime }, false).probe).instance;
    await notListening.adopt(() => true);
    expect(notListening.owned('a')).toBeNull();
    expect(listed(quiet)).toEqual([]);
  });

  it('notices when a server it took back exits on its own', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const { probe, running } = processes({ 4321: RECORD.startTime });
    const { instance } = adopter(file, probe);
    await instance.adopt(() => true);
    running.delete(4321);
    await vi.waitFor(() => expect(instance.owned('a')).toBeNull());
    expect(instance.problem('a')).toBe('Ollama stopped.');
    await vi.waitFor(() => expect(listed(file)).toEqual([]));
  });
});

describe('hostProcessProbe', () => {
  it('reads a running process start time on Linux and macOS, and none for a pid that is not running', async () => {
    const probe = hostProcessProbe();
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const now = await probe.startTime(process.pid);
      expect(now).not.toBeNull();
      expect(sameStartTime(await probe.startTime(process.pid), now)).toBe(true);
    }
    expect(await probe.startTime(2 ** 22 + 7)).toBeNull();
    expect(await hostProcessProbe('win32').startTime(process.pid)).toBeNull();
  });

  it('matches a Linux start time on its tick count, allowing the boot time to drift by a second or two', () => {
    expect(sameStartTime('1700000000:555', '1700000001:555')).toBe(true);
    expect(sameStartTime('1700000000:555', '1700000000:556')).toBe(false);
    expect(sameStartTime('1700000000:555', '1700000010:555')).toBe(false);
    expect(sameStartTime('Wed Nov  4 10:00:00 2026', 'Wed Nov  4 10:00:00 2026')).toBe(true);
    expect(sameStartTime(null, null)).toBe(false);
  });
});

describe('hostLaunchers', () => {
  it('asks for a models folder before looking for llama-server, and runs the one entered', async () => {
    const launchers = hostLaunchers({ env: {} });
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

  it('prefills the launch settings that would run Ollama as it runs now, naming the variables', () => {
    expect(observedPrefill({ OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1' })).toEqual({
      settings: { kvCacheType: 'q8_0', flashAttention: 'on' },
      from: 'OLLAMA_KV_CACHE_TYPE=q8_0, OLLAMA_FLASH_ATTENTION=1',
    });
    // Ollama keeps an f16 cache with flash attention off, so only that carries over.
    expect(observedPrefill({ OLLAMA_KV_CACHE_TYPE: 'q4_0', OLLAMA_FLASH_ATTENTION: '0' })).toEqual({
      settings: { flashAttention: 'off' },
      from: 'OLLAMA_FLASH_ATTENTION=0',
    });
    expect(observedPrefill({ OLLAMA_NUM_PARALLEL: '2' })).toBeNull();
  });

  it('reads flash attention as Ollama does, leaving it unset at auto', () => {
    expect(observedFlashAttention({ OLLAMA_FLASH_ATTENTION: '1' })).toBe('on');
    expect(observedFlashAttention({ OLLAMA_FLASH_ATTENTION: 'false' })).toBe('off');
    expect(observedFlashAttention({ OLLAMA_FLASH_ATTENTION: '' })).toBeUndefined();
    expect(observedFlashAttention({})).toBeUndefined();
  });
});
