import { z } from 'zod';

export const COMPLETION_SEQUENCE_POLICY_VERSION = 1;
export const COMPLETION_SEQUENCE_MIN_ACCOUNTS = 3;
export const COMPLETION_SEQUENCE_MAX_ACCOUNTS = 10;
export const COMPLETION_SEQUENCE_SCAN_LIMIT = 5_000;
export const COMPLETION_SEQUENCE_WINDOW_HOURS = 24;

/** Observation of settlement order, not request start order or an abuse verdict. */
export const completionSequenceEvidenceSchema = z.strictObject({
  source: z.literal('completion_usage_ledger'),
  windowHours: z.literal(COMPLETION_SEQUENCE_WINDOW_HOURS),
  eventsScanned: z.number().int().nonnegative(),
  scanTruncated: z.boolean(),
  rounds: z.number().int().min(2),
  minRequestsPerRound: z.number().int().min(COMPLETION_SEQUENCE_MIN_ACCOUNTS),
  maxRequestsPerRound: z.number().int().min(COMPLETION_SEQUENCE_MIN_ACCOUNTS),
  maxRoundSpanSeconds: z.number().nonnegative(),
  minGapSeconds: z.number().nonnegative(),
  maxGapSeconds: z.number().nonnegative(),
  firstObservedAt: z.date(),
  lastObservedAt: z.date(),
});
export type CompletionSequenceEvidence = z.infer<typeof completionSequenceEvidenceSchema>;
