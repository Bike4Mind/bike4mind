import type { AbuseAssessmentJudgment, SignupRiskReviewAdvisory } from '@bike4mind/common';
import { abuseAssessmentRepository, shadowDetectionRepository } from '@bike4mind/database';

/** Detections read per queue request; the queue lists at most a few hundred accounts. */
const MAX_DETECTIONS = 1000;

/**
 * The advisory model verdict to show on each pending risk review row, keyed by user id. Read-only:
 * nothing that approves, reopens or rescores an account reads this, because the model judged
 * attacker-influenced data. Per user, an abuse judgment on any detection naming the account wins;
 * otherwise the newest judgment. Users with no judged detection are absent from the map.
 */
export async function findRiskReviewAdvisories(userIds: string[]): Promise<Map<string, SignupRiskReviewAdvisory>> {
  const advisories = new Map<string, SignupRiskReviewAdvisory>();
  const detections = await shadowDetectionRepository.findForUsers(userIds, MAX_DETECTIONS);
  if (detections.length === 0) return advisories;

  const assessments = await abuseAssessmentRepository.findLatestJudgedForDetections(detections.map(d => d.id));
  const assessmentByDetection = new Map(assessments.map(assessment => [assessment.detectionId, assessment]));
  const wanted = new Set(userIds);

  for (const detection of detections) {
    const assessment = assessmentByDetection.get(detection.id);
    // findLatestJudgedForDetections drops unknown, so this narrows to a judgment.
    if (!assessment || assessment.result === 'unknown') continue;
    const candidate: SignupRiskReviewAdvisory = {
      detectionId: detection.id,
      detector: detection.detector,
      result: assessment.result satisfies AbuseAssessmentJudgment,
      confidence: assessment.confidence,
      assessedAt: assessment.assessedAt,
    };
    for (const userId of detection.userIds) {
      if (!wanted.has(userId)) continue;
      const current = advisories.get(userId);
      if (!current || outranks(candidate, current)) advisories.set(userId, candidate);
    }
  }
  return advisories;
}

function outranks(candidate: SignupRiskReviewAdvisory, current: SignupRiskReviewAdvisory): boolean {
  const candidateIsAbuse = candidate.result === 'abuse';
  if (candidateIsAbuse !== (current.result === 'abuse')) return candidateIsAbuse;
  return new Date(candidate.assessedAt).getTime() > new Date(current.assessedAt).getTime();
}
