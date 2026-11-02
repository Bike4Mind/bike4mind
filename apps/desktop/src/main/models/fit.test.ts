import {
  estimateFit,
  estimateFitFromSize,
  type FitPlacement,
  type FitResult,
  type HardwareProfile,
  type ModelArch,
  type SizeFit,
} from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMemory } from '@shared/models';
import { fitFromArch, fitFromSize, machineView } from './fit';

// The estimator's numbers belong to @bike4mind/common; these tests pin only how a plan becomes a badge.
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  estimateFit: vi.fn(),
  estimateFitFromSize: vi.fn(),
}));

const actualCommon = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');

const GIB = 1024 ** 3;

const DENSE: ModelArch = {
  contextMax: 131072,
  blockCount: 32,
  full: { layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 },
  mtpLayers: 0,
};

const cpu = (ramGiB: number): HardwareProfile => ({
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: ramGiB * GIB,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  chip: null,
  diskFreeBytes: null,
  confidence: 'low',
});

const gpu = (vramGiB: number, ramGiB: number): HardwareProfile => ({
  ...cpu(ramGiB),
  memoryKind: 'discrete',
  gpuMemoryBytes: vramGiB * GIB,
  gpuName: 'NVIDIA GeForce RTX 4090',
  gpuCount: 1,
  confidence: 'high',
});

/** A stubbed estimate: `totalGiB` allocated plus a 1 GiB margin beside it, against a 12 GiB budget. */
function stub(totalGiB: number, options: { fits?: boolean; placement?: FitPlacement; context?: number } = {}) {
  const context = options.context ?? 16384;
  const requested = {
    context,
    kv: { k: 'f16', v: 'f16' },
    placement: options.placement ?? 'cpu',
    nCpuMoe: 0,
    ubatch: 1024,
    fits: options.fits ?? totalGiB + 1 <= 12,
    memory: {
      weightsBytes: 0,
      offloadedBytes: 0,
      mmprojBytes: 0,
      draftBytes: 0,
      kvBytes: 0,
      recurrentBytes: 0,
      computeBytes: 0,
      marginBytes: GIB,
      totalBytes: totalGiB * GIB,
      budgetBytes: 12 * GIB,
      ramPoolBytes: 0,
    },
  } as const;
  vi.mocked(estimateFit).mockReturnValue({ requested } as unknown as FitResult);
}

beforeEach(() => {
  vi.mocked(estimateFit).mockReset();
  vi.mocked(estimateFitFromSize).mockReset().mockImplementation(actualCommon.estimateFitFromSize);
});

describe('fitFromArch', () => {
  it('asks the estimator for an Ollama chat load of this arch at the context chat sends, capped at its limit', () => {
    stub(6);
    fitFromArch({ ...DENSE, contextMax: 8192 }, 4 * GIB, cpu(16), 16384, { mmprojBytes: 5 });
    expect(estimateFit).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { arch: { ...DENSE, contextMax: 8192 }, weightsBytes: 4 * GIB, mmprojBytes: 5 },
        mode: 'chat',
        runtime: expect.objectContaining({ kind: 'ollama', slots: 1 }),
        context: 8192,
      })
    );
  });

  it('fits, names the context, and sets what the runtime allocates against the budget less the margin', () => {
    stub(5);
    const fit = fitFromArch(DENSE, 4 * GIB, cpu(16), 16384);
    expect(fit).toMatchObject({ level: 'fits', basis: 'arch', context: 16384 });
    for (const figure of ['16K', 'about 5 GiB of the 11 GiB', 'runs on the CPU']) expect(fit.detail).toContain(figure);
  });

  it.each([
    [10.5, { fits: true }, 'tight', 'about 10.5 GiB'],
    [9.5, { fits: true }, 'fits', 'about 9.5 GiB'],
    [13, { fits: false }, 'too-large', 'about 13 GiB'],
  ])(
    'rates a %d GiB plan as the estimator and a 90%% share with the margin decide',
    (total, options, level, figure) => {
      stub(total, options);
      const fit = fitFromArch(DENSE, 4 * GIB, cpu(16), 16384);
      expect(fit.level).toBe(level);
      expect(fit.detail).toContain(figure);
    }
  );

  it('words a plan that misses only by the margin with numbers that agree with the verdict', () => {
    stub(11.5, { fits: false });
    const fit = fitFromArch(DENSE, 4 * GIB, cpu(16), 16384);
    expect(fit.level).toBe('too-large');
    expect(fit.detail).toContain('Needs about 11.5 GiB');
    expect(fit.detail).toContain('more than the 11 GiB this computer can hold for a model');
  });

  it.each([
    ['fits', 5, {}],
    ['tight', 10.5, {}],
    ['tight', 10, { placement: 'layer-offload' as const }],
    ['too-large', 13, { fits: false }],
  ])('adds the close-other-apps line only to a tight verdict: %s', (level, total, options) => {
    stub(total, options);
    const fit = fitFromArch(DENSE, 4 * GIB, cpu(16), 16384);
    expect(fit.level).toBe(level);
    if (level === 'tight') expect(fit.detail).toMatch(/ Close other apps first, or this computer may slow down\.$/);
    else expect(fit.detail).not.toContain('Close other apps');
  });

  it.each(['layer-offload', 'expert-offload'] as const)('is tight when the plan is %s', placement => {
    stub(10, { placement });
    const fit = fitFromArch(DENSE, 4 * GIB, gpu(8, 32), 16384);
    expect(fit.level).toBe('tight');
    expect(fit.detail).toContain('system RAM');
  });

  it('says GPU memory on a GPU machine and reports the context the plan used', () => {
    stub(6, { placement: 'gpu', context: 40960 });
    const fit = fitFromArch(DENSE, 4 * GIB, gpu(24, 64), 40960);
    expect(fit).toMatchObject({ level: 'fits', context: 40960 });
    expect(fit.detail).toContain('GPU memory');
    expect(fit.detail).toContain('40K');
    expect(fit.detail).not.toContain('CPU');
  });
});

describe('fitFromSize', () => {
  it('rates every size, machine and context exactly as the shared size-only estimate does', () => {
    for (const hardware of [cpu(8), cpu(16), cpu(128), gpu(8, 32), gpu(24, 64)])
      for (const size of [0.3, 3, 9, 12, 30, 100].map(sizeGiB => sizeGiB * GIB))
        for (const context of [2048, 16384, 131072]) {
          const shared = actualCommon.estimateFitFromSize(size, hardware, context);
          const fit = fitFromSize(size, hardware, context);
          const usable = shared.budgetBytes - actualCommon.fitMarginBytes(hardware);
          const machine = usable + actualCommon.memoryBudgets(hardware).ramPool;
          expect(fit).toMatchObject({ level: shared.level, basis: 'size', context });
          expect(fit.detail).toContain(`about ${formatMemory(shared.needBytes)} before`);
          if (shared.level === 'too-large' && shared.needBytes > machine)
            expect(fit.detail).toContain(`the ${formatMemory(machine)} this computer can hold for a model`);
          else expect(fit.detail).toContain(`the ${formatMemory(usable)} `);
          expect(fit.detail.includes('Close other apps')).toBe(shared.level === 'tight');
        }
    expect(estimateFit).not.toHaveBeenCalled();
  });

  const sized = (overrides: Partial<SizeFit>): SizeFit => ({
    level: 'fits',
    needBytes: 3.5 * GIB,
    budgetBytes: 12 * GIB,
    offloadBytes: 0,
    cpuOnly: false,
    context: 16384,
    ...overrides,
  });

  // gpu(12, 32) keeps a 2 GiB margin, so 10 GiB of the 12 GiB budget is the model's.
  it.each([
    ['fits', ', of the 10 GiB', sized({})],
    ['tight', ', close to the 10 GiB', sized({ level: 'tight' })],
    ['tight', 'part of it runs from system RAM', sized({ level: 'tight', offloadBytes: GIB })],
    ['too-large', ', more than the 10 GiB of GPU memory', sized({ level: 'too-large', offloadBytes: GIB })],
  ])('words a %s verdict with "%s"', (level, phrase, verdict) => {
    vi.mocked(estimateFitFromSize).mockReturnValue(verdict);
    const fit = fitFromSize(3 * GIB, gpu(12, 32), 16384);
    expect(fit).toMatchObject({ level, basis: 'size', context: 16384 });
    expect(fit.detail).toContain('Rough estimate from the file size: about 3.5 GiB');
    expect(fit.detail).toContain(phrase);
    expect(fit.detail).not.toContain('No GPU memory');
  });

  it('notes the CPU assumption when no GPU memory was detected', () => {
    vi.mocked(estimateFitFromSize).mockReturnValue(sized({ cpuOnly: true }));
    expect(fitFromSize(3 * GIB, cpu(16), 16384).detail).toContain('No GPU memory was detected');
  });

  it('is tight when the spill fits in system RAM, and will not fit past it', () => {
    // gpu(8, 32): 8 GiB of VRAM, a 2 GiB margin and about 22.4 GiB of RAM to spill into.
    const offload = fitFromSize(7 * GIB, gpu(8, 32), 16384);
    expect(offload.level).toBe('tight');
    expect(offload.detail).toContain('system RAM');
    expect(fitFromSize(30 * GIB, gpu(8, 32), 16384).level).toBe('too-large');
  });

  it('says the context is an upper bound when the model limit is unknown', () => {
    expect(fitFromSize(3 * GIB, cpu(16), 16384).detail).not.toContain('up to');
    expect(fitFromSize(3 * GIB, cpu(16), 16384, { limitKnown: false }).detail).toContain('up to 16K');
  });
});

// Curated builds loaded by Ollama 0.40.13 on an M4 MacBook Pro with 16 GB; the estimator is real here.
describe('on a 16 GB unified-memory Mac', () => {
  const MAC16: HardwareProfile = {
    platform: 'darwin',
    arch: 'arm64',
    memoryKind: 'unified',
    totalMemoryBytes: 16 * GIB,
    gpuMemoryBytes: null,
    gpuName: 'Apple M4',
    gpuCount: 1,
    gpuVendor: 'apple',
    chip: 'Apple M4',
    diskFreeBytes: null,
    confidence: 'high',
  };
  const GEMMA4_12B: ModelArch = {
    contextMax: 262144,
    blockCount: 48,
    headCount: 16,
    embeddingLength: 3840,
    activeFeedForwardLength: 15360,
    full: { layers: 8, kvHeads: 1, keyLength: 512, valueLength: 512 },
    swa: { layers: 40, kvHeads: 8, keyLength: 256, valueLength: 256, window: 1024 },
    mtpLayers: 0,
  };
  const QWEN38_27B: ModelArch = {
    contextMax: 262144,
    blockCount: 64,
    headCount: 24,
    embeddingLength: 5120,
    activeFeedForwardLength: 17408,
    full: { layers: 16, kvHeads: 4, keyLength: 256, valueLength: 256 },
    recurrent: { layers: 48, stateBytesPerSeq: 156_893_184, kind: 'gated-delta-net' },
    mtpLayers: 0,
  };
  const IQ2_XS = { weights: 8_422_841_472, projector: 931_146_528 };
  const shown = (detail: string) => [...detail.matchAll(/(\d+(?:\.\d+)?) GiB/g)].map(m => Number(m[1]));
  const requested = (arch: ModelArch, weightsBytes: number, context: number, mmprojBytes = 0) =>
    actualCommon.estimateFit({
      model: { arch, weightsBytes, mmprojBytes },
      hardware: MAC16,
      mode: 'chat',
      runtime: { kind: 'ollama', flashAttn: 'auto', slots: 1, draftMax: 0 },
      context,
    }).requested!;

  beforeEach(() => {
    vi.mocked(estimateFit).mockImplementation(actualCommon.estimateFit);
  });

  it('rates Qwen3.8 27B IQ2_XS at 16K as tight with part in system RAM, not as will not fit', () => {
    const fit = fitFromArch(QWEN38_27B, IQ2_XS.weights, MAC16, 16384, { mmprojBytes: IQ2_XS.projector });
    expect(fit.level).toBe('tight');
    expect(fit.detail).toContain('only with part of it in system RAM');
    expect(fit.detail).toContain('Close other apps first, or this computer may slow down.');
    const plan = requested(QWEN38_27B, IQ2_XS.weights, 16384, IQ2_XS.projector);
    expect(shown(fit.detail)).toEqual([Number(formatMemory(plan.memory.totalBytes).split(' ')[0])]);
    // Past the 10.6 GiB the GPU part allows, within the 12 GiB this Mac can hold with its OS reserve.
    expect(plan.memory.totalBytes + plan.memory.marginBytes).toBeGreaterThan(plan.memory.budgetBytes);
    expect(plan.memory.totalBytes + plan.memory.marginBytes).toBeLessThanOrEqual(12 * GIB);
  });

  it('shows Gemma 4 12B at 64K against the memory the verdict counts', () => {
    // The library blob holds the 167 MiB projector; /api/ps showed 7.3 GiB without it or the 1 GiB full-attention cache.
    const fit = fitFromArch(GEMMA4_12B, 7_151_003_754, MAC16, 65536);
    const plan = requested(GEMMA4_12B, 7_151_003_754, 65536);
    expect(plan.memory.totalBytes).toBeGreaterThanOrEqual((7.3 + 1 + 0.16) * GIB);
    expect(plan.memory.totalBytes).toBeLessThanOrEqual((7.3 + 1 + 0.16) * GIB * 1.05);
    const [need, usable] = shown(fit.detail);
    expect(fit.level).not.toBe('too-large');
    expect(need).toBeLessThanOrEqual(usable);
    expect(usable).toBe(9.6);
  });

  it('says how much this Mac can hold when a model cannot load at all, and needs more than that', () => {
    const fit = fitFromArch(QWEN38_27B, 17_741_872_154, MAC16, 16384);
    expect(fit.level).toBe('too-large');
    const [need, limit] = shown(fit.detail);
    expect(fit.detail).toContain('this computer can hold for a model');
    expect(limit).toBe(11);
    expect(need).toBeGreaterThan(limit);
    expect(fit.detail).not.toContain('Close other apps');
  });
});

describe('machineView', () => {
  it('passes on only what the screen shows', () => {
    expect(machineView(gpu(24, 64))).toEqual({
      memoryKind: 'discrete',
      totalMemoryBytes: 64 * GIB,
      gpuMemoryBytes: 24 * GIB,
      gpuName: 'NVIDIA GeForce RTX 4090',
      confidence: 'high',
    });
  });
});
