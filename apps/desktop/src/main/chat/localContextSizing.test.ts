import { describe, expect, it, vi } from 'vitest';
import type { HardwareProfile } from '@bike4mind/local-models';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import { HardwareProbe, localContextSizing } from './localContextSizing';

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
