import { z } from 'zod';

export const COMPLETION_SYNCHRONY_POLICY_VERSION = 1;
export const API_COMPLETION_OUTCOMES = [
  'completed',
  'daily_cap_rejected',
  'rejected',
  'failed',
  'interrupted',
  'unknown',
] as const;
export const API_COMPLETION_OUTCOME_LABELS = {
  completed: 'Completed',
  daily_cap_rejected: 'Stopped: daily free-tier cap',
  rejected: 'Rejected',
  failed: 'Failed',
  interrupted: 'Connection interrupted',
  unknown: 'Unknown',
} as const;
export type ApiCompletionOutcome = (typeof API_COMPLETION_OUTCOMES)[number];
export const apiCompletionObservationSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  requestedModel: z.string().min(1).max(256),
  startedAt: z.string().datetime(),
  outcome: z.enum(API_COMPLETION_OUTCOMES),
});
export type ApiCompletionObservation = z.infer<typeof apiCompletionObservationSchema>;

export const completionSynchronyEvidenceSchema = z.strictObject({
  source: z.literal('api_key_request_starts'),
  windowHours: z.literal(24),
  eventsScanned: z.number().int().nonnegative(),
  legacyRows: z.number().int().nonnegative(),
  scanTruncated: z.boolean(),
  bursts: z.number().int().min(3),
  synchronizedModelSwitches: z.number().int().nonnegative(),
  distinctRequestedModels: z.number().int().positive(),
  maxStartSkewMilliseconds: z.number().nonnegative(),
  completedRequests: z.number().int().nonnegative(),
  dailyCapRejectedRequests: z.number().int().nonnegative(),
  otherRejectedRequests: z.number().int().nonnegative(),
  interruptedOrUnknownRequests: z.number().int().nonnegative(),
  creditExposure: z
    .strictObject({
      scope: z.literal('cohort_completion_api_24h'),
      creditsCharged: z.number().nonnegative(),
      grantFundedCredits: z.number().nonnegative(),
      unknownFundingCredits: z.number().nonnegative(),
      scanTruncated: z.boolean(),
    })
    .optional(),
  scannedAt: z.date(),
  firstObservedAt: z.date(),
  lastObservedAt: z.date(),
});
export type CompletionSynchronyEvidence = z.infer<typeof completionSynchronyEvidenceSchema>;

export const REVIEW_ONLY_COMPLETION_DETECTORS = ['completionSequence', 'completionSynchrony'] as const;
export const isReviewOnlyCompletionDetector = (detector: string): boolean =>
  REVIEW_ONLY_COMPLETION_DETECTORS.some(candidate => candidate === detector);
