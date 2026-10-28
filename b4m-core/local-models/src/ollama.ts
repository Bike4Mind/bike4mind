import { z } from 'zod';
import { archFromModelInfo, positiveInt, tensorStatsFromTensors } from './arch';
import {
  LocalRuntimeError,
  ModelNotFoundError,
  PullIdleTimeoutError,
  RuntimeHttpError,
  RuntimeProtocolError,
} from './errors';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  chooseRuntimeId,
  connectionError,
  describeError,
  runtimeEndpointId,
  mapLimit,
  requireBaseUrl,
  parseJson,
  readLines,
  requestJson,
  send,
  type HttpClient,
} from './http';
import type {
  FetchLike,
  InstalledModel,
  LoadedModel,
  LocalRuntime,
  ModelCapabilities,
  ModelInspection,
  PullOptions,
  RuntimeHealth,
} from './types';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

export const OLLAMA_SHOW_CONCURRENCY = 4;

/** Digest verification of a large blob can be silent for minutes. */
export const DEFAULT_PULL_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface OllamaRuntimeOptions {
  baseUrl?: string;
  /**
   * Replaces the address-derived id, so a saved server keeps its identity when its address changes and two
   * servers reached at the same address (one over SSH) stay apart.
   */
  id?: string;
  fetch?: FetchLike;
  /** Sent as `Authorization: Bearer <apiKey>`, for a daemon behind an authenticating proxy. */
  apiKey?: string;
  /** Deadline for ordinary API calls (ms). `pull` has none beyond its own signal. */
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
}

const remoteFields = { remote_host: z.string().optional(), remote_model: z.string().optional() };

const versionSchema = z.object({ version: z.string() });

// Go encodes an empty slice as null on some daemon versions.
const tagsSchema = z.object({ models: z.array(z.unknown()).nullable() });

const tagEntrySchema = z.object({
  name: z.string().optional(),
  model: z.string().optional(),
  size: z.number().optional(),
  modified_at: z.string().optional(),
  details: z.unknown().optional(),
  capabilities: z.unknown().optional(),
  ...remoteFields,
});

const detailsSchema = z.object({
  family: z.string().optional(),
  parameter_size: z.string().optional(),
  quantization_level: z.string().optional(),
});

const showSchema = z.object({
  details: z.unknown().optional(),
  capabilities: z.unknown().optional(),
  modified_at: z.string().optional(),
  model_info: z.record(z.string(), z.unknown()).nullable().optional(),
  tensors: z.array(z.unknown()).nullable().optional(),
  ...remoteFields,
});

const pullFrameSchema = z.object({
  status: z.string().optional(),
  digest: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
  error: z.string().optional(),
});

const psSchema = z.object({ models: z.array(z.unknown()).nullable() });

const psEntrySchema = z.object({
  name: z.string().min(1),
  size: z.number(),
  size_vram: z.number(),
  expires_at: z.string().optional(),
  context_length: z.number().optional(),
});

type TagEntry = z.infer<typeof tagEntrySchema> & { name: string };
type ShowResponse = z.infer<typeof showSchema>;

function isRemote(model: { remote_host?: string; remote_model?: string }): boolean {
  return !!(model.remote_host?.trim() || model.remote_model?.trim());
}

/** Unknown capability names are ignored; the enum keeps growing. */
function capabilityNames(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
}

function toCapabilities(names: string[] | undefined): ModelCapabilities {
  const has = (name: string) => names?.includes(name) ?? false;
  return {
    tools: has('tools'),
    vision: has('vision'),
    thinking: has('thinking'),
    embeddings: has('embedding'),
    completion: has('completion'),
  };
}

function toInstalledModel(
  name: string,
  facts: { size?: number; modifiedAt?: string; details?: unknown; capabilities?: string[] }
): InstalledModel {
  const details = detailsSchema.safeParse(facts.details);
  const detail = details.success ? details.data : {};
  return {
    name,
    sizeBytes: facts.size ?? null,
    quantization: detail.quantization_level || null,
    family: detail.family || null,
    parameterSize: detail.parameter_size || null,
    modifiedAt: facts.modifiedAt ?? null,
    capabilities: toCapabilities(facts.capabilities),
  };
}

const PER_LAYER_KEYS = [
  'attention.head_count_kv',
  'attention.head_count',
  'attention.recurrent_layers',
  'attention.sliding_window_pattern',
];

/**
 * Ollama 0.34.0 and older blank arrays longer than 5 entries in a non-verbose /api/show, to [] or null.
 * MoE models also need the verbose tensor list for `tensorStats`.
 */
function needsVerboseShow(modelInfo: Record<string, unknown> | null | undefined): boolean {
  const arch = modelInfo?.['general.architecture'];
  if (!modelInfo || typeof arch !== 'string') return false;
  if (positiveInt(modelInfo[`${arch}.expert_count`])) return true;
  return PER_LAYER_KEYS.some(key => {
    const value = modelInfo[`${arch}.${key}`];
    return value === null || (Array.isArray(value) && value.length === 0);
  });
}

// Ollama 0.34 and 0.40 both stream this when the registry has no such model or tag (server/images.go, PullModel).
const MISSING_MANIFEST = 'pull model manifest: file does not exist';

/** Carries an `onProgress` throw past the pull's error mapping so the caller gets it unchanged. */
class ProgressCallbackError {
  constructor(readonly error: unknown) {}
}

/** Ollama stores an untagged name as `<name>:latest`. */
function withDefaultTag(model: string): string {
  return /:[^/]+$/.test(model) ? model : `${model}:latest`;
}

export class OllamaRuntime implements LocalRuntime {
  readonly kind = 'ollama' as const;
  readonly id: string;
  readonly baseUrl: string;
  readonly capabilities = { canPull: true, canRemove: true, canInspect: true, reportsLoaded: true } as const;
  private readonly client: HttpClient;
  private readonly requestTimeoutMs: number;
  private readonly healthTimeoutMs: number;

  constructor(options: OllamaRuntimeOptions = {}) {
    this.baseUrl = requireBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_URL, 'ollama');
    this.id = chooseRuntimeId(
      options.id,
      this.baseUrl === DEFAULT_OLLAMA_URL ? 'ollama' : `ollama:${runtimeEndpointId(this.baseUrl)}`,
      'ollama'
    );
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    this.client = {
      runtimeId: this.id,
      baseUrl: this.baseUrl,
      fetch: options.fetch ?? fetch,
      headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined,
    };
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const { version } = await requestJson(this.client, '/api/version', versionSchema, {
        timeoutMs: this.healthTimeoutMs,
      });
      return { ok: true, version, error: null };
    } catch (error) {
      return { ok: false, version: null, error: describeError(error, this.healthTimeoutMs) };
    }
  }

  async list(): Promise<InstalledModel[]> {
    const entries = await this.tags();
    // Ollama 0.30+ puts capabilities in /api/tags; older daemons need one /api/show per model.
    const shown = await mapLimit(entries, OLLAMA_SHOW_CONCURRENCY, entry =>
      entry.capabilities === undefined ? this.show(entry.name).catch(() => null) : Promise.resolve(undefined)
    );
    return entries.flatMap((entry, index) => {
      const show = shown[index];
      if (show && isRemote(show)) return [];
      return [
        toInstalledModel(entry.name, {
          size: entry.size,
          modifiedAt: entry.modified_at,
          details: entry.details ?? show?.details,
          capabilities: capabilityNames(entry.capabilities) ?? capabilityNames(show?.capabilities),
        }),
      ];
    });
  }

  async inspect(model: string): Promise<ModelInspection> {
    const [shown, tags] = await Promise.all([this.show(model), this.tags().catch(() => [])]);
    if (isRemote(shown)) throw new LocalRuntimeError(`${model} is cloud-backed, not a local model`, this.id);
    const show = needsVerboseShow(shown.model_info) ? await this.show(model, true).catch(() => shown) : shown;
    const tagged = withDefaultTag(model);
    const tag = tags.find(entry => entry.name === model || entry.name === tagged);
    return {
      model: toInstalledModel(tag?.name ?? model, {
        size: tag?.size,
        modifiedAt: show.modified_at ?? tag?.modified_at,
        details: show.details ?? tag?.details,
        capabilities: capabilityNames(show.capabilities) ?? capabilityNames(tag?.capabilities),
      }),
      arch: archFromModelInfo(show.model_info, show.tensors),
      tensorStats: tensorStatsFromTensors(show.tensors),
    };
  }

  /**
   * Streams `/api/pull`, folding per-layer byte counts into one progress figure. Aborting via `signal` rejects
   * with fetch's `AbortError` and keeps the partial blobs, so pulling the same ref again resumes.
   */
  async pull(ref: string, opts: PullOptions = {}): Promise<void> {
    const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_PULL_IDLE_TIMEOUT_MS;
    if (!(idleTimeoutMs > 0)) {
      throw new LocalRuntimeError(`idleTimeoutMs must be a positive number or Infinity, got ${idleTimeoutMs}`, this.id);
    }
    const idle = new AbortController();
    const idleError = new PullIdleTimeoutError(this.id, ref, idleTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      // Infinity disables the watchdog; clamp finite delays to avoid Node's 1ms overflow fallback.
      if (Number.isFinite(idleTimeoutMs))
        timer = setTimeout(() => idle.abort(idleError), Math.min(idleTimeoutMs, MAX_TIMER_MS));
    };
    const signal = opts.signal ? AbortSignal.any([opts.signal, idle.signal]) : idle.signal;

    try {
      arm();
      const response = await send(this.client, '/api/pull', {
        method: 'POST',
        body: { model: ref, stream: true },
        signal,
      });
      if (!response.body) throw new RuntimeProtocolError(`${this.id} /api/pull returned no body`, this.id);

      const layers = new Map<string, { total: number; completed: number }>();
      let succeeded = false;
      for await (const line of readLines(response.body)) {
        if (signal.aborted) break;
        arm();
        const frame = parseJson(this.client, '/api/pull', line, pullFrameSchema);
        if (frame.error === MISSING_MANIFEST) throw new ModelNotFoundError(this.id, ref, { cause: frame.error });
        if (frame.error) throw new LocalRuntimeError(`${this.id} could not pull ${ref}: ${frame.error}`, this.id);
        if (frame.digest && frame.total !== undefined) {
          layers.set(frame.digest, { total: frame.total, completed: Math.min(frame.completed ?? 0, frame.total) });
        }
        let completedBytes = 0;
        let totalBytes = 0;
        for (const layer of layers.values()) {
          completedBytes += layer.completed;
          totalBytes += layer.total;
        }
        const status = frame.status ?? '';
        try {
          opts.onProgress?.({ status, completedBytes, totalBytes: layers.size > 0 ? totalBytes : null });
        } catch (error) {
          throw new ProgressCallbackError(error);
        }
        if (status === 'success') succeeded = true;
      }
      opts.signal?.throwIfAborted();
      if (idle.signal.aborted) throw idleError;
      if (!succeeded) throw new RuntimeProtocolError(`${this.id} pull of ${ref} ended before it finished`, this.id);
    } catch (error) {
      if (error instanceof ProgressCallbackError) throw error.error;
      if (idle.signal.aborted && !opts.signal?.aborted) throw idleError;
      throw connectionError(this.client, '/api/pull', error, { signal: opts.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async remove(model: string): Promise<void> {
    try {
      await send(this.client, '/api/delete', {
        method: 'DELETE',
        body: { model },
        timeoutMs: this.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof RuntimeHttpError && error.status === 404) throw new ModelNotFoundError(this.id, model);
      throw error;
    }
  }

  async loaded(): Promise<LoadedModel[]> {
    const { models } = await requestJson(this.client, '/api/ps', psSchema, { timeoutMs: this.requestTimeoutMs });
    return (models ?? []).flatMap(raw => {
      const entry = psEntrySchema.safeParse(raw);
      if (!entry.success) return [];
      return [
        {
          name: entry.data.name,
          sizeBytes: entry.data.size,
          vramBytes: entry.data.size_vram,
          contextLength: positiveInt(entry.data.context_length) ?? null,
          expiresAt: entry.data.expires_at ?? null,
        },
      ];
    });
  }

  private async tags(): Promise<TagEntry[]> {
    const { models } = await requestJson(this.client, '/api/tags', tagsSchema, { timeoutMs: this.requestTimeoutMs });
    return (models ?? []).flatMap(raw => {
      const entry = tagEntrySchema.safeParse(raw);
      if (!entry.success || isRemote(entry.data)) return [];
      const name = entry.data.name || entry.data.model;
      return name ? [{ ...entry.data, name }] : [];
    });
  }

  private async show(model: string, verbose = false): Promise<ShowResponse> {
    try {
      return await requestJson(this.client, '/api/show', showSchema, {
        method: 'POST',
        body: verbose ? { model, verbose } : { model },
        timeoutMs: this.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof RuntimeHttpError && error.status === 404) throw new ModelNotFoundError(this.id, model);
      throw error;
    }
  }
}
