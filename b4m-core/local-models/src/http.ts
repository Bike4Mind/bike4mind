import { z } from 'zod';
import { LocalRuntimeError, RuntimeConnectionError, RuntimeHttpError, RuntimeProtocolError } from './errors';
import type { FetchLike } from './types';

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const HEALTH_TIMEOUT_MS = 1_500;

export interface HttpClient {
  runtimeId: string;
  baseUrl: string;
  fetch: FetchLike;
  headers?: Record<string, string>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Omit for no deadline beyond `signal`. */
  timeoutMs?: number;
}

// `detail` is the FastAPI error shape.
const errorBodySchema = z.union([
  z
    .object({
      error: z.union([z.string(), z.object({ message: z.string() }).transform(error => error.message)]),
    })
    .transform(body => body.error),
  z.object({ detail: z.string() }).transform(body => body.detail),
]);

/**
 * Accepts `host:port`, `http://host:port` or an OpenAI-style base ending in `/v1`; null when unusable or when
 * it embeds `user:pass@` credentials.
 * `localhost` becomes `127.0.0.1` so both spellings dedupe to one runtime.
 */
export function parseBaseUrl(hostOrUrl: string): string | null {
  const url = toUrl(hostOrUrl);
  if (!url || url.username || url.password) return null;
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${url.origin}${path}`;
}

function toUrl(hostOrUrl: string): URL | null {
  const trimmed = hostOrUrl.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!URL.canParse(withScheme)) return null;
  const url = new URL(withScheme);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url : null;
}

/** `parseBaseUrl` for constructors: throws `LocalRuntimeError` instead of returning null. */
export function requireBaseUrl(hostOrUrl: string, runtimeKind: string): string {
  const url = toUrl(hostOrUrl);
  // The message must not echo the URL: it would leak the password.
  if (url && (url.username || url.password))
    throw new LocalRuntimeError(
      `${runtimeKind} base URL must not contain credentials; pass apiKey instead`,
      runtimeKind
    );
  const baseUrl = parseBaseUrl(hostOrUrl);
  if (!baseUrl) throw new LocalRuntimeError(`Invalid ${runtimeKind} base URL`, runtimeKind);
  return baseUrl;
}

const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The caller's `id` option, or the address-derived default; throws `LocalRuntimeError` for an unusable id. */
export function chooseRuntimeId(id: string | undefined, fallback: string, runtimeKind: string): string {
  if (id === undefined) return fallback;
  if (!RUNTIME_ID.test(id)) throw new LocalRuntimeError(`Invalid ${runtimeKind} runtime id`, runtimeKind);
  return id;
}

export function hostPort(baseUrl: string): string {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname}:${port}`;
}

/** Preserve the familiar HTTP root identity while distinguishing TLS and reverse-proxy roots. */
export function runtimeEndpointId(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.protocol === 'http:' && url.pathname === '/' ? hostPort(baseUrl) : baseUrl;
}

export function combinedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): AbortSignal | undefined {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  if (signal && timeout) return AbortSignal.any([signal, timeout]);
  return signal ?? timeout;
}

/**
 * Wraps a failure below HTTP in `RuntimeConnectionError`. Errors of ours and anything thrown after the
 * caller's `signal` aborted (fetch's `AbortError`, or the abort reason) pass through unchanged.
 */
export function connectionError(
  client: HttpClient,
  path: string,
  error: unknown,
  options: Pick<RequestOptions, 'signal' | 'timeoutMs'> = {}
): unknown {
  if (error instanceof LocalRuntimeError || options.signal?.aborted) return error;
  return new RuntimeConnectionError(
    `${client.runtimeId} ${path} failed: ${describeError(error, options.timeoutMs)}`,
    client.runtimeId,
    { cause: error }
  );
}

// Bytes fetch refuses in a header value; its error would quote the value (an API key) in message and cause.
const INVALID_HEADER_VALUE = /[\0\r\n]|[^\0-\xff]/;

/** Throws `LocalRuntimeError` naming the header, never its value, when fetch would reject that value. */
export function assertHeaderValues(headers: Record<string, string> | undefined, runtimeId: string): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (INVALID_HEADER_VALUE.test(value)) {
      throw new LocalRuntimeError(`${runtimeId} ${name} header contains a character HTTP does not allow`, runtimeId);
    }
  }
}

/** Throws `RuntimeHttpError` on a non-2xx status and `RuntimeConnectionError` when there is no response. */
export async function send(client: HttpClient, path: string, options: RequestOptions = {}): Promise<Response> {
  assertHeaderValues(client.headers, client.runtimeId);
  const hasBody = options.body !== undefined;
  let response: Response;
  try {
    response = await client.fetch(`${client.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: { ...client.headers, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: combinedSignal(options.signal, options.timeoutMs),
      // A redirect could carry the Authorization header to another origin or turn a POST into a GET.
      redirect: 'error',
    });
  } catch (error) {
    throw connectionError(client, path, error, options);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const parsed = errorBodySchema.safeParse(safeJsonParse(text));
    const detail = parsed.success ? parsed.data : null;
    throw new RuntimeHttpError(
      `${client.runtimeId} ${path} returned HTTP ${response.status}${detail === null ? '' : `: ${detail}`}`,
      client.runtimeId,
      response.status,
      detail
    );
  }
  return response;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isAuthError(error: unknown): error is RuntimeHttpError {
  return error instanceof RuntimeHttpError && (error.status === 401 || error.status === 403);
}

export async function requestJson<T extends z.ZodType>(
  client: HttpClient,
  path: string,
  schema: T,
  options: RequestOptions = {}
): Promise<z.infer<T>> {
  const response = await send(client, path, options);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw connectionError(client, path, error, options);
  }
  return parseJson(client, path, text, schema);
}

export function parseJson<T extends z.ZodType>(client: HttpClient, path: string, text: string, schema: T): z.infer<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new RuntimeProtocolError(`${client.runtimeId} ${path} returned invalid JSON`, client.runtimeId, { cause });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RuntimeProtocolError(`${client.runtimeId} ${path} returned an unexpected shape`, client.runtimeId, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Yields each non-empty line of a streamed body, decoding UTF-8 across chunk boundaries. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) yield line;
    }
    pending += decoder.decode();
    if (pending.trim()) yield pending;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** One-line reason for a failed request, suitable for `RuntimeHealth.error`. */
export function describeError(error: unknown, timeoutMs?: number): string {
  if (error instanceof RuntimeConnectionError) return describeError(error.cause, timeoutMs);
  if (error instanceof LocalRuntimeError) return error.message;
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return `timed out${timeoutMs === undefined ? '' : ` after ${timeoutMs}ms`}`;
    if (error.name === 'AbortError') return 'aborted';
    const code = causeCode(error);
    if (code === 'ECONNREFUSED') return 'connection refused';
    if (code) return `${error.message} (${code})`;
    return error.message;
  }
  return String(error);
}

// Node's fetch reports socket failures as `TypeError: fetch failed` with the errno on `cause`.
function causeCode(error: Error): string | undefined {
  const cause: unknown = error.cause;
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') return cause.code;
  return undefined;
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
