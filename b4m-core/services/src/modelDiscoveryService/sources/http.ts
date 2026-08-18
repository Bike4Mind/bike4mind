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
  /**
   * Off by default, and only ever safe on a request that carries no credential.
   * Per WHATWG Fetch a cross-origin redirect strips Authorization, Cookie, Host
   * and Proxy-Authorization and NOTHING else, so the vendor key headers this
   * layer sends (x-api-key, x-goog-api-key, xi-api-key) would be replayed
   * verbatim to whatever origin the 3xx names. Following also amplifies an
   * operator-set base URL (Ollama) into arbitrary hosts. Left off, a redirect is
   * a source failure, which is visible in the run report and fail-safe.
   */
  followRedirects?: boolean;
}

/**
 * 304 is handled before this: it is the one 3xx that is a success carrying no
 * body. Status 0 covers the filtered opaque-redirect response a spec-strict
 * fetch returns for redirect:'manual' instead of the real 3xx.
 */
const isRedirect = (response: Response): boolean =>
  response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);

/** SHA-256 of the fetched body, recorded so "the aggregator changed under us" stays answerable (sec 6.5). */
export const contentHashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Ceiling on one response body. Every read here is buffered whole and hashed, so
 * without a cap a runaway or hostile endpoint is bounded only by the abort
 * deadline. Generous on purpose: litellm's blob is already ~7 MB and grows every
 * release, so this is a runaway guard, not a feed-size policy.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * A URL fit for an error string. Errors land in the run document and the admin
 * UI, and a configured base URL can carry basic-auth credentials
 * (https://user:pass@host) or a key in the query string, so neither survives.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    // Not parseable, so strip the userinfo and query textually rather than
    // letting an unparseable string be the one that leaks.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1').split('?')[0];
  }
}

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
  const safeUrl = redactUrl(request.url);

  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers,
      body: request.body,
      signal: ctx.signal,
      redirect: request.followRedirects ? 'follow' : 'manual',
    });
    const etag = response.headers.get('etag') ?? undefined;
    if (response.status === 304) return { ok: true, status: 304, notModified: true, etag };
    if (isRedirect(response)) {
      return { ok: false, status: response.status, error: `${safeUrl} redirected; refusing to replay the request` };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: `${safeUrl} responded ${response.status}` };
    }
    // Read the body as text first: the content hash must cover the exact bytes,
    // and re-serializing a parsed object would hash a different document.
    const body = await readBounded(response, safeUrl);
    if (!body.ok) return { ok: false, status: response.status, error: body.error };
    return { ok: true, status: response.status, text: body.text, etag };
  } catch (error) {
    return { ok: false, error: abortAware(error, safeUrl) };
  }
}

/**
 * The body as text, refused past MAX_RESPONSE_BYTES. Streamed rather than read
 * whole so an oversized body is abandoned at the cap instead of after it has
 * already been buffered.
 */
async function readBounded(response: Response, safeUrl: string): Promise<{ ok: true; text: string } | HttpFailure> {
  const tooLarge: HttpFailure = {
    ok: false,
    status: response.status,
    error: `${safeUrl} exceeded the ${MAX_RESPONSE_BYTES}-byte response cap`,
  };
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return tooLarge;

  const stream = response.body;
  if (!stream) return { ok: true, text: await response.text() };

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return tooLarge;
    }
    // Streaming decode: a multi-byte character split across two chunks would
    // otherwise decode as two replacement characters and change the hash.
    text += decoder.decode(value, { stream: true });
  }
  return { ok: true, text: text + decoder.decode() };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function abortAware(error: unknown, safeUrl: string): string {
  const isAbort = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
  return isAbort ? `${safeUrl} aborted at the deadline` : `${safeUrl} failed: ${describe(error)}`;
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
