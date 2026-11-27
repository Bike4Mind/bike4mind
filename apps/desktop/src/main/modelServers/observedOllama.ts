import {
  detectOllamaInstall,
  fitRuntimeFromOllamaSettings,
  ollamaEnvValue,
  readOllamaSettings,
  type OllamaEnvironment,
} from '@bike4mind/local-models';
import {
  QUANTIZED_KV_CACHE_TYPES,
  type FlashAttention,
  type ModelServerLaunchSettings,
  type QuantizedKvCacheType,
} from '@shared/modelServers';

/** The launch variables Settings shows for an Ollama Desktop did not start. */
export const OBSERVED_OLLAMA_KEYS = [
  'OLLAMA_KV_CACHE_TYPE',
  'OLLAMA_FLASH_ATTENTION',
  'OLLAMA_CONTEXT_LENGTH',
  'OLLAMA_NUM_PARALLEL',
] as const;

/**
 * What the Ollama at `url` on this computer runs with, read from its process or systemd unit; null when it cannot be
 * read. Linux only: on macOS and Windows neither is readable, so it is null there.
 */
export async function readHostOllamaEnv(
  url: string,
  platform: NodeJS.Platform = process.platform
): Promise<OllamaEnvironment | null> {
  if (platform !== 'linux') return null;
  const install = await detectOllamaInstall({ url });
  const { settings, env } = await readOllamaSettings(install);
  return settings.readable ? env : null;
}

/** The set launch variables, by name, as Ollama reads them. */
export function observedLaunchVars(env: OllamaEnvironment): Record<string, string> {
  return Object.fromEntries(
    OBSERVED_OLLAMA_KEYS.flatMap(key => {
      const value = ollamaEnvValue(env, key);
      return value ? [[key, value]] : [];
    })
  );
}

/** The cache type fit sizes with for these variables: f16 (undefined) unless a priced quantized type applies. */
export function observedKvCacheType(vars: Record<string, string>): QuantizedKvCacheType | undefined {
  const runtime = fitRuntimeFromOllamaSettings(vars);
  // Ollama keeps an f16 cache with flash attention off.
  if (runtime.flashAttn === 'off') return undefined;
  const kv = runtime.kv && runtime.kv !== 'auto' ? runtime.kv.k : undefined;
  return QUANTIZED_KV_CACHE_TYPES.find(type => type === kv);
}

/** The launch settings that would start Ollama as these variables run it, and the variables that say so; null if none. */
export function observedPrefill(
  vars: Record<string, string>
): { settings: ModelServerLaunchSettings; from: string } | null {
  const kvCacheType = observedKvCacheType(vars);
  const flashAttention = observedFlashAttention(vars);
  const keys = [
    ...(kvCacheType ? (['OLLAMA_KV_CACHE_TYPE'] as const) : []),
    ...(flashAttention ? (['OLLAMA_FLASH_ATTENTION'] as const) : []),
  ];
  if (keys.length === 0) return null;
  return {
    settings: { ...(kvCacheType ? { kvCacheType } : {}), ...(flashAttention ? { flashAttention } : {}) },
    from: keys.map(key => `${key}=${vars[key]}`).join(', '),
  };
}

/** OLLAMA_FLASH_ATTENTION as Ollama reads it; undefined when unset or unreadable, which Ollama treats as auto. */
export function observedFlashAttention(vars: Record<string, string>): FlashAttention | undefined {
  const flash = fitRuntimeFromOllamaSettings(vars).flashAttn;
  return flash === 'on' || flash === 'off' ? flash : undefined;
}
