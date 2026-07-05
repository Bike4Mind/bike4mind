import { IChatHistoryItemDocument, IFabFileRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { createSession, CreateSessionAdapters } from './create';

const cloneSessionSchema = z.object({
  id: z.string(),
});

type CloneSessionParameters = z.infer<typeof cloneSessionSchema>;

type CloneSessionAdapters = {
  db: {
    users: IUserRepository;
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    chatHistories: {
      findAllBySessionId: (sessionId: string) => Promise<IChatHistoryItemDocument[]>;
      create: (chat: Omit<IChatHistoryItemDocument, 'id'>) => Promise<IChatHistoryItemDocument>;
    };
  };
} & CreateSessionAdapters;

export const cloneSession = async (
  userId: string,
  parameters: CloneSessionParameters,
  { db }: CloneSessionAdapters
) => {
  const { id } = secureParameters(parameters, cloneSessionSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const session = await db.sessions.shareable.findAccessibleById(user, id);
  if (!session) throw new NotFoundError('Session not found');

  const buildCloneSession = {
    name: `Cloned ${session.name}`,
    knowledgeIds: session.knowledgeIds,
    tags: session.tags ? session.tags : [],
    summary: session.summary,
    summaryAt: session.summaryAt,
    clonedSourceId: session.id,
  };
  if (session.summary) buildCloneSession.summary = session.summary;
  if (session.summaryAt) buildCloneSession.summaryAt = session.summaryAt;

  const clonedSession = await createSession(user, buildCloneSession, {
    db,
  });

  const messagesToClone = await db.chatHistories.findAllBySessionId(id);

  // Clone all messages from the session
  await Promise.all(
    messagesToClone.map(async ({ id, ...messageData }) => {
      await db.chatHistories.create({
        ...messageData,
        sessionId: clonedSession.id,
      });
    })
  );

  return clonedSession;
};
