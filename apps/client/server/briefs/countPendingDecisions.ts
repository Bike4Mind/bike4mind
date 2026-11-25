import { PENDING_ACTION_TTL_MS, type PendingDecisionCount } from '@bike4mind/common';
import { assistantBriefRepository, questRepository, sessionRepository } from '@bike4mind/database';

/**
 * Decisions waiting on the user (GET /api/v1/pending-decisions): the approvals still open in notebooks
 * they own, inside the window the pending-actions endpoints accept an answer in, plus the non-approval
 * decisions of the latest regular activity brief and busy-block briefs readied since it, excluding memo
 * follow-up briefs, answered questions and resolved follow-ups. A brief's approval decision is never
 * counted from the brief: while open it is already among approvals, and after resolution it is no longer pending.
 */
export async function countPendingDecisions(userId: string, now: number = Date.now()): Promise<PendingDecisionCount> {
  const [approvals, brief] = await Promise.all([
    sessionRepository
      .findSessionIdsByUserId(userId)
      .then(sessionIds => questRepository.countPendingActionsBySessionIds(sessionIds, now - PENDING_ACTION_TTL_MS)),
    assistantBriefRepository.findLatestReadyDecisionRefs(userId),
  ]);
  const briefDecisions = brief
    ? brief.decisions.filter(
        decision =>
          !decision.approval && !decision.repliedAt && (!decision.followUp || decision.followUp.state === 'pending')
      ).length
    : 0;
  return {
    count: approvals + briefDecisions,
    approvals,
    briefDecisions,
    briefId: brief ? String(brief._id) : null,
  };
}
