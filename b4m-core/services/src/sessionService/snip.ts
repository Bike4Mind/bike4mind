import { IChatHistoryItemDocument, IFabFileRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { createSession, CreateSessionAdapters } from './create';

const snipSessionSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});

type SnipSessionParameters = z.infer<typeof snipSessionSchema>;

type SnipSessionAdapters = {
  db: {
    users: Pick<IUserRepository, 'findById'>;
    sessions: Pick<ISessionRepository, 'findByIdAndUserId'>;
    fabFiles: IFabFileRepository;
    chatHistories: {
      findAllBySessionIdAndGreaterThanOrEqualToTimestamp: (
        sessionId: string,
        timestamp: Date
      ) => Promise<IChatHistoryItemDocument[]>;
      findById: (id: string) => Promise<IChatHistoryItemDocument | null>;
      create: (chat: Omit<IChatHistoryItemDocument, 'id'>) => Promise<IChatHistoryItemDocument>;
    };
  };
} & CreateSessionAdapters;

export const snipSession = async (userId: string, parameters: SnipSessionParameters, adapters: SnipSessionAdapters) => {
  const { db } = adapters;
  const { sessionId, messageId } = secureParameters(parameters, snipSessionSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const session = await db.sessions.findByIdAndUserId(sessionId, userId);
  if (!session) throw new NotFoundError('Session not found');

  const message = await db.chatHistories.findById(messageId);
  if (!message) throw new NotFoundError('Message not found');

  const newSession = await createSession(
    user,
    {
      name: `Snip ${session.name}`,
      knowledgeIds: session.knowledgeIds,
      tags: session.tags,
      summary: session.summary,
      summaryAt: session.summaryAt,
    },
    adapters
  );

  const messagesToSnip = await db.chatHistories.findAllBySessionIdAndGreaterThanOrEqualToTimestamp(
    sessionId,
    message.timestamp
  );

  await Promise.all(
    messagesToSnip.map(async ({ id, ...messageData }) => {
      await db.chatHistories.create({
        ...messageData,
        sessionId: newSession.id,
      });
    })
  );
  return newSession;
};
