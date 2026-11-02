import { z } from 'zod';
import type { FitRuntime, HardwareProfile } from '../modelHub/fit';
import { HUB_RUNTIMES, KV_CACHE_TYPES } from './modelHub';

/** Bounds keep a hostile model host from making clients allocate without limit; a host clamps to them before parsing. */
export const MODEL_HOST_LIMITS = {
  text: 256,
  path: 4096,
  url: 2048,
  modelName: 1024,
  bytes: 2 ** 53 - 1,
  count: 65536,
  gpus: 64,
  loaded: 64,
  unreadable: 64,
  context: 2 ** 24,
} as const;
const L = MODEL_HOST_LIMITS;

const TextSchema = z.string().max(L.text);
const PathSchema = z.string().max(L.path);
const ByteCountSchema = z.number().int().nonnegative().max(L.bytes);
const CountSchema = z.number().int().nonnegative().max(L.count);
const ConfidenceSchema = z.enum(['high', 'low']);

/** Ollama settings a model host may change; `OLLAMA_HOST` only back to a loopback address. */
export const OLLAMA_WRITABLE_SETTING_KEYS = [
  'OLLAMA_CONTEXT_LENGTH',
  'OLLAMA_KEEP_ALIVE',
  'OLLAMA_NUM_PARALLEL',
  'OLLAMA_MAX_LOADED_MODELS',
  'OLLAMA_FLASH_ATTENTION',
  'OLLAMA_KV_CACHE_TYPE',
  'OLLAMA_NO_CLOUD',
  'OLLAMA_HOST',
] as const;
/** Reported but never changed by a model host. */
export const OLLAMA_READ_ONLY_SETTING_KEYS = ['OLLAMA_MODELS', 'OLLAMA_ORIGINS'] as const;
export const OLLAMA_SETTING_KEYS = [...OLLAMA_WRITABLE_SETTING_KEYS, ...OLLAMA_READ_ONLY_SETTING_KEYS] as const;
export type OllamaSettingKey = (typeof OLLAMA_SETTING_KEYS)[number];

/** `official` is Ollama under the system `ollama.service`, whoever wrote the unit; `manual` a process with no unit. */
export const OLLAMA_INSTALL_TYPES = ['official', 'user-systemd', 'manual', 'docker', 'snap', 'unknown'] as const;
export type OllamaInstallType = (typeof OLLAMA_INSTALL_TYPES)[number];
/**
 * `unattributed`: systemd reports the value but no readable unit file, drop-in or environment file sets it.
 * `config`: Ollama's own `~/.ollama/server.json` for its service user (`disable_ollama_cloud`).
 */
export const OLLAMA_SETTING_SOURCE_KINDS = [
  'default',
  'unit',
  'dropin',
  'override',
  'env-file',
  'process',
  'config',
  'unattributed',
] as const;
export type OllamaSettingSourceKind = (typeof OLLAMA_SETTING_SOURCE_KINDS)[number];

export const OllamaSettingSchema = z.object({
  key: z.enum(OLLAMA_SETTING_KEYS),
  /** Null when unset and Ollama decides at runtime (flash attention, allowed origins, the store path). */
  value: z.string().max(L.path).nullable(),
  source: z.object({ kind: z.enum(OLLAMA_SETTING_SOURCE_KINDS), path: PathSchema.nullable() }),
  writable: z.boolean(),
  /** The running Ollama has this value, but its unit files now say otherwise; a restart applies theirs. */
  pendingRestart: z.boolean().optional(),
});
export type OllamaSetting = z.infer<typeof OllamaSettingSchema>;

export const OllamaSettingsSchema = z.object({
  /** False for docker and unknown installs, and a process whose environment this user cannot read. */
  readable: z.boolean(),
  settings: z.array(OllamaSettingSchema).max(OLLAMA_SETTING_KEYS.length),
  /** Unit files, drop-ins or environment files that exist but could not be read; their values may be missing. */
  unreadablePaths: z.array(PathSchema).max(L.unreadable),
});
export type OllamaSettings = z.infer<typeof OllamaSettingsSchema>;

export const OllamaInstallSchema = z.object({
  type: z.enum(OLLAMA_INSTALL_TYPES),
  /** The systemd unit file, for `official` and `user-systemd`. */
  unit: PathSchema.nullable(),
  binary: PathSchema.nullable(),
});
export type OllamaInstall = z.infer<typeof OllamaInstallSchema>;

const GpuVendorSchema = z.enum(['nvidia', 'amd', 'intel']);

export const HardwareProfileSchema = z.object({
  platform: TextSchema,
  arch: TextSchema,
  memoryKind: z.enum(['unified', 'discrete', 'cpu']),
  totalMemoryBytes: ByteCountSchema,
  gpuMemoryBytes: ByteCountSchema.nullable(),
  gpuName: TextSchema.nullable(),
  gpuCount: CountSchema,
  gpuVendor: z.enum(['nvidia', 'amd', 'intel', 'apple']).nullable().optional(),
  chip: TextSchema.nullable(),
  diskFreeBytes: ByteCountSchema.nullable(),
  confidence: ConfidenceSchema,
  gpuWorkingSetBytes: ByteCountSchema.nullable().optional(),
}) satisfies z.ZodType<HardwareProfile>;

const KvTypeSchema = z.enum(KV_CACHE_TYPES);
export const FitRuntimeSchema = z.object({
  kind: z.enum(HUB_RUNTIMES),
  kv: z.union([z.literal('auto'), z.object({ k: KvTypeSchema, v: KvTypeSchema })]).optional(),
  flashAttn: z.enum(['auto', 'on', 'off']).optional(),
  slots: z.number().int().min(1).max(1024).optional(),
}) satisfies z.ZodType<FitRuntime>;

export const STORE_PATH_SOURCES = ['setting', 'service-home', 'process-home', 'installed-model'] as const;

export const HostFactsSchema = z.object({
  os: z.object({ name: TextSchema.nullable(), kernel: TextSchema.nullable() }),
  cpu: z.object({ model: TextSchema.nullable(), cores: CountSchema.nullable(), threads: CountSchema.nullable() }),
  memory: z.object({ totalBytes: ByteCountSchema, availableBytes: ByteCountSchema.nullable() }),
  gpus: z
    .array(
      z.object({
        vendor: GpuVendorSchema,
        name: TextSchema.nullable(),
        memoryBytes: ByteCountSchema.nullable(),
        memoryUsedBytes: ByteCountSchema.nullable(),
      })
    )
    .max(L.gpus),
  /** Measured on the host; `diskFreeBytes` is the model store's filesystem. */
  hardware: HardwareProfileSchema,
  ollama: z.object({
    url: z.string().max(L.url),
    reachable: z.boolean(),
    version: TextSchema.nullable(),
    install: OllamaInstallSchema,
    store: z.object({
      path: PathSchema.nullable(),
      source: z.enum(STORE_PATH_SOURCES).nullable(),
      mountPoint: PathSchema.nullable(),
      freeBytes: ByteCountSchema.nullable(),
      /** Low when the store path could not be resolved through its symlinks, so the mount may be another. */
      confidence: ConfidenceSchema,
    }),
    loaded: z
      .array(
        z.object({
          name: z.string().max(L.modelName),
          sizeBytes: ByteCountSchema,
          vramBytes: ByteCountSchema,
          contextLength: z.number().int().positive().max(L.context).nullable(),
        })
      )
      .max(L.loaded),
  }),
  fitRuntime: FitRuntimeSchema,
  /** Low when Ollama's settings were unreadable or set a KV cache type the planner can only approximate. */
  fitRuntimeConfidence: ConfidenceSchema,
  /** The context Ollama gives a request that sets none: `OLLAMA_CONTEXT_LENGTH`, else its VRAM-tiered default. */
  defaultContext: z.number().int().positive().max(L.context),
});
export type HostFacts = z.infer<typeof HostFactsSchema>;

/** The model host API version; a host refuses nothing older than its `minClientProtocol`. */
export const MODEL_HOST_PROTOCOL = 1;
/** Ordered: each role can do everything the ones before it can. */
export const MODEL_HOST_ROLES = ['chat', 'manage', 'admin'] as const;
export type ModelHostRole = (typeof MODEL_HOST_ROLES)[number];
export const MODEL_HOST_MODES = ['system', 'user'] as const;

/** `GET /v1/hello`: what a client checks before any other call. `role` is the caller's. */
export const ModelHostHelloSchema = z.object({
  protocol: z.number().int().positive(),
  minClientProtocol: z.number().int().positive(),
  version: TextSchema,
  serverId: TextSchema,
  mode: z.enum(MODEL_HOST_MODES),
  role: z.enum(MODEL_HOST_ROLES),
  ollama: z.object({ url: z.string().max(L.url), reachable: z.boolean(), version: TextSchema.nullable() }),
  features: z.array(TextSchema).max(64),
});
export type ModelHostHello = z.infer<typeof ModelHostHelloSchema>;

/** Every non-2xx body from a model host. */
export const ModelHostErrorSchema = z.object({ code: TextSchema, message: z.string().max(L.path) });
export type ModelHostError = z.infer<typeof ModelHostErrorSchema>;
