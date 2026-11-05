import { describe, expect, it, vi } from 'vitest';
import type { SecretCipher } from '../chat/mcp/McpServerStore';
import { adoptedHandle, hostProcessProbe, readOwnedRecords, sameStartTime, type ProcessProbe } from './adoptedServers';
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
  function processes(starts: Record<number, string>, listening = true, followers = new Set<number>()) {
    const running = new Map(Object.entries(starts).map(([pid, start]) => [Number(pid), start]));
    const signals: [number, string][] = [];
    const probe: ProcessProbe = {
      startTime: async pid => running.get(pid) ?? null,
      leadsGroup: async pid => !followers.has(pid),
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

  const cipher: SecretCipher = {
    isEncryptionAvailable: () => true,
    encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: encrypted => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
      return text.slice(4);
    },
  };

  function adopter(
    file: ReturnType<typeof memoryFile>,
    probe: ProcessProbe,
    options: { cipher?: SecretCipher | null; handle?: ServerHandle; probeRetryMs?: number } = {}
  ) {
    const changed = vi.fn();
    const warn = vi.fn();
    const start = vi.fn<Launchers['start']>(async () => options.handle ?? handle());
    const instance = new LocalServerSupervisor({
      launchers: { program: async () => ({ path: '/bin/x' }), start },
      logger: { warn },
      changed,
      records: file,
      ...(options.cipher === null ? {} : { cipher: options.cipher ?? cipher }),
      processes: probe,
      adoptedTiming: { pollMs: 10, stopTimeoutMs: 50, probeRetryMs: options.probeRetryMs ?? 1 },
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
    const { probe, signals } = processes({ 4321: RECORD.startTime });
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

  const ROUTER = { ...RECORD, runtime: 'llama-server', settings: { modelsDir: '/m' } };
  const sealed = (key: string) => Buffer.from(`enc:${key}`, 'utf8').toString('base64');

  it("keeps a router's key, so requests to the router it takes back still get in", async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [{ ...ROUTER, sealedKey: sealed('k-zz') }] }));
    const { instance } = adopter(file, processes({ 4321: RECORD.startTime }).probe);
    await instance.adopt(() => true);
    expect(instance.headers('a')).toEqual({ authorization: 'Bearer k-zz' });
    expect(file.contents).not.toContain('k-zz');
    expect(listed(file)[0].sealedKey).toBe(sealed('k-zz'));
  });

  it("never writes a router's key in the clear, and lists no router it cannot seal the key of", async () => {
    const file = memoryFile();
    const { instance } = adopter(file, processes({ 4321: RECORD.startTime }).probe, { handle: handle('k-zz') });
    await instance.start('a', { runtime: 'llama-server', port: 8090, settings: { modelsDir: '/m' } });
    expect(file.contents).not.toContain('k-zz');
    expect(listed(file)[0]).toMatchObject({ sealedKey: sealed('k-zz') });
    expect(listed(file)[0].apiKey).toBeUndefined();

    const unsealed = memoryFile();
    const plain = adopter(unsealed, processes({ 4321: RECORD.startTime }).probe, {
      cipher: null,
      handle: handle('k-zz'),
    });
    await plain.instance.start('a', { runtime: 'llama-server', port: 8090, settings: { modelsDir: '/m' } });
    expect(unsealed.contents).toBeNull();
  });

  it('does not take back a router whose key cannot be decrypted, and deletes its record', async () => {
    const records = [
      { ...ROUTER, sealedKey: Buffer.from('garbage').toString('base64') },
      { ...RECORD, id: 'b', pid: 5555, port: 11501 },
    ];
    const file = memoryFile(JSON.stringify({ version: 1, servers: records }));
    const { instance } = adopter(file, processes({ 4321: RECORD.startTime, 5555: RECORD.startTime }).probe);
    await instance.adopt(() => true);
    expect(instance.owned('a')).toBeNull();
    expect(instance.owned('b')).not.toBeNull();
    expect(listed(file).map((record: { id: string }) => record.id)).toEqual(['b']);

    const keyless = memoryFile(JSON.stringify({ version: 1, servers: [{ ...ROUTER, apiKey: 'k-zz' }] }));
    const other = adopter(keyless, processes({ 4321: RECORD.startTime }).probe);
    await other.instance.adopt(() => true);
    expect(other.instance.owned('a')).toBeNull();
    expect(listed(keyless)).toEqual([]);
  });

  it('never takes back pid 1 or a process that does not lead its own group', async () => {
    expect(readOwnedRecords(JSON.stringify({ servers: [{ ...RECORD, pid: 1 }] }))).toEqual([]);
    expect(readOwnedRecords(JSON.stringify({ servers: [{ ...RECORD, pid: 2 }] }))).toHaveLength(1);

    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const { probe, signals } = processes({ 4321: RECORD.startTime }, true, new Set([4321]));
    const { instance } = adopter(file, probe);
    await instance.adopt(() => true);
    expect(instance.owned('a')).toBeNull();
    expect(signals).toEqual([]);
    expect(listed(file)).toEqual([]);
  });

  it('lists nothing when Stop lands during the start time read', async () => {
    for (const how of ['stop', 'exit']) {
      const file = memoryFile();
      const { probe } = processes({ 4321: RECORD.startTime });
      let release: (time: string) => void = () => undefined;
      const slow: ProcessProbe = { ...probe, startTime: () => new Promise(resolve => (release = resolve)) };
      const fake = handle();
      if (how === 'stop') fake.stop = vi.fn(async () => undefined);
      const { instance } = adopter(file, slow, { handle: fake });
      const starting = instance.start('a', OLLAMA);
      await vi.waitFor(() => expect(instance.owned('a')).not.toBeNull());
      if (how === 'stop') await instance.stop('a');
      else fake.running = false;
      release(RECORD.startTime);
      await starting;
      expect(file.contents).toBeNull();
    }
  });

  it('ends a server it took back that is already gone without signalling', async () => {
    const { probe, signals, running } = processes({ 4321: RECORD.startTime });
    const adopted = adoptedHandle({ ...RECORD, runtime: 'ollama', settings: {} }, probe, { pollMs: 60_000 });
    running.delete(4321);
    await adopted.stop();
    expect(signals).toEqual([]);
    expect(adopted.running).toBe(false);
  });

  it('escalates to SIGKILL when the server it took back ignores SIGTERM', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const { probe, running, signals } = processes({ 4321: RECORD.startTime });
    const stubborn: ProcessProbe = {
      ...probe,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 'SIGKILL') running.delete(pid);
      },
    };
    const { instance } = adopter(file, stubborn);
    await instance.adopt(() => true);
    await instance.stop('a');
    expect(signals).toEqual([
      [4321, 'SIGTERM'],
      [4321, 'SIGKILL'],
    ]);
  });

  it('never takes one back on its pid alone, and drops the records it does not take', async () => {
    const records = [
      { ...RECORD, id: 'reused', pid: 5 },
      { ...RECORD, id: 'gone', pid: 2 },
      { ...RECORD, id: 'unread', pid: 3 },
      { ...RECORD, id: 'refused', pid: 4 },
    ];
    const file = memoryFile(JSON.stringify({ version: 1, servers: records }));
    const { probe } = processes({ 5: '1700000000:999', 4: RECORD.startTime });
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

  const unreadable = (failures: number): ProcessProbe => {
    const { probe } = processes({ 4321: RECORD.startTime });
    let left = failures;
    return {
      ...probe,
      startTime: async pid => {
        if (left-- > 0) throw new Error('ps timed out');
        return probe.startTime(pid);
      },
    };
  };

  it('keeps the record of a server whose process it cannot read, and takes it back once it can', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const stuck = adopter(file, unreadable(Infinity)).instance;
    await stuck.adopt(() => true);
    expect(stuck.owned('a')).toBeNull();
    expect(listed(file)).toEqual([{ ...RECORD, unverifiedLaunches: 1 }]);

    const next = adopter(file, unreadable(0)).instance;
    await next.adopt(() => true);
    expect(next.owned('a')).not.toBeNull();
  });

  it('starts the count over for a record it takes back', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [{ ...RECORD, unverifiedLaunches: 3 }] }));
    const { instance } = adopter(file, processes({ 4321: RECORD.startTime }).probe);
    await instance.adopt(() => true);
    expect(instance.owned('a')).not.toBeNull();
    expect(listed(file)).toEqual([RECORD]);
  });

  it('takes back the first entry for an id and ignores the rest', async () => {
    const twin = { ...RECORD, pid: 4322 };
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD, twin] }));
    const { instance } = adopter(file, processes({ 4321: RECORD.startTime, 4322: RECORD.startTime }).probe);
    await instance.adopt(() => true);
    expect(listed(file)).toEqual([RECORD]);
  });

  it('drops a record whose process stays unreadable for more than three launches', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    for (const launches of [1, 2, 3]) {
      await adopter(file, unreadable(Infinity)).instance.adopt(() => true);
      expect(listed(file)).toEqual([{ ...RECORD, unverifiedLaunches: launches }]);
    }
    await adopter(file, unreadable(Infinity)).instance.adopt(() => true);
    expect(listed(file)).toEqual([]);
  });

  it('forgets an unreadable record when its id starts again and stops', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const { instance } = adopter(file, unreadable(Infinity));
    await instance.adopt(() => true);
    expect(listed(file)).toHaveLength(1);
    await instance.start('a', OLLAMA);
    await instance.stop('a');
    expect(listed(file)).toEqual([]);
  });

  it('asks about every record at once and pauses before it asks again', async () => {
    const records = [RECORD, { ...RECORD, id: 'b', pid: 5555, port: 11501 }];
    const file = memoryFile(JSON.stringify({ version: 1, servers: records }));
    const events: string[] = [];
    const calls = new Map<number, number[]>();
    const slow: ProcessProbe = {
      ...processes({ 4321: RECORD.startTime, 5555: RECORD.startTime }).probe,
      startTime: async pid => {
        const times = calls.get(pid) ?? [];
        calls.set(pid, [...times, Date.now()]);
        events.push(`start:${pid}`);
        await new Promise(done => setTimeout(done, 20));
        events.push(`end:${pid}`);
        if (times.length === 0) throw new Error('ps timed out');
        return RECORD.startTime;
      },
    };
    const { instance } = adopter(file, slow, { probeRetryMs: 60 });
    await instance.adopt(() => true);
    expect(events.slice(0, 2)).toEqual(['start:4321', 'start:5555']);
    for (const [first, second] of calls.values()) expect(second - first).toBeGreaterThanOrEqual(75);
    expect(instance.owned('a')).not.toBeNull();
    expect(instance.owned('b')).not.toBeNull();
  });

  it('retries one failed read at launch before it takes a server back', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const { instance } = adopter(file, unreadable(1));
    await instance.adopt(() => true);
    expect(instance.owned('a')).not.toBeNull();
    expect(listed(file)).toEqual([RECORD]);
  });

  it('treats a failed read as still running, so it keeps polling and still signals on Stop', async () => {
    const { probe, signals } = processes({ 4321: RECORD.startTime });
    let failing = true;
    const flaky: ProcessProbe = {
      ...probe,
      startTime: async pid => {
        if (failing) throw new Error('EMFILE');
        return probe.startTime(pid);
      },
    };
    const adopted = adoptedHandle({ ...RECORD, runtime: 'ollama', settings: {} }, flaky, { pollMs: 5 });
    await new Promise(done => setTimeout(done, 40));
    expect(adopted.running).toBe(true);
    failing = false;
    await adopted.stop();
    expect(signals).toEqual([[4321, 'SIGTERM']]);
    expect(adopted.running).toBe(false);
  });

  it('sends no signal to a process it cannot confirm is its server, and says Stop failed', async () => {
    const { probe, signals } = processes({ 4321: RECORD.startTime });
    const blind: ProcessProbe = {
      ...probe,
      startTime: async () => {
        throw new Error('ps timed out');
      },
    };
    const adopted = adoptedHandle({ ...RECORD, runtime: 'ollama', settings: {} }, blind, {
      pollMs: 5,
      stopTimeoutMs: 30,
    });
    await expect(adopted.stop()).rejects.toThrow(/could not confirm process 4321/);
    expect(signals).toEqual([]);
    expect(adopted.running).toBe(true);
  });

  it('does not report a later exit as a crash after Stop failed', async () => {
    const { probe, running } = processes({ 4321: RECORD.startTime });
    let blind = true;
    const flaky: ProcessProbe = {
      ...probe,
      startTime: async pid => {
        if (blind) throw new Error('ps timed out');
        return probe.startTime(pid);
      },
    };
    const adopted = adoptedHandle({ ...RECORD, runtime: 'ollama', settings: {} }, flaky, {
      pollMs: 5,
      stopTimeoutMs: 20,
    });
    await expect(adopted.stop()).rejects.toThrow();
    blind = false;
    running.delete(4321);
    await expect(adopted.exited).resolves.toMatchObject({ stopped: true });
  });

  it('keeps the slot and record of a server that outlives SIGKILL, and says Stop failed', async () => {
    const file = memoryFile(JSON.stringify({ version: 1, servers: [RECORD] }));
    const { probe, signals } = processes({ 4321: RECORD.startTime });
    const immortal: ProcessProbe = { ...probe, signal: (pid, signal) => void signals.push([pid, signal]) };
    const { instance } = adopter(file, immortal);
    await instance.adopt(() => true);
    await expect(instance.stop('a')).rejects.toThrow(/did not exit/);
    expect(signals.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(instance.owned('a')).not.toBeNull();
    expect(instance.busy('a')).toBeNull();
    expect(listed(file)).toEqual([RECORD]);
  });

  it('seals a router key only with a keychain backend, not basic_text', async () => {
    const basic = { ...cipher, getSelectedStorageBackend: () => 'basic_text' };
    const file = memoryFile();
    const { instance } = adopter(file, processes({ 4321: RECORD.startTime }).probe, {
      cipher: basic,
      handle: handle('k-zz'),
    });
    await instance.start('a', { runtime: 'llama-server', port: 8090, settings: { modelsDir: '/m' } });
    expect(file.contents).toBeNull();

    const stored = memoryFile(JSON.stringify({ version: 1, servers: [{ ...ROUTER, sealedKey: sealed('k-zz') }] }));
    const adopting = adopter(stored, processes({ 4321: RECORD.startTime }).probe, { cipher: basic }).instance;
    await adopting.adopt(() => true);
    expect(adopting.owned('a')).toBeNull();

    const real = memoryFile();
    const keychain = { ...cipher, getSelectedStorageBackend: () => 'gnome_libsecret' };
    const sealing = adopter(real, processes({ 4321: RECORD.startTime }).probe, {
      cipher: keychain,
      handle: handle('k-zz'),
    }).instance;
    await sealing.start('a', { runtime: 'llama-server', port: 8090, settings: { modelsDir: '/m' } });
    expect(listed(real)[0].sealedKey).toBe(sealed('k-zz'));
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

  it('matches start times exactly', () => {
    expect(sameStartTime('boot-a:555', 'boot-a:555')).toBe(true);
    expect(sameStartTime('boot-a:555', 'boot-a:556')).toBe(false);
    expect(sameStartTime('boot-a:555', 'boot-b:555')).toBe(false);
    expect(sameStartTime('Wed Nov  4 10:00:00 2026', 'Wed Nov  4 10:00:00 2026')).toBe(true);
    expect(sameStartTime(null, null)).toBe(false);
  });

  /** A /proc/<pid>/stat line: after the state, field 5 (pgrp) is third and field 22 (start ticks) twentieth. */
  const statLine = (pid: number, { state = 'S', pgrp = pid, ticks = 555 } = {}) => {
    const fields = Array.from({ length: 22 }, () => '0');
    fields[0] = state;
    fields[2] = String(pgrp);
    fields[19] = String(ticks);
    return `${pid} (llama (srv) x) ${fields.join(' ')}`;
  };
  const proc = (files: Record<string, string>) => async (path: string) => {
    if (path in files) return files[path];
    throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
  };
  const BOOT = '/proc/sys/kernel/random/boot_id';

  it('identifies a Linux process by boot id and start ticks, and not by the clock', async () => {
    let clock = 1_700_000_000;
    const files = {
      '/proc/4321/stat': statLine(4321),
      [BOOT]: 'aaaa-1111\n',
    };
    const read = async (path: string) => (path === '/proc/stat' ? `btime ${clock}\n` : proc(files)(path));
    const probe = hostProcessProbe('linux', { readText: read });
    const first = await probe.startTime(4321);
    clock += 100;
    expect(await probe.startTime(4321)).toBe(first);

    const rebooted = hostProcessProbe('linux', { readText: proc({ ...files, [BOOT]: 'bbbb-2222\n' }) });
    expect(sameStartTime(first, await rebooted.startTime(4321))).toBe(false);
  });

  it('does not take back a process after a reboot, and keeps one after the clock steps', async () => {
    const files = { '/proc/4321/stat': statLine(4321), [BOOT]: 'aaaa-1111\n' };
    const listening = async () => true;
    const stored = await hostProcessProbe('linux', { readText: proc(files) }).startTime(4321);
    const record = {
      servers: [{ id: 'a', runtime: 'ollama', pid: 4321, startTime: stored, port: 11500, startedAt: 'x' }],
    };

    const rebooted = { ...files, [BOOT]: 'bbbb-2222\n' };
    const afterReboot = new LocalServerSupervisor({
      logger: { warn: vi.fn() },
      changed: vi.fn(),
      records: { read: async () => JSON.stringify(record), write: async () => undefined },
      processes: { ...hostProcessProbe('linux', { readText: proc(rebooted) }), listening },
    });
    await afterReboot.adopt(() => true);
    expect(afterReboot.owned('a')).toBeNull();

    const steppedClock = async (path: string) => (path === '/proc/stat' ? 'btime 1800000000\n' : proc(files)(path));
    const sameBoot = new LocalServerSupervisor({
      logger: { warn: vi.fn() },
      changed: vi.fn(),
      records: { read: async () => JSON.stringify(record), write: async () => undefined },
      processes: { ...hostProcessProbe('linux', { readText: steppedClock }), listening },
      adoptedTiming: { pollMs: 5 },
    });
    await sameBoot.adopt(() => true);
    await new Promise(done => setTimeout(done, 40));
    expect(sameBoot.owned('a')).not.toBeNull();
  });

  it('reads no start time for a zombie, or a process that is gone', async () => {
    const files = { '/proc/4321/stat': statLine(4321, { state: 'Z' }), [BOOT]: 'aaaa-1111\n' };
    const probe = hostProcessProbe('linux', { readText: proc(files) });
    expect(await probe.startTime(4321)).toBeNull();
    expect(await probe.startTime(4322)).toBeNull();
  });

  it('says a Linux process leads its group only when its group is its pid', async () => {
    const files = { '/proc/10/stat': statLine(10), '/proc/11/stat': statLine(11, { pgrp: 10 }) };
    const probe = hostProcessProbe('linux', { readText: proc(files) });
    expect(await probe.leadsGroup(10)).toBe(true);
    expect(await probe.leadsGroup(11)).toBe(false);
    expect(await probe.leadsGroup(12)).toBe(false);
  });

  it('asks ps for the macOS start time in the C locale and UTC', async () => {
    const run = vi.fn(
      (_file: string, _args: string[], _options: unknown, done: (e: Error | null, out: string) => void) =>
        done(null, 'Wed Nov  4 10:00:00 2026\n')
    );
    const probe = hostProcessProbe('darwin', { execFile: run });
    expect(await probe.startTime(4321)).toBe('Wed Nov  4 10:00:00 2026');
    expect(run).toHaveBeenCalledWith(
      'ps',
      ['-o', 'lstart=', '-p', '4321'],
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }) }),
      expect.any(Function)
    );
  });

  it('rejects instead of reporting a gone process when it cannot tell on Linux', async () => {
    const denied = async (path: string) => {
      if (path === '/proc/4321/stat') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return proc({ [BOOT]: 'aaaa-1111\n' })(path);
    };
    const probe = hostProcessProbe('linux', { readText: denied });
    await expect(probe.startTime(4321)).rejects.toThrow('EACCES');
    await expect(probe.leadsGroup(4321)).rejects.toThrow('EACCES');
    const noBoot = hostProcessProbe('linux', { readText: proc({ '/proc/4321/stat': statLine(4321) }) });
    await expect(noBoot.startTime(4321)).rejects.toThrow();
  });

  const ps =
    (error: (Error & { code?: unknown }) | null, out = '') =>
    (_file: string, _args: string[], _options: unknown, done: (e: Error | null, out: string) => void) =>
      done(error, out);

  it('rejects on a ps timeout or spawn error, and reads none only when ps finds no such process', async () => {
    const timeout = hostProcessProbe('darwin', {
      execFile: ps(Object.assign(new Error('timed out'), { killed: true })),
    });
    await expect(timeout.startTime(4321)).rejects.toThrow('timed out');
    await expect(timeout.leadsGroup(4321)).rejects.toThrow('timed out');
    const missing = hostProcessProbe('darwin', { execFile: ps(Object.assign(new Error('ps'), { code: 'ENOENT' })) });
    await expect(missing.startTime(4321)).rejects.toThrow();
    const none = hostProcessProbe('darwin', { execFile: ps(Object.assign(new Error('ps'), { code: 1 })) });
    expect(await none.startTime(4321)).toBeNull();
    expect(await none.leadsGroup(4321)).toBe(false);
  });

  it('asks ps for the macOS process group and requires it to be the pid', async () => {
    const run = vi.fn(ps(null, ' 4321\n'));
    const probe = hostProcessProbe('darwin', { execFile: run });
    expect(await probe.leadsGroup(4321)).toBe(true);
    expect(run).toHaveBeenCalledWith(
      'ps',
      ['-o', 'pgid=', '-p', '4321'],
      expect.objectContaining({ timeout: 2_000, env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }) }),
      expect.any(Function)
    );
    expect(await hostProcessProbe('darwin', { execFile: ps(null, '100\n') }).leadsGroup(4321)).toBe(false);
  });

  it('signals the process group with the negative pid, and the process alone when that fails', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      hostProcessProbe('linux').signal(4321, 'SIGTERM');
      expect(kill).toHaveBeenLastCalledWith(-4321, 'SIGTERM');
      kill.mockImplementationOnce(() => {
        throw new Error('ESRCH');
      });
      hostProcessProbe('linux').signal(4321, 'SIGKILL');
      expect(kill.mock.calls.slice(-2)).toEqual([
        [-4321, 'SIGKILL'],
        [4321, 'SIGKILL'],
      ]);
    } finally {
      kill.mockRestore();
    }
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
