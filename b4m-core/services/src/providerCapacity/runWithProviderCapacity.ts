import { randomUUID } from 'crypto';
import type { ICacheRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { ProviderRateLimitError } from '@bike4mind/utils';

export type ProviderSlotStore = Pick<ICacheRepository, 'tryAcquireLease' | 'releaseLease'>;

export type ProviderBusyReason = 'slots_exhausted' | 'upstream_rate_limited';

/**
 * The provider stayed at capacity for longer than the request could wait. Callers map it to a
 * 429 with `Retry-After` - it is "busy, try again shortly", never a 5xx.
 */
export class ProviderBusyError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: ProviderBusyReason,
    readonly retryAfterSeconds: number
  ) {
    super(`${provider} is at capacity (${reason}); retry in ${retryAfterSeconds}s`);
    this.name = 'ProviderBusyError';
  }
}

export type ProviderCapacityOptions = {
  provider: string;
  logger: Logger;
  /** Semaphore to hold a slot in; omit both to run unslotted (retry on 429 still applies). */
  slots?: { store: ProviderSlotStore; key: string; limit: number };
  /**
   * Whole-request time budget in ms: slot wait, retry backoff and every provider attempt share it.
   * Each attempt's `timeoutMs` is whatever is left, so waiting never pushes the provider call past
   * the deadline the caller sized against its serving-function cap.
   */
  budgetMs: number;
  /** Longest a request waits for a free slot before giving up with `slots_exhausted`. */
  maxSlotWaitMs: number;
  /** Below this much remaining budget a provider attempt is not worth starting. */
  minAttemptMs: number;
  /** Retries after an upstream 429; the first attempt is not counted. */
  maxRetries: number;
  pollIntervalMs?: number;
  retryBaseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
// A lease outlives the request's deadline by this much, so it never lapses under a live holder.
const LEASE_MARGIN_MS = 5_000;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const withJitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));
const toRetryAfterSeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Runs a provider call inside a distributed concurrency slot, retrying upstream 429s within one time
 * budget. Throws ProviderBusyError when capacity does not free up in time; any other error from
 * `attempt` propagates unchanged.
 */
export async function runWithProviderCapacity<T>(
  options: ProviderCapacityOptions,
  attempt: (call: { timeoutMs: number }) => Promise<T>
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.budgetMs;
  const remaining = () => deadline - now();

  const release = await acquireSlot(options, deadline, now, sleep);
  try {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt({ timeoutMs: remaining() });
      } catch (error) {
        if (!(error instanceof ProviderRateLimitError)) throw error;
        const delayMs =
          error.retryAfterMs ?? withJitter((options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS) * 2 ** retry);
        if (retry >= options.maxRetries || remaining() - delayMs < options.minAttemptMs) {
          throw new ProviderBusyError(options.provider, 'upstream_rate_limited', toRetryAfterSeconds(delayMs));
        }
        options.logger.warn(`[providerCapacity] ${options.provider} rate-limited; retrying`, {
          retry: retry + 1,
          delayMs,
        });
        await sleep(delayMs);
      }
    }
  } finally {
    await release();
  }
}

/** Returns the slot's release function; a no-op when running unslotted. */
async function acquireSlot(
  options: ProviderCapacityOptions,
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>
): Promise<() => Promise<void>> {
  const noop = async () => {};
  if (!options.slots) return noop;
  const { store, key, limit } = options.slots;
  const holderId = randomUUID();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const waitUntil = Math.min(now() + options.maxSlotWaitMs, deadline - options.minAttemptMs);

  for (;;) {
    let acquired: boolean;
    try {
      acquired = await store.tryAcquireLease(key, holderId, limit, deadline - now() + LEASE_MARGIN_MS);
    } catch (error) {
      // Fail open: a semaphore outage must not take generation down with it. The 429 retry still
      // guards the provider; the cost is only that this request is not counted.
      options.logger.warn(`[providerCapacity] slot store unavailable; running ${options.provider} unslotted`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return noop;
    }
    if (acquired) {
      return async () => {
        await store.releaseLease(key, holderId).catch((error: unknown) =>
          // The lease lapses on its own; a failed release only holds the slot until then.
          options.logger.warn(`[providerCapacity] failed to release ${options.provider} slot`, {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      };
    }
    const delayMs = withJitter(pollIntervalMs);
    if (now() + delayMs > waitUntil) {
      throw new ProviderBusyError(options.provider, 'slots_exhausted', toRetryAfterSeconds(pollIntervalMs * 5));
    }
    await sleep(delayMs);
  }
}
