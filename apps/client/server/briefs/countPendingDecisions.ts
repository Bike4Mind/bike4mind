import type { PendingDecisionCount } from '@bike4mind/common';
import { assistantBriefRepository, questRepository, sessionRepository } from '@bike4mind/database';
import { TOKEN_EXPIRATION_MS } from '@bike4mind/slack';

/**
 * Decisions waiting on the user (GET /api/v1/pending-decisions): the approvals still open in notebooks
 * they own, inside the window the pending-actions endpoints accept an answer in, plus the non-approval
 * decisions of their latest ready brief, the one a client shows by default. A brief's approval decision
 * is never counted from the brief: while open it is already among the approvals, and once answered or
 * lapsed it is no longer waiting.
 */
export async function countPendingDecisions(userId: string, now: number = Date.now()): Promise<PendingDecisionCount> {
  const [approvals, brief] = await Promise.all([
    sessionRepository
      .findSessionIdsByUserId(userId)
      .then(sessionIds => questRepository.countPendingActionsBySessionIds(sessionIds, now - TOKEN_EXPIRATION_MS)),
    assistantBriefRepository.findLatestReadyDecisionRefs(userId),
  ]);
  const briefDecisions = brief ? brief.decisions.filter(decision => !decision.approval).length : 0;
  return {
    count: approvals + briefDecisions,
    approvals,
    briefDecisions,
    briefId: brief ? String(brief._id) : null,
  };
}
