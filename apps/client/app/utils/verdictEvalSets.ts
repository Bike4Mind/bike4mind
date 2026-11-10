import { z } from 'zod';
import { SHADOW_DETECTION_VERDICTS } from '@bike4mind/common';
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
  reason: z.string().trim().min(1).max(500),
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
});
export type EvalSetScore = z.infer<typeof evalSetScoreSchema>;

export const evalSetRunReportSchema = z.object({
  split: z.literal('heldOut'),
  /** Held-out examples. */
  examples: countSchema,
  /** Of those, the ones with a label. */
  labelled: countSchema,
  scores: z.array(evalSetScoreSchema),
  recall: z.object({
    flaggedAbuse: countSchema,
    sampledUnflaggedAbuse: countSchema,
    sampledUnflagged: countSchema,
    /** The unflagged accounts the sampled held-out ones stand for. */
    unflaggedPopulation: countSchema,
    estimatedMissedAbuse: z.number().min(0).nullable(),
    estimatedRecall: z.number().min(0).max(1).nullable(),
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
  /** The verdict wins over the label frozen at draw. */
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
  });
export type EvalSetDetail = z.infer<typeof evalSetDetailSchema>;

export const evalSetListSchema = z.object({ data: z.array(evalSetSummarySchema) });
export type EvalSetList = z.infer<typeof evalSetListSchema>;

export const evalSetIdQuerySchema = z.object({ id: z.string() });
