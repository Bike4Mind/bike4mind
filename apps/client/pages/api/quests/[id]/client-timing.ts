import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { questRepository, sessionRepository } from '@bike4mind/database';
import type { Request } from 'express';
import { z } from 'zod';

const ClientTimingSchema = z.object({
  clientFirstTokenTime: z.number().positive(),
});

const handler = baseApi().post(async (req: Request<{}, {}, { clientFirstTokenTime: number }, { id: string }>, res) => {
  const { id: questId } = req.query;
  const userId = req.user?.id;

  if (!questId) {
    throw new BadRequestError('Quest ID is required');
  }

  const validatedBody = ClientTimingSchema.parse(req.body);
  const { clientFirstTokenTime } = validatedBody;

  const quest = await questRepository.findById(questId);

  if (!quest) {
    throw new NotFoundError('Quest not found');
  }

  const session = await sessionRepository.findById(quest.sessionId);
  if (!session) {
    throw new NotFoundError('Quest not found');
  }

  const userHasAccess = session.userId === userId || session.users?.some(userShare => userShare.userId === userId);

  if (!userHasAccess) {
    throw new NotFoundError('Quest not found');
  }

  const updatedQuest = await questRepository.update({
    ...quest,
    promptMeta: {
      ...quest.promptMeta,
      performance: {
        ...quest.promptMeta?.performance,
        clientFirstTokenTime,
      },
    },
  });

  if (!updatedQuest) {
    throw new Error('Failed to update quest');
  }

  return res.json({
    success: true,
    clientFirstTokenTime,
    questId: updatedQuest.id,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
