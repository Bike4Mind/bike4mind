import type { Logger } from '@bike4mind/observability';
import type { ProviderCredentialSpec } from './providerAuth';
import { recordProviderCredentialUse, type CredentialProvider } from './providerCredentialMetrics';

/**
 * The credential one provider request goes out with, fixed BEFORE the request is sent. Only a
 * failure up to this point (building the federated client, or the token exchange itself) may
 * fall back to the static key: once a request is sent, any error (5xx, a dead stream) is the
 * caller's, never a reason to resend with another credential, which would double-send and
 * double-bill.
 */
export type ResolvedProviderCredential =
  | { kind: 'federated' }
  | { kind: 'static' | 'user_key'; key: string }
  | { kind: 'static_fallback'; key: string; cause: unknown };

/**
 * Upper bound on the whole up-front exchange (subject token plus provider exchange, each also
 * capped by TOKEN_EXCHANGE_TIMEOUT_MS), so one request waits at most this long before it falls
 * back.
 */
export const EXCHANGE_DEADLINE_MS = 10_000;

/**
 * After a failed exchange, a provider's requests go straight to the static key for this long
 * (still recording `static_fallback` each time), so an exchange outage costs one deadline a
 * minute rather than one per request.
 */
export const EXCHANGE_BACKOFF_MS = 60_000;

const exchangeBackoff = new Map<CredentialProvider, { until: number; cause: unknown }>();

/** Test seam: forget recent exchange failures. */
export const resetProviderCredentialBackoff = (): void => exchangeBackoff.clear();

export interface ResolveCredentialInput {
  provider: CredentialProvider;
  spec: ProviderCredentialSpec;
  /** Set when the federated client could not be built at construction; skips the exchange. */
  setupError: unknown;
  /** Completes the token exchange now, before anything is sent. Throws when it fails. */
  exchange: () => Promise<void>;
  logger: Pick<Logger, 'warn'>;
  /** The caller's abort: an abort while exchanging is rethrown, never turned into a fallback. */
  signal?: AbortSignal;
}

/**
 * Resolve the credential for one request and record it on the ProviderCredentialUse metric:
 * exactly one of static / user_key / federated / static_fallback per resolved request. A
 * federated spec with no fallback key rethrows the exchange failure and records nothing.
 */
export async function resolveCredentialBeforeSend(input: ResolveCredentialInput): Promise<ResolvedProviderCredential> {
  const resolved = await resolve(input);
  recordProviderCredentialUse(input.provider, resolved.kind);
  return resolved;
}

async function resolve({
  provider,
  spec,
  setupError,
  exchange,
  logger,
  signal,
}: ResolveCredentialInput): Promise<ResolvedProviderCredential> {
  if (spec.kind !== 'federated') return spec;
  if (setupError !== undefined) {
    if (spec.fallbackKey === null) throw setupError;
    warnFallback(logger, provider, 'client could not be built (check the deploy env)', setupError);
    return { kind: 'static_fallback', key: spec.fallbackKey, cause: setupError };
  }
  const backoff = exchangeBackoff.get(provider);
  if (spec.fallbackKey !== null && backoff && Date.now() < backoff.until) {
    return { kind: 'static_fallback', key: spec.fallbackKey, cause: backoff.cause };
  }
  try {
    await settleWithinDeadline(exchange, signal);
    exchangeBackoff.delete(provider);
    return { kind: 'federated' };
  } catch (err) {
    if (signal?.aborted) throw err;
    // Wrapped so a timeout ("...aborted due to timeout") is never mistaken for a user abort.
    if (spec.fallbackKey === null) throw new Error(`${provider} federated token exchange failed`, { cause: err });
    exchangeBackoff.set(provider, { until: Date.now() + EXCHANGE_BACKOFF_MS, cause: err });
    warnFallback(logger, provider, 'token exchange failed', err);
    return { kind: 'static_fallback', key: spec.fallbackKey, cause: err };
  }
}

function warnFallback(logger: Pick<Logger, 'warn'>, provider: CredentialProvider, failed: string, cause: unknown) {
  logger.warn(
    `[providerCredential] ${provider} federated ${failed}; using the static key for ${EXCHANGE_BACKOFF_MS / 1000}s`,
    { error: cause instanceof Error ? cause.message : String(cause) }
  );
}

/**
 * Run `start` and wait until EXCHANGE_DEADLINE_MS or the caller's abort. A lost race abandons
 * the wait, not the exchange. With a fallback key the provider then backs off, so only callers
 * without one may reuse the exchange's shared in-flight promise.
 */
async function settleWithinDeadline(start: () => Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`token exchange exceeded its ${EXCHANGE_DEADLINE_MS}ms deadline`)),
    EXCHANGE_DEADLINE_MS
  );
  const stop = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const work = start();
  work.catch(() => {});
  let onStop = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onStop = () => reject(stop.reason);
    stop.addEventListener('abort', onStop, { once: true });
  });
  try {
    await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', onStop);
  }
}
