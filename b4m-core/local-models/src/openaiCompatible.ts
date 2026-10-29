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

// `meta` is llama-server's extension; `owned_by` is 'llamacpp' there and 'vllm' on vLLM.
export const openAIModelEntrySchema = z.object({
  id: z.string().min(1),
  owned_by: z.string().optional(),
  meta: z.object({ size: z.number().optional() }).nullable().optional(),
});

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
    return data.flatMap(raw => {
      const entry = openAIModelEntrySchema.safeParse(raw);
      return entry.success ? [bareModel(entry.data.id, entry.data.meta?.size ?? null)] : [];
    });
  }

  async inspect(model: string): Promise<ModelInspection> {
    const found = (await this.list()).find(entry => entry.name === model);
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
