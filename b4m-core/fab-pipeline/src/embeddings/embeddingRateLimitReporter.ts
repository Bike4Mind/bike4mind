/**
 * Passive reporting of embedding-provider rate-limit ceilings.
 *
 * A rate limit belongs to the provider organization behind the key, and every embedding response
 * already carries the ceiling in its headers, so reading them costs no extra request and no extra
 * tokens. Providers that do not report them (Bedrock, Ollama) simply never produce an observation.
 *
 * This module owns the "what did the provider say" half only. It has no opinion about data lakes
 * or about the throughput levers configured against these numbers; interpreting a ceiling against
 * a lever belongs to the layer that knows what the levers are.
 */
import { hasUsableLimits, parseEmbeddingRateLimitHeaders, type EmbeddingRateLimitSnapshot } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { EmbeddingModelProvider } from './EmbeddingService';

/** A ceiling reading taken off a response the caller was already making. */
export interface EmbeddingRateLimitObservation {
  provider: EmbeddingModelProvider;
  model: string;
  /** Which provider account the reading describes. See `recordEmbeddingRateLimitHeaders`. */
  account: string;
  snapshot: EmbeddingRateLimitSnapshot;
  /** Epoch ms. */
  observedAt: number;
}

/**
 * Remaining/limit ratio at or below which the provider counts as under pressure. A bulk re-index
 * draws its window down steadily, so this sits low enough that ordinary throughput does not trip
 * it and only genuine starvation does.
 */
const PRESSURE_RATIO = 0.1;

/**
 * Pressure lasts as long as the window does, and every call in that window reports it. Throttle to
 * one line per interval so a starved ingest leaves a readable trace instead of flooding the log.
 */
const PRESSURE_LOG_INTERVAL_MS = 60_000;

interface ProviderState {
  last: EmbeddingRateLimitObservation;
  lastPressureLogAt: number | null;
}

/**
 * Process-local, and deliberately so: a cold start re-reports what it measures rather than leaving
 * a gap shared storage would have to close. Keyed by provider+model+account, so the map is bounded
 * by the model list times the number of distinct credentials the process serves.
 */
const stateByKey = new Map<string, ProviderState>();

/**
 * A broken reporter is indistinguishable from a steady ceiling - both are silence - so the first
 * fault has to be loud. Subsequent ones drop to debug: whatever breaks here breaks on every
 * embedding call, and a bulk re-index would drown the log in it.
 */
let hasReportedFailure = false;

const keyFor = (provider: EmbeddingModelProvider, model: string, account: string): string =>
  `${provider}:${model}:${account}`;

const ceilingChanged = (previous: EmbeddingRateLimitSnapshot, next: EmbeddingRateLimitSnapshot): boolean =>
  previous.limitTokens !== next.limitTokens || previous.limitRequests !== next.limitRequests;

// Per-minute is an OpenAI/VoyageAI fact, not a universal one. A provider that reports a different
// window has to render its own units rather than reuse this.
const describeCeiling = (snapshot: EmbeddingRateLimitSnapshot): string =>
  `${snapshot.limitTokens ?? 'unreported'} tokens/min, ${snapshot.limitRequests ?? 'unreported'} requests/min`;

/** Ratio of the window still available, or null when the provider did not report that dimension. */
const remainingRatio = (remaining: number | null, limit: number | null): number | null => {
  // A limit of 0 would make the ratio meaningless rather than infinite, so it is not a reading.
  if (remaining === null || limit === null || limit <= 0) return null;
  return remaining / limit;
};

const pressuredDimensions = (snapshot: EmbeddingRateLimitSnapshot): string[] => {
  const tokens = remainingRatio(snapshot.remainingTokens, snapshot.limitTokens);
  const requests = remainingRatio(snapshot.remainingRequests, snapshot.limitRequests);
  const dimensions: string[] = [];
  if (tokens !== null && tokens <= PRESSURE_RATIO) dimensions.push('tokens');
  if (requests !== null && requests <= PRESSURE_RATIO) dimensions.push('requests');
  return dimensions;
};

/**
 * Read the rate-limit headers off an embedding response and report the ceiling when it is worth
 * reporting: the first sighting in this process, a change since the last sighting, or the window
 * running down. Returns the observation when the provider reported a usable ceiling, else null.
 *
 * `account` identifies the provider account the reading belongs to and is part of the memo key,
 * not just the log line. The credential is resolved per user - a stored personal key beats the
 * platform key in `getEffectiveLLMApiKeys` - so one process can see several accounts on the same
 * provider+model. Without the discriminator their readings would collapse into one entry that
 * flaps between unrelated ceilings and attributes each figure to whoever reads the log next. The
 * caller supplies it; it must never be key material.
 *
 * Never throws. This hangs off the hot path of every embedding call, and a reporting fault must
 * not be able to fail an embedding that otherwise succeeded.
 */
export function recordEmbeddingRateLimitHeaders(
  provider: EmbeddingModelProvider,
  model: string,
  account: string,
  headers: unknown,
  now: number = Date.now()
): EmbeddingRateLimitObservation | null {
  try {
    const snapshot = parseEmbeddingRateLimitHeaders(headers);
    if (!hasUsableLimits(snapshot)) return null;

    const key = keyFor(provider, model, account);
    const previous = stateByKey.get(key);
    const observation: EmbeddingRateLimitObservation = { provider, model, account, snapshot, observedAt: now };
    const subject = `${provider} ${model} (account ${account})`;

    if (!previous) {
      Logger.globalInstance.info(`[embedding-limits] ${subject} ceiling measured: ${describeCeiling(snapshot)}`, {
        provider,
        model,
        account,
        limitTokens: snapshot.limitTokens,
        limitRequests: snapshot.limitRequests,
      });
    } else if (ceilingChanged(previous.last.snapshot, snapshot)) {
      // Same account, different ceiling: the provider moved this account's tier or quota. A key
      // rotation to a DIFFERENT organization does not land here - it is a new account, so it
      // reports as a fresh "ceiling measured" naming an organization the log has not carried before.
      Logger.globalInstance.warn(
        `[embedding-limits] ${subject} ceiling CHANGED: was ${describeCeiling(previous.last.snapshot)}, ` +
          `now ${describeCeiling(snapshot)}. Reconcile any throughput lever governed by this account ` +
          `against the new figure.`,
        {
          provider,
          model,
          account,
          previousLimitTokens: previous.last.snapshot.limitTokens,
          previousLimitRequests: previous.last.snapshot.limitRequests,
          limitTokens: snapshot.limitTokens,
          limitRequests: snapshot.limitRequests,
        }
      );
    }

    const pressured = pressuredDimensions(snapshot);
    const dueForPressureLog =
      previous?.lastPressureLogAt == null || now - previous.lastPressureLogAt >= PRESSURE_LOG_INTERVAL_MS;
    const logPressure = pressured.length > 0 && dueForPressureLog;

    if (logPressure) {
      Logger.globalInstance.warn(
        `[embedding-limits] ${subject} is at or below ${PRESSURE_RATIO * 100}% of its ` +
          `${pressured.join(' and ')} window`,
        {
          provider,
          model,
          account,
          remainingTokens: snapshot.remainingTokens,
          remainingRequests: snapshot.remainingRequests,
          limitTokens: snapshot.limitTokens,
          limitRequests: snapshot.limitRequests,
          resetTokensMs: snapshot.resetTokensMs,
          resetRequestsMs: snapshot.resetRequestsMs,
        }
      );
    }

    stateByKey.set(key, {
      last: observation,
      lastPressureLogAt: logPressure ? now : (previous?.lastPressureLogAt ?? null),
    });

    return observation;
  } catch (error) {
    // Degrade rather than fail: this is a side-channel on a call whose result the caller needs.
    const message = `[embedding-limits] failed to record rate-limit headers: ${error}`;
    if (hasReportedFailure) {
      Logger.globalInstance.debug(message);
    } else {
      hasReportedFailure = true;
      Logger.globalInstance.warn(message);
    }
    return null;
  }
}

/**
 * The most recent ceiling this process measured for a provider+model+account, or null if it has
 * not made such a call yet. Doubles as the assertion seam for the provider tests, which would
 * otherwise have to read the reporting decision back out of a log spy, and as the read seam for a
 * layer that wants to interpret a ceiling - comparing it against a configured throughput lever
 * being the obvious one.
 */
export function getLastObservedEmbeddingRateLimit(
  provider: EmbeddingModelProvider,
  model: string,
  account: string
): EmbeddingRateLimitObservation | null {
  return stateByKey.get(keyFor(provider, model, account))?.last ?? null;
}

/** Test seam: the module's memo is process-local state that leaks between test cases otherwise. */
export function __resetEmbeddingRateLimitReporterForTests(): void {
  stateByKey.clear();
  hasReportedFailure = false;
}
