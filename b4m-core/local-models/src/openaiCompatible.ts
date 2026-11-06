import { z } from 'zod';
import { ModelNotFoundError, RuntimeUnsupportedError } from './errors';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  chooseRuntimeId,
  describeError,
  runtimeEndpointId,
  isAuthError,
  requireBaseUrl,
  requestJson,
  type HttpClient,
} from './http';
import type {
  FetchLike,
  InstalledModel,
  LoadedModel,
  LocalRuntime,
  ModelCapabilities,
  ModelInspection,
  OpenAICompatibleProduct,
  PullOptions,
  RuntimeHealth,
} from './types';

export interface OpenAICompatibleRuntimeOptions {
  /** Server root; a trailing `/v1` is accepted and stripped. */
  baseUrl: string;
  /** Replaces the address-derived id; see `OllamaRuntimeOptions.id`. */
  id?: string;
  fetch?: FetchLike;
  /** Enables product-specific endpoints for richer model details. */
  product?: OpenAICompatibleProduct | null;
  /** Sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export const openAIModelsSchema = z.object({ data: z.array(z.unknown()) });

// `meta` is llama-server's extension; `owned_by` is 'llamacpp' there and 'vllm' on vLLM. vLLM's ModelCard adds
// `root` (the weights, shared by every served name), `parent` (a LoRA adapter's base) and `max_model_len`.
export const openAIModelEntrySchema = z.object({
  id: z.string().min(1),
  owned_by: z.string().optional(),
  meta: z.object({ size: z.number().optional() }).nullable().optional(),
  root: z.unknown().optional(),
  parent: z.unknown().optional(),
  max_model_len: z.unknown().optional(),
});

type OpenAIModelEntry = z.infer<typeof openAIModelEntrySchema>;

// LM Studio's native REST API (`GET /api/v0/models`), documented at lmstudio.ai/docs/developer/rest/endpoints.
export const lmStudioModelsSchema = z.object({ object: z.literal('list'), data: z.array(z.unknown()) });

const lmStudioEntrySchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  arch: z.string().optional(),
  quantization: z.string().optional(),
});

/** Health text for a 401/403, so a UI can ask for (or re-ask for) a key. */
export function authErrorMessage(hasApiKey: boolean): string {
  return hasApiKey ? 'API key was rejected' : 'Requires an API key';
}

const NO_CAPABILITIES: ModelCapabilities = {
  tools: false,
  vision: false,
  thinking: false,
  embeddings: false,
  completion: false,
};

/** Product hint from a `/v1/models` body, when `owned_by` gives it away. */
export function productFromOwner(entries: unknown[]): OpenAICompatibleProduct | null {
  for (const raw of entries) {
    const entry = openAIModelEntrySchema.safeParse(raw);
    if (entry.data?.owned_by === 'llamacpp') return 'llama-server';
    if (entry.data?.owned_by === 'vllm') return 'vllm';
  }
  return null;
}

function bareModel(name: string, sizeBytes: number | null = null): InstalledModel {
  return {
    name,
    sizeBytes,
    quantization: null,
    family: null,
    parameterSize: null,
    modifiedAt: null,
    capabilities: { ...NO_CAPABILITIES },
  };
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const positiveInt = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * One model per set of weights: names sharing a `root` collapse into the first listed, which keeps the
 * rest as aliases. An adapter names its base by that first name and inherits the base's context.
 */
function listedModels(entries: OpenAIModelEntry[]): InstalledModel[] {
  const models: InstalledModel[] = [];
  const byRoot = new Map<string, InstalledModel>();
  const byName = new Map<string, InstalledModel>();
  for (const entry of entries) {
    const root = text(entry.root);
    const parent = text(entry.parent);
    const shared = !parent && root ? byRoot.get(root) : undefined;
    if (shared) {
      if (shared.name !== entry.id && !shared.aliases?.includes(entry.id))
        shared.aliases = [...(shared.aliases ?? []), entry.id];
      byName.set(entry.id, shared);
      continue;
    }
    const base = parent ? byName.get(parent) : undefined;
    const contextLength = positiveInt(entry.max_model_len) ?? base?.contextLength;
    const model: InstalledModel = {
      ...bareModel(entry.id, entry.meta?.size ?? null),
      ...(contextLength ? { contextLength } : {}),
      ...(parent ? { baseModel: base?.name ?? parent } : {}),
    };
    if (root && !parent) byRoot.set(root, model);
    byName.set(entry.id, model);
    models.push(model);
  }
  return models;
}

/** LM Studio, llama-server, vLLM and anything else serving the OpenAI `/v1/models` endpoint. */
export class OpenAICompatibleRuntime implements LocalRuntime {
  readonly kind = 'openai-compatible' as const;
  readonly id: string;
  readonly baseUrl: string;
  readonly product: OpenAICompatibleProduct | null;
  readonly capabilities = { canPull: false, canRemove: false, canInspect: false, reportsLoaded: false } as const;
  private readonly client: HttpClient;
  private readonly requestTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly hasApiKey: boolean;

  constructor(options: OpenAICompatibleRuntimeOptions) {
    this.baseUrl = requireBaseUrl(options.baseUrl, 'openai-compatible');
    this.id = chooseRuntimeId(options.id, `openai-compatible:${runtimeEndpointId(this.baseUrl)}`, 'openai-compatible');
    this.product = options.product ?? null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    this.hasApiKey = !!options.apiKey;
    this.client = {
      runtimeId: this.id,
      baseUrl: this.baseUrl,
      fetch: options.fetch ?? fetch,
      headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined,
    };
  }

  async health(): Promise<RuntimeHealth> {
    try {
      await requestJson(this.client, '/v1/models', openAIModelsSchema, { timeoutMs: this.healthTimeoutMs });
      return { ok: true, version: null, error: null };
    } catch (error) {
      const message = isAuthError(error)
        ? authErrorMessage(this.hasApiKey)
        : describeError(error, this.healthTimeoutMs);
      return { ok: false, version: null, error: message };
    }
  }

  async list(): Promise<InstalledModel[]> {
    if (this.product === 'lmstudio') {
      const rich = await this.listLmStudio().catch(() => null);
      if (rich) return rich;
    }
    const { data } = await requestJson(this.client, '/v1/models', openAIModelsSchema, {
      timeoutMs: this.requestTimeoutMs,
    });
    return listedModels(
      data.flatMap(raw => {
        const entry = openAIModelEntrySchema.safeParse(raw);
        return entry.success ? [entry.data] : [];
      })
    );
  }

  async inspect(model: string): Promise<ModelInspection> {
    const found = (await this.list()).find(entry => entry.name === model || entry.aliases?.includes(model));
    if (!found) throw new ModelNotFoundError(this.id, model);
    return { model: found, arch: null, tensorStats: null };
  }

  async pull(_ref: string, _opts?: PullOptions): Promise<void> {
    throw new RuntimeUnsupportedError(this.id, 'pull');
  }

  async remove(_model: string): Promise<void> {
    throw new RuntimeUnsupportedError(this.id, 'remove');
  }

  async loaded(): Promise<LoadedModel[]> {
    throw new RuntimeUnsupportedError(this.id, 'loaded');
  }

  private async listLmStudio(): Promise<InstalledModel[]> {
    const { data } = await requestJson(this.client, '/api/v0/models', lmStudioModelsSchema, {
      timeoutMs: this.requestTimeoutMs,
    });
    return data.flatMap(raw => {
      const entry = lmStudioEntrySchema.safeParse(raw);
      if (!entry.success) return [];
      const { id, type, arch, quantization } = entry.data;
      return [
        {
          ...bareModel(id),
          quantization: quantization || null,
          family: arch || null,
          capabilities: {
            ...NO_CAPABILITIES,
            completion: type === 'llm' || type === 'vlm',
            vision: type === 'vlm',
            embeddings: type === 'embeddings',
          },
        },
      ];
    });
  }
}
