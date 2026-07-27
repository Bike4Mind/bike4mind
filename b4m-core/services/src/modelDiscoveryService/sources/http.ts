import { createHash } from 'node:crypto';
import type { DiscoveryFetchContext } from '../types';

/**
 * The one shape every source's network call collapses to. A non-2xx, an abort, a
 * transport error and unparseable JSON are all `{ ok: false }` here, which is what
 * keeps the sec 5.5 rule ("never an empty success, never a deletion") from having
 * to be re-derived in ten places.
 */
export interface HttpBody {
  ok: true;
  status: number;
  text: string;
  etag?: string;
  notModified?: false;
}

export interface HttpNotModified {
  ok: true;
  status: 304;
  notModified: true;
  etag?: string;
}

export interface HttpFailure {
  ok: false;
  status?: number;
  error: string;
}

export type TextResult = HttpBody | HttpNotModified | HttpFailure;

export type HttpResult<T> = (HttpBody & { body: T }) | HttpNotModified | HttpFailure;

export interface HttpRequest {
  url: string;
  headers?: Record<string, string>;
  /** Sent as If-None-Match. Only aggregators use it; providers do not publish validators. */
  ifNoneMatch?: string;
  /** Ollama's /api/show is the one read in this layer that is not a GET. */
  method?: 'GET' | 'POST';
  body?: string;
}

/** SHA-256 of the fetched body, recorded so "the aggregator changed under us" stays answerable (sec 6.5). */
export const contentHashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * GET a JSON document under the run's abort signal.
 *
 * 304 is a success carrying no body: the caller decides what an unchanged
 * document means for it. Every other non-2xx is a failure carrying its status,
 * so the run report can tell a 401 (fix the credential) from a 500 (retry later).
 */
export async function fetchJson<T>(request: HttpRequest, ctx: DiscoveryFetchContext): Promise<HttpResult<T>> {
  const result = await fetchText(request, ctx);
  if (!result.ok) return result;
  if (result.notModified) return result;
  try {
    return { ...result, body: JSON.parse(result.text) as T };
  } catch (error) {
    return { ok: false, status: result.status, error: `response was not JSON: ${describe(error)}` };
  }
}

export async function fetchText(request: HttpRequest, ctx: DiscoveryFetchContext): Promise<TextResult> {
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
  if (request.ifNoneMatch) headers['if-none-match'] = request.ifNoneMatch;
  if (request.body !== undefined) headers['content-type'] = 'application/json';

  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers,
      body: request.body,
      signal: ctx.signal,
      redirect: 'follow',
    });
    const etag = response.headers.get('etag') ?? undefined;
    if (response.status === 304) return { ok: true, status: 304, notModified: true, etag };
    if (!response.ok) {
      return { ok: false, status: response.status, error: `${request.url} responded ${response.status}` };
    }
    // Read the body as text first: the content hash must cover the exact bytes,
    // and re-serializing a parsed object would hash a different document.
    const text = await response.text();
    return { ok: true, status: response.status, text, etag };
  } catch (error) {
    return { ok: false, error: abortAware(error, request.url) };
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function abortAware(error: unknown, url: string): string {
  const isAbort = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
  return isAbort ? `${url} aborted at the deadline` : `${url} failed: ${describe(error)}`;
}

/** True while there is still budget to issue another page (sec 6.3). */
export const hasTimeLeft = (ctx: DiscoveryFetchContext): boolean =>
  !ctx.signal.aborted && Date.now() < ctx.deadlineAt.getTime();

/** Trim a value to a non-empty string, or undefined. Feeds ship empty strings. */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A non-negative integer, or undefined. Feeds ship null, -1 and floats. */
export function count(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Drop undefined keys so a patch never claims a field with no value behind it. */
export function compact<T extends object>(patch: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
