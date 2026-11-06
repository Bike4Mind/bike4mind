/**
 * Internal (platform-paid) Decisions calls: the accounting policy, model gate, concurrency slot and
 * failure mapping shared by every internal consumer. Each consumer passes its own cache-key prefix
 * and limits, so budgets, call caps and concurrency never pool across features. Consumers:
 * - apps/client/server/security/abuseAssessment/abuseAssessment.ts (prefix 'abuseAssessment')
 * - apps/client/server/security/signupDomainHoldAssessment/signupDomainHoldAssessment.ts
 */

import { randomUUID } from 'node:crypto';
import {
  DecisionResponseMismatchError,
  getDecisionModelCapabilities,
  type DecisionInput,
  type DecisionModelId,
} from '@bike4mind/common';
import { cacheRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import {
  DecisionOverloadedError,
  DecisionProviderError,
  type ResolvedDecisionInput,
} from '@bike4mind/utils/decisionProviders';
import {
  getDecisionProviderRegistry,
  resolvePlatformDecisionProviderKey,
} from '@bike4mind/server-utils/decisions/providers';
import { DecisionRequestError } from './decisionErrors';
import type { DecisionAccounting } from './executeDecision';

const DAY_MS = 24 * 60 * 60 * 1000;
// Longer than the text deadline (10s) plus a retry, so a lease or claim never lapses mid-call.
const IN_FLIGHT_MS = 60_000;

export type PlatformDecisionSkipReason =
  'disabled' | 'no_model' | 'model_not_callable' | 'budget_exhausted' | 'call_cap_reached' | 'busy' | 'in_flight';

/** A call that was deliberately not made. Consumers may widen `Reason` with their own skips. */
export class DecisionSkipped<Reason extends string = PlatformDecisionSkipReason> extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
    this.name = 'DecisionSkipped';
  }
}

export type PlatformDecisionFailureCode =
  | 'provider_not_configured'
  | 'model_unavailable'
  | 'provider_overloaded'
  | 'provider_rejected'
  | 'provider_error'
  | 'malformed_response'
  | 'refused'
  | 'invalid_request';

/** Per consumer: `keyPrefix` namespaces its cache keys, so its budget and caps are its own. */
export type PlatformDecisionLimits = { keyPrefix: string; dailyBudgetUsd: number; maxCallsPerDay: number };

const toMicroUsd = (usd: number) => Math.ceil(usd * 1_000_000);

/**
 * Platform keys only, and a call cap and USD budget per fixed 24h window. The budget is metered at each
 * call's worst-case cost and not refunded, so it can only under-spend. A zero budget refuses every
 * call, free models included.
 */
export const platformDecisionAccounting = (
  { keyPrefix, dailyBudgetUsd, maxCallsPerDay }: PlatformDecisionLimits,
  logger: Logger
): DecisionAccounting => ({
  resolveProviderKey: provider => resolvePlatformDecisionProviderKey(provider, logger),
  reserve: async ({ maxCostUsd }) => {
    if (dailyBudgetUsd <= 0) throw new DecisionSkipped('budget_exhausted');
    const calls = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `${keyPrefix}:calls`,
      maxCallsPerDay,
      DAY_MS
    );
    if (!calls.success) throw new DecisionSkipped('call_cap_reached');
    const spend = await cacheRepository.tryAddWithinLimitFixedWindow(
      `${keyPrefix}:spendMicroUsd`,
      toMicroUsd(maxCostUsd),
      toMicroUsd(dailyBudgetUsd),
      DAY_MS
    );
    if (!spend.success) throw new DecisionSkipped('budget_exhausted');
    return { refund: async () => {}, fail: async () => {}, settle: async () => 0 };
  },
});

/** The configured model when this deployment serves it and holds a platform key for it. */
export const callablePlatformModel = async (
  { enabled, model }: { enabled: boolean; model: DecisionModelId | null },
  logger: Logger
): Promise<DecisionModelId> => {
  if (!enabled) throw new DecisionSkipped('disabled');
  if (!model) throw new DecisionSkipped('no_model');
  if (!getDecisionProviderRegistry().forModel(model)) throw new DecisionSkipped('model_not_callable');
  const key = await resolvePlatformDecisionProviderKey(getDecisionModelCapabilities(model).provider, logger);
  if (!key) throw new DecisionSkipped('model_not_callable');
  return model;
};

// Internal summaries are JSON only; an image part could only come from a bug, so refuse it outright.
export const resolveJsonInput = async (input: DecisionInput): Promise<ResolvedDecisionInput> => {
  if (typeof input === 'string') return input;
  return input.map(part => {
    if (part.type === 'image')
      throw new DecisionRequestError(422, 'unsupported_input', 'input', 'Images are not accepted');
    return part;
  });
};

/** The diagnostic code for a provider-side failure; null for anything else (skips, bugs), which callers rethrow. */
export const decisionFailureCode = (error: unknown): PlatformDecisionFailureCode | null => {
  if (error instanceof DecisionOverloadedError) return 'provider_overloaded';
  if (error instanceof DecisionResponseMismatchError) return 'malformed_response';
  if (error instanceof DecisionProviderError)
    return error.kind === 'rejected_key' ? 'provider_rejected' : 'provider_error';
  if (error instanceof DecisionRequestError) {
    if (error.errorCode === 'provider_not_configured') return 'provider_not_configured';
    if (error.errorCode === 'model_unavailable') return 'model_unavailable';
    return 'invalid_request';
  }
  return null;
};

/** Runs `work` while holding one of the consumer's concurrency slots and an in-flight claim on `cacheKey`. */
export async function withPlatformCallSlot<T>(
  { keyPrefix, cacheKey, maxConcurrency }: { keyPrefix: string; cacheKey: string; maxConcurrency: number },
  work: () => Promise<T>
): Promise<T> {
  const inflightKey = `${keyPrefix}:inflight:${cacheKey}`;
  const concurrencyKey = `${keyPrefix}:concurrency`;
  const claim = await cacheRepository.claimDedup(inflightKey, {}, IN_FLIGHT_MS);
  if (!claim.claimed) throw new DecisionSkipped('in_flight');
  const holderId = randomUUID();
  try {
    if (!(await cacheRepository.tryAcquireLease(concurrencyKey, holderId, maxConcurrency, IN_FLIGHT_MS))) {
      throw new DecisionSkipped('busy');
    }
    try {
      return await work();
    } finally {
      await cacheRepository.releaseLease(concurrencyKey, holderId);
    }
  } finally {
    await cacheRepository.deleteByKey(inflightKey);
  }
}
