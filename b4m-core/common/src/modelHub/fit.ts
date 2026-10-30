import { RECURRENT_KINDS, type HubRuntime, type KvCacheType, type ModelArch } from '../schemas/modelHub';

/** Source of truth for the machine description; `@bike4mind/local-models` probes the same fields. */
export interface HardwareProfile {
  platform: string;
  /** The hardware's architecture: `arm64` for an x64 process translated by Rosetta. */
  arch: string;
  memoryKind: 'unified' | 'discrete' | 'cpu';
  /** RAM the OS sees; a firmware VRAM carve-out is not part of it. */
  totalMemoryBytes: number;
  /**
   * Summed across one vendor's GPUs. On AMD unified memory, what ROCm can allocate; null on Apple and NVIDIA unified
   * memory, where the GPU shares `totalMemoryBytes`, or when unknown.
   */
  gpuMemoryBytes: number | null;
  gpuName: string | null;
  gpuCount: number;
  /** Vendor of the GPUs behind `gpuMemoryBytes`; null without a usable GPU, absent when not probed. */
  gpuVendor?: 'nvidia' | 'amd' | 'intel' | 'apple' | null;
  chip: string | null;
  diskFreeBytes: number | null;
  /** 'low' when a usable GPU's memory is unknown or the GPUs could not be listed; `cpu` with 'high' has no usable GPU. */
  confidence: 'high' | 'low';
  /** Apple: `recommendedMaxWorkingSetSize` from a llama-server load log, or a non-zero `iogpu.wired_limit_mb`. */
  gpuWorkingSetBytes?: number | null;
}

export type FitMode = 'chat' | 'code' | 'embeddings';
export type FitVerdict = 'fast' | 'tight' | 'slow' | 'too-large';
export type FitReason =
  | 'fits'
  | 'kv-quantized'
  | 'reduced-context'
  | 'expert-offload'
  | 'layer-offload'
  | 'below-floor'
  | 'cpu-only'
  | 'exceeds-memory';
export type FitPlacement = 'gpu' | 'expert-offload' | 'layer-offload' | 'cpu';

export interface KvPair {
  k: KvCacheType;
  v: KvCacheType;
}

export const CONTEXT_PRESETS = [8192, 16384, 32768, 65536, 131072, 262144] as const;

export const MODE_CONTEXT_TARGETS: Record<Exclude<FitMode, 'embeddings'>, number> = { chat: 65536, code: 262144 };
export const MODE_CONTEXT_FLOORS: Record<Exclude<FitMode, 'embeddings'>, number> = { chat: 32768, code: 65536 };
export const EMBEDDINGS_CONTEXT = 8192;

// ggml block sizes: q8_0 stores 32 values in 34 bytes, q4_0 in 18.
export const KV_BYTES_PER_ELEMENT: Record<KvCacheType, number> = { f16: 2, q8_0: 1.0625, q4_0: 0.5625 };

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const FIT_CONSTANTS = {
  // Kept free per device: llama-server's 1 GiB --fit-target on a GPU, plus 1 GiB on discrete for the CUDA context,
  // the display and other GPU clients (unmeasured); on a CPU, runner memory outside its buffers (38 MiB measured).
  marginBytes: { cpu: 256 * MIB, unified: GIB, discrete: 2 * GIB },
  // Embedding widths per token that bound the measured Mamba2 and gated delta net loads.
  recurrentActivationWidths: 20,
  // Other recurrent kinds keep the flat figure used before measuring; MiniMax's ub x ub decay matrices fit under it.
  uncalibratedRecurrentBytesPerToken: 2 * MIB,
  // n_embd assumed for split inputs when the arch has none; at or above current families.
  assumedEmbeddingLength: 16384,
  // llama.cpp pads every KV cache to a multiple of 256 cells.
  kvCellPadding: 256,
  unifiedLargeMinBytes: 36 * GIB,
  unifiedLargeFraction: 0.75,
  unifiedSmallFraction: 0.66,
  // Tuned to the SELF_HOST.md RAM tiers, so partly circular until measured offload runs replace it.
  discreteOffloadRamFraction: 0.7,
  cpuFraction: 0.75,
  // Query heads assumed for flash attention off when the arch has no headCount; at or above current families.
  faOffAssumedHeads: 128,
} as const;

export interface FitModel {
  arch: ModelArch;
  /** Weight files as loaded; an Ollama library layer already includes its projector. */
  weightsBytes: number;
  mmprojBytes?: number;
  draftBytes?: number;
  /** From the build's tensorStats; enables expert offload on llama-server. */
  expertBytesPerLayer?: number;
}

export interface FitRuntime {
  kind: HubRuntime;
  /** llama-server preset KV; for Ollama the daemon-wide OLLAMA_KV_CACHE_TYPE, which the hub cannot set per model. */
  kv?: 'auto' | KvPair;
  /** 'auto' is planned as on for compute; Ollama is 'off' when OLLAMA_FLASH_ATTENTION disables it. */
  flashAttn?: 'auto' | 'on' | 'off';
  /** KV types a passing smoke loaded under flash attention 'auto'; the 'auto' KV search offers only these. */
  verifiedKv?: KvCacheType[];
  /** Offer q4_0 in the 'auto' KV search; only when the user picked it. */
  allowQ4Kv?: boolean;
  /** llama-server preset slots, or Ollama numParallel. */
  slots?: number;
  /** Defaults to 512 on llama-server and to Ollama's context-scaled choice on Ollama. */
  ubatch?: number;
  /** llama-server --n-cpu-moe: 'auto' searches the minimum; a number fixes it. Ollama never offloads experts. */
  nCpuMoe?: 'auto' | number;
  /** Draft tokens per step when speculative decoding is on; recurrent models keep one state snapshot per token. */
  draftMax?: number;
}

export interface FitInput {
  model: FitModel;
  hardware: HardwareProfile;
  mode: FitMode;
  runtime: FitRuntime;
  /** A preset's ctxCap; lowers the target. */
  contextCap?: number;
  /** A context the user picked; reported in `requested`, while the verdict stays relative to the target. */
  context?: number;
}

export interface FitMemory {
  /** Weights resident on the GPU, or in RAM on a CPU-only placement. */
  weightsBytes: number;
  /** Weights moved to system RAM by expert or layer offload. */
  offloadedBytes: number;
  mmprojBytes: number;
  draftBytes: number;
  kvBytes: number;
  recurrentBytes: number;
  computeBytes: number;
  /** Everything above, wherever it is placed: what the runtime allocates. */
  totalBytes: number;
  /** Headroom kept free on top of `totalBytes`; a placement fits when both together stay within the budget. */
  marginBytes: number;
  budgetBytes: number;
  ramPoolBytes: number;
}

export interface FitPlan {
  context: number;
  kv: KvPair;
  placement: FitPlacement;
  /** The --n-cpu-moe to pass, including a preset's fixed value; 0 passes none. */
  nCpuMoe: number;
  ubatch: number;
  memory: FitMemory;
}

export interface FitResult extends FitPlan {
  verdict: FitVerdict;
  reason: FitReason;
  target: number;
  floor: number;
  requested?: FitPlan & { fits: boolean };
}

const F16: KvPair = { k: 'f16', v: 'f16' };
const Q8: KvPair = { k: 'q8_0', v: 'q8_0' };
const Q4: KvPair = { k: 'q4_0', v: 'q4_0' };

const padCells = (n: number) => Math.ceil(n / FIT_CONSTANTS.kvCellPadding) * FIT_CONSTANTS.kvCellPadding;

/** Ollama 0.40.11's -b/-ub for a generation load, from its context across all slots (server/sched.go). */
export function ollamaUbatch(context: number, slots = 1): number {
  const total = context * slots;
  if (total > 32768) return 2048;
  return total > 4096 ? 1024 : 512;
}

/** Ollama's library is CUDA; a profile without a vendor counts every discrete GPU, as before vendors were probed. */
const onCuda = (hw: HardwareProfile) =>
  hw.gpuVendor === undefined ? hw.memoryKind === 'discrete' : hw.gpuVendor === 'nvidia';

/**
 * Ollama's GPU batch step-down and CUDA flash-attention-off rule (server/sched.go). The budget stands in for live free
 * memory, held to the RAM the OS sees on unified memory as Ollama holds an integrated GPU to free RAM; a mismatch
 * shifts one batch step only where Ollama's prediction leaves at least 20% free.
 */
function ollamaGpuUbatch(
  model: FitModel,
  hw: HardwareProfile,
  budget: number,
  context: number,
  slots: number,
  faOff: boolean
): number {
  const total = context * slots;
  if (faOff && onCuda(hw)) return total > 4096 && budget <= 8 * GIB ? 256 : 512;
  const { arch } = model;
  const kvHeads = arch.recurrent ? 1 : Math.min(arch.full.kvHeads, arch.swa?.kvHeads ?? Infinity);
  const headDim = arch.embeddingLength && arch.headCount ? arch.embeddingLength / arch.headCount : arch.full.keyLength;
  const predicted = model.weightsBytes + 2 * arch.blockCount * kvHeads * headDim * total * 2;
  const available =
    hw.memoryKind === 'unified' && hw.totalMemoryBytes > 0 ? Math.min(budget, hw.totalMemoryBytes) : budget;
  const threshold = available * 0.8;
  const fits = (batch: number) => {
    const extra = batch >= 2048 ? 2 * GIB : batch >= 1024 ? 768 * MIB : 0;
    const headroom = batch >= 2048 ? 0.6 : batch >= 1024 ? 0.75 : 1;
    return predicted <= threshold && predicted <= available * headroom && extra <= threshold - predicted;
  };
  let batch = ollamaUbatch(context, slots);
  while (batch > 512 && !fits(batch)) batch = batch > 1024 ? 1024 : 512;
  return batch;
}

/**
 * KV cache bytes for one runtime context. `context` is per slot; SWA layers keep window + ubatch cells per slot,
 * as llama-server allocates with its default non-unified cache.
 */
export function kvCacheBytes(arch: ModelArch, context: number, kv: KvPair, slots = 1, ubatch = 512): number {
  if (arch.kvProbe) return arch.kvProbe.bytesPerToken * context * slots + arch.kvProbe.fixedBytes;
  const k = KV_BYTES_PER_ELEMENT[kv.k];
  const v = KV_BYTES_PER_ELEMENT[kv.v];
  const cells = padCells(context);
  const { full, swa, mla } = arch;
  // MTP layers share the main attention shape: MLA when the model has no full-attention layers.
  const mtpOnMla = mla && full.layers === 0;
  const fullLayers = full.layers + (mtpOnMla ? 0 : arch.mtpLayers);
  let perSlot = fullLayers * full.kvHeads * (full.keyLength * k + full.valueLength * v) * cells;
  if (swa) {
    const swaCells = Math.min(cells, padCells(swa.window + ubatch));
    perSlot += swa.layers * swa.kvHeads * (swa.keyLength * k + swa.valueLength * v) * swaCells;
  }
  if (mla) perSlot += (mla.layers + (mtpOnMla ? arch.mtpLayers : 0)) * (mla.kvLoraRank + mla.ropeDim) * k * cells;
  return Math.ceil(perSlot * slots);
}

/**
 * Compute buffer growth with flash attention off: the F32 KQ matrix plus an F32 mask, cells x ubatch x (heads + 1)
 * x 4 bytes. Measured exactly on llama-server b11889; with flash attention on the mask is F16 and there is no KQ.
 */
export function flashAttnOffBytes(context: number, ubatch: number, headCount: number): number {
  return padCells(context) * ubatch * 4 * (headCount + 1);
}

/**
 * F32 graph activations per ubatch token, measured on Ollama 0.40.11's CPU backend; without the widths, a bound
 * from the bytes per layer that holds at 2.4 bits per weight or more.
 */
export function activationBytesPerToken(model: FitModel): number {
  const { arch } = model;
  const extra = (arch.moe ? 2 * arch.moe.experts : 0) + 32;
  let bytes: number;
  if (arch.embeddingLength && arch.activeFeedForwardLength) {
    const ff = arch.activeFeedForwardLength;
    // MoE: the down projection writes used x n_embd while its input is still live.
    const ffn = arch.moe ? Math.max(3 * ff, ff + arch.moe.used * arch.embeddingLength) : 3 * ff;
    // Absorbed MLA holds the latent query, its roped part and their concat per head; past the FFN at 128 heads.
    const mla = arch.mla && arch.headCount ? arch.headCount * 2 * (arch.mla.kvLoraRank + arch.mla.ropeDim) : 0;
    const transformer = Math.max(ffn, mla) + 5 * arch.embeddingLength + extra;
    const recurrent = arch.recurrent ? FIT_CONSTANTS.recurrentActivationWidths * arch.embeddingLength : 0;
    bytes = 4 * Math.max(transformer, recurrent);
  } else {
    let active = model.weightsBytes;
    if (arch.moe) {
      const idle = 1 - arch.moe.used / arch.moe.experts;
      const expertBytes = arch.moe.moeLayers * (model.expertBytesPerLayer ?? 0);
      // Tensor stats describe the hub build; a smaller library blob can hold less than they claim, so ignore them then.
      active = expertBytes && expertBytes < active ? active - expertBytes * idle : active * Math.max(1 - idle, 0.25);
    }
    bytes = Math.ceil((arch.recurrent ? 60 : 44) * Math.sqrt(active / arch.blockCount)) + 4 * extra;
  }
  const calibrated = (RECURRENT_KINDS as readonly string[]).includes(arch.recurrent?.kind ?? '');
  if (arch.recurrent && !calibrated) return Math.max(bytes, FIT_CONSTANTS.uncalibratedRecurrentBytesPerToken);
  return bytes;
}

/** F16 KQ masks under flash attention: one per attention kind, cache cells x ubatch. */
export function attentionMaskBytes(arch: ModelArch, context: number, ubatch: number): number {
  const cells = padCells(context);
  const full = arch.full.layers > 0 || arch.mla || arch.kvProbe ? cells : 0;
  const swa = arch.swa ? Math.min(cells, padCells(arch.swa.window + ubatch)) : 0;
  return (full + swa) * ubatch * 2;
}

/**
 * Metal reserves an F16 copy of one layer's K and V across all slots inside every flash attention op; CUDA converts
 * a quantized cache the same way in its pool. From llama.cpp source, not measured.
 */
function kvScratchBytes(arch: ModelArch, context: number, ubatch: number, slots: number): number {
  const cells = padCells(context);
  if (arch.kvProbe) return Math.ceil((arch.kvProbe.bytesPerToken * cells * slots) / arch.blockCount);
  const { full, swa, mla } = arch;
  const fullBytes = full.layers > 0 ? cells * full.kvHeads * (full.keyLength + full.valueLength) : 0;
  const swaCells = swa ? Math.min(cells, padCells(swa.window + ubatch)) : 0;
  const swaBytes = swa ? swaCells * swa.kvHeads * (swa.keyLength + swa.valueLength) : 0;
  const mlaBytes = mla ? cells * (mla.kvLoraRank + mla.ropeDim) : 0;
  return Math.max(fullBytes, swaBytes, mlaBytes) * 2 * slots;
}

export interface ComputeBufferOptions {
  memoryKind: HardwareProfile['memoryKind'];
  flashAttnOff?: boolean;
  slots?: number;
  /** GPUs sharing a layer split; each holds its own compute buffer. */
  devices?: number;
}

/**
 * The runtime's compute buffers at this ubatch. CPU figures are measured; GPU additions (host mask copy on unified
 * memory, KV scratch, pipeline input copies) come from llama.cpp source.
 */
export function computeBufferBytes(
  model: FitModel,
  context: number,
  ubatch: number,
  options: ComputeBufferOptions
): number {
  const { arch } = model;
  const devices = options.devices ?? 1;
  const masks = attentionMaskBytes(arch, context, ubatch);
  const attention = options.flashAttnOff
    ? flashAttnOffBytes(context, ubatch, arch.headCount ?? FIT_CONSTANTS.faOffAssumedHeads)
    : masks;
  const scratch = options.memoryKind === 'cpu' ? 0 : kvScratchBytes(arch, context, ubatch, options.slots ?? 1);
  let bytes = devices * (ubatch * activationBytesPerToken(model) + attention + scratch);
  // Flash attention off makes the mask F32.
  const maskCopy = options.flashAttnOff ? 2 * masks : masks;
  if (options.memoryKind === 'unified') bytes += maskCopy;
  if (devices > 1) {
    // Pipeline parallelism keeps 4 copies (GGML_SCHED_MAX_COPIES) of the masks and the layer input on every device.
    const input = ubatch * 4 * (arch.embeddingLength ?? FIT_CONSTANTS.assumedEmbeddingLength);
    bytes += devices * (3 * maskCopy + 4 * input);
  }
  return bytes;
}

/** GPUs a layer split spans; HardwareProfile only sums their VRAM. */
function splitDevices(hw: HardwareProfile): number {
  return hw.memoryKind === 'discrete' && hw.gpuMemoryBytes ? Math.max(1, hw.gpuCount) : 1;
}

/** The headroom a plan keeps free on this machine; see FIT_CONSTANTS.marginBytes. */
export function fitMarginBytes(hw: HardwareProfile): number {
  const { cpuOnly } = memoryBudgets(hw);
  if (cpuOnly) return FIT_CONSTANTS.marginBytes.cpu;
  if (hw.memoryKind === 'unified') return FIT_CONSTANTS.marginBytes.unified;
  // Without per-device VRAM, several GPUs are planned as an even split, each keeping its own margin.
  return FIT_CONSTANTS.marginBytes.discrete * splitDevices(hw);
}

/** Whether models run from system RAM on this machine: no GPU, or a discrete GPU of unknown memory. */
export function isCpuOnly(hw: HardwareProfile): boolean {
  return memoryBudgets(hw).cpuOnly;
}

export function contextTarget(arch: ModelArch, mode: FitMode, contextCap?: number): number {
  const modeTarget = mode === 'embeddings' ? EMBEDDINGS_CONTEXT : MODE_CONTEXT_TARGETS[mode];
  return Math.min(modeTarget, arch.contextMax, contextCap ?? Infinity);
}

export function contextFloor(arch: ModelArch, mode: FitMode, contextCap?: number): number {
  const target = contextTarget(arch, mode, contextCap);
  return mode === 'embeddings' ? target : Math.min(MODE_CONTEXT_FLOORS[mode], target);
}

export interface MemoryBudgets {
  /** Bytes a model may use on the GPU, or in RAM on a CPU-only machine. */
  gpu: number;
  /** System RAM layer or expert offload may spill into on a discrete GPU; 0 elsewhere. */
  ramPool: number;
  cpuOnly: boolean;
}

export function memoryBudgets(hw: HardwareProfile): MemoryBudgets {
  if (hw.memoryKind === 'unified') {
    // AMD reports what ROCm can allocate, which a firmware carve-out keeps outside totalMemoryBytes.
    if (hw.gpuMemoryBytes) return { gpu: hw.gpuMemoryBytes, ramPool: 0, cpuOnly: false };
    const fraction =
      hw.totalMemoryBytes >= FIT_CONSTANTS.unifiedLargeMinBytes
        ? FIT_CONSTANTS.unifiedLargeFraction
        : FIT_CONSTANTS.unifiedSmallFraction;
    return { gpu: hw.gpuWorkingSetBytes || hw.totalMemoryBytes * fraction, ramPool: 0, cpuOnly: false };
  }
  if (hw.memoryKind === 'discrete' && hw.gpuMemoryBytes) {
    return {
      gpu: hw.gpuMemoryBytes,
      ramPool: hw.totalMemoryBytes * FIT_CONSTANTS.discreteOffloadRamFraction,
      cpuOnly: false,
    };
  }
  // A discrete box whose VRAM is unknown is planned as CPU-only.
  return { gpu: hw.totalMemoryBytes * FIT_CONSTANTS.cpuFraction, ramPool: 0, cpuOnly: true };
}

function kvCandidates(runtime: FitRuntime, arch: ModelArch): KvPair[] {
  const fixed = runtime.kv && runtime.kv !== 'auto' ? runtime.kv : undefined;
  const faOff = runtime.flashAttn === 'off';
  // Ollama quietly keeps an f16 cache when flash attention is off.
  if (runtime.kind === 'ollama') return [fixed && !faOff ? fixed : F16];
  // A fixed quantized V needs flash attention 'on'; under 'auto' a backend without it rejects the cache at load.
  if (fixed) return [fixed.v === 'f16' || runtime.flashAttn === 'on' ? fixed : F16];
  if (faOff || arch.kvProbe) return [F16];
  const offered = (pair: KvPair) => runtime.flashAttn === 'on' || !!runtime.verifiedKv?.includes(pair.v);
  return [F16, ...(runtime.allowQ4Kv ? [Q8, Q4] : [Q8]).filter(offered)];
}

class Planner {
  private readonly budgets: MemoryBudgets;
  private readonly kvs: KvPair[];
  private readonly slots: number;
  private readonly moeLayers: number;
  /** A preset's fixed --n-cpu-moe, clamped to the MoE layers; undefined when the search picks it. */
  private readonly fixedMoe: number | undefined;
  private readonly margin: number;
  private readonly ollamaEmbedding: boolean;

  constructor(private readonly input: FitInput) {
    this.budgets = memoryBudgets(input.hardware);
    this.margin = fitMarginBytes(input.hardware);
    this.kvs = kvCandidates(input.runtime, input.model.arch);
    this.ollamaEmbedding = input.runtime.kind === 'ollama' && input.mode === 'embeddings';
    // Ollama loads embedding models with one slot.
    this.slots = this.ollamaEmbedding ? 1 : (input.runtime.slots ?? 1);
    const { arch, expertBytesPerLayer } = input.model;
    const expertOffload = input.runtime.kind === 'llama-server' && expertBytesPerLayer && arch.moe;
    this.moeLayers = expertOffload && arch.moe ? arch.moe.moeLayers : 0;
    const fixed = input.runtime.nCpuMoe;
    this.fixedMoe = typeof fixed === 'number' ? Math.min(fixed, this.moeLayers) : undefined;
  }

  get preferredKv(): KvPair {
    return this.kvs[0];
  }

  get cpuOnly(): boolean {
    return this.budgets.cpuOnly;
  }

  /** The plan as the runtime would load it at this context, for reporting when nothing fits. */
  unfit(context: number): FitPlan {
    if (this.budgets.cpuOnly) return this.plan(context, this.preferredKv, 'cpu');
    if (this.fixedMoe) return this.plan(context, this.preferredKv, 'expert-offload', this.fixedMoe);
    return this.plan(context, this.preferredKv, 'gpu');
  }

  private ubatch(context: number): number {
    const { model, runtime, hardware } = this.input;
    if (runtime.ubatch) return runtime.ubatch;
    if (runtime.kind !== 'ollama') return 512;
    // Embedding loads skip the generation rule: a 2048 batch capped at the context.
    if (this.ollamaEmbedding) return Math.min(2048, context);
    if (this.budgets.cpuOnly) return ollamaUbatch(context, this.slots);
    const faOff = runtime.flashAttn === 'off';
    return ollamaGpuUbatch(model, hardware, this.budgets.gpu, context, this.slots, faOff);
  }

  /**
   * ggml-backend.cpp runs a batch of 32+ tokens on CUDA or Metal even when the weight sits in a host buffer, copying
   * it into the compute buffer. Bounded at 2/3 of a layer, a fused gate_up tensor.
   */
  private hostWeightCopyBytes(placement: FitPlacement, nCpuMoe: number, ubatch: number): number {
    if (this.budgets.cpuOnly || ubatch < 32) return 0;
    const { model } = this.input;
    if (placement === 'expert-offload' && nCpuMoe > 0) return Math.ceil(((model.expertBytesPerLayer ?? 0) * 2) / 3);
    if (placement === 'layer-offload') return Math.ceil((model.weightsBytes * 2) / 3 / model.arch.blockCount);
    return 0;
  }

  plan(context: number, kv: KvPair, placement: FitPlacement, nCpuMoe = 0): FitPlan {
    const { model, runtime, hardware } = this.input;
    const ubatch = this.ubatch(context);
    const kvBytes = kvCacheBytes(model.arch, context, kv, this.slots, ubatch);
    const recurrentBytes = (model.arch.recurrent?.stateBytesPerSeq ?? 0) * this.slots * (1 + (runtime.draftMax ?? 0));
    const computeBytes =
      computeBufferBytes(model, context, ubatch, {
        memoryKind: this.budgets.cpuOnly ? 'cpu' : hardware.memoryKind,
        flashAttnOff: runtime.flashAttn === 'off',
        slots: this.slots,
        devices: splitDevices(hardware),
      }) + this.hostWeightCopyBytes(placement, nCpuMoe, ubatch);
    const mmprojBytes = model.mmprojBytes ?? 0;
    const draftBytes = model.draftBytes ?? 0;
    const totalBytes = model.weightsBytes + mmprojBytes + draftBytes + kvBytes + recurrentBytes + computeBytes;
    let offloadedBytes = 0;
    if (placement === 'expert-offload') offloadedBytes = nCpuMoe * (model.expertBytesPerLayer ?? 0);
    if (placement === 'layer-offload') offloadedBytes = Math.max(0, totalBytes + this.margin - this.budgets.gpu);
    return {
      context,
      kv,
      placement,
      nCpuMoe,
      ubatch,
      memory: {
        weightsBytes: model.weightsBytes - offloadedBytes,
        offloadedBytes,
        mmprojBytes,
        draftBytes,
        kvBytes,
        recurrentBytes,
        computeBytes,
        totalBytes,
        marginBytes: this.margin,
        budgetBytes: this.budgets.gpu,
        ramPoolBytes: this.budgets.ramPool,
      },
    };
  }

  /** All-GPU, or all-RAM on a CPU-only machine: the first KV type that fits. */
  resident(context: number): FitPlan | null {
    // A preset that fixes --n-cpu-moe always offloads that many expert layers on a GPU.
    if (!this.budgets.cpuOnly && this.fixedMoe) return null;
    const placement = this.budgets.cpuOnly ? 'cpu' : 'gpu';
    for (const kv of this.kvs) {
      const p = this.plan(context, kv, placement);
      if (p.memory.totalBytes + this.margin <= this.budgets.gpu) return p;
    }
    return null;
  }

  private fitsGpu(p: FitPlan): boolean {
    return p.memory.totalBytes - p.memory.offloadedBytes + this.margin <= this.budgets.gpu;
  }

  /** Binary search: GPU bytes only fall as more expert layers move to RAM. */
  private fewestExpertLayers(context: number, kv: KvPair): number | null {
    let lo = 1;
    let hi = this.moeLayers;
    if (!this.fitsGpu(this.plan(context, kv, 'expert-offload', hi))) return null;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.fitsGpu(this.plan(context, kv, 'expert-offload', mid))) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** The fewest expert layers moved to RAM, across KV types, that fit both the GPU and the RAM pool. */
  expertOffload(context: number): FitPlan | null {
    if (this.budgets.cpuOnly || this.moeLayers === 0 || this.fixedMoe === 0) return null;
    let best: FitPlan | null = null;
    for (const kv of this.kvs) {
      const n = this.fixedMoe ?? this.fewestExpertLayers(context, kv);
      if (n === null || (best && n >= best.nCpuMoe)) continue;
      const p = this.plan(context, kv, 'expert-offload', n);
      // On unified memory the offloaded experts stay in the same pool.
      const fits =
        this.input.hardware.memoryKind === 'unified'
          ? p.memory.totalBytes + this.margin <= this.budgets.gpu
          : this.fitsGpu(p) && p.memory.offloadedBytes <= this.budgets.ramPool;
      if (fits) best = p;
    }
    return best;
  }

  /** Dense layer split between GPU and RAM; only weights can move. */
  layerOffload(context: number): FitPlan | null {
    if (this.budgets.cpuOnly || this.budgets.ramPool === 0 || this.fixedMoe) return null;
    for (const kv of this.kvs) {
      const p = this.plan(context, kv, 'layer-offload');
      const { offloadedBytes } = p.memory;
      if (offloadedBytes <= this.input.model.weightsBytes && offloadedBytes <= this.budgets.ramPool) return p;
    }
    return null;
  }

  best(context: number): FitPlan | null {
    return this.resident(context) ?? this.expertOffload(context) ?? this.layerOffload(context);
  }
}

function candidateContexts(target: number, mode: FitMode): number[] {
  if (mode === 'embeddings') return [target];
  return [target, ...CONTEXT_PRESETS.filter(p => p < target).reverse()];
}

function validateContext(context: number, arch: ModelArch): void {
  if (!Number.isInteger(context) || context < 1 || context > arch.contextMax) {
    throw new RangeError(`context must be an integer from 1 to ${arch.contextMax}, got ${context}`);
  }
}

/**
 * Whether a model fits the machine and at what context, KV type and placement. Prefers, in order: all-GPU at the
 * target (fast); all-GPU at a reduced context no lower than the mode floor, then expert offload at or above the
 * floor (tight); then the largest context with any placement (slow). Pure and deterministic.
 */
export function estimateFit(input: FitInput): FitResult {
  const { arch } = input.model;
  if (input.context !== undefined) validateContext(input.context, arch);
  const target = contextTarget(arch, input.mode, input.contextCap);
  const floor = contextFloor(arch, input.mode, input.contextCap);
  const planner = new Planner(input);
  const contexts = candidateContexts(target, input.mode);
  const result = search(planner, contexts, target, floor);
  if (input.context === undefined) return result;

  const atRequested = planner.best(input.context);
  const requested = atRequested ? { ...atRequested, fits: true } : { ...planner.unfit(input.context), fits: false };
  return { ...result, requested };
}

function search(planner: Planner, contexts: number[], target: number, floor: number): FitResult {
  const frame = { target, floor };
  if (planner.cpuOnly) {
    for (const context of contexts) {
      const p = planner.resident(context);
      if (p) return { ...p, ...frame, verdict: 'slow', reason: 'cpu-only' };
    }
  } else {
    const atTarget = planner.resident(target);
    if (atTarget) {
      const reason = atTarget.kv === planner.preferredKv ? 'fits' : 'kv-quantized';
      return { ...atTarget, ...frame, verdict: 'fast', reason };
    }
    const aboveFloor = contexts.filter(c => c >= floor && c < target);
    for (const context of aboveFloor) {
      const p = planner.resident(context);
      if (p) return { ...p, ...frame, verdict: 'tight', reason: 'reduced-context' };
    }
    for (const context of contexts.filter(c => c >= floor)) {
      const p = planner.expertOffload(context);
      if (p) return { ...p, ...frame, verdict: 'tight', reason: 'expert-offload' };
    }
    for (const context of contexts) {
      const p = planner.best(context);
      if (!p) continue;
      const reason = p.placement === 'gpu' ? 'below-floor' : p.placement;
      return { ...p, ...frame, verdict: 'slow', reason: reason === 'cpu' ? 'cpu-only' : reason };
    }
  }
  const smallest = contexts[contexts.length - 1];
  return {
    ...planner.unfit(smallest),
    ...frame,
    verdict: 'too-large',
    reason: 'exceeds-memory',
  };
}

/** The plan at the target and every preset below it, smallest first; `fits` is false where nothing fits. */
export function contextOptions(input: Omit<FitInput, 'context'>): Array<FitPlan & { fits: boolean }> {
  const { arch } = input.model;
  const planner = new Planner(input);
  const target = contextTarget(arch, input.mode, input.contextCap);
  return candidateContexts(target, input.mode)
    .reverse()
    .map(context => {
      const p = planner.best(context);
      return p ? { ...p, fits: true } : { ...planner.unfit(context), fits: false };
    });
}

// Ceiling on the num_ctx llm-adapters ollamaBackend.ts requests: advertised windows (262K on qwen3.5) outgrow a
// dev box's KV cache. Override with OLLAMA_MAX_NUM_CTX.
export const DEFAULT_MAX_NUM_CTX = 32768;

/** The num_ctx the Ollama backend requests for a model reporting a `reported`-token window. */
export function ollamaNumCtx(reported: number): number {
  const configuredCap = Number(process.env.OLLAMA_MAX_NUM_CTX);
  const cap = Number.isFinite(configuredCap) && configuredCap > 0 ? configuredCap : DEFAULT_MAX_NUM_CTX;
  return Math.min(reported, cap);
}

export type SizeFitLevel = 'fits' | 'tight' | 'too-large';

export interface SizeFit {
  level: SizeFitLevel;
  /** The file plus the compute buffers at `context`; the KV cache is not in it, since the size gives no shape. */
  needBytes: number;
  budgetBytes: number;
  /** Bytes past the budget, margin included; 0 when it all fits. */
  offloadBytes: number;
  cpuOnly: boolean;
  context: number;
}

// A size-only estimate fits only when this much of the budget is left for context memory.
const SIZE_HEADROOM = 0.8;
// computeBufferBytes bounds compute from the bytes per layer; current GGUFs run 24 to 64 layers, and fewer is larger.
const SIZE_ONLY_LAYERS = 24;

/** One token-wide attention layer: compute gets the context's mask, and the cache it cannot size stays out. */
const sizeOnlyArch = (context: number): ModelArch => ({
  contextMax: context,
  blockCount: SIZE_ONLY_LAYERS,
  full: { layers: 1, kvHeads: 1, keyLength: 1, valueLength: 1 },
  mtpLayers: 0,
});

/**
 * A rough Ollama verdict from a download's size alone, for a model whose layer shapes are unknown: the compute
 * and margin terms on top of the file, with headroom for the context memory it cannot size.
 */
export function estimateFitFromSize(sizeBytes: number, hardware: HardwareProfile, context: number): SizeFit {
  const tokens = Math.max(1, Math.round(context));
  const { gpu: budgetBytes, ramPool, cpuOnly } = memoryBudgets(hardware);
  const computeBytes = computeBufferBytes(
    { arch: sizeOnlyArch(tokens), weightsBytes: sizeBytes },
    tokens,
    ollamaUbatch(tokens),
    { memoryKind: cpuOnly ? 'cpu' : hardware.memoryKind }
  );
  const needBytes = sizeBytes + computeBytes;
  const plannedBytes = needBytes + fitMarginBytes(hardware);
  const over = plannedBytes - budgetBytes;
  const base = { needBytes, budgetBytes, offloadBytes: Math.max(0, over), cpuOnly, context: tokens };
  // Only weights move to RAM in a layer split.
  if (over > 0) {
    const level = cpuOnly || over > ramPool || over > sizeBytes ? 'too-large' : 'tight';
    return { ...base, level };
  }
  return { ...base, level: plannedBytes > budgetBytes * SIZE_HEADROOM ? 'tight' : 'fits' };
}
