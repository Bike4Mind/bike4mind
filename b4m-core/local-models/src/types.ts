export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeHealth {
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  embeddings: boolean;
  completion: boolean;
}

export interface InstalledModel {
  name: string;
  sizeBytes: number | null;
  quantization: string | null;
  family: string | null;
  parameterSize: string | null;
  modifiedAt: string | null;
  /** All false when the runtime does not report capabilities; false means "not reported", not "absent". */
  capabilities: ModelCapabilities;
}

/** Attention layers that share one KV layout. */
export interface AttentionGroup {
  layers: number;
  kvHeads: number;
  keyLength: number;
  valueLength: number;
}

/** Cache and recurrent-state layout used to estimate model memory requirements. */
export interface ModelArch {
  contextMax: number;
  blockCount: number;
  headCount?: number;
  /** n_embd, for compute sizing. */
  embeddingLength?: number;
  /** The widest FFN one token passes through: n_ff, or used experts x expert width plus shared experts. */
  activeFeedForwardLength?: number;
  /** Full (global) attention layers. */
  full: AttentionGroup;
  swa?: AttentionGroup & { window: number };
  mla?: { layers: number; kvLoraRank: number; ropeDim: number };
  /**
   * F32 state per sequence; does not grow with context. `kind` is set for layer types with measured compute and must
   * match RECURRENT_KINDS in @bike4mind/common (schemas/modelHub.ts).
   */
  recurrent?: { layers: number; stateBytesPerSeq: number; kind?: 'mamba2' | 'gated-delta-net' };
  /** Multi-token-prediction layers, each with its own KV at full-attention cost. */
  mtpLayers: number;
  moe?: { experts: number; used: number; moeLayers: number };
  /** Measured by llama-fit-params for sparse-attention families; no runtime API reports it. */
  kvProbe?: { bytesPerToken: number; fixedBytes: number; source: 'llama-fit-params'; runtime: string };
}

/** Weight split used to estimate partially offloaded MoE models. */
export interface TensorStats {
  expertBytesPerLayer: number;
  nonExpertBytes: number;
}

export interface PullProgress {
  status: string;
  completedBytes: number;
  /** Sum over the layers announced so far; Ollama announces each layer only when it starts it, so this grows. */
  totalBytes: number | null;
}

export interface PullOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PullProgress) => void;
  /** Fails the pull when the runtime sends nothing for this long (ms). Must be positive; Infinity disables the check. */
  idleTimeoutMs?: number;
}

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  vramBytes: number;
  contextLength: number | null;
  expiresAt: string | null;
}

export type RuntimeKind = 'ollama' | 'openai-compatible' | 'llama-server';

export interface RuntimeCapabilities {
  canPull: boolean;
  canRemove: boolean;
  /** True when `inspect` can return architecture details; without it `inspect` still works with `arch: null`. */
  canInspect: boolean;
  reportsLoaded: boolean;
}

export interface ModelInspection {
  model: InstalledModel;
  arch: ModelArch | null;
  /** MoE weight split, when the runtime lists tensor types and shapes; null for dense models. */
  tensorStats: TensorStats | null;
  /** The Modelfile's PARAMETER lines as Ollama's /api/show prints them (`num_ctx 4096`, one per line). */
  parameters?: string | null;
  /** The trained context limit the runtime reports, even when `arch` could not be read. */
  contextLength?: number | null;
  /** What the installed model was built from, for checking it against reviewed registry layers. */
  contents?: ModelContents;
}

export interface ModelContents {
  /** The chat template text, byte for byte as its layer stores it. */
  template: string | null;
  /** License layers' text; Ollama joins several with a newline. */
  license: string | null;
  /** sha256 hex of the weights blob. */
  modelBlob: string | null;
}

export interface InspectOptions {
  /** false skips re-reading the installed list, for callers that already have it; `model` then carries no size. */
  tags?: boolean;
}

/** The layers an Ollama registry (ollama.com or hf.co) serves for one tag; digests are hex with no `sha256:`. */
export interface OllamaRegistryLayers {
  model: string | null;
  /** Every other layer in manifest order, e.g. `application/vnd.ollama.image.template`. */
  others: { mediaType: string; digest: string }[];
}

export interface LocalRuntime {
  /**
   * `'ollama'` for the default daemon, otherwise `'<kind>:<host:port>'` for HTTP server roots.
   * HTTPS and reverse-proxy paths use `'<kind>:<canonical base URL>'` to keep distinct endpoints unique.
   * `'llama-server'` for the managed llama-server runtime, of which a process runs one.
   * A caller-supplied `id` option replaces both.
   */
  readonly id: string;
  readonly kind: RuntimeKind;
  readonly baseUrl: string;
  readonly capabilities: RuntimeCapabilities;
  /** Never throws. */
  health(): Promise<RuntimeHealth>;
  list(): Promise<InstalledModel[]>;
  inspect(model: string, options?: InspectOptions): Promise<ModelInspection>;
  pull(ref: string, opts?: PullOptions): Promise<void>;
  remove(model: string): Promise<void>;
  loaded(): Promise<LoadedModel[]>;
}

export type OpenAICompatibleProduct = 'lmstudio' | 'llama-server' | 'vllm';
