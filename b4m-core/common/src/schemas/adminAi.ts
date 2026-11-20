import { z } from 'zod';

/**
 * Admin AI suggestions: a model's advisory verdict on one admin queue item (an abuse detection, a
 * domain hold, a feedback ticket, ...), stored for an admin to accept, override or dismiss. Stored in
 * the AdminAiSuggestion collection (packages/database/src/models/infra/admin/AdminAiSuggestionModel.ts);
 * the per-feature switches live in the adminAiConfig setting (schemas/settings.ts).
 */

export const ADMIN_AI_FEATURES = [
  'abuseAssessment',
  'domainHold',
  'detectionTriage',
  'feedbackTriage',
  'dlqTriage',
  'morningBrief',
] as const;
export type AdminAiFeature = (typeof ADMIN_AI_FEATURES)[number];

/** decision: a Decisions-catalog model picks from fixed choices. text: the operations model writes JSON. */
export const ADMIN_AI_ENGINES = ['decision', 'text'] as const;
export type AdminAiEngine = (typeof ADMIN_AI_ENGINES)[number];

export const ADMIN_AI_FEATURE_ENGINE: Record<AdminAiFeature, AdminAiEngine> = {
  abuseAssessment: 'decision',
  domainHold: 'decision',
  detectionTriage: 'decision',
  feedbackTriage: 'decision',
  dlqTriage: 'text',
  morningBrief: 'text',
};

/** auto_applied and undone only occur in act mode; expired is a pending row whose input changed. */
export const ADMIN_AI_SUGGESTION_STATUSES = [
  'pending',
  'accepted',
  'overridden',
  'dismissed',
  'auto_applied',
  'undone',
  'expired',
] as const;
export type AdminAiSuggestionStatus = (typeof ADMIN_AI_SUGGESTION_STATUSES)[number];

export const ADMIN_AI_CONFIDENCE_BANDS = ['high', 'medium', 'low'] as const;
export type AdminAiConfidenceBand = (typeof ADMIN_AI_CONFIDENCE_BANDS)[number];

export const ADMIN_AI_MAX_REASONS = 3;
export const ADMIN_AI_MAX_REASON_CHARS = 500;
export const ADMIN_AI_MAX_EVIDENCE_LINKS = 5;
export const ADMIN_AI_MAX_OVERRIDE_REASON_CHARS = 1000;

const HIGH_CONFIDENCE_MIN = 0.8;
const MEDIUM_CONFIDENCE_MIN = 0.5;

/** Bands a probability for display; anything that is not a finite number in [0, 1] reads as low. */
export function confidenceBand(probability: number): AdminAiConfidenceBand {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return 'low';
  if (probability >= HIGH_CONFIDENCE_MIN) return 'high';
  if (probability >= MEDIUM_CONFIDENCE_MIN) return 'medium';
  return 'low';
}

export const adminAiReasonSchema = z.object({
  text: z.string().min(1).max(ADMIN_AI_MAX_REASON_CHARS),
  evidenceLinks: z.array(z.string()).max(ADMIN_AI_MAX_EVIDENCE_LINKS),
});
export type AdminAiReason = z.infer<typeof adminAiReasonSchema>;

export const adminAiSuggestionItemSchema = z.object({
  id: z.string().min(1),
  feature: z.enum(ADMIN_AI_FEATURES),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  inputHash: z.string().min(1),
  policyVersion: z.string().min(1),
  actionClass: z.string().optional(),
  overrideCostly: z.boolean().nullable().optional(),
  costUnknown: z.boolean().optional(),
  model: z.string().min(1),
  escalated: z.boolean(),
  verdict: z.string().min(1),
  confidence: z.object({
    band: z.enum(ADMIN_AI_CONFIDENCE_BANDS),
    probability: z.number().min(0).max(1),
  }),
  reasons: z.array(adminAiReasonSchema).max(ADMIN_AI_MAX_REASONS),
  proposedAction: z.unknown(),
  status: z.enum(ADMIN_AI_SUGGESTION_STATUSES),
  decidedBy: z.object({ userId: z.string().min(1), name: z.string().min(1) }).nullable(),
  decidedAt: z.date().nullable(),
  overrideAction: z.unknown(),
  overrideReason: z.string().max(ADMIN_AI_MAX_OVERRIDE_REASON_CHARS).nullable(),
  costUsd: z.number(),
  latencyMs: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type AdminAiSuggestionItem = z.infer<typeof adminAiSuggestionItemSchema>;

/**
 * The admin queues that offer an abuse assessment as a suggestion. Each records its own suggestion
 * rows (feature + entityType), so agreement is measured per queue. Server side:
 * apps/client/server/admin/ai/assessmentSuggestion.ts.
 */
export const ASSESSMENT_SUGGESTION_SURFACES = ['shadowDetection', 'signupRiskReview', 'heldSignupGrant'] as const;
export type AssessmentSuggestionSurface = (typeof ASSESSMENT_SUGGESTION_SURFACES)[number];

/**
 * Carried by an admin action taken from an assessment suggestion: the assessment the admin saw and,
 * on an override, why the model was wrong. The server decides accepted vs overridden itself.
 */
export const assessmentAiDecisionSchema = z.object({
  assessmentId: z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid assessment id'),
  overrideReason: z.string().trim().min(1).max(ADMIN_AI_MAX_OVERRIDE_REASON_CHARS).optional(),
});
export type AssessmentAiDecision = z.infer<typeof assessmentAiDecisionSchema>;

/** Accepting an abuse assessment on a user queue: records agreement, changes nothing on the account. */
export const assessmentSuggestionAcceptSchema = z.object({
  surface: z.enum(['signupRiskReview', 'heldSignupGrant']),
  userId: z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid user id'),
  assessmentId: z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid assessment id'),
});
export type AssessmentSuggestionAccept = z.infer<typeof assessmentSuggestionAcceptSchema>;
