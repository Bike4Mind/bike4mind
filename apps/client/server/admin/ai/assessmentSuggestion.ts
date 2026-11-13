import {
  ADMIN_AI_MAX_OVERRIDE_REASON_CHARS,
  ADMIN_AI_MAX_REASONS,
  ADMIN_AI_MAX_REASON_CHARS,
  confidenceBand,
  type AbuseAssessmentItem,
  type AbuseAssessmentJudgment,
  type AdminAiFeature,
  type AdminAiSuggestionItem,
  type AssessmentAiDecision,
  type AssessmentSuggestionSurface,
  type ShadowDetectionVerdict,
} from '@bike4mind/common';
import { abuseAssessmentRepository, adminAiSuggestionRepository, shadowDetectionRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { recordAiDecision } from './audit';

/**
 * Turns a stored abuse assessment into an AdminAiSuggestion row for one admin queue, so an admin's
 * accept or override is recorded against it (see b4m-core/common/src/schemas/adminAi.ts). The
 * assessment itself is untouched: this only reads it.
 */

const SURFACE_FEATURE: Record<AssessmentSuggestionSurface, AdminAiFeature> = {
  shadowDetection: 'detectionTriage',
  signupRiskReview: 'abuseAssessment',
  heldSignupGrant: 'abuseAssessment',
};

/** The Detections grade an assessment judgment proposes. */
export const ASSESSMENT_PROPOSED_VERDICT: Record<AbuseAssessmentJudgment, ShadowDetectionVerdict> = {
  abuse: 'confirmed_abuse',
  legitimate_automation: 'legitimate_automation',
  insufficient_evidence: 'insufficient_evidence',
};

/** What accepting an abuse assessment means on each user queue: leave the account as it is. */
const USER_SURFACE_PROPOSAL = {
  signupRiskReview: 'keep_in_review',
  heldSignupGrant: 'keep_held',
} as const;

type UserSurface = keyof typeof USER_SURFACE_PROPOSAL;

export type AdminDecider = { userId: string; name: string };

const overrideReasonText = (reason: string): string => reason.slice(0, ADMIN_AI_MAX_OVERRIDE_REASON_CHARS);

const isJudgment = (result: AbuseAssessmentItem['result']): result is AbuseAssessmentJudgment => result !== 'unknown';

async function loadJudgedAssessment(
  assessmentId: string
): Promise<AbuseAssessmentItem & { result: AbuseAssessmentJudgment }> {
  const assessment = await abuseAssessmentRepository.findById(assessmentId);
  if (!assessment || !isJudgment(assessment.result)) throw new BadRequestError('Assessment not found');
  return assessment as AbuseAssessmentItem & { result: AbuseAssessmentJudgment };
}

function proposalFor(
  surface: AssessmentSuggestionSurface,
  result: AbuseAssessmentJudgment
): { verdict: string } | { action: string } {
  if (surface === 'shadowDetection') return { verdict: ASSESSMENT_PROPOSED_VERDICT[result] };
  return { action: USER_SURFACE_PROPOSAL[surface] };
}

/**
 * The pending (or already decided) suggestion row for this queue item and assessment. Keyed per
 * surface so the same assessment shown on two queues is decided separately on each.
 */
async function suggestionFor(
  surface: AssessmentSuggestionSurface,
  entityId: string,
  assessment: AbuseAssessmentItem & { result: AbuseAssessmentJudgment }
): Promise<AdminAiSuggestionItem> {
  const probability = assessment.confidence ?? 0;
  return adminAiSuggestionRepository.createPending({
    feature: SURFACE_FEATURE[surface],
    entityType: surface,
    entityId,
    inputHash: `${surface}:${assessment.id}`,
    policyVersion: String(assessment.policyVersion),
    model: assessment.model,
    verdict: assessment.result,
    confidence: { probability, band: confidenceBand(probability) },
    reasons: (assessment.reasons ?? []).slice(0, ADMIN_AI_MAX_REASONS).map(reason => ({
      text: `${reason.key} (${Math.round(reason.probability * 100)}%)`.slice(0, ADMIN_AI_MAX_REASON_CHARS),
      evidenceLinks: [],
    })),
    proposedAction: proposalFor(surface, assessment.result),
    // The assessment's own cost was billed when it ran; showing it again costs nothing.
    costUsd: 0,
    latencyMs: 0,
  });
}

/**
 * Records a Detections grade taken from the detection's assessment: accepted when the grade is the
 * one the assessment proposed, else overridden with the admin's reason. Returns the suggestion id
 * for the audit entry. A suggestion that was already decided keeps its first decision.
 */
export async function recordDetectionAssessmentDecision(input: {
  detectionId: string;
  verdict: ShadowDetectionVerdict;
  aiDecision: AssessmentAiDecision;
  fallbackReason: string;
  decidedBy: AdminDecider;
}): Promise<string> {
  const assessment = await loadJudgedAssessment(input.aiDecision.assessmentId);
  if (assessment.detectionId !== input.detectionId) throw new BadRequestError('Assessment is for another detection');
  const suggestion = await suggestionFor('shadowDetection', input.detectionId, assessment);
  const accepted = ASSESSMENT_PROPOSED_VERDICT[assessment.result] === input.verdict;
  await recordAiDecision(suggestion.id, accepted ? 'accepted' : 'overridden', {
    decidedBy: input.decidedBy,
    overrideAction: accepted ? null : { verdict: input.verdict },
    overrideReason: accepted ? null : overrideReasonText(input.aiDecision.overrideReason ?? input.fallbackReason),
    overrideCostly: false,
  });
  return suggestion.id;
}

/**
 * The suggestion row for an abuse assessment shown on a user queue, after checking the assessment
 * judged a detection naming that user. Only an abuse judgment is a suggestion there: a model's
 * "legitimate" never proposes approving or paying an account.
 */
export async function userAssessmentSuggestion(
  surface: UserSurface,
  userId: string,
  assessmentId: string
): Promise<AdminAiSuggestionItem> {
  const assessment = await loadJudgedAssessment(assessmentId);
  if (assessment.result !== 'abuse') throw new BadRequestError('Only an abuse assessment can be decided here');
  const detection = await shadowDetectionRepository.findById(assessment.detectionId);
  if (!detection?.userIds.includes(userId)) throw new BadRequestError('Assessment does not name this account');
  return suggestionFor(surface, userId, assessment);
}

/** Records an admin acting against a user-queue abuse assessment (approving or releasing anyway). */
export async function recordUserAssessmentOverride(
  suggestion: AdminAiSuggestionItem,
  input: { overrideAction: { action: string }; overrideReason: string; decidedBy: AdminDecider }
): Promise<AdminAiSuggestionItem | null> {
  return recordAiDecision(suggestion.id, 'overridden', {
    decidedBy: input.decidedBy,
    overrideAction: input.overrideAction,
    overrideReason: overrideReasonText(input.overrideReason),
    overrideCostly: true,
  });
}
