import type { HubRuntime, KvCacheType, ModelArch } from '../schemas/modelHub';

/** Source of truth for the machine description; `@bike4mind/local-models` probes the same fields. */
export interface HardwareProfile {
  platform: string;
  /** The hardware's architecture: `arm64` for an x64 process translated by Rosetta. */
  arch: string;
  memoryKind: 'unified' | 'discrete' | 'cpu';
  totalMemoryBytes: number;
  /** Summed across GPUs; null on unified memory, where the GPU shares `totalMemoryBytes`, or when unknown. */
  gpuMemoryBytes: number | null;
  gpuName: string | null;
  gpuCount: number;
  chip: string | null;
  diskFreeBytes: number | null;
  /** 'low' when a GPU the probe cannot measure (AMD, Intel, unknown) may be present. */
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

const GIB = 1024 ** 3;

export const FIT_CONSTANTS = {
  // Linear scaling with ubatch is an assumption; llama-fit-params reserves logits for a full ubatch, which is
  // most of this on large-vocab models.
  computeBytesPerUbatch512: GIB,
  // llama-server's --fit-target default.
  marginBytes: GIB,
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
  marginBytes: number;
  /** Everything above, wherever it is placed. */
  totalBytes: number;
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

// Observed on Ollama 0.40.11 (CPU backend): it passes -ub 512 below 8k context, 1024 below 64k, 2048 above.
export function ollamaUbatch(context: number): number {
  if (context < 8192) return 512;
  return context < 65536 ? 1024 : 2048;
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

export function contextTarget(arch: ModelArch, mode: FitMode, contextCap?: number): number {
  const modeTarget = mode === 'embeddings' ? EMBEDDINGS_CONTEXT : MODE_CONTEXT_TARGETS[mode];
  return Math.min(modeTarget, arch.contextMax, contextCap ?? Infinity);
}

export function contextFloor(arch: ModelArch, mode: FitMode, contextCap?: number): number {
  const target = contextTarget(arch, mode, contextCap);
  return mode === 'embeddings' ? target : Math.min(MODE_CONTEXT_FLOORS[mode], target);
}

interface Budgets {
  gpu: number;
  ramPool: number;
  cpuOnly: boolean;
}

function memoryBudgets(hw: HardwareProfile): Budgets {
  if (hw.memoryKind === 'unified') {
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
  private readonly budgets: Budgets;
  private readonly kvs: KvPair[];
  private readonly slots: number;
  private readonly moeLayers: number;
  /** A preset's fixed --n-cpu-moe, clamped to the MoE layers; undefined when the search picks it. */
  private readonly fixedMoe: number | undefined;

  constructor(private readonly input: FitInput) {
    this.budgets = memoryBudgets(input.hardware);
    this.kvs = kvCandidates(input.runtime, input.model.arch);
    this.slots = input.runtime.slots ?? 1;
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

  plan(context: number, kv: KvPair, placement: FitPlacement, nCpuMoe = 0): FitPlan {
    const { model, runtime } = this.input;
    const ubatch = runtime.ubatch ?? (runtime.kind === 'ollama' ? ollamaUbatch(context) : 512);
    const kvBytes = kvCacheBytes(model.arch, context, kv, this.slots, ubatch);
    const recurrentBytes = (model.arch.recurrent?.stateBytesPerSeq ?? 0) * this.slots * (1 + (runtime.draftMax ?? 0));
    const heads = model.arch.headCount ?? FIT_CONSTANTS.faOffAssumedHeads;
    const computeBytes =
      Math.ceil((FIT_CONSTANTS.computeBytesPerUbatch512 * ubatch) / 512) +
      (runtime.flashAttn === 'off' ? flashAttnOffBytes(context, ubatch, heads) : 0);
    const mmprojBytes = model.mmprojBytes ?? 0;
    const draftBytes = model.draftBytes ?? 0;
    const totalBytes =
      model.weightsBytes +
      mmprojBytes +
      draftBytes +
      kvBytes +
      recurrentBytes +
      computeBytes +
      FIT_CONSTANTS.marginBytes;
    let offloadedBytes = 0;
    if (placement === 'expert-offload') offloadedBytes = nCpuMoe * (model.expertBytesPerLayer ?? 0);
    if (placement === 'layer-offload') offloadedBytes = Math.max(0, totalBytes - this.budgets.gpu);
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
        marginBytes: FIT_CONSTANTS.marginBytes,
        totalBytes,
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
      if (p.memory.totalBytes <= this.budgets.gpu) return p;
    }
    return null;
  }

  private fitsGpu(p: FitPlan): boolean {
    return p.memory.totalBytes - p.memory.offloadedBytes <= this.budgets.gpu;
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
          ? p.memory.totalBytes <= this.budgets.gpu
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
