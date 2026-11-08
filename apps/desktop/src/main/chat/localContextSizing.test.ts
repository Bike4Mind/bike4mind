import { describe, expect, it, vi } from 'vitest';
import type { HardwareProbeOptions, HardwareProfile } from '@bike4mind/local-models';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import type { ModelServerView } from '@shared/modelServers';
import { HardwareProbe, localContextSizing, localLlamaServer } from './localContextSizing';

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
    expect(probe).toHaveBeenLastCalledWith({ llamaServer: locate, llamaServerMaxAgeMs: 0 });
    await hardware.profile();
    expect(probe).toHaveBeenCalledTimes(2);
    hardware.forget();
    await hardware.profile();
    expect(probe).toHaveBeenLastCalledWith({ llamaServer: locate, llamaServerMaxAgeMs: 0 });
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

  it('lists again on every save on a Linux Intel card, keeping the last result readable', async () => {
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
    hardware.relistLlamaServer();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(probe).toHaveBeenLastCalledWith({ llamaServerMaxAgeMs: 0 });
    expect(hardware.known()).toBe(intel);
    finish(sized);
    expect(await hardware.profile()).toBe(sized);
    expect(hardware.known()).toBe(sized);
    // With its VRAM known, a save may still point at another binary.
    hardware.relistLlamaServer();
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
    hardware.relistLlamaServer();
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
      const probe = vi.fn(async (_options: HardwareProbeOptions) => probed);
      const hardware = new HardwareProbe(probe);
      await hardware.profile();
      hardware.relistLlamaServer();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(probe).toHaveBeenCalledTimes(1);
      expect(hardware.known()).toBe(probed);
    }
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
