import type { Logger } from '@bike4mind/observability';
import {
  DecisionProviderError,
  type DecisionProvider,
  type DecisionProviderRequest,
  type ProviderDecision,
} from './types';

/** Whole-call deadlines, retry included. Images take longer to upload and encode. */
export const DECISION_DEADLINE_MS = { text: 10_000, images: 30_000 } as const;

const RETRY_JITTER_MS = { min: 100, max: 400 } as const;
/** What we tell the caller to wait when the vendor gave no `retry-after` of its own. */
const DEFAULT_RETRY_AFTER_MS = 1_000;

export type DecideWithRetryOptions = {
  provider: DecisionProvider;
  request: DecisionProviderRequest;
  apiKey: string;
  logger: Logger;
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type DecideWithRetryResult = { decision: ProviderDecision; retries: number };

/** Thrown once the one same-model retry is spent or cannot fit in the deadline. Never falls back to another model. */
export class DecisionOverloadedError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    readonly retries: number,
    readonly providerError: DecisionProviderError
  ) {
    super(`decision provider overloaded after ${retries} retr${retries === 1 ? 'y' : 'ies'}: ${providerError.message}`);
    this.name = 'DecisionOverloadedError';
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const attempt = async (options: DecideWithRetryOptions, timeoutMs: number): Promise<ProviderDecision> => {
  const { provider, request, apiKey, logger } = options;
  const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
  try {
    return await provider.decide(request, { apiKey, logger, signal });
  } catch (error) {
    if (error instanceof DecisionProviderError) throw error;
    // A timeout or dropped connection is the same retryable condition as a 5xx.
    if (signal.aborted || error instanceof TypeError) {
      throw new DecisionProviderError('overloaded', signal.aborted ? 'decision provider timed out' : String(error));
    }
    throw error;
  }
};

/**
 * Calls the provider, retrying the SAME model once on `overloaded` after jitter (or the vendor's `retry-after`, when it
 * fits in the deadline). Probabilities are not comparable across models, so there is never a cross-model fallback.
 */
export const decideWithRetry = async (options: DecideWithRetryOptions): Promise<DecideWithRetryResult> => {
  const { now = Date.now, sleep = defaultSleep, random = Math.random, deadlineMs } = options;
  const deadline = now() + deadlineMs;
  try {
    return { decision: await attempt(options, deadlineMs), retries: 0 };
  } catch (error) {
    if (!(error instanceof DecisionProviderError) || error.kind !== 'overloaded') throw error;
    const jitter = RETRY_JITTER_MS.min + random() * (RETRY_JITTER_MS.max - RETRY_JITTER_MS.min);
    const delay = error.details.retryAfterMs ?? jitter;
    const retryAfterSeconds = Math.ceil((error.details.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000);
    if (now() + delay >= deadline) throw new DecisionOverloadedError(retryAfterSeconds, 0, error);
    await sleep(delay);
    try {
      return { decision: await attempt(options, deadline - now()), retries: 1 };
    } catch (retryError) {
      if (retryError instanceof DecisionProviderError && retryError.kind === 'overloaded') {
        const seconds = Math.ceil((retryError.details.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000);
        throw new DecisionOverloadedError(seconds, 1, retryError);
      }
      throw retryError;
    }
  }
};
