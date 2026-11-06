import { z } from 'zod';
import { accountCampaignGroupSchema } from './accountCampaign';

/**
 * Shadow detections: what an abuse detector WOULD have done to an actor, recorded next to its alert
 * without acting, so admins can grade each one and measure detection errors before any automated
 * containment is switched on. Recording never changes access, credits, API keys or
 * riskScore.reviewState. The record lives in the ShadowDetection collection (packages/database);
 * detectors write it, the admin Detections page reads and grades it.
 */

export const SHADOW_DETECTORS = [
  'signupNetworkBurst',
  'accountCampaign',
  'youngAccountSpend',
  'paymentRisk',
  /** A new account that signed up from the same IP as a blocked account, close in time. */
  'signupIpLinkedToBlocked',
  'signupDomainHold',
] as const;
export type ShadowDetector = (typeof SHADOW_DETECTORS)[number];

/**
 * Detectors whose detections already carry their own Decisions verdict
 * (apps/client/server/security/signupDomainHoldAssessment), so the abuse assessment sweep and the
 * Detections assessment panel leave them alone.
 */
export const SELF_ASSESSED_SHADOW_DETECTORS: readonly ShadowDetector[] = ['signupDomainHold'];

/**
 * The action the detector's policy maps the detection to. contain/suspend/restrict match the admin
 * bulk user actions; blockIp is for actors with no signed-in account, where containing a user is not
 * possible. confirmHold/none are the signup domain hold assessment's outcomes (confirm the hold, or
 * leave it for an admin).
 */
export const SHADOW_DETECTION_ACTIONS = ['contain', 'suspend', 'restrict', 'blockIp', 'confirmHold', 'none'] as const;
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

/**
 * Where a verdict came from. `review` is a grade recorded on the Detections page; `suspension` and
 * `reinstatement` are recorded for the admin who suspended or reinstated an account the detection
 * names. Absent on entries written before the field existed, which were all reviews.
 */
export const SHADOW_DETECTION_VERDICT_SOURCES = ['review', 'suspension', 'reinstatement'] as const;
export type ShadowDetectionVerdictSource = (typeof SHADOW_DETECTION_VERDICT_SOURCES)[number];

export const shadowDetectionVerdictEntrySchema = z.object({
  verdict: z.enum(SHADOW_DETECTION_VERDICTS),
  reason: z.string(),
  reviewerId: z.string(),
  reviewedAt: z.date(),
  source: z.enum(SHADOW_DETECTION_VERDICT_SOURCES).optional(),
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

/**
 * Verdict counts for one detector and policy version. Precision is derived on the client. Verdict
 * counts cover only records that would have acted; `noAction` counts the `wouldAction: 'none'`
 * records, which are listed and gradable but never counted in precision.
 */
export const shadowDetectionSummaryRowSchema = z.object({
  detector: z.enum(SHADOW_DETECTORS),
  policyVersion: z.number().int(),
  recorded: z.number(),
  noAction: z.number(),
  confirmedAbuse: z.number(),
  legitimateHuman: z.number(),
  legitimateAutomation: z.number(),
  insufficientEvidence: z.number(),
});
export type ShadowDetectionSummaryRow = z.infer<typeof shadowDetectionSummaryRowSchema>;

export const SHADOW_DETECTION_ACCOUNT_STATUSES = ['active', 'suspended', 'deleted', 'missing'] as const;
export type ShadowDetectionAccountStatus = (typeof SHADOW_DETECTION_ACCOUNT_STATUSES)[number];

/**
 * An account a listed detection names, as it is now, so a reviewer sees a suspended or drained account
 * without opening its profile. `missing` is an id with no user record.
 */
export const shadowDetectionAccountSchema = z.object({
  userId: z.string(),
  status: z.enum(SHADOW_DETECTION_ACCOUNT_STATUSES),
  signupMethod: z.string().nullable(),
  currentCredits: z.number().nullable(),
});
export type ShadowDetectionAccount = z.infer<typeof shadowDetectionAccountSchema>;

/** Burst peers listed per detection; `truncated` says more accounts signed up in the window. */
export const SHADOW_DETECTION_BURST_PEER_LIMIT = 10;

/**
 * The other accounts that signed up from a signupNetworkBurst detection's IP inside its window. The
 * detection names only the signup that tripped it; these are read from the users at list time.
 */
export const shadowDetectionBurstPeersSchema = z.object({
  detectionId: z.string(),
  userIds: z.array(z.string()),
  truncated: z.boolean(),
});
export type ShadowDetectionBurstPeers = z.infer<typeof shadowDetectionBurstPeersSchema>;

export const shadowDetectionListSchema = z.object({
  data: z.array(shadowDetectionItemSchema),
  truncated: z.boolean(),
  summary: z.array(shadowDetectionSummaryRowSchema),
  /** Every account the listed detections and their burst peers name. */
  accounts: z.array(shadowDetectionAccountSchema),
  burstPeers: z.array(shadowDetectionBurstPeersSchema),
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

/** Detections one bulk verdict may grade. */
export const SHADOW_DETECTION_BULK_VERDICT_LIMIT = 100;

/** One verdict and reason for several detections, each named with the revision it was decided against. */
export const shadowDetectionBulkVerdictRequestSchema = z.object({
  items: z
    .array(z.object({ id: ObjectIdStringSchema, expectedRevision: z.number().int().min(0) }))
    .min(1)
    .max(SHADOW_DETECTION_BULK_VERDICT_LIMIT),
  verdict: z.enum(SHADOW_DETECTION_VERDICTS),
  reason: z.unknown(),
});
export type ShadowDetectionBulkVerdictRequest = z.infer<typeof shadowDetectionBulkVerdictRequestSchema>;

/** `conflicts` moved since the reviewer read them and were left alone; they come back as they are now. */
export const shadowDetectionBulkVerdictResponseSchema = z.object({
  updated: z.array(shadowDetectionItemSchema),
  conflicts: z.array(shadowDetectionItemSchema),
  notFound: z.array(z.string()),
});
export type ShadowDetectionBulkVerdictResponse = z.infer<typeof shadowDetectionBulkVerdictResponseSchema>;

/**
 * Suspension reasons that mean the admin judged the account abusive, so its open detections are graded
 * confirmed abuse. The admin suspend dialog offers these as presets (adminReason.ts); a reason counts
 * when it is the preset alone or "Preset: note".
 */
export const ABUSE_SUSPENSION_REASONS = ['Abuse / automated signups', 'Payment fraud', 'Terms violation'] as const;

export function isAbuseSuspensionReason(reason: string): boolean {
  return ABUSE_SUSPENSION_REASONS.some(preset => reason === preset || reason.startsWith(`${preset}: `));
}

/**
 * Precision of a would-act decision among graded detections. insufficient_evidence is excluded from
 * both sides: it says the reviewer could not tell, not that the detector was wrong. Null with no
 * conclusive verdicts, so the UI never shows a ratio over zero. `noAction` records never enter it:
 * the row's verdict counts already exclude them (shadowDetectionRepository.summarize), and a verdict
 * on a record that would not have acted says nothing about a would-act decision.
 */
export function shadowDetectionPrecision(row: ShadowDetectionSummaryRow): number | null {
  const falsePositives = row.legitimateHuman + row.legitimateAutomation;
  const conclusive = row.confirmedAbuse + falsePositives;
  return conclusive === 0 ? null : row.confirmedAbuse / conclusive;
}
