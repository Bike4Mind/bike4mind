import type { FitInput, FitPlan, FitResult, HardwareProfile, ModelArch } from '@bike4mind/common';

/**
 * estimateFit (b4m-core/common/src/modelHub/fit.ts) in round numbers: weights plus 2 GiB per 16K, resident
 * when that fits the GPU (or RAM without one), loading with offload when it fits both; it pins Desktop's choices.
 */
export const GIB = 1024 ** 3;
const STUB_TARGET_TOKENS = 65_536;
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

/** A CPU-only machine as the probe reports it once it can vouch for having no GPU. */
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

/** What the probe reports today on a machine without nvidia-smi: the RAM, and no claim about a GPU. */
export const lowConfidenceMachine = (gib: number): HardwareProfile => ({ ...cpuMachine(gib), confidence: 'low' });
