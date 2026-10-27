import type { FitInput, FitPlan, FitResult, HardwareProfile, ModelArch } from '@bike4mind/common';

/**
 * A stand-in for estimateFit (b4m-core/common/src/modelHub/fit.ts) with round numbers, so sizing
 * tests pin Desktop's choices and not the estimator's constants. Memory is the weights plus 128 KiB
 * a token (16K = 2 GiB, 32K = 4 GiB, 64K = 8 GiB); a model is resident when that fits the GPU, or RAM
 * without one, and loads with layers offloaded when it fits GPU and RAM together. The target is 64K.
 */
export const GIB = 1024 ** 3;
export const STUB_TARGET_TOKENS = 65_536;
const KV_BYTES_PER_TOKEN = 128 * 1024;

type StubPlan = Pick<FitPlan, 'context' | 'placement'> & { fits: boolean };

function planAt({ model, hardware }: FitInput, context: number): StubPlan {
  const total = model.weightsBytes + context * KV_BYTES_PER_TOKEN;
  const ram = hardware.totalMemoryBytes;
  if (hardware.memoryKind === 'discrete') {
    const gpu = hardware.gpuMemoryBytes ?? 0;
    if (total <= gpu) return { context, placement: 'gpu', fits: true };
    return { context, placement: 'layer-offload', fits: total <= gpu + ram };
  }
  return { context, placement: hardware.memoryKind === 'unified' ? 'gpu' : 'cpu', fits: total <= ram };
}

export function stubEstimateFit(input: FitInput): FitResult {
  const target = Math.min(STUB_TARGET_TOKENS, input.model.arch.contextMax);
  const result = { ...planAt(input, target), target };
  const requested = input.context === undefined ? undefined : planAt(input, input.context);
  // Only the fields Desktop's sizing reads.
  return { ...result, requested } as unknown as FitResult;
}

export const stubArch = (contextMax = 262_144): ModelArch => ({
  contextMax,
  blockCount: 32,
  headCount: 32,
  full: { layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 },
  mtpLayers: 0,
});

export const cpuMachine = (gib: number): HardwareProfile => ({
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: gib * GIB,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  chip: null,
  diskFreeBytes: null,
  confidence: 'high',
});

export const discreteMachine = (vramGib: number, ramGib: number): HardwareProfile => ({
  ...cpuMachine(ramGib),
  memoryKind: 'discrete',
  gpuMemoryBytes: vramGib * GIB,
  gpuName: 'GPU',
  gpuCount: 1,
});

export const unifiedMachine = (gib: number): HardwareProfile => ({
  ...cpuMachine(gib),
  platform: 'darwin',
  arch: 'arm64',
  memoryKind: 'unified',
  gpuCount: 1,
});

/** What the probe reports without nvidia-smi or a known GPU: the RAM, and no claim about a GPU. */
export const lowConfidenceMachine = (gib: number): HardwareProfile => ({ ...cpuMachine(gib), confidence: 'low' });
