import { z } from 'zod';

/**
 * The labelled verdict eval: how the automated abuse verdicts agree with what admins decided. Graded
 * by apps/client/server/security/verdictEval/gradeVerdicts.ts and served by
 * GET /api/admin/shadow-detections/verdict-eval. It is the evidence for moving auto-containment from
 * shadow to enforce.
 */

export const VERDICT_EVAL_WINDOWS = [7, 30, 90] as const;
export type VerdictEvalWindowDays = (typeof VERDICT_EVAL_WINDOWS)[number];

/**
 * What is graded: the AI assessment of a detection (per model), the auto-containment decision on a
 * detection (per mode), and the signup chart's verdict on an account (the Users list's
 * Suspected / Likely legit chip).
 */
export const VERDICT_EVAL_GRADERS = ['assessment', 'containment', 'signupVerdict'] as const;
export type VerdictEvalGrader = (typeof VERDICT_EVAL_GRADERS)[number];

export const VERDICT_EVAL_LABELS = ['abuse', 'legit'] as const;
export type VerdictEvalLabel = (typeof VERDICT_EVAL_LABELS)[number];

/**
 * Where a label came from, strongest first: the admin verdict on the detection, an admin reinstating
 * or undoing a containment, an admin suspension or Contain, or the signup risk review.
 */
export const VERDICT_EVAL_LABEL_SOURCES = ['adminVerdict', 'reinstated', 'adminSuspended', 'riskReview'] as const;
export type VerdictEvalLabelSource = (typeof VERDICT_EVAL_LABEL_SOURCES)[number];

export const verdictEvalScoreSchema = z.object({
  grader: z.enum(VERDICT_EVAL_GRADERS),
  /** The model for an assessment, the mode for a containment decision, 'chart' for the signup verdict. */
  variant: z.string(),
  truePositive: z.number().int().min(0),
  falsePositive: z.number().int().min(0),
  falseNegative: z.number().int().min(0),
  trueNegative: z.number().int().min(0),
  /** Labelled items the grader gave no verdict on (insufficient evidence, pending, unclassified). */
  abstained: z.number().int().min(0),
  /** Of the items it called abuse, the share admins labelled abuse; null with none called. */
  precision: z.number().min(0).max(1).nullable(),
  /** Of the items admins labelled abuse, the share it called abuse; null with none labelled. */
  hitRate: z.number().min(0).max(1).nullable(),
  /** Of the items admins labelled legit, the share it called abuse; null with none labelled. */
  falsePositiveRate: z.number().min(0).max(1).nullable(),
});
export type VerdictEvalScore = z.infer<typeof verdictEvalScoreSchema>;

export const verdictEvalDisagreementSchema = z.object({
  grader: z.enum(VERDICT_EVAL_GRADERS),
  variant: z.string(),
  kind: z.enum(['falsePositive', 'falseNegative']),
  detectionId: z.string().nullable(),
  userId: z.string().nullable(),
  predicted: z.string(),
  label: z.enum(VERDICT_EVAL_LABELS),
  labelSource: z.enum(VERDICT_EVAL_LABEL_SOURCES),
  confidence: z.number().min(0).max(1).nullable(),
  at: z.coerce.date(),
});
export type VerdictEvalDisagreement = z.infer<typeof verdictEvalDisagreementSchema>;

/**
 * Groups of legitimate users that detectors are more likely to flag by mistake. Assistive technology
 * leaves no stored signal, so it is listed but never measurable.
 */
export const EVAL_COHORTS = ['mobile', 'sharedNetwork', 'apiAgent', 'assistive'] as const;
export type EvalCohort = (typeof EVAL_COHORTS)[number];
export const evalCohortSchema = z.enum(EVAL_COHORTS);

export const verdictEvalCohortRowSchema = z.object({
  cohort: evalCohortSchema,
  measurable: z.boolean(),
  /** Accounts in the cohort that a detection flagged. */
  flaggedAccounts: z.number().int().min(0),
  /** Of those, the accounts with an admin label. */
  labelledAccounts: z.number().int().min(0),
  abuse: z.number().int().min(0),
  legit: z.number().int().min(0),
  /** Labelled accounts labelled legit; null with none labelled. */
  falsePositiveShare: z.number().min(0).max(1).nullable(),
});
export type VerdictEvalCohortRow = z.infer<typeof verdictEvalCohortRowSchema>;

export const verdictEvalOperationsRowSchema = z.object({
  detector: z.string(),
  /** Detections of this detector in the window. */
  detections: z.number().int().min(0),
  /** Detections an admin gave a verdict. */
  reviewed: z.number().int().min(0),
  /** Reviewed detections whose verdict was not insufficient evidence. */
  conclusive: z.number().int().min(0),
  /** Confirmed abuse over conclusive verdicts; null with none. */
  reviewYield: z.number().min(0).max(1).nullable(),
  /** Hours from the earliest member signup to detection, over detections labelled abuse. */
  timeToDetection: z.object({ n: z.number().int().min(1), medianHours: z.number(), p90Hours: z.number() }).nullable(),
  /** Credits charged to members of detections labelled abuse, split at the detection time. */
  spend: z
    .object({
      accounts: z.number().int().min(0),
      creditsBeforeDetection: z.number(),
      creditsAfterDetection: z.number(),
    })
    .nullable(),
});
export type VerdictEvalOperationsRow = z.infer<typeof verdictEvalOperationsRowSchema>;

export const verdictEvalReportSchema = z.object({
  since: z.coerce.date(),
  detections: z.number().int().min(0),
  labelledDetections: z.number().int().min(0),
  labelledAccounts: z.number().int().min(0),
  /** Accounts whose only label would have been a risk review approved by policy, not by an admin. */
  excludedAutoApprovals: z.number().int().min(0),
  scores: z.array(verdictEvalScoreSchema),
  /** One row per detector, by name. */
  operations: z.array(verdictEvalOperationsRowSchema),
  /** Flagged accounts by cohort, one row per cohort. */
  cohorts: z.array(verdictEvalCohortRowSchema),
  /** Newest first, capped; false negatives are the farms the grader let through. */
  disagreements: z.array(verdictEvalDisagreementSchema),
  /** True when a read hit its cap, so the counts cover only the newest part of the window. */
  truncated: z.boolean(),
});
export type VerdictEvalReport = z.infer<typeof verdictEvalReportSchema>;

export const verdictEvalQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((value): value is VerdictEvalWindowDays => (VERDICT_EVAL_WINDOWS as readonly number[]).includes(value))
    .default(30),
});
