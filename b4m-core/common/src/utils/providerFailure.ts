import type { CompletionErrorCause, CompletionErrorCauseKind } from '../schemas/cliCompletions';

/**
 * Classifies a model provider failure from the error a provider SDK or fetch threw, for the
 * completions error frame (CompletionErrorCauseSchema) and the server's failure log.
 *
 * `client_aborted` never reaches the wire: the client that would read it is already gone.
 */
export type ProviderFailureKind = CompletionErrorCauseKind | 'client_aborted';

/** One level of an error's `cause` chain, for server logs only: `message` may be upstream text. */
export interface ProviderFailureCauseLevel {
  name?: string;
  code?: string;
  message?: string;
}

export interface ProviderFailure {
  /** Absent when nothing in the error says how the provider call failed. */
  kind?: ProviderFailureKind;
  /** The allowlisted transport code that decided `kind`. Safe to send to a client. */
  transportCode?: string;
  upstreamStatus?: number;
  /** Total attempts the SDK made, when it reports them (AWS SDK `$metadata.attempts`). */
  sdkAttempts?: number;
  chain: ProviderFailureCauseLevel[];
}

// undici nests the real socket error under `cause`, and Node puts happy-eyeballs connect
// failures under an AggregateError's `errors`; both are walked.
const MAX_LEVELS = 8;
const MAX_LOGGED_MESSAGE = 500;

const TRANSPORT_KINDS = new Map<string, CompletionErrorCauseKind>(
  Object.entries({
    UND_ERR_SOCKET: 'connection_lost',
    UND_ERR_CLOSED: 'connection_lost',
    ECONNRESET: 'connection_lost',
    EPIPE: 'connection_lost',
    ERR_STREAM_PREMATURE_CLOSE: 'connection_lost',
    UND_ERR_HEADERS_TIMEOUT: 'timeout',
    UND_ERR_BODY_TIMEOUT: 'timeout',
    UND_ERR_CONNECT_TIMEOUT: 'timeout',
    ETIMEDOUT: 'timeout',
    ESOCKETTIMEDOUT: 'timeout',
    // axios's own request timeout.
    ECONNABORTED: 'timeout',
    ENOTFOUND: 'unreachable',
    EAI_AGAIN: 'unreachable',
    ECONNREFUSED: 'unreachable',
    EHOSTUNREACH: 'unreachable',
    ENETUNREACH: 'unreachable',
  } satisfies Record<string, CompletionErrorCauseKind>)
);

// AWS SDK request timeouts, AbortSignal.timeout(), and the OpenAI/Anthropic SDKs' connect timeout.
const TIMEOUT_NAMES = new Set(['TimeoutError', 'APIConnectionTimeoutError']);

function readStatus(value: Record<string, unknown>): number | undefined {
  const response = value.response as { status?: unknown } | undefined;
  const metadata = value.$metadata as { httpStatusCode?: unknown } | undefined;
  const status = response?.status ?? metadata?.httpStatusCode ?? value.status;
  return typeof status === 'number' && status >= 100 && status <= 599 ? status : undefined;
}

function walk(error: unknown): Record<string, unknown>[] {
  const levels: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && levels.length < MAX_LEVELS) {
    const next = queue.shift();
    if (!next || typeof next !== 'object' || seen.has(next)) continue;
    seen.add(next);
    const level = next as Record<string, unknown>;
    levels.push(level);
    if (level.cause !== undefined) queue.push(level.cause);
    if (Array.isArray(level.errors)) queue.push(...level.errors);
  }
  return levels;
}

function describeLevel(level: Record<string, unknown>): ProviderFailureCauseLevel {
  const { name, code, message } = level;
  return {
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    ...(typeof message === 'string' ? { message: message.slice(0, MAX_LOGGED_MESSAGE) } : {}),
  };
}

/** Message-only signals, consulted last: they carry no code to report. */
function kindFromMessage(level: Record<string, unknown>): CompletionErrorCauseKind | undefined {
  const message = typeof level.message === 'string' ? level.message.toLowerCase() : '';
  if (level.name === 'TypeError' && message === 'terminated') return 'connection_lost';
  if (/socket hang up|premature close|other side closed/.test(message)) return 'connection_lost';
  if (/\btimed out\b|\bstream timeout\b/.test(message)) return 'timeout';
  return undefined;
}

/**
 * @param clientAborted - the caller's own client went away first. That outranks whatever the
 *   provider call threw afterwards, since the failure may only be fallout from it.
 */
export function classifyProviderFailure(
  error: unknown,
  { clientAborted = false }: { clientAborted?: boolean } = {}
): ProviderFailure {
  const levels = walk(error);
  const chain = levels.map(describeLevel);
  const attempts = levels
    .map(level => (level.$metadata as { attempts?: unknown } | undefined)?.attempts)
    .find((value): value is number => typeof value === 'number');
  const base = { chain, ...(attempts !== undefined ? { sdkAttempts: attempts } : {}) };

  if (clientAborted) return { ...base, kind: 'client_aborted' };

  for (const level of levels) {
    const upstreamStatus = readStatus(level);
    if (upstreamStatus !== undefined) return { ...base, kind: 'upstream_error', upstreamStatus };
  }
  for (const level of levels) {
    const kind = typeof level.code === 'string' ? TRANSPORT_KINDS.get(level.code) : undefined;
    if (kind) return { ...base, kind, transportCode: level.code as string };
  }
  if (levels.some(level => typeof level.name === 'string' && TIMEOUT_NAMES.has(level.name))) {
    return { ...base, kind: 'timeout' };
  }
  for (const level of levels) {
    const kind = kindFromMessage(level);
    if (kind) return { ...base, kind };
  }
  return base;
}

/** `10m 49s`, `45s`, `1h 3m`, `850ms`. */
export function formatFailureDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

// Under a second of silence says nothing about a stall, so the message leaves it out.
const IDLE_WORTH_MENTIONING_MS = 1000;

/**
 * The user-facing message for a `provider_error` frame. Keeps the `(upstream NNN)` suffix
 * verbatim: the CLI's errorFrameToModelCallError reads the status back out of it.
 */
export function describeProviderFailure(cause: CompletionErrorCause | undefined): string {
  const after = cause?.elapsedMs !== undefined ? ` after ${formatFailureDuration(cause.elapsedMs)}` : '';
  const idle =
    cause?.idleMs !== undefined && cause.idleMs >= IDLE_WORTH_MENTIONING_MS
      ? ` (no data for ${formatFailureDuration(cause.idleMs)})`
      : '';
  switch (cause?.kind) {
    case 'connection_lost':
      return `Lost the connection to the model provider${after}${idle}`;
    case 'timeout':
      return `The model provider timed out${after}${idle}`;
    case 'unreachable':
      return 'Could not reach the model provider';
    case 'upstream_error':
      return cause.upstreamStatus === undefined
        ? 'Model provider returned an error'
        : `Model provider returned an error (upstream ${cause.upstreamStatus})`;
    default:
      return 'Model provider returned an error';
  }
}

/**
 * The wire-safe part of a classification: no message text, no chain. Undefined when there is
 * nothing a client could act on.
 */
export function toCompletionErrorCause(
  failure: ProviderFailure,
  timing: { elapsedMs?: number; idleMs?: number } = {}
): CompletionErrorCause | undefined {
  if (!failure.kind || failure.kind === 'client_aborted') return undefined;
  const whole = (ms: number | undefined) => (ms === undefined ? undefined : Math.max(0, Math.round(ms)));
  const elapsedMs = whole(timing.elapsedMs);
  const idleMs = whole(timing.idleMs);
  return {
    kind: failure.kind,
    ...(failure.transportCode ? { transportCode: failure.transportCode } : {}),
    ...(failure.upstreamStatus !== undefined ? { upstreamStatus: failure.upstreamStatus } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(idleMs !== undefined ? { idleMs } : {}),
  };
}
