import type { FetchLike, OpenAICompatibleProduct } from '../types';
import { describeFailure } from './failure';
import type { ModelServerKind } from './modelServerFile';
import { ServerRedirectError, ServerTransportError } from './serverFetch';

export interface ProbeOutcome {
  kind: ModelServerKind | null;
  product: OpenAICompatibleProduct | null;
  version: string | null;
  latencyMs: number | null;
  models: number | null;
  auth: boolean;
  /** A 403 with no 401: the request was refused, not asked for credentials. */
  forbidden: boolean;
  error: string | null;
  refused: boolean;
}

const PROBE_TIMEOUT_MS = 5_000;
const OWNER_PRODUCT: Record<string, OpenAICompatibleProduct> = { llamacpp: 'llama-server', vllm: 'vllm' };

/** Identifies the server by what it answers, never by port, and times the answer. */
export async function probeServer(
  fetch: FetchLike,
  baseUrl: string,
  label: string,
  now: () => number,
  expected?: ModelServerKind
): Promise<ProbeOutcome> {
  const get = async (path: string) => {
    const started = now();
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const latencyMs = Math.round(now() - started);
      const body: unknown = response.ok
        ? await response.json().catch(() => null)
        : (await response.body?.cancel(), null);
      return { status: response.status, body, latencyMs, error: null as unknown };
    } catch (error) {
      return { status: 0, body: null, latencyMs: null, error };
    }
  };
  const [version, models] = await Promise.all([
    expected === 'openai-compatible' ? null : get('/api/version'),
    expected === 'ollama' ? null : get('/v1/models'),
  ]);
  const auth = [version, models].some(result => result?.status === 401);
  const ollamaVersion = (version?.body as { version?: unknown } | null)?.version;
  if (version && version.status === 200 && typeof ollamaVersion === 'string') {
    const tags = await get('/api/tags');
    const listed = (tags.body as { models?: unknown } | null)?.models;
    return {
      kind: 'ollama',
      product: null,
      version: ollamaVersion,
      latencyMs: version.latencyMs,
      models: Array.isArray(listed) ? listed.length : null,
      auth: false,
      forbidden: false,
      error: null,
      refused: false,
    };
  }
  const data = (models?.body as { data?: unknown } | null)?.data;
  if (models && models.status === 200 && Array.isArray(data)) {
    const owner = data
      .map(entry => (entry as { owned_by?: unknown } | null)?.owned_by)
      .find(value => typeof value === 'string' && value in OWNER_PRODUCT) as string | undefined;
    const product = owner ? OWNER_PRODUCT[owner] : null;
    return {
      kind: 'openai-compatible',
      product,
      version: await openAIVersion(get, product),
      latencyMs: models.latencyMs,
      models: data.length,
      auth: false,
      forbidden: false,
      error: null,
      refused: false,
    };
  }
  const failure = [version, models].find(result => result && result.error)?.error;
  const forbidden = !auth && [version, models].some(result => result?.status === 403);
  const refused = forbidden || failure instanceof ServerTransportError || failure instanceof ServerRedirectError;
  const status = [version, models].find(result => result && result.status > 0)?.status;
  return {
    kind: null,
    product: null,
    version: null,
    latencyMs: null,
    models: null,
    auth,
    forbidden,
    refused,
    error: forbidden
      ? forbiddenMessage(label)
      : failure
        ? refused
          ? describeFailure(failure)
          : `Could not reach ${label}: ${describeFailure(failure)}`
        : status
          ? `${label} answered HTTP ${status}, not as Ollama or an OpenAI-compatible server.`
          : null,
  };
}

/** A 403 is a refusal, not a credentials prompt; Desktop's ServerForbiddenError carries the same text. */
export function forbiddenMessage(label: string): string {
  return `${label} answered 403 Forbidden: the server or a proxy in front of it refused the request.`;
}

async function openAIVersion(
  get: (path: string) => Promise<{ status: number; body: unknown }>,
  product: OpenAICompatibleProduct | null
): Promise<string | null> {
  if (product === 'llama-server') {
    const props = await get('/props');
    const build = (props.body as { build_info?: unknown } | null)?.build_info;
    return typeof build === 'string' ? build : null;
  }
  if (product === 'vllm') {
    const version = (await get('/version')).body as { version?: unknown } | null;
    return typeof version?.version === 'string' ? version.version : null;
  }
  return null;
}

/** Whether the server lists its models with no credential at all. */
export async function answersWithoutCredentials(
  fetch: FetchLike,
  baseUrl: string,
  kind: ModelServerKind
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${kind === 'ollama' ? '/api/tags' : '/v1/models'}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
