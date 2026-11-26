import { z } from 'zod';
import type { IPlatformUsageEvent, IPlatformUsageEventInput } from './UsageEventTypes';

const identity = z.string().min(1).max(128);
export const PlatformAttribution = z
  .object({
    kind: z.literal('platform_operation'),
    operation: z.enum(['sre_diagnosis', 'secops_triage']),
    environment: z.enum(['production', 'staging', 'development', 'test']),
    logicalJobId: identity,
    executionId: identity,
  })
  .strict();
export type IPlatformAttribution = z.infer<typeof PlatformAttribution>;

export const PlatformAttemptRegistration = z
  .object({
    providerCallId: identity,
    attribution: PlatformAttribution,
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    leaseExpiresAt: z.date(),
  })
  .strict();
export type IPlatformAttemptRegistration = z.infer<typeof PlatformAttemptRegistration>;
export const PLATFORM_ATTEMPT_STATES = ['registered', 'dispatched', 'usage_known', 'recorded', 'unresolved'] as const;
export const PLATFORM_UNRESOLVED_REASONS = ['missing_usage', 'aborted_without_usage', 'expired_intent'] as const;
export type PlatformUnresolvedReason = (typeof PLATFORM_UNRESOLVED_REASONS)[number];

export type IPlatformAttempt = IPlatformAttemptRegistration & {
  state: (typeof PLATFORM_ATTEMPT_STATES)[number];
  dispatchedAt?: Date;
  usage?: IPlatformUsageEventInput;
  unresolvedReason?: PlatformUnresolvedReason;
  createdAt: Date;
  updatedAt: Date;
};

export type PlatformAttemptPage = { attempts: IPlatformAttempt[]; nextCursor?: string };
export type PlatformAttemptDiagnostics = PlatformAttemptPage & {
  total: number;
  byState: Record<'registered' | 'dispatched' | 'usage_known' | 'unresolved', number>;
};

export type PlatformRecoveryFailureCode = 'conflict' | 'persistence_pending' | 'lookup_failed' | 'recovery_failed';
export type PlatformRecoveryResult = {
  recorded: number;
  unresolved: number;
  failed: { providerCallId: string; code: PlatformRecoveryFailureCode }[];
  nextCursor?: string;
};

export interface IPlatformAttemptRepository {
  register(input: IPlatformAttemptRegistration): Promise<IPlatformAttempt>;
  get(providerCallId: string): Promise<IPlatformAttempt | null>;
  claimDispatch(providerCallId: string, dispatchedAt: Date): Promise<boolean>;
  stageUsage(providerCallId: string, usage: IPlatformUsageEventInput): Promise<IPlatformAttempt>;
  markRecorded(providerCallId: string): Promise<void>;
  markUnresolved(providerCallId: string, reason: PlatformUnresolvedReason, expiredBefore?: Date): Promise<void>;
  recoverable(params: {
    now: Date;
    limit: number;
    executionId?: string;
    afterProviderCallId?: string;
  }): Promise<PlatformAttemptPage>;
  diagnostics(params: {
    limit: number;
    executionId?: string;
    afterProviderCallId?: string;
  }): Promise<PlatformAttemptDiagnostics>;
}

export interface IPlatformUsageRecorderRepository {
  recordPlatform(
    event: IPlatformUsageEventInput
  ): Promise<IPlatformUsageEvent | (IPlatformUsageEvent & { id: string })>;
  findPlatformCall(providerCallId: string): Promise<IPlatformUsageEvent | null>;
}

export class PlatformAccountingConflictError extends Error {
  constructor() {
    super('Conflicting platform accounting fact');
    this.name = 'PlatformAccountingConflictError';
  }
}

export function platformAccountingPayload(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return '[' + value.map(platformAccountingPayload).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ':' + platformAccountingPayload(item))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
