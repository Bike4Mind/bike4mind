import {
  ADMIN_ACTION_REASON_MAX_LENGTH,
  type AbuseAssessmentItem,
  type AutoContainmentConfig,
  type ShadowDetectionItem,
} from '@bike4mind/common';

/**
 * Whether automated containment acts on one assessed detection. Pure, so the thresholds are tested
 * without a database; the executor (executor.ts) does the rest.
 */

export const AUTO_CONTAINMENT_SKIP_REASONS = [
  'mode_off',
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
  detection: Pick<ShadowDetectionItem, 'id' | 'detector' | 'summary'>
): string {
  const group = assessment.featureSummary.group;
  const signals =
    group && group.signals.length > 0 ? `; linked-account evidence: ${group.signals.map(formatSignal).join(', ')}` : '';
  const text =
    `Automated containment: abuse assessment ${assessment.id} (${assessment.model}, confidence ` +
    `${(assessment.confidence ?? 0).toFixed(2)}) on ${detection.detector} detection ${detection.id}: ` +
    `${detection.summary}${signals}`;
  return text.length <= ADMIN_ACTION_REASON_MAX_LENGTH
    ? text
    : `${text.slice(0, ADMIN_ACTION_REASON_MAX_LENGTH - 3)}...`;
}
