import { z } from 'zod';
import { AdminActionReasonSchema, SHADOW_DETECTION_VERDICTS } from '@bike4mind/common';
import {
  VERDICT_EVAL_LABELS,
  VERDICT_EVAL_WINDOWS,
  evalCohortSchema,
  verdictEvalCohortRowSchema,
  verdictEvalScoreSchema,
  type VerdictEvalWindowDays,
} from './verdictEval';

/**
 * Frozen abuse evaluation sets: every flagged account in a window plus a seeded sample of unflagged
 * ones, split by campaign into tuning and held-out examples, labelled by admins and graded in
 * repeatable runs. Served by /api/admin/shadow-detections/eval-sets; drawn and graded by
 * apps/client/server/security/verdictEval/evalSets.ts.
 */

export const EVAL_SET_SPLITS = ['tuning', 'heldOut'] as const;
export const EVAL_SET_EXAMPLE_KINDS = ['flagged', 'unflagged'] as const;

export const EVAL_SET_UNFLAGGED_SAMPLE_MIN = 10;
export const EVAL_SET_UNFLAGGED_SAMPLE_MAX = 500;
export const EVAL_SET_HELD_OUT_SHARE_MIN = 0.2;
export const EVAL_SET_HELD_OUT_SHARE_MAX = 0.8;
export const EVAL_SET_NOTE_MAX = 500;
/**
 * Conclusive evaluation-set verdicts a run needs on each side (held-out unflagged examples, and
 * held-out flagged examples that signed up in the window) before it estimates recall.
 */
export const EVAL_SET_MIN_REVIEWED = 30;
/** The unflagged side is checked first, so a run short on both reports `too_few_unflagged_reviews`. */
export const EVAL_SET_RECALL_WITHHELD_REASONS = ['too_few_unflagged_reviews', 'too_few_flagged_reviews'] as const;

/**
 * Whether an example drives the recall estimate: held out and, for a flagged one, signed up in the
 * set window. Shared by the run grader (evalSetMath.ts estimateRecall) and the panel's review order.
 */
export function countsTowardRecall(
  example: {
    kind: (typeof EVAL_SET_EXAMPLE_KINDS)[number];
    split: (typeof EVAL_SET_SPLITS)[number];
    signedUpAt: Date | null;
  },
  window: { since: Date; until: Date }
): boolean {
  if (example.split !== 'heldOut') return false;
  if (example.kind === 'unflagged') return true;
  return example.signedUpAt !== null && example.signedUpAt >= window.since && example.signedUpAt <= window.until;
}

const objectIdStringSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid id');
const windowDaysSchema = z.coerce
  .number()
  .int()
  .refine((value): value is VerdictEvalWindowDays => (VERDICT_EVAL_WINDOWS as readonly number[]).includes(value));
const noteSchema = z.string().trim().max(EVAL_SET_NOTE_MAX);

export const evalSetCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  days: windowDaysSchema,
  unflaggedSample: z.number().int().min(EVAL_SET_UNFLAGGED_SAMPLE_MIN).max(EVAL_SET_UNFLAGGED_SAMPLE_MAX).default(200),
  heldOutShare: z.number().min(EVAL_SET_HELD_OUT_SHARE_MIN).max(EVAL_SET_HELD_OUT_SHARE_MAX).default(0.5),
  note: noteSchema.optional(),
});
export type EvalSetCreateRequest = z.infer<typeof evalSetCreateRequestSchema>;
export type EvalSetCreateInput = z.input<typeof evalSetCreateRequestSchema>;

export const evalSetExampleVerdictRequestSchema = z.object({
  userId: objectIdStringSchema,
  verdict: z.enum(SHADOW_DETECTION_VERDICTS),
  reason: AdminActionReasonSchema,
  expectedRevision: z.number().int().min(0),
});
export type EvalSetExampleVerdictRequest = z.infer<typeof evalSetExampleVerdictRequestSchema>;

export const evalSetRunRequestSchema = z.object({ note: noteSchema.optional() });
export type EvalSetRunRequest = z.infer<typeof evalSetRunRequestSchema>;

const countSchema = z.number().int().min(0);

export const evalSetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  createdBy: z.string(),
  window: z.object({ since: z.coerce.date(), until: z.coerce.date() }),
  heldOutShare: z.number(),
  /** Accounts the window held: flagged by a detection, and created in it without being flagged. */
  population: z.object({ flagged: countSchema, unflagged: countSchema }),
  /** A read or the example cap cut the draw short. */
  truncated: z.boolean(),
  examples: countSchema,
  heldOutExamples: countSchema,
  unflaggedExamples: countSchema,
  /** Examples by their latest verdict. */
  labelledByVerdict: z.record(z.enum(SHADOW_DETECTION_VERDICTS), countSchema),
  runs: countSchema,
  lastRunAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type EvalSetSummary = z.infer<typeof evalSetSummarySchema>;

export const evalSetScoreSchema = verdictEvalScoreSchema.extend({
  /** Wilson 95% lower bound on precision; null with none called abuse. */
  precisionLowerBound: z.number().min(0).max(1).nullable(),
  /**
   * Always null on a set: flagged examples are a census and unflagged ones a small sample, so a
   * rate over both would mix the two. The recall estimate is the set's rate.
   */
  hitRate: z.null(),
  falsePositiveRate: z.null(),
});
export type EvalSetScore = z.infer<typeof evalSetScoreSchema>;

export const evalSetRunReportSchema = z.object({
  split: z.literal('heldOut'),
  /** Held-out examples. */
  examples: countSchema,
  /** Of those, the ones with a label. */
  labelled: countSchema,
  scores: z.array(evalSetScoreSchema),
  /**
   * Recall over accounts created in the set window, held-out split only. Each side is its abuse rate
   * among reviewed examples times the population its examples stand for.
   */
  recall: z.object({
    /** Held-out flagged examples that signed up in the window. */
    flaggedExamples: countSchema,
    /** Of those, the ones whose latest evaluation-set verdict is conclusive; frozen labels never count. */
    flaggedReviewed: countSchema,
    flaggedAbuse: countSchema,
    /** The flagged accounts those examples stand for (undoes the flagged cap). */
    flaggedPopulation: countSchema,
    /** Held-out unflagged examples. */
    unflaggedExamples: countSchema,
    /** Of those, the ones whose latest evaluation-set verdict is conclusive; frozen labels never count. */
    unflaggedReviewed: countSchema,
    unflaggedAbuse: countSchema,
    /** The unflagged accounts those examples stand for. */
    unflaggedPopulation: countSchema,
    /** EVAL_SET_MIN_REVIEWED when the run was graded. */
    minimumReviewed: countSchema,
    estimatedFlaggedAbuse: z.number().min(0).nullable(),
    estimatedMissedAbuse: z.number().min(0).nullable(),
    /** Null when withheld; `recallWithheld` says why. */
    estimatedRecall: z.number().min(0).max(1).nullable(),
    recallWithheld: z.enum(EVAL_SET_RECALL_WITHHELD_REASONS).nullable(),
  }),
  /** Flagged held-out examples by cohort. */
  cohorts: z.array(verdictEvalCohortRowSchema),
  labelSources: z.record(z.string(), countSchema),
});
export type EvalSetRunReport = z.infer<typeof evalSetRunReportSchema>;

export const evalSetRunSchema = z.object({
  ranAt: z.coerce.date(),
  ranBy: z.string(),
  note: z.string().nullable(),
  report: evalSetRunReportSchema,
});
export type EvalSetRun = z.infer<typeof evalSetRunSchema>;

export const evalSetRunResponseSchema = z.object({
  run: evalSetRunSchema,
  previous: evalSetRunSchema.nullable(),
});
export type EvalSetRunResponse = z.infer<typeof evalSetRunResponseSchema>;

export const evalSetExampleSchema = z.object({
  userId: z.string(),
  kind: z.enum(EVAL_SET_EXAMPLE_KINDS),
  split: z.enum(EVAL_SET_SPLITS),
  detectionIds: z.array(z.string()),
  campaignKey: z.string(),
  cohorts: z.array(evalCohortSchema),
  signedUpAt: z.coerce.date().nullable(),
  /** The verdict wins over the label frozen at draw; an unflagged example has only verdict labels. */
  currentLabel: z.object({ label: z.enum(VERDICT_EVAL_LABELS), source: z.enum(['frozen', 'verdict']) }).nullable(),
  latestVerdict: z
    .object({
      verdict: z.enum(SHADOW_DETECTION_VERDICTS),
      reason: z.string(),
      reviewerId: z.string(),
      reviewedAt: z.coerce.date(),
    })
    .nullable(),
  revision: countSchema,
});
export type EvalSetExample = z.infer<typeof evalSetExampleSchema>;

export const evalSetDetailSchema = evalSetSummarySchema
  .omit({
    examples: true,
    heldOutExamples: true,
    unflaggedExamples: true,
    labelledByVerdict: true,
    runs: true,
    lastRunAt: true,
  })
  .extend({
    examples: z.array(evalSetExampleSchema),
    /** The last two runs, oldest first. */
    runs: z.array(evalSetRunSchema),
    runCount: countSchema,
    /** Stored runs that no longer match the run schema; counted in runCount, absent from runs. */
    unreadableRunCount: countSchema,
  });
export type EvalSetDetail = z.infer<typeof evalSetDetailSchema>;

export const evalSetListSchema = z.object({ data: z.array(evalSetSummarySchema) });
export type EvalSetList = z.infer<typeof evalSetListSchema>;

export const evalSetIdQuerySchema = z.object({ id: z.string() });
