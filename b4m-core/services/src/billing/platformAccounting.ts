import {
  PlatformAttribution,
  PlatformUsageEvent,
  PlatformAttemptRegistration,
  PlatformAccountingConflictError,
  platformUsagePayload,
  type IPlatformAttribution,
  type IPlatformAttempt,
  type IPlatformAttemptRepository,
  type IPlatformAttemptRegistration,
  type IPlatformUsageEventInput,
  type IPlatformUsageRecorderRepository,
  type ModelInfo,
  type PlatformUnresolvedReason,
  type PlatformAttemptDiagnostics,
  type PlatformRecoveryResult,
  type UsageEventStatus,
} from '@bike4mind/common';
import { priceCompletionUsage } from './priceCompletionUsage';

export class PlatformAccountingPendingError extends Error {
  constructor(
    readonly providerCallId: string,
    options?: ErrorOptions
  ) {
    super('Platform accounting requires durable recovery', options);
    this.name = 'PlatformAccountingPendingError';
  }
}

export function createPlatformAttribution(
  configuration: {
    environment: IPlatformAttribution['environment'];
    operation?: IPlatformAttribution['operation'];
  },
  execution: { logicalJobId: string; executionId: string }
): IPlatformAttribution {
  return PlatformAttribution.parse({
    kind: 'platform_operation',
    operation: configuration.operation ?? 'sre_diagnosis',
    environment: configuration.environment,
    logicalJobId: execution.logicalJobId,
    executionId: execution.executionId,
  });
}

export function pricePlatformUsage(params: {
  attempt: IPlatformAttempt;
  model: ModelInfo;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheWrite1hInputTokens?: number;
  };
  outcome: UsageEventStatus;
  completedAt: Date;
  providerRequestId?: string;
  providerOccurredAt?: Date;
  now?: Date;
}): IPlatformUsageEventInput {
  const { attempt, model, usage } = params;
  if (!attempt.dispatchedAt) throw new PlatformAccountingConflictError();
  if (model.id !== attempt.model || model.backend !== attempt.provider) throw new PlatformAccountingConflictError();
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'cacheWrite1hInputTokens',
  ] as const) {
    const quantity = usage[key];
    if ((key === 'inputTokens' || key === 'outputTokens') && quantity === undefined)
      throw new Error('Missing provider usage');
    if (quantity !== undefined && (!Number.isSafeInteger(quantity) || quantity < 0))
      throw new Error('Invalid provider usage');
  }
  if ((usage.cacheWrite1hInputTokens ?? 0) > (usage.cacheCreationInputTokens ?? 0))
    throw new Error('Invalid one-hour cache usage');
  const priced = priceCompletionUsage(model, usage);
  const now = params.now ?? new Date();
  const event = PlatformUsageEvent.parse({
    attribution: attempt.attribution,
    providerCallId: attempt.providerCallId,
    requestId: attempt.attribution.executionId,
    feature: 'operations',
    provider: model.backend,
    model: model.id,
    source: 'system',
    keySource: 'platform',
    inputTokens: 0,
    outputTokens: 0,
    providerInputTokens: usage.inputTokens,
    providerOutputTokens: usage.outputTokens,
    cachedInputTokens: priced.cachedInputTokens,
    cacheWriteTokens: priced.cacheWriteTokens,
    costUsd: priced.costUsd,
    creditsCharged: 0,
    settledBasis: 'provider',
    status: params.outcome,
    ...priced.priceStamp,
    usageOccurredAt: params.providerOccurredAt ?? attempt.dispatchedAt,
    timestampSource: params.providerOccurredAt ? 'provider' : 'dispatch',
    dispatchedAt: attempt.dispatchedAt,
    completedAt: params.completedAt,
    recordedAt: now,
    providerRequestId: params.providerRequestId,
    createdAt: now,
    updatedAt: now,
  });
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...fact } = event;
  return fact;
}

export class PlatformAccounting {
  constructor(
    private readonly attempts: IPlatformAttemptRepository,
    private readonly usage: IPlatformUsageRecorderRepository
  ) {}

  async register(input: IPlatformAttemptRegistration): Promise<IPlatformAttempt> {
    return this.attempts.register(PlatformAttemptRegistration.parse(input));
  }

  async claimDispatch(providerCallId: string, dispatchedAt: Date): Promise<boolean> {
    return this.attempts.claimDispatch(providerCallId, dispatchedAt);
  }

  async settle(providerCallId: string, fact: IPlatformUsageEventInput): Promise<void> {
    try {
      const staged = await this.attempts.stageUsage(providerCallId, fact);
      await this.persist(staged);
    } catch (error) {
      if (error instanceof PlatformAccountingConflictError) throw error;
      throw new PlatformAccountingPendingError(providerCallId, { cause: error });
    }
  }

  async unresolved(providerCallId: string, reason: PlatformUnresolvedReason): Promise<void> {
    try {
      const attempt = await this.attempts.get(providerCallId);
      if (!attempt) throw new PlatformAccountingConflictError();
      await this.attempts.markUnresolved(providerCallId, reason);
    } catch (error) {
      if (error instanceof PlatformAccountingConflictError) throw error;
      throw new PlatformAccountingPendingError(providerCallId, { cause: error });
    }
  }

  async recover(params: {
    now: Date;
    limit: number;
    executionId?: string;
    afterProviderCallId?: string;
  }): Promise<PlatformRecoveryResult> {
    if (
      !Number.isInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > 1000 ||
      !Number.isFinite(params.now.getTime())
    )
      throw new Error('Invalid platform recovery page');
    const pending = await this.attempts.recoverable(params);
    if (pending.attempts.length > params.limit) throw new Error('Platform recovery page exceeds its limit');
    const result: PlatformRecoveryResult = {
      recorded: 0,
      unresolved: 0,
      failed: [],
      ...(pending.nextCursor ? { nextCursor: pending.nextCursor } : {}),
    };
    for (const attempt of pending.attempts) {
      let phase: 'lookup' | 'persistence' | 'recovery' = 'recovery';
      try {
        if (attempt.usage) {
          phase = 'persistence';
          await this.settle(attempt.providerCallId, attempt.usage);
          result.recorded++;
        } else {
          phase = 'lookup';
          const existing = await this.usage.findPlatformCall(attempt.providerCallId);
          if (existing) throw new PlatformAccountingConflictError();
          phase = 'persistence';
          await this.attempts.markUnresolved(attempt.providerCallId, 'expired_intent', params.now);
          const updated = await this.attempts.get(attempt.providerCallId);
          if (updated?.state !== 'unresolved') throw new PlatformAccountingPendingError(attempt.providerCallId);
          result.unresolved++;
        }
      } catch (error) {
        result.failed.push({
          providerCallId: attempt.providerCallId,
          code:
            error instanceof PlatformAccountingConflictError
              ? 'conflict'
              : phase === 'lookup'
                ? 'lookup_failed'
                : phase === 'persistence'
                  ? 'persistence_pending'
                  : 'recovery_failed',
        });
      }
    }
    return result;
  }

  async diagnostics(params: {
    limit: number;
    executionId?: string;
    afterProviderCallId?: string;
  }): Promise<PlatformAttemptDiagnostics> {
    return this.attempts.diagnostics(params);
  }

  private async persist(attempt: IPlatformAttempt): Promise<void> {
    if (!attempt.usage) throw new PlatformAccountingConflictError();
    const recorded = await this.usage.recordPlatform(attempt.usage);
    if (platformUsagePayload(recorded) !== platformUsagePayload(attempt.usage))
      throw new PlatformAccountingConflictError();
    await this.attempts.markRecorded(attempt.providerCallId);
  }
}
