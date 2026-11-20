import { z } from 'zod';
import type { AttentionGroup, ModelArch, TensorStats } from './types';

type ModelInfo = Record<string, unknown>;

const F32_BYTES = 4;

interface SwaDefault {
  /** Every `every`-th layer is full attention; 0 makes every attention layer sliding. */
  every: number;
  denseFirst?: boolean;
  window?: number;
}

// llama.cpp's SWA layout when a GGUF has no pattern array (src/models/<arch>.cpp, `load_swa_pattern`, which also
// takes a scalar pattern key). Other architectures use `sliding_window` only with a per-layer pattern array.
const SWA_DEFAULTS: Record<string, SwaDefault> = {
  afmoe: { every: 4 },
  cohere2: { every: 4 },
  cohere2moe: { every: 4, denseFirst: true },
  exaone4: { every: 4 },
  'exaone-moe': { every: 4 },
  gemma2: { every: 2, window: 4096 },
  gemma3: { every: 6 },
  gemma3n: { every: 5 },
  'gemma-embedding': { every: 6 },
  'gemma-embedding2': { every: 6 },
  'gpt-oss': { every: 2 },
  laguna: { every: 4, denseFirst: true },
  lfm2: { every: 0 },
  // Chunked attention; llama.cpp sizes its cache like a sliding window.
  llama4: { every: 4, window: 8192 },
  mellum: { every: 4 },
  'modern-bert': { every: 3, denseFirst: true },
  'muse-glimmer': { every: 4 },
  olmo2: { every: 4 },
  plamo3: { every: 8 },
  smallthinker: { every: 4, denseFirst: true },
};

// llama.cpp hardcodes where gemma3n's KV-sharing layers start; gemma4 states it in `attention.shared_kv_layers`.
const KV_LAYER_LIMIT: Record<string, number> = { gemma3n: 20 };
const FIXED_SWA_WINDOW: Record<string, number> = { llama4: 8192, smallthinker: 4096 };
// A window of 0 turns SWA off for these loaders; the rest keep the sliding layers with n_swa 0.
const ZERO_WINDOW_DISABLES_SWA = new Set([
  'afmoe',
  'gemma3',
  'laguna',
  'lfm2',
  'llama4',
  'mellum',
  'modern-bert',
  'olmo2',
  'plamo3',
  'smallthinker',
]);

export function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return value === 0 ? 0 : positiveInt(value);
}

function boolArray(value: unknown, minLength: number): boolean[] | undefined {
  return Array.isArray(value) && value.length >= minLength && value.every(flag => typeof flag === 'boolean')
    ? value.slice(0, minLength)
    : undefined;
}

/** A scalar applies to every layer; an array must give one value per block, as llama.cpp requires. */
function perLayer(value: unknown, blockCount: number): number[] | undefined {
  if (!Array.isArray(value)) {
    const scalar = nonNegativeInt(value);
    return scalar === undefined ? undefined : Array.from({ length: blockCount }, () => scalar);
  }
  const values = value.map(nonNegativeInt);
  return values.length === blockCount && values.every(entry => entry !== undefined) ? (values as number[]) : undefined;
}

// llama.cpp `llm_arch_is_recurrent`: every layer carries state and none has attention.
const PURE_RECURRENT = new Set(['mamba', 'mamba2', 'rwkv6', 'rwkv6qwen2', 'rwkv7', 'arwkv7']);
const NEMOTRON_H = new Set(['nemotron_h', 'nemotron_h_moe']);
// Full-attention interval llama.cpp assumes when neither recurrent_layers nor full_attention_interval is set.
const DEFAULT_RECURRENT_INTERVAL: Record<string, number> = {
  qwen35: 4,
  qwen35moe: 4,
  qwen3next: 4,
  clef: 4,
  'minimax-01': 8,
};
// Recurrent layer types the fit estimator has measured (Granite 4 H, Qwen3.5); qwen3next and clef build the same
// delta net. Other recurrent architectures get no kind and are planned at a flat high compute rate.
const RECURRENT_KIND: Record<string, NonNullable<ModelArch['recurrent']>['kind']> = {
  granitehybrid: 'mamba2',
  qwen35: 'gated-delta-net',
  qwen35moe: 'gated-delta-net',
  qwen3next: 'gated-delta-net',
  clef: 'gated-delta-net',
};
// Their expert tensors are feed_forward_length wide; other MoE architectures need expert_feed_forward_length.
const FFN_WIDE_EXPERTS = new Set(['llama', 'granitemoe', 'granitehybrid']);
const UNMODELED_ARCHES = new Set(['qwen4exp', 'deepseek32', 'glm-dsa', 'glm5-next', 'minimax-m3']);

/** Reads `ModelArch` from GGUF metadata as llama.cpp b11889 sizes its caches; null if a key is missing or blanked.
 * Verbose `/api/show` tensors, when given, decide which layers hold experts. */
export function archFromModelInfo(modelInfo: ModelInfo | null | undefined, tensors?: unknown): ModelArch | null {
  if (!modelInfo) return null;
  const arch = modelInfo['general.architecture'];
  if (typeof arch !== 'string' || !arch) return null;
  // Indexer KV caches (qwen4exp's QSA, DSA, minimax-m3's MSA) and qwen4exp's PLE conv history are not modeled,
  // so any estimate would undercount.
  if (UNMODELED_ARCHES.has(arch)) return null;
  const field = (key: string) => modelInfo[`${arch}.${key}`];

  const blockCount = positiveInt(field('block_count'));
  const contextMax = positiveInt(field('context_length'));
  const mtpLayers = nonNegativeInt(field('nextn_predict_layers')) ?? 0;
  if (!blockCount || !contextMax || mtpLayers >= blockCount) return null;
  const trunk = blockCount - mtpLayers;

  const rawHeads = field('attention.head_count');
  // A per-layer array holds 0 on recurrent layers, so the widest attention layer stands for the model.
  const maxHeads = Math.max(0, ...(perLayer(rawHeads, blockCount) ?? []));
  const headCount = maxHeads > 0 ? maxHeads : undefined;
  const headFields = headCount ? { headCount } : {};
  const embedding = positiveInt(field('embedding_length'));
  const keyLength =
    positiveInt(field('attention.key_length')) ??
    (headCount && embedding && embedding % headCount === 0 ? embedding / headCount : undefined);
  const valueLength = positiveInt(field('attention.value_length')) ?? keyLength;
  const stateBytesPerLayer = recurrentStateBytes(arch, field, embedding, headCount, keyLength);

  if (PURE_RECURRENT.has(arch)) {
    if (!stateBytesPerLayer) return null;
    // No attention at all: the empty full group's head sizes are placeholders the schema requires.
    return {
      contextMax,
      blockCount,
      ...headFields,
      ...computeWidths(arch, field, blockCount, trunk, embedding, undefined),
      full: { layers: 0, kvHeads: 1, keyLength: 1, valueLength: 1 },
      recurrent: { layers: trunk, stateBytesPerSeq: trunk * stateBytesPerLayer },
      mtpLayers,
    };
  }
  if (!keyLength || !valueLength) return null;

  // An absent head_count_kv means plain multi-head attention, which is how llama.cpp reads it.
  const rawKv = field('attention.head_count_kv');
  const kvByLayer = perLayer(rawKv === undefined ? headCount : rawKv, blockCount);
  if (!kvByLayer) return null;
  const kvHeads = Math.max(...kvByLayer);
  if (kvHeads <= 0) return null;

  const ffByLayer = NEMOTRON_H.has(arch) ? perLayer(field('feed_forward_length'), blockCount) : undefined;
  const recurrent = recurrentLayers(arch, field, kvByLayer, ffByLayer, trunk, stateBytesPerLayer !== undefined);
  const sliding = slidingLayers(arch, field, trunk);
  if (!sliding) return null;

  // Falcon-H1 runs attention and SSM side by side in every layer, so its recurrent layers keep KV too.
  const kvOnRecurrent = arch === 'falcon-h1';
  const sharedKv = nonNegativeInt(field('attention.shared_kv_layers')) ?? 0;
  const kvLimit = Math.min(trunk, blockCount - sharedKv, KV_LAYER_LIMIT[arch] ?? trunk);
  const fullKv: number[] = [];
  const swaKv: number[] = [];
  for (let i = 0; i < kvLimit; i++) {
    const heads = kvByLayer[i] ?? 0;
    if ((recurrent[i] && !kvOnRecurrent) || heads === 0) continue;
    (sliding.flags[i] ? swaKv : fullKv).push(heads);
  }

  const kvLoraRank = positiveInt(field('attention.kv_lora_rank'));
  // Only MLA-converted GGUFs (key_length_mla present) get the compressed cache; older ones cache full K/V.
  const isMla = !!kvLoraRank && positiveInt(field('attention.key_length_mla')) !== undefined;
  const ropeDim = positiveInt(field('rope.dimension_count')) ?? positiveInt(keyLength - (kvLoraRank ?? 0));
  if (isMla && !ropeDim) return null;

  const group = (layers: number[], keys: number, values: number): AttentionGroup => ({
    layers: layers.length,
    kvHeads: layers.length > 0 ? Math.max(...layers) : kvHeads,
    keyLength: keys,
    valueLength: values,
  });

  const result: ModelArch = {
    contextMax,
    blockCount,
    ...headFields,
    full: isMla ? group([], keyLength, valueLength) : group(fullKv, keyLength, valueLength),
    mtpLayers,
  };
  if (!isMla && swaKv.length > 0 && sliding.window !== undefined) {
    result.swa = {
      ...group(
        swaKv,
        positiveInt(field('attention.key_length_swa')) ?? keyLength,
        positiveInt(field('attention.value_length_swa')) ?? valueLength
      ),
      window: sliding.window,
    };
  }
  const mlaLayers = fullKv.length + swaKv.length;
  if (isMla && kvLoraRank && ropeDim && mlaLayers > 0) result.mla = { layers: mlaLayers, kvLoraRank, ropeDim };
  const recurrentCount = recurrent.filter(Boolean).length;
  if (recurrentCount > 0 && stateBytesPerLayer) {
    const kind = RECURRENT_KIND[arch];
    result.recurrent = {
      layers: recurrentCount,
      stateBytesPerSeq: recurrentCount * stateBytesPerLayer,
      ...(kind ? { kind } : {}),
    };
  }
  const fromTensors = expertLayers(tensors);
  const knownMoeLayers = fromTensors
    ? [...fromTensors].filter(layer => layer < trunk).length
    : ffByLayer?.slice(0, trunk).filter(ff => ff > 0).length;
  const moe = moeLayout(field, trunk, knownMoeLayers);
  if (moe) result.moe = moe;
  return { ...result, ...computeWidths(arch, field, blockCount, trunk, embedding, moe) };
}

/** n_embd and the widest FFN a token passes through; each omitted when its keys are missing. */
function computeWidths(
  arch: string,
  field: (key: string) => unknown,
  blockCount: number,
  trunk: number,
  embedding: number | undefined,
  moe: ModelArch['moe']
): Pick<ModelArch, 'embeddingLength' | 'activeFeedForwardLength'> {
  if (!embedding) return {};
  const widest = (key: string) => {
    const values = perLayer(field(key), blockCount);
    const max = values ? Math.max(0, ...values) : 0;
    return max > 0 ? max : undefined;
  };
  const denseFf = widest('feed_forward_length');
  if (!moe) return { embeddingLength: embedding, ...(denseFf && { activeFeedForwardLength: denseFf }) };
  const expertFf = widest('expert_feed_forward_length') ?? (FFN_WIDE_EXPERTS.has(arch) ? denseFf : undefined);
  if (!expertFf) return { embeddingLength: embedding };
  const shared =
    positiveInt(field('expert_shared_feed_forward_length')) ??
    expertFf * (nonNegativeInt(field('expert_shared_count')) ?? 0);
  let active = moe.used * expertFf + shared;
  // Leading dense layers run the full FFN.
  if (moe.moeLayers < trunk && denseFf && !FFN_WIDE_EXPERTS.has(arch)) active = Math.max(active, denseFf);
  return { embeddingLength: embedding, activeFeedForwardLength: active };
}

/** Recurrent layers keep no KV cache. Same precedence as llama.cpp: explicit flags, then the interval rule. */
function recurrentLayers(
  arch: string,
  field: (key: string) => unknown,
  kvByLayer: number[],
  ffByLayer: number[] | undefined,
  trunk: number,
  hasState: boolean
): boolean[] {
  if (arch === 'falcon-h1') return Array.from({ length: trunk }, () => hasState);
  const rawFlags = field('attention.recurrent_layers');
  if (typeof rawFlags === 'boolean') return Array.from({ length: trunk }, () => rawFlags);
  const flags = boolArray(rawFlags, trunk);
  if (flags) return flags;
  const every = positiveInt(field('full_attention_interval')) ?? DEFAULT_RECURRENT_INTERVAL[arch];
  if (every) return Array.from({ length: trunk }, (_, i) => (i + 1) % every !== 0);
  // Nemotron-H also has FFN-only layers, with neither KV nor state.
  if (ffByLayer) return kvByLayer.slice(0, trunk).map((heads, i) => hasState && heads === 0 && ffByLayer[i] === 0);
  return kvByLayer.slice(0, trunk).map(heads => hasState && heads === 0);
}

/** F32 state bytes one recurrent layer holds per sequence: llama.cpp `n_embd_r() + n_embd_s()`, same precedence. */
function recurrentStateBytes(
  arch: string,
  field: (key: string) => unknown,
  embedding = 0,
  heads = 0,
  keyLength = 0
): number | undefined {
  const key = (name: string) => positiveInt(field(name)) ?? 0;
  const wkv = key('wkv.head_size');
  const shortConv = key('shortconv.l_cache');
  const kda = key('kda.head_dim');
  const linear = arch === 'minimax-01' ? keyLength : 0;
  const conv = key('ssm.conv_kernel');
  const inner = key('ssm.inner_size');
  const state = key('ssm.state_size');
  const groups = key('ssm.group_count');
  const tokenShift = positiveInt(field('token_shift_count')) ?? 2;
  const r = wkv
    ? tokenShift * embedding
    : shortConv
      ? embedding * (shortConv - 1)
      : kda
        ? 3 * (conv > 0 ? conv - 1 : 3) * heads * kda
        : (conv > 0 ? conv - 1 : 0) * (inner + 2 * groups * state);
  const s = wkv ? embedding * wkv : kda ? kda * kda * heads : linear ? linear * linear * heads : state * inner;
  return r + s > 0 ? (r + s) * F32_BYTES : undefined;
}

function slidingLayers(
  arch: string,
  field: (key: string) => unknown,
  trunk: number
): { window: number | undefined; flags: boolean[] } | null {
  const none = { window: undefined, flags: [] };
  // Only EXAONE 4's 64-layer variant enables SWA, independently of the window key.
  if (arch === 'exaone4' && trunk !== 64) return none;
  const defaults = SWA_DEFAULTS[arch];
  const rawWindow = field('attention.sliding_window');
  const defaultWindow = arch === 'exaone4' ? 4096 : defaults?.window;
  const configuredWindow = rawWindow === undefined ? defaultWindow : nonNegativeInt(rawWindow);
  if (configuredWindow === undefined) return none;
  if (configuredWindow === 0 && (!defaults || ZERO_WINDOW_DISABLES_SWA.has(arch))) return none;
  // These loaders use the key as an enable switch and then set a fixed cache window.
  const window = FIXED_SWA_WINDOW[arch] ?? configuredWindow;
  const pattern = field('attention.sliding_window_pattern');
  if (Array.isArray(pattern) || pattern === null) {
    const flags = boolArray(pattern, trunk);
    return flags ? { window, flags } : null;
  }
  if (!defaults) return none;
  const every = nonNegativeInt(pattern) ?? defaults.every;
  const denseFirst = defaults.denseFirst ?? false;
  const flags = Array.from({ length: trunk }, (_, i) =>
    every === 0 ? true : denseFirst ? i % every !== 0 : i % every < every - 1
  );
  return { window, flags };
}

/** `knownLayers` overrides the key-based count; a single expert is a dense FFN, as in llama.cpp's Jamba. */
function moeLayout(field: (key: string) => unknown, trunk: number, knownLayers?: number): ModelArch['moe'] {
  const experts = positiveInt(field('expert_count'));
  const used = positiveInt(field('expert_used_count'));
  if (!experts || experts < 2 || !used) return undefined;
  let moeLayers = knownLayers ?? 0;
  if (knownLayers === undefined) {
    const leadingDense = nonNegativeInt(field('leading_dense_block_count')) ?? 0;
    const step = positiveInt(field('interleave_moe_layer_step')) ?? 1;
    for (let i = leadingDense; i < trunk; i++) if ((i + 1) % step === 0) moeLayers++;
  }
  return moeLayers > 0 ? { experts, used, moeLayers } : undefined;
}

// [elements per block, bytes per block], from ggml's type_traits; keyed by the names /api/show prints.
const GGML_BLOCKS: Record<string, readonly [number, number]> = {
  F64: [1, 8],
  F32: [1, 4],
  F16: [1, 2],
  BF16: [1, 2],
  I64: [1, 8],
  I32: [1, 4],
  I16: [1, 2],
  I8: [1, 1],
  Q1_0: [128, 18],
  Q2_0: [64, 18],
  Q4_0: [32, 18],
  Q4_1: [32, 20],
  Q5_0: [32, 22],
  Q5_1: [32, 24],
  Q8_0: [32, 34],
  Q8_1: [32, 36],
  MXFP4: [32, 17],
  NVFP4: [64, 36],
  IQ4_NL: [32, 18],
  Q2_K: [256, 84],
  Q3_K: [256, 110],
  Q4_K: [256, 144],
  Q5_K: [256, 176],
  Q6_K: [256, 210],
  Q8_K: [256, 292],
  IQ1_S: [256, 50],
  IQ1_M: [256, 56],
  IQ2_XXS: [256, 66],
  IQ2_XS: [256, 74],
  IQ2_S: [256, 82],
  IQ3_XXS: [256, 98],
  IQ3_S: [256, 110],
  IQ4_XS: [256, 136],
  TQ1_0: [256, 54],
  TQ2_0: [256, 66],
};

const tensorSchema = z.object({
  name: z.string(),
  type: z.string(),
  shape: z.array(z.number().int().nonnegative()),
});

// Routed expert weights, the tensors llama.cpp's --n-cpu-moe moves to RAM; shared experts (`_shexp`) stay.
const EXPERT_TENSOR = /^blk\.(\d+)\.ffn_\w+?_(?:ch)?exps\b/;

interface ParsedTensor {
  name: string;
  bytes: number;
}

function parseTensors(tensors: unknown): ParsedTensor[] | undefined {
  if (!Array.isArray(tensors)) return undefined;
  const parsed: ParsedTensor[] = [];
  for (const raw of tensors) {
    const tensor = tensorSchema.safeParse(raw);
    const block = tensor.success ? GGML_BLOCKS[tensor.data.type] : undefined;
    if (!tensor.success || !block) return undefined;
    const elements = tensor.data.shape.reduce((product, size) => product * size, 1);
    parsed.push({ name: tensor.data.name, bytes: Math.ceil(elements / block[0]) * block[1] });
  }
  return parsed;
}

function expertLayer(name: string): number | undefined {
  const layer = EXPERT_TENSOR.exec(name)?.[1];
  return layer === undefined ? undefined : Number(layer);
}

/** Layers holding routed experts, from tensor names alone; undefined when there is no tensor list. */
function expertLayers(tensors: unknown): Set<number> | undefined {
  if (!Array.isArray(tensors)) return undefined;
  const layers = new Set<number>();
  for (const raw of tensors) {
    const name: unknown = raw && typeof raw === 'object' && 'name' in raw ? raw.name : undefined;
    const layer = typeof name === 'string' ? expertLayer(name) : undefined;
    if (layer !== undefined) layers.add(layer);
  }
  return layers;
}

/** Splits verbose `/api/show` tensors into expert and other weight bytes; null for dense models or unknown types. */
export function tensorStatsFromTensors(tensors: unknown): TensorStats | null {
  const parsed = parseTensors(tensors);
  if (!parsed) return null;
  let total = 0;
  let expert = 0;
  const layers = new Set<number>();
  for (const { name, bytes } of parsed) {
    total += bytes;
    const layer = expertLayer(name);
    if (layer === undefined) continue;
    expert += bytes;
    layers.add(layer);
  }
  if (expert === 0 || total === expert) return null;
  return { expertBytesPerLayer: Math.round(expert / layers.size), nonExpertBytes: total - expert };
}
