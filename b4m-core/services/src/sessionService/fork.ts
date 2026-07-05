import { IChatHistoryItemRepository, IFabFileRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { createSession, CreateSessionAdapters } from './create';

const forkSessionSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});

type ForkSessionParameters = z.infer<typeof forkSessionSchema>;

type ForkSessionAdapters = {
  db: {
    users: Pick<IUserRepository, 'findById'>;
    sessions: Pick<ISessionRepository, 'findByIdAndUserId'>;
    fabFiles: IFabFileRepository;
    chatHistories: Pick<
      IChatHistoryItemRepository,
      'findById' | 'findAllBySessionIdAndLessThanOrEqualToTimestamp' | 'create'
    >;
  };
} & CreateSessionAdapters;

export const forkSession = async (userId: string, parameters: ForkSessionParameters, adapters: ForkSessionAdapters) => {
  const { db } = adapters;
  const { sessionId, messageId } = secureParameters(parameters, forkSessionSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const session = await db.sessions.findByIdAndUserId(sessionId, userId);
  if (!session) throw new NotFoundError('Session not found');

  const message = await db.chatHistories.findById(messageId);
  if (!message) throw new NotFoundError('Message not found');

  const newSession = await createSession(
    user,
    {
      name: `Forked ${session.name}`,
      knowledgeIds: session.knowledgeIds,
      tags: session.tags,
      summary: session.summary,
      summaryAt: session.summaryAt,
      forkedSourceId: session.id,
    },
    adapters
  );

  const messagesToFork = await db.chatHistories.findAllBySessionIdAndLessThanOrEqualToTimestamp(
    sessionId,
    message.timestamp
  );

  await Promise.all(
    messagesToFork.map(async ({ id, ...messageData }) => {
      await db.chatHistories.create({
        ...messageData,
        sessionId: newSession.id,
      });
    })
  );
  return newSession;
};
