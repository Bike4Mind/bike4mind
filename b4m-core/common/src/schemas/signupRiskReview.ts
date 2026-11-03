import { z } from 'zod';
import { SIGNUP_RISK_SIGNALS } from './settings';
import { ABUSE_ASSESSMENT_JUDGMENTS } from './abuseAssessment';
import { SHADOW_DETECTORS } from './shadowDetection';

/**
 * Pending accounts returned by one list request. The admin table sorts and pages the whole set
 * locally, so the server caps it instead of paging; `truncated` says the cap was hit.
 */
export const SIGNUP_RISK_REVIEW_LIST_LIMIT = 500;

/** Accounts one decision request may approve or reopen, each in its own audited transaction. */
export const MAX_SIGNUP_RISK_REVIEW_BATCH = 200;

const ObjectIdStringSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid user id');

/**
 * The Decisions model's latest judgment of a shadow detection naming the account
 * (b4m-core/common/src/schemas/abuseAssessment.ts). Advisory: shown to the reviewer, never read to
 * approve or change reviewState. An abuse judgment wins over a newer non-abuse one.
 */
export const signupRiskReviewAdvisorySchema = z.object({
  detectionId: z.string(),
  detector: z.enum(SHADOW_DETECTORS),
  result: z.enum(ABUSE_ASSESSMENT_JUDGMENTS),
  confidence: z.number().nullable(),
  assessedAt: z.date(),
});
export type SignupRiskReviewAdvisory = z.infer<typeof signupRiskReviewAdvisorySchema>;

export const signupRiskReviewItemSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  username: z.string().nullable(),
  /** Registrable domain of the email (eTLD+1), so burner subdomains group together. */
  domain: z.string().nullable(),
  createdAt: z.date(),
  score: z.number(),
  signals: z.array(z.object({ signal: z.enum(SIGNUP_RISK_SIGNALS), points: z.number(), reason: z.string() })),
  computedAt: z.date(),
  creditsSpent: z.number(),
  apiKeysCreated: z.number(),
  /** The signup grant policy withheld the signup tranche; approving releases it. */
  grantHeld: z.boolean(),
  /** Null when no detection naming the account has a judged assessment. */
  advisory: signupRiskReviewAdvisorySchema.nullable(),
});
export type SignupRiskReviewItem = z.infer<typeof signupRiskReviewItemSchema>;

/**
 * Evidence a pending review was approved on without an admin (apps/client/server/security/riskReviewAutoApproval.ts).
 * Only ever moves pending to approved; a model verdict is never one of these.
 */
export const SIGNUP_RISK_AUTO_APPROVAL_POLICIES = ['settled_payment', 'quiet_account'] as const;
export type SignupRiskAutoApprovalPolicy = (typeof SIGNUP_RISK_AUTO_APPROVAL_POLICIES)[number];

/** Auto-approvals listed for reopening: those still approved, decided within this many days. */
export const SIGNUP_RISK_AUTO_APPROVAL_LIST_DAYS = 30;
export const SIGNUP_RISK_AUTO_APPROVAL_LIST_LIMIT = 200;

export const signupRiskAutoApprovalItemSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  username: z.string().nullable(),
  score: z.number().nullable(),
  policy: z.enum(SIGNUP_RISK_AUTO_APPROVAL_POLICIES),
  decidedAt: z.date(),
});
export type SignupRiskAutoApprovalItem = z.infer<typeof signupRiskAutoApprovalItemSchema>;

export const signupRiskReviewListSchema = z.object({
  data: z.array(signupRiskReviewItemSchema),
  /** Recent automatic approvals, newest first, so a reviewer can reopen one. */
  autoApproved: z.array(signupRiskAutoApprovalItemSchema),
  truncated: z.boolean(),
  /** The configured score at which an account needs review. */
  reviewThreshold: z.number(),
});
export type SignupRiskReviewList = z.infer<typeof signupRiskReviewListSchema>;

/**
 * approve settles a pending review; reopen puts an approved account back in the queue (the undo of
 * approve). The reason is validated by the shared admin reason rule on the server.
 */
export const signupRiskReviewDecisionSchema = z.object({
  action: z.enum(['approve', 'reopen']),
  userIds: z.array(ObjectIdStringSchema).min(1).max(MAX_SIGNUP_RISK_REVIEW_BATCH),
  reason: z.unknown(),
});
export type SignupRiskReviewDecision = z.infer<typeof signupRiskReviewDecisionSchema>;

export const signupRiskReviewDecisionResultSchema = z.object({
  /** Users whose state changed. */
  updatedUserIds: z.array(z.string()),
  /** Users skipped because their review was no longer in the expected state. */
  skippedUserIds: z.array(z.string()),
  /** Users whose transaction failed and rolled back; the rest of the batch still ran. */
  failedUserIds: z.array(z.string()),
  /** Users whose held signup tranche was paid. A payout failure lands the user in failedUserIds. */
  grantReleasedUserIds: z.array(z.string()),
});
export type SignupRiskReviewDecisionResult = z.infer<typeof signupRiskReviewDecisionResultSchema>;
