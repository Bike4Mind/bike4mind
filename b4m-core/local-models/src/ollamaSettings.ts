import {
  KV_CACHE_TYPES,
  OLLAMA_SETTING_KEYS,
  type FitRuntime,
  type HardwareProfile,
  type KvCacheType,
  type OllamaSettingKey,
} from '@bike4mind/common/modelHub';

/** The only variables read from a process, unit or environment file; anything else (API keys, proxies) is dropped. */
export const OLLAMA_ENV_KEY_NAMES = [...OLLAMA_SETTING_KEYS, 'OLLAMA_GPU_OVERHEAD', 'HOME'] as const;
export type OllamaEnvKey = (typeof OLLAMA_ENV_KEY_NAMES)[number];
export const OLLAMA_ENV_KEYS: ReadonlySet<OllamaEnvKey> = new Set(OLLAMA_ENV_KEY_NAMES);

export const isOllamaEnvKey = (key: string): key is OllamaEnvKey => (OLLAMA_ENV_KEYS as ReadonlySet<string>).has(key);

/** Effective Ollama environment, by variable name; unset keys are absent. */
export type OllamaEnvironment = Partial<Record<OllamaEnvKey, string>>;

const GIB = 1024 ** 3;

/**
 * What Ollama uses for an unset key (envconfig/config.go). Null where it decides at runtime: the context length by
 * VRAM, flash attention per GPU, the store by the service user's home, origins from a built-in list.
 */
export const OLLAMA_SETTING_DEFAULTS: Record<OllamaSettingKey, string | null> = {
  OLLAMA_CONTEXT_LENGTH: null,
  OLLAMA_KEEP_ALIVE: '5m',
  OLLAMA_NUM_PARALLEL: '1',
  OLLAMA_MAX_LOADED_MODELS: '0',
  OLLAMA_FLASH_ATTENTION: null,
  OLLAMA_KV_CACHE_TYPE: 'f16',
  OLLAMA_NO_CLOUD: '0',
  OLLAMA_HOST: '127.0.0.1:11434',
  OLLAMA_MODELS: null,
  OLLAMA_ORIGINS: null,
};

/** envconfig.Var: surrounding spaces and quotes are not part of the value. */
export function ollamaEnvValue(env: OllamaEnvironment, key: OllamaEnvKey): string {
  return (env[key] ?? '').trim().replace(/^["']+|["']+$/g, '');
}

/** envconfig.Uint: a value that is not a whole number falls back to the default. */
function ollamaUint(env: OllamaEnvironment, key: OllamaEnvKey): number | null {
  const value = ollamaEnvValue(env, key);
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

/** envconfig.BoolWithDefault: strconv.ParseBool, and any other non-empty value reads as true. */
export function ollamaBool(env: OllamaEnvironment, key: OllamaEnvKey): boolean | null {
  const value = ollamaEnvValue(env, key);
  if (!value) return null;
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(value)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(value)) return false;
  return true;
}

type KvPricing = { type: KvCacheType | null; exact: boolean };

// Ollama hands the type to llama-server's --cache-type-k/v as is. bf16 and iq4_nl are the size of f16 and q4_0;
// q8_0 is no smaller than the other 4- and 5-bit types. f32 has no stand-in at least as large.
const KV_STAND_INS: Record<string, KvPricing> = {
  bf16: { type: 'f16', exact: true },
  iq4_nl: { type: 'q4_0', exact: true },
  q4_1: { type: 'q8_0', exact: false },
  q5_0: { type: 'q8_0', exact: false },
  q5_1: { type: 'q8_0', exact: false },
};

/** The planner's KV type for OLLAMA_KV_CACHE_TYPE and whether it prices the cache exactly. */
function ollamaKvType(env: OllamaEnvironment): KvPricing {
  const value = ollamaEnvValue(env, 'OLLAMA_KV_CACHE_TYPE').toLowerCase();
  if (!value) return { type: null, exact: true };
  if ((KV_CACHE_TYPES as readonly string[]).includes(value)) return { type: value as KvCacheType, exact: true };
  return KV_STAND_INS[value] ?? { type: null, exact: false };
}

/** The fit runtime an Ollama with this environment loads models with. */
export function fitRuntimeFromOllamaSettings(env: OllamaEnvironment): FitRuntime {
  const flash = ollamaBool(env, 'OLLAMA_FLASH_ATTENTION');
  const kv = ollamaKvType(env).type;
  const runtime: FitRuntime = {
    kind: 'ollama',
    slots: Math.min(Math.max(ollamaUint(env, 'OLLAMA_NUM_PARALLEL') || 1, 1), 1024),
    flashAttn: flash === null ? 'auto' : flash ? 'on' : 'off',
  };
  // Ollama passes the type to both caches whenever set; the planner keeps f16 when flash attention is off.
  if (kv) runtime.kv = { k: kv, v: kv };
  return runtime;
}

/** Low when the KV cache type is one the planner can only over-price (or, for f32 and unknown types, not price). */
export function ollamaFitConfidence(env: OllamaEnvironment): 'high' | 'low' {
  return ollamaKvType(env).exact ? 'high' : 'low';
}

type VramFields = Pick<
  HardwareProfile,
  'memoryKind' | 'totalMemoryBytes' | 'gpuMemoryBytes' | 'gpuCount' | 'gpuWorkingSetBytes'
>;

/**
 * The VRAM Ollama totals for its default context: every GPU's total less OLLAMA_GPU_OVERHEAD, summed in uint64 as
 * Server.Serve does, so an overhead above a GPU's total wraps. Falls back to the profile without per-GPU totals.
 */
function ollamaTotalVram(hardware: VramFields, env: OllamaEnvironment, gpuTotals?: ReadonlyArray<number | null>) {
  const overhead = ollamaUint(env, 'OLLAMA_GPU_OVERHEAD') ?? 0;
  if (gpuTotals?.length && gpuTotals.every(total => total !== null && Number.isSafeInteger(total))) {
    let sum = 0n;
    for (const total of gpuTotals) sum = BigInt.asUintN(64, sum + BigInt(total ?? 0) - BigInt(overhead));
    return Number(sum);
  }
  if (hardware.gpuCount === 0) return 0;
  // A unified GPU with no separate size (Apple, GB10) reports the shared memory it may use.
  const total =
    hardware.gpuMemoryBytes ??
    (hardware.memoryKind === 'unified' ? (hardware.gpuWorkingSetBytes ?? hardware.totalMemoryBytes) : 0);
  return Math.max(0, total - overhead * hardware.gpuCount);
}

/**
 * The context Ollama gives a request that sets none: OLLAMA_CONTEXT_LENGTH, else 4K, 32K or 256K by total VRAM
 * (server/routes.go, 23 and 47 GiB thresholds). `gpuTotals`: each GPU's total memory, all vendors, when measured.
 */
export function ollamaDefaultContext(
  hardware: VramFields,
  env: OllamaEnvironment = {},
  gpuTotals?: ReadonlyArray<number | null>
): number {
  const configured = ollamaUint(env, 'OLLAMA_CONTEXT_LENGTH');
  if (configured) return Math.min(configured, 2 ** 24);
  const vram = ollamaTotalVram(hardware, env, gpuTotals);
  if (vram >= 47 * GIB) return 262144;
  if (vram >= 23 * GIB) return 32768;
  return 4096;
}
