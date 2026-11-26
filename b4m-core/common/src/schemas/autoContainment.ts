import { z } from 'zod';
import { ABUSE_ASSESSMENT_RESULTS } from './abuseAssessment';
import { AUTO_CONTAINMENT_MODES, type AutoContainmentConfig, type AutoContainmentMode } from './settings';

/**
 * Automated containment decisions: what the executor decided for one shadow detection from its abuse
 * assessment, one graduated record and one independent Contain record per revision: a campaign detection that gains members after a
 * decision gets a new one covering only the new members. Shadow-mode records are graded against the detection's admin
 * verdict (shadowDetection.ts), so the precision of automated containment is measured before it is
 * enforced. Produced by apps/workers/src/security/autoContainment; stored in the
 * AutoContainmentDecision collection (packages/database).
 */

/** Contain is the top tier; the rest are graduated holds that never suspend, revoke keys or remove balance. */
export const INTERVENTION_TIERS = ['contain', 'limit', 'verify', 'holdGrant', 'review'] as const;
export type InterventionTier = (typeof INTERVENTION_TIERS)[number];
export type GraduatedInterventionTier = Exclude<InterventionTier, 'contain'>;

/** Bumped whenever the wouldAction-to-tier table or a skip rule changes, so graded decisions stay comparable. */
export const INTERVENTION_POLICY_VERSION = 2;

/**
 * Deterministic link rules that can decide a graduated tier when the abuse model abstains
 * (apps/workers/src/security/autoContainment/linkRules.ts). Part of the versioned policy table.
 */
export const LINK_RULES = ['sharedOwnedDomain', 'heldSignupDomain', 'bannedSameDevice'] as const;
export type LinkRule = (typeof LINK_RULES)[number];

export const INTERVENTION_DECIDERS = ['model', 'link_rule'] as const;
export type InterventionDecider = (typeof INTERVENTION_DECIDERS)[number];

/**
 * What the link rules read about one account (loaded by
 * packages/server-utils/src/security/autoContainment/linkRuleFacts.ts). A null field is a fact that
 * could not be read, so the rule needing it cannot fire.
 */
export type LinkRuleFacts = {
  userId: string;
  /** Paid standing (credit purchase or paid subscription); true also when it could not be read. */
  paying: boolean;
  /** The address is on a partner organization's signup domain; true also when it could not be read. */
  partnerDomain: boolean;
  /** Credits spent since signup (usage events, never the balance). */
  creditsSpent: number;
  /**
   * Accounts (this one included) on the same owned mail domain that signed up within the strong-link
   * window of this one, and how many of them spent credits since their signup.
   */
  ownedDomainCluster: { domain: string; accounts: number; spenders: number } | null;
  /** The address's domain (or a parent) an admin confirmed blocked on review; automated blocks do not count. */
  adminHeldDomain: string | null;
  /** Distinct banned accounts on the same uncommon device, outside the detection. */
  bannedSameDevice: number | null;
};

export const INTERVENTION_SCOPES = ['ai_spend', 'signup_grant', 'account'] as const;
export type InterventionScope = (typeof INTERVENTION_SCOPES)[number];

export const INTERVENTION_RELEASE_CONDITIONS = [
  'admin_release',
  'expiry',
  'verification',
  'legitimate_verdict',
  'contained',
] as const;
export type InterventionReleaseCondition = (typeof INTERVENTION_RELEASE_CONDITIONS)[number];

/** The global mode is the kill switch: off turns every tier off whatever the tier says. */
export const effectiveTierMode = (config: AutoContainmentConfig, tier: InterventionTier): AutoContainmentMode => {
  if (config.mode === 'off') return 'off';
  return tier === 'contain' ? config.mode : config.tiers[tier].mode;
};

export const AUTO_CONTAINMENT_OUTCOMES = [
  /**
   * Claimed and still running. A row left here past the stale window means the run died; the next
   * run on the detection reclaims and retries it (as it does a time-budget-partial Contain).
   */
  'pending',
  /** Shadow mode: would have contained the accounts. */
  'would_contain',
  /** Enforce mode: the accounts were contained. */
  'contained',
  /** The per-hour cap was spent; nothing was done. Re-evaluated by the first run after the window resets. */
  'capped',
  /** Enforce mode: the Contain path failed for at least one account, or no account was eligible. */
  'failed',
  /** Enforce mode: an admin ruled on the detection after the decision and before the Contain ran. */
  'withdrawn',
  /** Shadow mode, graduated tier: would have applied the hold. */
  'would_intervene',
  /** Enforce mode, graduated tier: the hold was applied. */
  'intervened',
  /** A graduated hold was released before it expired. */
  'released',
  /** A graduated hold lapsed at expiresAt. */
  'expired',
] as const;
export type AutoContainmentOutcome = (typeof AUTO_CONTAINMENT_OUTCOMES)[number];

export const autoContainmentDecisionItemSchema = z.object({
  id: z.string(),
  detectionId: z.string(),
  /** The detection revision decided; a later revision is decided again for its new members only. */
  revision: z.number().int(),
  assessmentId: z.string(),
  mode: z.enum(AUTO_CONTAINMENT_MODES).exclude(['off']),
  outcome: z.enum(AUTO_CONTAINMENT_OUTCOMES),
  userIds: z.array(z.string()),
  confidence: z.number(),
  /** The audit reason the Contain path carries (or would carry): the evidence, in short. */
  reason: z.string(),
  /** The bulk batch that contained the accounts; null in shadow mode or when nothing ran. */
  batchId: z.string().nullable(),
  /** Short diagnostic for a failed outcome; never vendor text. */
  error: z.string().nullable(),
  decidedAt: z.date(),
  /** Rows written before graduated tiers have no tier; they were all Contain decisions. */
  tier: z.enum(INTERVENTION_TIERS).prefault('contain'),
  /** null on rows written before the policy was versioned. */
  policyVersion: z.number().int().nullable().prefault(null),
  scope: z.enum(INTERVENTION_SCOPES).prefault('account'),
  /** When a graduated hold lapses on its own; null for Contain, which never expires. */
  expiresAt: z.date().nullable().prefault(null),
  releaseCondition: z.enum(INTERVENTION_RELEASE_CONDITIONS).nullable().prefault(null),
  releasedAt: z.date().nullable().prefault(null),
  releasedBy: z.string().nullable().prefault(null),
  releaseReason: z.string().nullable().prefault(null),
  /** Rows written before link rules were all decided by the model. */
  decidedBy: z.enum(INTERVENTION_DECIDERS).prefault('model'),
  /** The link rules that fired for the decision's accounts, whoever decided it. */
  linkRules: z.array(z.enum(LINK_RULES)).prefault([]),
  /** The model's own judgment on graduated rows, so abstention on rule-decided cases is measurable. */
  modelJudgment: z
    .object({ result: z.enum(ABUSE_ASSESSMENT_RESULTS), confidence: z.number().nullable() })
    .nullable()
    .prefault(null),
});
export type AutoContainmentDecisionItem = z.infer<typeof autoContainmentDecisionItemSchema>;

/**
 * One graduated hold on a user, keyed by the decision that applied it so release and expiry touch
 * only that hold, never a manual moderation, review state or another decision's hold.
 */
export const interventionHoldSchema = z.object({
  decisionId: z.string(),
  detectionId: z.string(),
  tier: z.enum(INTERVENTION_TIERS).exclude(['contain']),
  policyVersion: z.number().int(),
  reason: z.string(),
  appliedAt: z.date(),
  expiresAt: z.date(),
  releasedAt: z.date().nullable(),
  releasedBy: z.string().nullable(),
  /** Limit holds only: AI spend admitted per fixed hour, snapshotted so a later config change does not move it. */
  creditsPerHour: z.number().int().min(0).optional(),
});
export type InterventionHold = z.infer<typeof interventionHoldSchema>;

/** Active = not released and not yet expired. Expiry is enforced here, not by a sweep. */
export const isActiveInterventionHold = (hold: InterventionHold, now: Date): boolean =>
  hold.releasedAt === null && hold.expiresAt.getTime() > now.getTime();

/** Most applied decisions one rollback request releases (same cap as a bulk detection verdict). */
export const INTERVENTION_BULK_RELEASE_LIMIT = 100;

export const interventionHoldListSchema = z.object({ data: z.array(interventionHoldSchema) });
export const autoContainmentDecisionListSchema = z.object({ data: z.array(autoContainmentDecisionItemSchema) });

/** Admin release of one decision's hold, or of every applied decision of one tier (rollback). */
export const interventionReleaseRequestSchema = z.union([
  z.object({ decisionId: z.string().regex(/^[a-f0-9]{24}$/), reason: z.string() }),
  z.object({ tier: z.enum(INTERVENTION_TIERS).exclude(['contain']), reason: z.string() }),
]);
export const interventionReleaseResponseSchema = z.object({
  released: z.array(
    z.object({
      decisionId: z.string(),
      userIds: z.array(z.string()),
      /** Accounts the admin may not release (their own, or an admin's for a delegated admin); their hold stays. */
      skippedUserIds: z.array(z.string()).optional(),
    })
  ),
});
export type InterventionReleaseResponse = z.infer<typeof interventionReleaseResponseSchema>;
