import { mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HardwareProbeOptions, HardwareProfile } from '@bike4mind/local-models';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import type { ModelServerView } from '@shared/modelServers';
import { HardwareProbe, localContextSizing, localLlamaServer, relistAfterSave } from './localContextSizing';

const qwenInfo = {
  'general.architecture': 'qwen2',
  'qwen2.block_count': 24,
  'qwen2.context_length': 32768,
  'qwen2.attention.head_count': 14,
  'qwen2.attention.head_count_kv': 2,
  'qwen2.embedding_length': 896,
};
// Ollama leaves a long per-layer array out of the plain /api/show.
const hybridInfo = {
  'general.architecture': 'granitehybrid',
  'granitehybrid.block_count': 4,
  'granitehybrid.context_length': 131072,
  'granitehybrid.attention.head_count': 32,
  'granitehybrid.attention.head_count_kv': [],
  'granitehybrid.embedding_length': 2048,
};
const machine: HardwareProfile = {
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: 64 * 1024 ** 3,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  chip: null,
  diskFreeBytes: null,
  confidence: 'high',
};
const qwen = { name: 'qwen2.5:0.5b', modelInfo: qwenInfo, sizeBytes: 397_821_000, digest: 'a' };
const hybrid = { name: 'granite', modelInfo: hybridInfo, sizeBytes: 1_942_572_096, digest: 'g' };
const verbose = { model_info: { ...hybridInfo, 'granitehybrid.attention.head_count_kv': [0, 8, 0, 8] } };

const intelCard: HardwareProfile = { ...machine, memoryKind: 'discrete', gpuVendor: 'intel', gpuCount: 1 };
const settled = () => new Promise(resolve => setTimeout(resolve, 0));
// A binary's identity as its path alone, so a test moves it by changing the path.
const byPath = async (path: string) => path;

describe('HardwareProbe', () => {
  it('probes once, whoever asks first, and reports nothing until it finishes', async () => {
    const probe = vi.fn(async () => machine);
    const hardware = new HardwareProbe(probe);
    expect(hardware.known()).toBeUndefined();
    const [first, second] = await Promise.all([hardware.profile(), hardware.profile()]);
    expect(first).toBe(machine);
    expect(second).toBe(machine);
    expect(hardware.known()).toBe(machine);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('reads a failed probe as unknown', async () => {
    const hardware = new HardwareProbe(async () => {
      throw new Error('no probe');
    });
    expect(await hardware.profile()).toBeNull();
    expect(hardware.known()).toBeNull();
  });

  it('probes again a minute after a failure', async () => {
    let clock = 0;
    const probe = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(machine);
    const hardware = new HardwareProbe(probe, () => clock);
    expect(await hardware.profile()).toBeNull();
    expect(await hardware.profile()).toBeNull();
    clock = 60_001;
    expect(await hardware.profile()).toBe(machine);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('applies an override to what sizing reads and keeps the probe itself apart', async () => {
    const hardware = new HardwareProbe(async () => machine);
    let ram = 64;
    hardware.setOverride(probed => ({ ...probed, totalMemoryBytes: ram * 1024 ** 3 }));
    ram = 128;
    expect((await hardware.profile())?.totalMemoryBytes).toBe(128 * 1024 ** 3);
    expect(hardware.known()?.totalMemoryBytes).toBe(128 * 1024 ** 3);
    expect(await hardware.probed()).toBe(machine);
  });

  it('passes the llama-server to the probe and lists its devices afresh when it is set or forgotten', async () => {
    const intel = { ...machine, memoryKind: 'discrete' as const, gpuVendor: 'intel' as const, gpuCount: 1 };
    const probe = vi.fn(async (_options: HardwareProbeOptions) => intel);
    const hardware = new HardwareProbe(probe);
    await hardware.profile();
    expect(probe).toHaveBeenLastCalledWith({});
    const locate = async () => ({ path: '/opt/llama/llama-server' });
    hardware.setLlamaServer(locate);
    expect(hardware.known()).toBeUndefined();
    await hardware.profile();
    expect(probe).toHaveBeenLastCalledWith({ llamaServer: expect.any(Function), llamaServerMaxAgeMs: 0 });
    expect(await probe.mock.lastCall?.[0].llamaServer?.()).toEqual({ path: '/opt/llama/llama-server' });
    await hardware.profile();
    expect(probe).toHaveBeenCalledTimes(2);
    hardware.forget();
    await hardware.profile();
    expect(probe).toHaveBeenLastCalledWith({ llamaServer: expect.any(Function), llamaServerMaxAgeMs: 0 });
    hardware.forget();
    hardware.forget();
    await hardware.profile();
    await hardware.profile();
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('reuses the cached device listing when the probe is retried after a failure', async () => {
    let now = 0;
    const probe = vi
      .fn<(options: HardwareProbeOptions) => Promise<HardwareProfile>>()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValue(machine);
    const hardware = new HardwareProbe(probe, () => now);
    hardware.forget();
    expect(await hardware.profile()).toBeNull();
    expect(probe).toHaveBeenLastCalledWith({ llamaServerMaxAgeMs: 0 });
    now = 60_000;
    expect(await hardware.profile()).toEqual(machine);
    expect(probe).toHaveBeenLastCalledWith({});
  });

  it('lists again on every llama-server save on a Linux Intel card, keeping the last result readable', async () => {
    const intel = { ...machine, memoryKind: 'discrete' as const, gpuVendor: 'intel' as const, gpuCount: 1 };
    const sized = { ...intel, gpuMemoryBytes: 32 * 1024 ** 3 };
    let finish: (profile: HardwareProfile) => void = () => undefined;
    const probe = vi
      .fn<(options: HardwareProbeOptions) => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(intel)
      .mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
      .mockResolvedValue(intel);
    const hardware = new HardwareProbe(probe);
    await hardware.profile();
    hardware.relistLlamaServer(true);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(probe).toHaveBeenLastCalledWith({ llamaServerMaxAgeMs: 0 });
    expect(hardware.known()).toBe(intel);
    finish(sized);
    expect(await hardware.profile()).toBe(sized);
    expect(hardware.known()).toBe(sized);
    // With its VRAM known, a save may still point at another binary.
    hardware.relistLlamaServer(true);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3));
    expect(probe).toHaveBeenLastCalledWith({ llamaServerMaxAgeMs: 0 });
    expect(await hardware.profile()).toBe(intel);
  });

  it('keeps the last result when a probe on save fails', async () => {
    const intel = { ...machine, memoryKind: 'discrete' as const, gpuVendor: 'intel' as const, gpuCount: 1 };
    const probe = vi
      .fn<(options: HardwareProbeOptions) => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(intel)
      .mockRejectedValue(new Error('probe failed'));
    const hardware = new HardwareProbe(probe);
    await hardware.profile();
    hardware.relistLlamaServer(true);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(await hardware.profile()).toBe(intel);
    expect(hardware.known()).toBe(intel);
  });

  it('does not probe again on a save without a Linux Intel card', async () => {
    const machines: HardwareProfile[] = [
      { ...machine, memoryKind: 'discrete', gpuVendor: 'nvidia', gpuMemoryBytes: 24 * 1024 ** 3, gpuCount: 1 },
      { ...machine, memoryKind: 'unified', gpuVendor: 'amd', gpuCount: 1 },
      { ...machine, platform: 'darwin', arch: 'arm64', memoryKind: 'unified', gpuVendor: 'apple', gpuCount: 1 },
      machine,
      { ...machine, platform: 'win32', memoryKind: 'discrete', gpuVendor: 'intel', gpuCount: 1 },
    ];
    for (const probed of machines) {
      for (const llamaServerSaved of [true, false]) {
        const probe = vi.fn(async (_options: HardwareProbeOptions) => probed);
        const hardware = new HardwareProbe(probe, undefined, byPath);
        let path = '/opt/sycl/llama-server';
        const locate = vi.fn(async () => ({ path }));
        hardware.setLlamaServer(locate);
        await hardware.profile();
        path = '/usr/local/bin/llama-server';
        hardware.relistLlamaServer(llamaServerSaved);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(locate).not.toHaveBeenCalled();
        expect(probe).toHaveBeenCalledTimes(1);
        expect(hardware.known()).toBe(probed);
      }
    }
  });

  it('lists again on any other save only when the llama-server it would list is another one', async () => {
    const intel = { ...machine, memoryKind: 'discrete' as const, gpuVendor: 'intel' as const, gpuCount: 1 };
    const probe = vi.fn(async (options: HardwareProbeOptions) => {
      await options.llamaServer?.();
      return intel;
    });
    const unset = new HardwareProbe(probe);
    await unset.profile();
    unset.relistLlamaServer(false);
    await settled();
    expect(probe).toHaveBeenCalledTimes(1);

    probe.mockClear();
    let path: string | null = '/opt/sycl/llama-server';
    const locate = vi.fn(async () => (path ? { path } : null));
    const hardware = new HardwareProbe(probe, undefined, byPath);
    hardware.setLlamaServer(locate);
    await hardware.profile();
    hardware.relistLlamaServer(false);
    await settled();
    expect(probe).toHaveBeenCalledTimes(1);
    // The configured llama-server was removed, leaving the one on PATH.
    path = '/usr/local/bin/llama-server';
    hardware.relistLlamaServer(false);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(probe).toHaveBeenLastCalledWith({ llamaServer: expect.any(Function), llamaServerMaxAgeMs: 0 });
    hardware.relistLlamaServer(false);
    await settled();
    expect(probe).toHaveBeenCalledTimes(2);
    path = null;
    hardware.relistLlamaServer(false);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3));
    hardware.relistLlamaServer(false);
    await settled();
    expect(probe).toHaveBeenCalledTimes(3);
    locate.mockRejectedValueOnce(new Error('store unreadable'));
    hardware.relistLlamaServer(false);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(4));
  });

  it('compares with the llama-server of the probe whose result it keeps, not of one superseded', async () => {
    const intel = { ...machine, memoryKind: 'discrete' as const, gpuVendor: 'intel' as const, gpuCount: 1 };
    let finishFirst: (profile: HardwareProfile) => void = () => undefined;
    const probe = vi
      .fn<(options: HardwareProbeOptions) => Promise<HardwareProfile>>()
      .mockImplementationOnce(async options => {
        await options.llamaServer?.();
        return new Promise(resolve => (finishFirst = resolve));
      })
      .mockImplementation(async options => {
        await options.llamaServer?.();
        return intel;
      });
    let path = '/opt/old/llama-server';
    const hardware = new HardwareProbe(probe, undefined, byPath);
    hardware.setLlamaServer(async () => ({ path }));
    const first = hardware.probed();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    path = '/opt/new/llama-server';
    hardware.forget();
    expect(await hardware.probed()).toBe(intel);
    finishFirst(intel);
    await first;
    hardware.relistLlamaServer(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  describe('on a save that is not a llama-server', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'llama-identity-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const listing = () =>
      vi.fn(async (options: HardwareProbeOptions) => {
        await options.llamaServer?.();
        return intelCard;
      });
    const listedFrom = async (path: string, probe = listing(), timeoutMs?: number) => {
      const locate = vi.fn(async () => ({ path }));
      const hardware = new HardwareProbe(probe, undefined, undefined, timeoutMs);
      hardware.setLlamaServer(locate);
      await hardware.profile();
      return { hardware, probe, locate };
    };

    it('lists again when the binary is replaced in place, and not while it is unchanged', async () => {
      const binary = join(dir, 'llama-server');
      await writeFile(binary, 'build one');
      const { hardware, probe } = await listedFrom(binary);
      hardware.relistLlamaServer(false);
      await settled();
      expect(probe).toHaveBeenCalledTimes(1);
      await writeFile(binary, 'build two, a different size');
      hardware.relistLlamaServer(false);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
      await writeFile(binary, 'build two, a different size');
      await utimes(binary, new Date(1_000_000), new Date(1_000_000));
      hardware.relistLlamaServer(false);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3));
    });

    it('lists again when the symlink it found now points at another binary', async () => {
      await writeFile(join(dir, 'sycl'), 'sycl');
      await writeFile(join(dir, 'cpu'), 'cpu build');
      const link = join(dir, 'llama-server');
      await symlink(join(dir, 'sycl'), link);
      const { hardware, probe } = await listedFrom(link);
      await rm(link);
      await symlink(join(dir, 'cpu'), link);
      hardware.relistLlamaServer(false);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    });

    it('warns and lists again when the binary cannot be read', async () => {
      const binary = join(dir, 'llama-server');
      await writeFile(binary, 'build');
      const { hardware, probe } = await listedFrom(binary);
      await rm(binary);
      const warn = vi.fn();
      hardware.relistLlamaServer(false, warn);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
      expect(warn).toHaveBeenCalledOnce();
    });

    it('warns and lists again when the lookup does not answer in time', async () => {
      const binary = join(dir, 'llama-server');
      await writeFile(binary, 'build');
      const probe = vi.fn(async (_options: HardwareProbeOptions) => intelCard);
      const { hardware } = await listedFrom(binary, probe, 20);
      hardware.setLlamaServer(() => new Promise(() => undefined));
      await hardware.profile();
      probe.mockClear();
      const warn = vi.fn();
      hardware.relistLlamaServer(false, warn);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    });
  });

  it('never looks up the llama-server on a save when there is no Linux Intel card', async () => {
    const machines: HardwareProfile[] = [
      machine,
      { ...machine, memoryKind: 'discrete', gpuVendor: 'nvidia', gpuCount: 1 },
      { ...intelCard, platform: 'darwin' },
      { ...intelCard, platform: 'win32' },
    ];
    for (const probed of machines) {
      const locate = vi.fn(async () => ({ path: '/opt/sycl/llama-server' }));
      const probe = vi.fn(async (options: HardwareProbeOptions) => {
        await options.llamaServer?.();
        return probed;
      });
      const hardware = new HardwareProbe(probe, undefined, byPath);
      hardware.setLlamaServer(locate);
      await hardware.profile();
      locate.mockClear();
      hardware.relistLlamaServer(false);
      hardware.relistLlamaServer(true);
      await settled();
      expect(locate).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(1);
    }
  });

  it('does not let a save that finds nothing changed hide the relist another save needs', async () => {
    let gate: Promise<void> = Promise.resolve();
    let open: () => void = () => undefined;
    const probe = vi.fn(async (options: HardwareProbeOptions) => {
      await options.llamaServer?.();
      return intelCard;
    });
    const hardware = new HardwareProbe(probe, undefined, byPath);
    const locate = vi.fn(async () => {
      await gate;
      return { path: '/opt/sycl/llama-server' };
    });
    hardware.setLlamaServer(locate);
    await hardware.profile();
    gate = new Promise(resolve => (open = resolve));
    locate.mockClear();
    hardware.relistLlamaServer(false);
    await vi.waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
    hardware.relistLlamaServer(true);
    await vi.waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
    open();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await settled();
    expect(probe.mock.calls[1][0].llamaServerMaxAgeMs).toBe(0);
    expect(await hardware.profile()).toBe(intelCard);
  });

  it('keeps a probe that finishes after forget from overwriting the newer one', async () => {
    let finishFirst: (profile: HardwareProfile) => void = () => undefined;
    const newer = { ...machine, totalMemoryBytes: 1 };
    const probe = vi
      .fn<(options: HardwareProbeOptions) => Promise<HardwareProfile>>()
      .mockImplementationOnce(() => new Promise(resolve => (finishFirst = resolve)))
      .mockResolvedValue(newer);
    const hardware = new HardwareProbe(probe);
    const first = hardware.probed();
    hardware.forget();
    expect(await hardware.probed()).toBe(newer);
    finishFirst(machine);
    expect(await first).toBe(machine);
    expect(hardware.known()).toBe(newer);
  });

  it('gives a caller of a superseded probe that fails the newer result, not null', async () => {
    let failFirst: (error: Error) => void = () => undefined;
    const newer = { ...machine, totalMemoryBytes: 1 };
    const probe = vi
      .fn<(options: HardwareProbeOptions) => Promise<HardwareProfile>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (failFirst = reject)))
      .mockResolvedValue(newer);
    const hardware = new HardwareProbe(probe);
    const first = hardware.probed();
    hardware.forget();
    const second = hardware.probed();
    failFirst(new Error('probe failed'));
    expect(await first).toBe(newer);
    expect(await second).toBe(newer);
    expect(hardware.known()).toBe(newer);
  });
});

describe('localLlamaServer', () => {
  const view = (launch: Record<string, unknown> | null) => ({ launch }) as unknown as ModelServerView;
  const llama = (owner: string, binaryPath?: string) =>
    view({ runtime: 'llama-server', owner, settings: binaryPath ? { binaryPath } : {} });

  it('takes the binary a local llama-server is configured with, else the one on PATH', async () => {
    const onPath = vi.fn(async () => '/usr/local/bin/llama-server');
    const configured = localLlamaServer({
      views: async () => [
        view(null),
        llama('remote', '/remote/llama-server'),
        llama('desktop', '/opt/sycl/llama-server'),
      ],
      onPath,
    });
    expect(await configured()).toEqual({ path: '/opt/sycl/llama-server' });
    expect(onPath).not.toHaveBeenCalled();
    const unset = localLlamaServer({ views: async () => [llama('desktop'), llama('remote', '/remote/x')], onPath });
    expect(await unset()).toEqual({ path: '/usr/local/bin/llama-server' });
    expect(await localLlamaServer({ views: async () => [], onPath: async () => null })()).toBeNull();
  });

  it('rejects when the saved servers cannot be read', async () => {
    const failing = localLlamaServer({
      views: () => Promise.reject(new Error('store unreadable')),
      onPath: async () => null,
    });
    await expect(failing()).rejects.toThrow('store unreadable');
  });
});

describe('relistAfterSave', () => {
  const view = (id: string, launch: Record<string, unknown> | null) => ({ id, launch }) as unknown as ModelServerView;
  const llama = (owner: string) => ({ runtime: 'llama-server', owner, settings: {} });
  const ollama = (owner: string) => ({ runtime: 'ollama', owner, settings: {} });

  it('says whether the saved server is a llama-server Desktop would run on this computer', async () => {
    const hardware = new HardwareProbe(async () => machine);
    const relist = vi.spyOn(hardware, 'relistLlamaServer').mockImplementation(() => undefined);
    const views = [
      view('local', ollama('none')),
      view('remote-ollama', ollama('remote')),
      view('ssh-ollama', null),
      view('llama-stopped', llama('none')),
      view('llama-running', { ...llama('desktop'), settings: { binaryPath: '/opt/sycl/llama-server' } }),
      view('llama-other', llama('other')),
      view('llama-remote', llama('remote')),
    ];
    const warn = vi.fn();
    const saved = relistAfterSave(hardware, async () => views, { warn });
    const expected: [string, boolean][] = [
      ['local', false],
      ['remote-ollama', false],
      ['ssh-ollama', false],
      ['llama-stopped', true],
      ['llama-running', true],
      ['llama-other', true],
      ['llama-remote', false],
      ['removed', false],
    ];
    for (const [id, llamaServerSaved] of expected) {
      relist.mockClear();
      saved(id);
      await vi.waitFor(() => expect(relist).toHaveBeenCalledOnce());
      expect(relist).toHaveBeenCalledWith(llamaServerSaved, expect.any(Function));
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and lists again when the saved servers cannot be read', async () => {
    const hardware = new HardwareProbe(async () => machine);
    const relist = vi.spyOn(hardware, 'relistLlamaServer').mockImplementation(() => undefined);
    const warn = vi.fn();
    relistAfterSave(hardware, () => Promise.reject(new Error('store unreadable')), { warn })('llama');
    await vi.waitFor(() => expect(relist).toHaveBeenCalledWith(true, expect.any(Function)));
    expect(warn).toHaveBeenCalledWith(
      "MODEL SERVERS: could not read the saved servers after a save, so listing the llama-server's devices again: Error: store unreadable"
    );
  });
});

describe('localContextSizing', () => {
  const sizing = (deps: Partial<Parameters<typeof localContextSizing>[0]> = {}) =>
    localContextSizing({
      setting: async () => AUTO_LOCAL_CONTEXT,
      hardware: new HardwareProbe(async () => machine),
      ...deps,
    });

  it('reads the shape from the plain /api/show and the size from /api/tags, with no request of its own', async () => {
    const showVerbose = vi.fn();
    const footprint = await sizing({ showVerbose }).footprint(qwen);
    expect(footprint).toMatchObject({ weightsBytes: 397_821_000, hardware: machine, arch: { contextMax: 32768 } });
    expect(showVerbose).not.toHaveBeenCalled();
  });

  it('fetches the verbose /api/show once when per-layer arrays are left out', async () => {
    const showVerbose = vi.fn(async () => verbose);
    const sized = sizing({ showVerbose });
    expect(sized.cachedFootprint(hybrid).arch).toBeNull();
    const footprint = await sized.footprint(hybrid);
    expect(footprint.arch?.contextMax).toBe(131072);
    expect(sized.cachedFootprint(hybrid).arch?.contextMax).toBe(131072);
    expect(showVerbose).toHaveBeenCalledOnce();
  });

  it('answers what it knows now without waiting for the probe', () => {
    const sized = sizing({ hardware: new HardwareProbe(() => new Promise<HardwareProfile>(() => undefined)) });
    expect(sized.cachedFootprint(qwen)).toMatchObject({ hardware: null, weightsBytes: 397_821_000 });
  });

  it('sizes with the KV cache type entered at the time of each read', async () => {
    let entered: 'q8_0' | undefined = 'q8_0';
    const sized = sizing({ kvCacheType: () => entered });
    expect((await sized.footprint(qwen)).kvCacheType).toBe('q8_0');
    expect(sized.kvCacheType?.()).toBe('q8_0');
    entered = undefined;
    expect(sized.cachedFootprint(qwen).kvCacheType).toBeUndefined();
    expect((await sizing().footprint(qwen)).kvCacheType).toBeUndefined();
  });

  it('sizes with the flash attention known at the time of each read', async () => {
    let known: 'off' | undefined = 'off';
    const sized = sizing({ flashAttention: () => known });
    expect((await sized.footprint(qwen)).flashAttention).toBe('off');
    known = undefined;
    expect(sized.cachedFootprint(qwen).flashAttention).toBeUndefined();
  });

  it('backs off after a failed inspection instead of asking on every refresh', async () => {
    let clock = 0;
    const showVerbose = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(verbose);
    const sized = sizing({ showVerbose, now: () => clock });

    expect((await sized.footprint(hybrid)).arch).toBeNull();
    expect((await sized.footprint(hybrid)).arch).toBeNull();
    sized.cachedFootprint(hybrid);
    expect(showVerbose).toHaveBeenCalledOnce();

    clock = 60_001;
    expect((await sized.footprint(hybrid)).arch?.contextMax).toBe(131072);
    expect(showVerbose).toHaveBeenCalledTimes(2);
  });

  it('does not keep the unknown shape of a model listed before /api/show answered', async () => {
    const sized = sizing();
    expect(sized.cachedFootprint({ ...qwen, modelInfo: undefined }).arch).toBeNull();
    expect((await sized.footprint(qwen)).arch?.contextMax).toBe(32768);
  });

  it('reads every shape again after a Settings change', async () => {
    const showVerbose = vi.fn(async () => verbose);
    const sized = sizing({ showVerbose });
    await sized.footprint(hybrid);
    sized.forget?.();
    await sized.footprint(hybrid);
    expect(showVerbose).toHaveBeenCalledTimes(2);
  });

  it('inspects again when the tag now points at a different digest', async () => {
    const showVerbose = vi.fn(async () => verbose);
    const sized = sizing({ showVerbose });
    await sized.footprint(hybrid);
    await sized.footprint(hybrid);
    await sized.footprint({ ...hybrid, digest: 'g2' });
    expect(showVerbose).toHaveBeenCalledTimes(2);
  });
});
