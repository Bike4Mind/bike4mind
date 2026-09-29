import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { questRepository, sessionRepository } from '@bike4mind/database';
import { resolveQuestTimeoutRecovery } from '@server/chatCompletion/questTimeoutRecovery';
import { dispatchQuestCallback } from '@server/generationCallback/dispatchQuestCallback';
import type { Request } from 'express';

const handler = baseApi().post(async (req: Request<{}, {}, {}, { id: string }>, res) => {
  const { id: questId } = req.query;
  const userId = req.user?.id;

  if (!questId) {
    throw new BadRequestError('Quest ID is required');
  }

  const quest = await questRepository.findById(questId);
  if (!quest) {
    throw new NotFoundError('Quest not found');
  }

  // Validate user access via session ownership
  const session = await sessionRepository.findById(quest.sessionId);
  if (!session) {
    throw new NotFoundError('Quest not found');
  }

  const userHasAccess = session.userId === userId || session.users?.some(userShare => userShare.userId === userId);
  if (!userHasAccess) {
    throw new NotFoundError('Quest not found');
  }

  // Recovery is a pure function of liveness (see resolveQuestTimeoutRecovery). A live quest keeps
  // its updatedAt fresh via the streaming heartbeat, so only a genuinely dead run is recovered.
  // Already-terminal quests return null here and are sent back as-is - that is how the client
  // recovers a successful run whose terminal WebSocket frame was lost (DB already 'done', content
  // intact).
  const recovery = resolveQuestTimeoutRecovery(quest, Date.now());
  if (!recovery) {
    return res.json(quest);
  }

  // Conditional, so a real answer that landed after the read above is returned rather than
  // overwritten; the re-read returns whichever state won.
  await questRepository.settleIfUnfinished(quest.id, recovery);
  const updatedQuest = await questRepository.findById(quest.id);
  if (!updatedQuest) {
    throw new NotFoundError('Quest not found');
  }
  // A recovery settles the quest; same settle-site dispatch as the poll route's recovery.
  await dispatchQuestCallback(quest.id, req.logger);
  return res.json(updatedQuest);
});

export default handler;
