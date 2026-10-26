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
  /** Full (global) attention layers. */
  full: AttentionGroup;
  swa?: AttentionGroup & { window: number };
  mla?: { layers: number; kvLoraRank: number; ropeDim: number };
  /** F32 state per sequence; does not grow with context. */
  recurrent?: { layers: number; stateBytesPerSeq: number };
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
  /** Fails the pull when the runtime sends nothing for this long (ms). Infinity disables the check. */
  idleTimeoutMs?: number;
}

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  vramBytes: number;
  contextLength: number | null;
  expiresAt: string | null;
}

export type RuntimeKind = 'ollama' | 'openai-compatible';

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
}

export interface LocalRuntime {
  /**
   * `'ollama'` for the default daemon, otherwise `'<kind>:<host:port>'` for HTTP server roots.
   * HTTPS and reverse-proxy paths use `'<kind>:<canonical base URL>'` to keep distinct endpoints unique.
   */
  readonly id: string;
  readonly kind: RuntimeKind;
  readonly baseUrl: string;
  readonly capabilities: RuntimeCapabilities;
  /** Never throws. */
  health(): Promise<RuntimeHealth>;
  list(): Promise<InstalledModel[]>;
  inspect(model: string): Promise<ModelInspection>;
  pull(ref: string, opts?: PullOptions): Promise<void>;
  remove(model: string): Promise<void>;
  loaded(): Promise<LoadedModel[]>;
}

export type OpenAICompatibleProduct = 'lmstudio' | 'llama-server' | 'vllm';
