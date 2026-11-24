import { createHash } from 'node:crypto';
import {
  ADMIN_ACTION_REASON_MAX_LENGTH,
  effectiveTierMode,
  INTERVENTION_POLICY_VERSION,
  isReviewOnlyCompletionDetector,
  type AbuseAssessmentItem,
  type AutoContainmentConfig,
  type AutoContainmentMode,
  type GraduatedInterventionTier,
  type InterventionScope,
  type InterventionTier,
  type ShadowDetectionItem,
} from '@bike4mind/common';

/**
 * Whether automated containment acts on one assessed detection. Pure, so the thresholds are tested
 * without a database; the executor (executor.ts) does the rest.
 */

export const AUTO_CONTAINMENT_SKIP_REASONS = [
  'mode_off',
  'review_only_detector',
  'not_abuse',
  'below_confidence',
  /** The detector's policy maps the detection to something other than containment (restrict, blockIp). */
  'not_a_containment_detection',
  /** An admin already judged the detection: their verdict wins, whatever it is. */
  'already_reviewed',
  'no_accounts',
  'too_many_accounts',
] as const;
export type AutoContainmentSkipReason = (typeof AUTO_CONTAINMENT_SKIP_REASONS)[number];

export type ContainmentDecision =
  { kind: 'contain'; userIds: string[]; reason: string } | { kind: 'skip'; why: AutoContainmentSkipReason };

const CONTAINMENT_ACTIONS: ReadonlySet<ShadowDetectionItem['wouldAction']> = new Set(['contain', 'suspend']);

export function decideContainment(input: {
  assessment: Pick<AbuseAssessmentItem, 'id' | 'result' | 'confidence' | 'model' | 'featureSummary'>;
  detection: Pick<ShadowDetectionItem, 'id' | 'detector' | 'wouldAction' | 'userIds' | 'verdict' | 'summary'>;
  config: Pick<AutoContainmentConfig, 'mode' | 'minConfidence' | 'maxAccountsPerDetection'>;
}): ContainmentDecision {
  const { assessment, detection, config } = input;
  if (config.mode === 'off') return { kind: 'skip', why: 'mode_off' };
  if (isReviewOnlyCompletionDetector(detection.detector)) return { kind: 'skip', why: 'review_only_detector' };
  if (assessment.result !== 'abuse') return { kind: 'skip', why: 'not_abuse' };
  if ((assessment.confidence ?? 0) < config.minConfidence) return { kind: 'skip', why: 'below_confidence' };
  if (!CONTAINMENT_ACTIONS.has(detection.wouldAction)) return { kind: 'skip', why: 'not_a_containment_detection' };
  if (detection.verdict !== null) return { kind: 'skip', why: 'already_reviewed' };
  const userIds = [...new Set(detection.userIds)];
  if (userIds.length === 0) return { kind: 'skip', why: 'no_accounts' };
  if (userIds.length > config.maxAccountsPerDetection) return { kind: 'skip', why: 'too_many_accounts' };
  return { kind: 'contain', userIds, reason: containmentReason(input.assessment, input.detection) };
}

const formatSignal = ({ key, value }: { key: string; value: number | boolean | null }) =>
  `${key}=${value === null ? 'unknown' : String(value)}`;

/**
 * The audit reason: which judgment, on which detection, from which evidence. Kept to the admin
 * reason limit, so the most important part (the judgment and the detection) comes first.
 */
export function containmentReason(
  assessment: Pick<AbuseAssessmentItem, 'id' | 'confidence' | 'model' | 'featureSummary'>,
  detection: Pick<ShadowDetectionItem, 'id' | 'detector' | 'summary'>,
  label = 'Automated containment'
): string {
  const group = assessment.featureSummary.group;
  const signals =
    group && group.signals.length > 0 ? `; linked-account evidence: ${group.signals.map(formatSignal).join(', ')}` : '';
  const text =
    `${label}: abuse assessment ${assessment.id} (${assessment.model}, confidence ` +
    `${(assessment.confidence ?? 0).toFixed(2)}) on ${detection.detector} detection ${detection.id}: ` +
    `${detection.summary}${signals}`;
  return text.length <= ADMIN_ACTION_REASON_MAX_LENGTH
    ? text
    : `${text.slice(0, ADMIN_ACTION_REASON_MAX_LENGTH - 3)}...`;
}

export const INTERVENTION_SKIP_REASONS = [
  ...AUTO_CONTAINMENT_SKIP_REASONS,
  'tier_off',
  /** The detection's wouldAction maps to no tier (blockIp, releaseHold, none). */
  'not_an_intervention_detection',
  /** No usable judgment (provider failure or no confidence): never read as clean, never releases. */
  'evidence_unavailable',
  'stale_evidence',
  /** Every account fell outside the tier's rolloutPercent. */
  'not_in_rollout',
] as const;
export type InterventionSkipReason = (typeof INTERVENTION_SKIP_REASONS)[number];

export type InterventionDecision =
  | {
      kind: 'act';
      tier: InterventionTier;
      mode: Exclude<AutoContainmentMode, 'off'>;
      userIds: string[];
      reason: string;
      scope: InterventionScope;
      /** null for Contain, which never lapses. */
      expiresAt: Date | null;
      policyVersion: number;
    }
  | { kind: 'skip'; why: InterventionSkipReason; tier: InterventionTier | null };

/** The versioned table; changing it means bumping INTERVENTION_POLICY_VERSION. */
const TIER_BY_ACTION: Partial<Record<ShadowDetectionItem['wouldAction'], InterventionTier>> = {
  contain: 'contain',
  suspend: 'contain',
  restrict: 'review',
  confirmHold: 'holdGrant',
  limit: 'limit',
  verify: 'verify',
};

const SCOPE_BY_TIER: Record<InterventionTier, InterventionScope> = {
  contain: 'account',
  limit: 'ai_spend',
  verify: 'ai_spend',
  review: 'ai_spend',
  holdGrant: 'signup_grant',
};

const HOUR_MS = 60 * 60 * 1000;
const MAX_EVIDENCE_AGE_MS = 24 * HOUR_MS;
/** Tolerated clock skew for an assessment stamped slightly ahead of this host. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Stable 0-99 bucket per account, so a tier's rollout never flips an account in and out between runs. */
export const rolloutBucket = (userId: string): number =>
  createHash('sha256').update(userId).digest().readUInt32BE(0) % 100;

/**
 * Which tier, if any, acts on one assessed detection. Contain keeps decideContainment's rules
 * unchanged; graduated tiers also refuse unusable or stale evidence and honor the tier's rollout.
 */
export function decideIntervention(input: {
  assessment: Pick<AbuseAssessmentItem, 'id' | 'result' | 'confidence' | 'model' | 'featureSummary' | 'assessedAt'>;
  detection: Pick<ShadowDetectionItem, 'id' | 'detector' | 'wouldAction' | 'userIds' | 'verdict' | 'summary'>;
  config: AutoContainmentConfig;
  now: Date;
  /** Whether any verification flow (card or phone) can clear a verify hold; without one, verify becomes review. */
  verificationAvailable: boolean;
}): InterventionDecision {
  const { assessment, detection, config, now } = input;
  const mapped = TIER_BY_ACTION[detection.wouldAction];
  if (!mapped) return { kind: 'skip', why: 'not_an_intervention_detection', tier: null };

  if (mapped === 'contain') {
    const decided = decideContainment(input);
    if (decided.kind === 'skip') return { ...decided, tier: 'contain' };
    return {
      kind: 'act',
      tier: 'contain',
      mode: config.mode === 'enforce' ? 'enforce' : 'shadow',
      userIds: decided.userIds,
      reason: decided.reason,
      scope: SCOPE_BY_TIER.contain,
      expiresAt: null,
      policyVersion: INTERVENTION_POLICY_VERSION,
    };
  }

  const tier: GraduatedInterventionTier = mapped === 'verify' && !input.verificationAvailable ? 'review' : mapped;
  const skip = (why: InterventionSkipReason): InterventionDecision => ({ kind: 'skip', why, tier });
  const tierConfig = config.tiers[tier];
  const mode = effectiveTierMode(config, tier);
  if (config.mode === 'off') return skip('mode_off');
  if (mode === 'off') return skip('tier_off');
  if (isReviewOnlyCompletionDetector(detection.detector)) return skip('review_only_detector');
  if (assessment.result === 'unknown' || assessment.confidence === null) return skip('evidence_unavailable');
  const age = now.getTime() - assessment.assessedAt.getTime();
  const maxAge = Math.min(tierConfig.expiryHours * HOUR_MS, MAX_EVIDENCE_AGE_MS);
  if (age > maxAge || age < -FUTURE_SKEW_MS) return skip('stale_evidence');
  if (assessment.result !== 'abuse') return skip('not_abuse');
  if (assessment.confidence < tierConfig.minConfidence) return skip('below_confidence');
  if (detection.verdict !== null) return skip('already_reviewed');
  const named = [...new Set(detection.userIds)];
  if (named.length === 0) return skip('no_accounts');
  if (named.length > config.maxAccountsPerDetection) return skip('too_many_accounts');
  const userIds = named.filter(id => rolloutBucket(id) < tierConfig.rolloutPercent);
  if (userIds.length === 0) return skip('not_in_rollout');

  return {
    kind: 'act',
    tier,
    mode,
    userIds,
    reason: containmentReason(assessment, detection, `Automated ${tier} (policy v${INTERVENTION_POLICY_VERSION})`),
    scope: SCOPE_BY_TIER[tier],
    expiresAt: new Date(now.getTime() + tierConfig.expiryHours * HOUR_MS),
    policyVersion: INTERVENTION_POLICY_VERSION,
  };
}
