import { BRIEF_DECISION_CLOSED_ERROR_CODE, ConflictError, NotFoundError, type BriefDecision } from '@bike4mind/common';
import { assistantBriefRepository } from '@bike4mind/database';
import { serializeBrief } from './serializeBrief';

export const decisionClosed = () =>
  new ConflictError('This follow-up was already approved or dismissed.', {
    errorCode: BRIEF_DECISION_CLOSED_ERROR_CODE,
  });

/**
 * The caller's follow-up decision, for the edit and resolve routes. A missing or foreign brief, a missing
 * decision and an approval or question decision are all `404`; one no longer pending is `409`.
 */
export async function loadPendingFollowUp(briefId: string, userId: string, decisionId: string) {
  const brief = await assistantBriefRepository.findByIdForUser(briefId, userId);
  const decision = brief?.decisions.find(d => d.id === decisionId);
  const followUp = decision?.followUp;
  if (!decision || !followUp) throw new NotFoundError('Follow-up not found');
  if (followUp.state !== 'pending') throw decisionClosed();
  return { decision, followUp };
}

/** Re-reads the brief after a write and returns the decision as the API serializes it. */
export async function readSerializedDecision(
  briefId: string,
  userId: string,
  decisionId: string
): Promise<BriefDecision> {
  const brief = await assistantBriefRepository.findByIdForUser(briefId, userId);
  const decision = brief && (await serializeBrief(brief)).decisions.find(d => d.id === decisionId);
  if (!decision) throw new NotFoundError('Follow-up not found');
  return decision;
}
