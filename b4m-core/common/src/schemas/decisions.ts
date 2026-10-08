import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { DECISION_PLATFORM_LIMITS, DecisionModelIdSchema } from '../decisions/catalog';
import { DECISION_PROVIDER_IDS } from '../decisions/types';
import { ApiErrorSchema } from './chat';

/**
 * Public wire schema for `POST /api/v1/decisions` and `GET /api/v1/decision-models`: provider-neutral typed questions
 * answered with calibrated probabilities. snake_case per CONVENTIONS.md. Platform ceilings live here so OpenAPI shows
 * them; per-model caps are enforced by `validateDecisionRequest` (decisions/validate.ts).
 *
 * Public-API rules apply: no `.catch()`, no top-level `.transform()`.
 */

const { maxTextLength } = DECISION_PLATFORM_LIMITS;

const DECISION_IMAGE_MEDIA_TYPES = ['png', 'jpeg', 'webp', 'gif'] as const;
// Inline images only: an arbitrary http(s) URL would mean SSRF, unbounded latency and third-party egress.
const DATA_IMAGE_URL_PATTERN = new RegExp(
  `^data:image/(${DECISION_IMAGE_MEDIA_TYPES.join('|')});base64,[A-Za-z0-9+/]+={0,2}$`
);

export const DecisionTextPartSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1).max(maxTextLength),
});

export const DecisionJsonPartSchema = z.strictObject({
  type: z.literal('json'),
  json: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .describe('Structured state. Sent natively to models that accept it, otherwise serialized to text.'),
});

export const DecisionImagePartSchema = z.strictObject({
  type: z.literal('image'),
  file_id: z
    .string()
    .min(1)
    .optional()
    .describe('A Files entry the caller can read. Exactly one of file_id or image_url.'),
  image_url: z
    .string()
    .regex(DATA_IMAGE_URL_PATTERN, 'image_url must be a base64 data: URL (png, jpeg, webp or gif)')
    .optional()
    .describe('A base64 data: URL. http(s) URLs are rejected; upload the image and pass file_id instead.'),
});

export const DecisionInputPartSchema = z.discriminatedUnion('type', [
  DecisionTextPartSchema,
  DecisionJsonPartSchema,
  DecisionImagePartSchema,
]);

export const DecisionInputSchema = z.union([
  z.string().min(1).max(maxTextLength),
  z.array(DecisionInputPartSchema).min(1),
]);

const QuestionNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'name must be 1-64 characters of letters, digits, _ or -')
  .describe('Unique within the request; answers carry it back.');
const InstructionsSchema = z.string().min(1).max(maxTextLength);

export const PredicateQuestionSchema = z.strictObject({
  type: z.literal('predicate'),
  name: QuestionNameSchema,
  instructions: InstructionsSchema.describe('A statement to judge true or false against the input.'),
});

export const ChoiceQuestionSchema = z.strictObject({
  type: z.literal('choice'),
  name: QuestionNameSchema,
  instructions: InstructionsSchema,
  choices: z
    .array(z.strictObject({ value: z.string().min(1).max(256), description: z.string().min(1).max(4096).optional() }))
    .min(2)
    .max(DECISION_PLATFORM_LIMITS.maxChoices),
});

export const ScoreQuestionSchema = z.strictObject({
  type: z.literal('score'),
  name: QuestionNameSchema,
  instructions: InstructionsSchema,
  levels: z
    .array(z.strictObject({ label: z.string().min(1).max(256), description: z.string().min(1).max(4096).optional() }))
    .min(DECISION_PLATFORM_LIMITS.minLevels)
    .max(DECISION_PLATFORM_LIMITS.maxLevels)
    .describe('Ordered lowest to highest; the answer score is a 0-based index into this list.'),
});

export const DecisionQuestionSchema = z.discriminatedUnion('type', [
  PredicateQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);

export const DecisionsRequestSchema = z.strictObject({
  model: DecisionModelIdSchema,
  input: DecisionInputSchema,
  questions: z.array(DecisionQuestionSchema).min(1).max(DECISION_PLATFORM_LIMITS.maxQuestions),
  safety_identifier: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('A stable, non-identifying id for your end user. Defaults to a hash of the B4M user id.'),
});

const ProbabilitySchema = z.number().min(0).max(1);

export const PredicateAnswerSchema = z.object({
  type: z.literal('predicate'),
  name: z.string(),
  probability: ProbabilitySchema.describe('Probability that the statement is true.'),
});

export const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  name: z.string(),
  choice: z.string().describe('The most probable value.'),
  probabilities: z.array(z.object({ value: z.string(), probability: ProbabilitySchema })).describe('In request order.'),
  confidence: ProbabilitySchema.describe('(n * p_max - 1) / (n - 1), computed by B4M for every model.'),
});

export const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  name: z.string(),
  score: z.number().describe('Probability-weighted mean of the 0-based level indices.'),
  probabilities: z
    .array(z.object({ value: z.number().int(), label: z.string(), probability: ProbabilitySchema }))
    .describe('In level order; value is the level index.'),
  confidence: ProbabilitySchema.describe('Distance-aware: 1 - sum(p_i * |i - peak|) / mean_i(|i - (n-1)/2|).'),
});

export const RefusalAnswerSchema = z.object({
  type: z.literal('refusal'),
  name: z.string(),
});

export const DecisionAnswerSchema = z.discriminatedUnion('type', [
  PredicateAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
  RefusalAnswerSchema,
]);

export const DecisionUsageSchema = z.object({
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  total_tokens: z.number().int(),
});

export const DecisionResponseSchema = z.object({
  id: z.string().describe('Unique per decision.'),
  object: z.literal('decision'),
  model: z.string().describe('The resolved model version. Pin it when you tune thresholds.'),
  answers: z.array(DecisionAnswerSchema).describe('One per question, in question order.'),
  usage: DecisionUsageSchema,
});

export const DecisionModelSchema = z.object({
  id: z.string(),
  object: z.literal('decision_model'),
  display_name: z.string(),
  provider: z.enum(DECISION_PROVIDER_IDS),
  alias_of: z.string().nullable().describe('Set on a floating alias; pin the versioned id to keep thresholds stable.'),
  supports_images: z.boolean(),
  limits: z.object({
    max_questions: z.number().int(),
    max_choices: z.number().int(),
    max_levels: z.number().int(),
    max_images: z.number().int(),
    max_input_tokens: z.number().int(),
  }),
  pricing: z.object({
    usd_per_million_input_tokens: z.number(),
    usd_per_million_output_tokens: z.number(),
  }),
});

export const ListDecisionModelsResponseSchema = z.object({ models: z.array(DecisionModelSchema) });

export const DECISIONS_ERROR_CODES = [
  'insufficient_credits',
  'spend_cap_exceeded',
  'provider_not_configured',
  'provider_rejected',
  'provider_overloaded',
  'provider_error',
  'context_length_exceeded',
  'limit_exceeded',
  'unsupported_input',
  'invalid_request',
  'model_unavailable',
  'input_image_not_found',
] as const satisfies readonly ApiErrorCode[];
export type DecisionsErrorCode = (typeof DECISIONS_ERROR_CODES)[number];

export const DecisionsErrorSchema = ApiErrorSchema.extend({
  errorCode: z.enum(DECISIONS_ERROR_CODES).optional(),
  param: z.string().optional().describe('Path of the offending field, e.g. questions[1].choices.'),
});

export type DecisionTextPart = z.infer<typeof DecisionTextPartSchema>;
export type DecisionJsonPart = z.infer<typeof DecisionJsonPartSchema>;
export type DecisionImagePart = z.infer<typeof DecisionImagePartSchema>;
export type DecisionInputPart = z.infer<typeof DecisionInputPartSchema>;
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export type PredicateQuestion = z.infer<typeof PredicateQuestionSchema>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof ScoreQuestionSchema>;
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>;
export type DecisionsRequest = z.infer<typeof DecisionsRequestSchema>;
export type PredicateAnswer = z.infer<typeof PredicateAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;
export type RefusalAnswer = z.infer<typeof RefusalAnswerSchema>;
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;
export type DecisionUsage = z.infer<typeof DecisionUsageSchema>;
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
export type DecisionModel = z.infer<typeof DecisionModelSchema>;
export type ListDecisionModelsResponse = z.infer<typeof ListDecisionModelsResponseSchema>;
