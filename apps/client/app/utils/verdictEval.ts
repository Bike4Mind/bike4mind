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

export const verdictEvalReportSchema = z.object({
  since: z.coerce.date(),
  detections: z.number().int().min(0),
  labelledDetections: z.number().int().min(0),
  labelledAccounts: z.number().int().min(0),
  scores: z.array(verdictEvalScoreSchema),
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
