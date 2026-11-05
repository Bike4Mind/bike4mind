import { z } from 'zod';
import { accountCampaignGroupSchema } from './accountCampaign';

/**
 * Shadow detections: what an abuse detector WOULD have done to an actor, recorded next to its alert
 * without acting, so admins can grade each one and measure detection errors before any automated
 * containment is switched on. Recording never changes access, credits, API keys or
 * riskScore.reviewState. The record lives in the ShadowDetection collection (packages/database);
 * detectors write it, the admin Detections page reads and grades it.
 */

export const SHADOW_DETECTORS = ['signupNetworkBurst', 'accountCampaign', 'youngAccountSpend', 'paymentRisk'] as const;
export type ShadowDetector = (typeof SHADOW_DETECTORS)[number];

/**
 * The action the detector's policy maps the detection to. contain/suspend/restrict match the admin
 * bulk user actions; blockIp is for actors with no signed-in account, where containing a user is not
 * possible.
 */
export const SHADOW_DETECTION_ACTIONS = ['contain', 'suspend', 'restrict', 'blockIp'] as const;
export type ShadowDetectionAction = (typeof SHADOW_DETECTION_ACTIONS)[number];

export const SHADOW_DETECTION_VERDICTS = [
  'confirmed_abuse',
  'legitimate_human',
  'legitimate_automation',
  'insufficient_evidence',
] as const;
export type ShadowDetectionVerdict = (typeof SHADOW_DETECTION_VERDICTS)[number];

/** Detections returned by one list request; the table pages locally, `truncated` says the cap was hit. */
export const SHADOW_DETECTION_LIST_LIMIT = 500;

const ObjectIdStringSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid id');

/** One measured signal: what was observed against the threshold that tripped. */
export const shadowDetectionSignalSchema = z.object({
  key: z.string(),
  label: z.string(),
  observed: z.number().nullable(),
  threshold: z.number().nullable(),
});
export type ShadowDetectionSignal = z.infer<typeof shadowDetectionSignalSchema>;

export const shadowDetectionNetworkSchema = z.object({
  ip: z.string().nullable(),
  asn: z.number().nullable(),
  asnOrg: z.string().nullable(),
  country: z.string().nullable(),
  hosting: z.boolean().nullable(),
});
export type ShadowDetectionNetwork = z.infer<typeof shadowDetectionNetworkSchema>;

export const SHADOW_DETECTION_PAYMENT_KINDS = ['credits', 'subscription'] as const;
export const SHADOW_DETECTION_PAYMENT_OUTCOMES = ['succeeded', 'failed'] as const;

/**
 * The Stripe payment a paymentRisk detection screened. Ids only: no card details. `livemode` is
 * Stripe's own flag, so it says which Stripe Dashboard (live or /test) the ids resolve in.
 */
export const shadowDetectionPaymentSchema = z.object({
  paymentIntentId: z.string(),
  chargeId: z.string().nullable(),
  kind: z.enum(SHADOW_DETECTION_PAYMENT_KINDS),
  outcome: z.enum(SHADOW_DETECTION_PAYMENT_OUTCOMES),
  /** Minor currency units (cents). */
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  riskLevel: z.string().nullable(),
  livemode: z.boolean(),
});
export type ShadowDetectionPayment = z.infer<typeof shadowDetectionPaymentSchema>;

export const shadowDetectionVerdictEntrySchema = z.object({
  verdict: z.enum(SHADOW_DETECTION_VERDICTS),
  reason: z.string(),
  reviewerId: z.string(),
  reviewedAt: z.date(),
});
export type ShadowDetectionVerdictEntry = z.infer<typeof shadowDetectionVerdictEntrySchema>;

export const shadowDetectionItemSchema = z.object({
  id: z.string(),
  detector: z.enum(SHADOW_DETECTORS),
  /** Bumped whenever a detector's thresholds-to-action mapping changes, so precision is per policy. */
  policyVersion: z.number().int(),
  wouldAction: z.enum(SHADOW_DETECTION_ACTIONS),
  /** Short human summary of why the detector fired, e.g. "3 signups from one IP in 180 minutes". */
  summary: z.string(),
  userIds: z.array(z.string()),
  network: shadowDetectionNetworkSchema.nullable(),
  signals: z.array(shadowDetectionSignalSchema),
  windowMinutes: z.number().nullable(),
  /** The linked-account evidence of an accountCampaign detection; null for single-actor detectors. */
  group: accountCampaignGroupSchema.nullable(),
  /** The screened payment of a paymentRisk detection; null for detectors that do not watch payments. */
  payment: shadowDetectionPaymentSchema.nullable(),
  detectedAt: z.date(),
  /** The latest verdict; null until reviewed. Earlier verdicts stay in `verdicts`. */
  verdict: z.enum(SHADOW_DETECTION_VERDICTS).nullable(),
  verdicts: z.array(shadowDetectionVerdictEntrySchema),
  /** Optimistic-concurrency token: a verdict must name the revision it was decided against. */
  revision: z.number().int(),
});
export type ShadowDetectionItem = z.infer<typeof shadowDetectionItemSchema>;

/** Verdict counts for one detector and policy version. Precision is derived on the client. */
export const shadowDetectionSummaryRowSchema = z.object({
  detector: z.enum(SHADOW_DETECTORS),
  policyVersion: z.number().int(),
  recorded: z.number(),
  confirmedAbuse: z.number(),
  legitimateHuman: z.number(),
  legitimateAutomation: z.number(),
  insufficientEvidence: z.number(),
});
export type ShadowDetectionSummaryRow = z.infer<typeof shadowDetectionSummaryRowSchema>;

export const shadowDetectionListSchema = z.object({
  data: z.array(shadowDetectionItemSchema),
  truncated: z.boolean(),
  summary: z.array(shadowDetectionSummaryRowSchema),
});
export type ShadowDetectionList = z.infer<typeof shadowDetectionListSchema>;

export const shadowDetectionListQuerySchema = z.object({
  detector: z.enum(SHADOW_DETECTORS).optional(),
  verdict: z.enum([...SHADOW_DETECTION_VERDICTS, 'unreviewed']).optional(),
});
export type ShadowDetectionListQuery = z.infer<typeof shadowDetectionListQuerySchema>;

/** The reason is validated by the shared admin reason rule on the server. */
export const shadowDetectionVerdictRequestSchema = z.object({
  id: ObjectIdStringSchema,
  expectedRevision: z.number().int().min(0),
  verdict: z.enum(SHADOW_DETECTION_VERDICTS),
  reason: z.unknown(),
});
export type ShadowDetectionVerdictRequest = z.infer<typeof shadowDetectionVerdictRequestSchema>;

/**
 * Precision of a would-act decision among graded detections. insufficient_evidence is excluded from
 * both sides: it says the reviewer could not tell, not that the detector was wrong. Null with no
 * conclusive verdicts, so the UI never shows a ratio over zero.
 */
export function shadowDetectionPrecision(row: ShadowDetectionSummaryRow): number | null {
  const falsePositives = row.legitimateHuman + row.legitimateAutomation;
  const conclusive = row.confirmedAbuse + falsePositives;
  return conclusive === 0 ? null : row.confirmedAbuse / conclusive;
}
