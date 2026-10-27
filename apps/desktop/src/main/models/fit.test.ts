import {
  computeBufferBytes,
  estimateFit,
  type FitPlacement,
  type FitResult,
  type HardwareProfile,
  type ModelArch,
} from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fitFromArch, fitFromSize, machineView } from './fit';

// The estimator's numbers belong to @bike4mind/common; these tests pin only how a plan becomes a badge.
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  estimateFit: vi.fn(),
  computeBufferBytes: vi.fn(),
}));

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

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
  vi.mocked(computeBufferBytes)
    .mockReset()
    .mockReturnValue(GIB / 2);
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

  it('fits, names the context, and shows what the runtime allocates without the margin', () => {
    stub(5);
    const fit = fitFromArch(DENSE, 4 * GIB, cpu(16), 16384);
    expect(fit).toMatchObject({ level: 'fits', basis: 'arch', context: 16384 });
    for (const figure of ['16K', 'about 5 GiB', '12 GiB', 'runs on the CPU']) expect(fit.detail).toContain(figure);
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
  it("adds the estimator's compute buffer for the context's ubatch, with no cache to size", () => {
    fitFromSize(3 * GIB, cpu(16), 16384);
    const [model, context, ubatch, options] = vi.mocked(computeBufferBytes).mock.calls[0];
    expect(model.weightsBytes).toBe(3 * GIB);
    expect(model.arch.full.layers).toBe(1);
    expect(model.arch.recurrent).toBeUndefined();
    expect([context, ubatch, options.memoryKind]).toEqual([16384, 1024, 'cpu']);
    expect(estimateFit).not.toHaveBeenCalled();
  });

  it('sizes compute in the tens to hundreds of MiB for a small model', async () => {
    const actual = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
    vi.mocked(computeBufferBytes).mockImplementation(actual.computeBufferBytes);
    fitFromSize(500 * 1e6, cpu(16), 16384);
    const bytes = vi.mocked(computeBufferBytes).mock.results[0].value as number;
    expect(bytes).toBeGreaterThan(10 * MIB);
    expect(bytes).toBeLessThan(GIB);
  });

  // cpu(16): a 12 GiB budget and a 256 MiB margin; compute is stubbed at 0.5 GiB.
  it.each([
    [3, 'fits', 'about 3.5 GiB'],
    [9, 'tight', 'about 9.5 GiB'],
    [12, 'too-large', 'about 12.5 GiB'],
  ])('rates %d GiB of weights as %s on the CPU, keeping 20%% headroom for the context', (sizeGiB, level, figure) => {
    const fit = fitFromSize(sizeGiB * GIB, cpu(16), 16384);
    expect(fit).toMatchObject({ level, basis: 'size', context: 16384 });
    expect(fit.detail).toContain('file size');
    expect(fit.detail).toContain(figure);
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
