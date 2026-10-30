import { z } from 'zod';
import { HEALTH_TIMEOUT_MS, isAuthError, parseBaseUrl, requestJson, type HttpClient } from './http';
import { OllamaRuntime } from './ollama';
import {
  OpenAICompatibleRuntime,
  authErrorMessage,
  lmStudioModelsSchema,
  openAIModelsSchema,
  productFromOwner,
} from './openaiCompatible';
import type { FetchLike, LocalRuntime, OpenAICompatibleProduct, RuntimeHealth } from './types';

/** Ollama, LM Studio, llama-server and vLLM default ports, in that order. */
export const DEFAULT_PROBE_HOSTS: readonly string[] = [
  '127.0.0.1:11434',
  '127.0.0.1:1234',
  '127.0.0.1:8080',
  '127.0.0.1:8000',
];

/** `host:port` or a full URL, optionally with a key for an OpenAI-compatible server. */
export type ProbeHost = string | { url: string; apiKey?: string };

export interface DetectRuntimesOptions {
  /** Probed before the defaults. */
  hosts?: ProbeHost[];
  fetch?: FetchLike;
  /** Per-request probe deadline (ms). */
  timeoutMs?: number;
  /** Replaces `DEFAULT_PROBE_HOSTS`; pass `[]` to probe only `hosts`. */
  defaultHosts?: readonly string[];
}

export interface DetectedRuntime {
  runtime: LocalRuntime;
  /** `ok: false` only for a server that answered 401/403, so the caller can ask for a key. */
  health: RuntimeHealth;
  product: OpenAICompatibleProduct | null;
  /** True when the host came from `hosts` rather than the defaults. */
  configured: boolean;
}

interface Candidate {
  baseUrl: string;
  apiKey?: string;
  configured: boolean;
}

const ollamaVersionSchema = z.object({ version: z.string().min(1) });

/** Probes every candidate host in parallel and identifies each by response shape, never by port. */
export async function detectRuntimes(options: DetectRuntimesOptions = {}): Promise<DetectedRuntime[]> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const add = (host: ProbeHost, configured: boolean) => {
    const { url, apiKey } = typeof host === 'string' ? { url: host, apiKey: undefined } : host;
    const baseUrl = parseBaseUrl(url);
    if (!baseUrl || seen.has(baseUrl)) return;
    seen.add(baseUrl);
    candidates.push({ baseUrl, apiKey, configured });
  };
  for (const host of options.hosts ?? []) add(host, true);
  for (const host of options.defaultHosts ?? DEFAULT_PROBE_HOSTS) add(host, false);

  const results = await Promise.all(
    candidates.map(candidate => probe(candidate, fetchImpl, timeoutMs).catch(() => null))
  );
  return results.filter((result): result is DetectedRuntime => result !== null);
}

async function probe(
  { baseUrl, apiKey, configured }: Candidate,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<DetectedRuntime | null> {
  const client: HttpClient = {
    runtimeId: baseUrl,
    baseUrl,
    fetch: fetchImpl,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  };
  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      value => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
  // Ollama also serves /v1/models, so its own endpoint decides first.
  const [version, models] = await Promise.all([
    settle(requestJson(client, '/api/version', ollamaVersionSchema, { timeoutMs })),
    settle(requestJson(client, '/v1/models', openAIModelsSchema, { timeoutMs })),
  ]);
  if (version.value) {
    return {
      runtime: new OllamaRuntime({ baseUrl, fetch: fetchImpl, apiKey }),
      health: { ok: true, version: version.value.version, error: null },
      product: null,
      configured,
    };
  }
  const runtime = (product: OpenAICompatibleProduct | null) =>
    new OpenAICompatibleRuntime({ baseUrl, fetch: fetchImpl, product, apiKey });
  // On a default port, a bare 401/403 is just as likely a secured Jenkins or dashboard; require an API-style body.
  if (isAuthError(models.error) && (configured || models.error.detail !== null)) {
    return {
      runtime: runtime(null),
      health: { ok: false, version: null, error: authErrorMessage(!!apiKey) },
      product: null,
      configured,
    };
  }
  if (!models.value) return null;
  const product = productFromOwner(models.value.data) ?? ((await isLmStudio(client, timeoutMs)) ? 'lmstudio' : null);
  return {
    runtime: runtime(product),
    health: { ok: true, version: null, error: null },
    product,
    configured,
  };
}

async function isLmStudio(client: HttpClient, timeoutMs: number): Promise<boolean> {
  return requestJson(client, '/api/v0/models', lmStudioModelsSchema, { timeoutMs }).then(
    () => true,
    () => false
  );
}
