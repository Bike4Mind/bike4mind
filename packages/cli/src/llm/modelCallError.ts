import { B4mApiError, B4mStreamEndedError } from '@bike4mind/sdk';

/**
 * Why a model call failed, as far as retrying is concerned. The first five are transient and
 * retried by {@link decideRetry}; `auth` and `refused` are answers that a retry would repeat.
 */
export type ModelCallErrorKind =
  'rate_limited' | 'overloaded' | 'server' | 'network' | 'stream_idle' | 'auth' | 'refused';

export type ModelCallErrorDetails = {
  status?: number;
  /** Server-requested wait before retrying, from a Retry-After header or frame. */
  retryAfterMs?: number;
  /** The server's machine-readable code (an envelope `errorCode` or an SSE frame `code`). */
  code?: string;
  requestId?: string;
  cause?: unknown;
};

/**
 * A classified model-call failure. `message` keeps the wording callers already show and match on
 * (utils/handoff.ts isLlmUnavailableError); retry decisions read `kind`, never the message.
 */
export class ModelCallError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly cause?: unknown;

  constructor(
    readonly kind: ModelCallErrorKind,
    message: string,
    details: ModelCallErrorDetails = {}
  ) {
    super(message);
    this.name = 'ModelCallError';
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.code = details.code;
    this.requestId = details.requestId;
    this.cause = details.cause;
  }
}

/**
 * Node / axios / undici codes for a connection that failed or was cut. Node reports a TLS socket
 * closed mid-response (an idle intermediary timing out a long thinking step) as `Error: aborted`
 * with code ECONNRESET; undici puts its code on `cause`.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_NETWORK',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function errorCodeOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** True when `error` (or its `cause`) carries a code for a failed or dropped connection. */
export function hasNetworkErrorCode(error: unknown): boolean {
  const code = errorCodeOf(error) ?? errorCodeOf((error as { cause?: unknown } | null)?.cause);
  return code !== undefined && NETWORK_ERROR_CODES.has(code);
}

/** Kind for an HTTP status from the B4M API or a model provider behind it. */
export function kindForStatus(status: number): ModelCallErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  if (status === 408) return 'network';
  if (status >= 500) return 'server';
  if (status === 401) return 'auth';
  return 'refused';
}

/**
 * Kind for a pre-stream B4M API error. A 5xx the server labelled with an `errorCode` (e.g.
 * `provider_not_configured`) is a deliberate answer, not a hiccup, so it is not retried.
 */
export function kindForApiError(error: B4mApiError): ModelCallErrorKind {
  const kind = kindForStatus(error.status);
  if (error.errorCode && (kind === 'server' || kind === 'overloaded')) return 'refused';
  return kind;
}

/**
 * Classify an error a transport let through unclassified: a typed {@link ModelCallError} as is,
 * a dropped connection as `network`. Anything else returns undefined and is not retried.
 */
export function classifyModelCallError(error: unknown): ModelCallError | undefined {
  if (error instanceof ModelCallError) return error;
  if (!(error instanceof Error)) return undefined;
  if (error instanceof B4mStreamEndedError || hasNetworkErrorCode(error)) {
    return new ModelCallError('network', error.message, { code: errorCodeOf(error), cause: error });
  }
  return undefined;
}

/** True for a dropped, refused or stalled connection: the request may never have been answered. */
export function isConnectionDrop(error: unknown): error is Error {
  const kind = classifyModelCallError(error)?.kind;
  return kind === 'network' || kind === 'stream_idle';
}
