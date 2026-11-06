import { signupRiskReviewAdvisorySchema, type SignupRiskReviewAdvisory } from '@bike4mind/common';
import { abuseAssessmentRepository, shadowDetectionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/** Detections read per queue request; the queue lists at most a few hundred accounts. */
const MAX_DETECTIONS = 1000;

/**
 * The advisory model verdict to show on each pending risk review row, keyed by user id. Read-only:
 * nothing that approves, reopens or rescores an account reads this, because the model judged
 * attacker-influenced data. Per user, an abuse judgment on any detection naming the account wins;
 * otherwise the newest judgment, among the newest MAX_DETECTIONS detections (a user whose judged
 * detections all fall outside that window shows no or a non-abuse verdict: an accepted miss for a
 * display-only hint). Users with no judged detection are absent from the map.
 */
export async function findRiskReviewAdvisories(
  userIds: string[],
  logger: Pick<Logger, 'warn'>
): Promise<Map<string, SignupRiskReviewAdvisory>> {
  const advisories = new Map<string, SignupRiskReviewAdvisory>();
  const detections = await shadowDetectionRepository.findForUsers(userIds, MAX_DETECTIONS);
  if (detections.length === 0) return advisories;
  if (detections.length === MAX_DETECTIONS)
    logger.warn('Signup risk review advisories capped; older detections not read', { limit: MAX_DETECTIONS });

  const assessments = await abuseAssessmentRepository.findLatestJudgedForDetections(detections.map(d => d.id));
  const assessmentByDetection = new Map(assessments.map(assessment => [assessment.detectionId, assessment]));
  const wanted = new Set(userIds);
  const judgedCount = new Map<string, number>();

  for (const detection of detections) {
    const assessment = assessmentByDetection.get(detection.id);
    if (!assessment) continue;
    // Stored rows outlive enum changes; one that no longer fits the response schema is dropped here
    // rather than failing validation of the whole queue response.
    const parsed = signupRiskReviewAdvisorySchema.safeParse({
      detectionId: detection.id,
      detector: detection.detector,
      result: assessment.result,
      confidence: assessment.confidence,
      assessedAt: assessment.assessedAt,
      otherVerdicts: 0,
    });
    if (!parsed.success) {
      logger.warn('Signup risk review advisory dropped: stored values no longer match', {
        detectionId: detection.id,
        detector: detection.detector,
        result: assessment.result,
      });
      continue;
    }
    const candidate = parsed.data;
    for (const userId of detection.userIds) {
      if (!wanted.has(userId)) continue;
      judgedCount.set(userId, (judgedCount.get(userId) ?? 0) + 1);
      const current = advisories.get(userId);
      if (!current || outranks(candidate, current)) advisories.set(userId, candidate);
    }
  }
  for (const [userId, advisory] of advisories) advisory.otherVerdicts = (judgedCount.get(userId) ?? 1) - 1;
  return advisories;
}

function outranks(candidate: SignupRiskReviewAdvisory, current: SignupRiskReviewAdvisory): boolean {
  const candidateIsAbuse = candidate.result === 'abuse';
  if (candidateIsAbuse !== (current.result === 'abuse')) return candidateIsAbuse;
  return new Date(candidate.assessedAt).getTime() > new Date(current.assessedAt).getTime();
}
