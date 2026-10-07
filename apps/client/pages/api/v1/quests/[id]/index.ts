import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { NotFoundError } from '@server/utils/errors';
import { questRepository, sessionRepository } from '@bike4mind/database';
import { getQuestContract } from '@bike4mind/common';
import { toQuestPollBody } from '@server/utils/questPollBody';
import { applyRecoveryInMemory, resolveQuestTimeoutRecovery } from '@server/chatCompletion/questTimeoutRecovery';
import { dispatchQuestCallback } from '@server/generationCallback/dispatchQuestCallback';
import { isSessionOwnedByUser } from '@server/utils/sessionOwnership';

// Reading a quest is the documented poll step after POST /api/chat, so the contract's scopes
// include ai:chat / ai:generate as well as notebooks:read - otherwise a least-privilege chat key
// 403s on its own reply.
const handler = nextRouteForContract(getQuestContract, {
  // Quest status is the poll step of the async generation pipeline; don't let
  // polling one job to completion burn the daily quota that meters submissions.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const questId = req.validatedParams.id;
  const userId = req.user?.id;

  const quest = await questRepository.findById(questId);

  if (!quest) {
    throw new NotFoundError('Quest not found');
  }

  const session = await sessionRepository.findById(quest.sessionId);
  if (!session) {
    throw new NotFoundError('Quest not found');
  }

  const userHasAccess = isSessionOwnedByUser(session, userId);

  if (!userHasAccess) {
    throw new NotFoundError('Quest not found');
  }

  // A share grant authorizes reading the conversation, not re-reading whatever the owner's
  // tools touched on the owner's behalf - see redactPromptMetaForViewer. It also gates the
  // recovery write below.
  const isOwner = session.userId === userId;

  // Recover a stuck quest on read so API clients (CLI, MCP, automated harnesses) that poll
  // this endpoint get a terminal status without needing the browser-only check-timeout POST.
  // See resolveQuestTimeoutRecovery for the liveness-based decision.
  //
  // Owner-only: a sharee's read must not stamp a terminal status onto someone else's quest.
  // The sweep cron is the backstop for a quest only sharees ever poll, so nothing stays stuck.
  const recovery = isOwner ? resolveQuestTimeoutRecovery(quest, Date.now()) : null;
  if (recovery) {
    try {
      // Conditional on the quest still being unfinished so a real answer that landed between
      // the read above and this write keeps it. Best-effort: writes fail for reasons reads do
      // not (a primary stepdown, a write-concern timeout), and letting that turn a GET that can
      // still answer into a 500 is strictly worse than the pre-recovery behaviour. Recovery is
      // idempotent, so the next poll or the next sweep redoes it.
      const applied = await questRepository.settleIfUnfinished(quest.id, recovery);
      if (applied) {
        // `updatedAt` is maintained by mongoose timestamps on that write, so report the write
        // rather than the stale value the read returned.
        applyRecoveryInMemory(quest, recovery);
        quest.updatedAt = new Date();
        await dispatchQuestCallback(quest.id, req.logger);
      }
    } catch (err) {
      req.logger.warn('Timeout recovery write failed; returning quest as-is', { questId: quest.id, err });
    }
  }

  return res.json(toQuestPollBody(quest, { isOwner, logger: req.logger }));
});

export default handler;
