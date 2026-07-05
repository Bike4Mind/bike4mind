import { IFabFileRepository, IChatHistoryItemRepository, ISessionRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { getFabFile, GetFabFileAdapter } from './get';

const listFabFilesBySessionSchema = z.object({
  sessionId: z.string(),
});

type ListFabFilesBySessionParameters = z.infer<typeof listFabFilesBySessionSchema>;

type ListFabFilesBySessionAdapters = GetFabFileAdapter & {
  db: GetFabFileAdapter['db'] & {
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    chatHistories: IChatHistoryItemRepository;
  };
};

export const listFabFilesBySession = async (
  userId: string,
  parameters: ListFabFilesBySessionParameters,
  { db, storage }: ListFabFilesBySessionAdapters
) => {
  const { sessionId } = secureParameters(parameters, listFabFilesBySessionSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const session = await db.sessions.shareable.findAccessibleById(user, sessionId);
  if (!session) {
    throw new NotFoundError('Session not found');
  }

  const chatHistories = await db.chatHistories.findAllBySessionId(sessionId);
  const chatHistoryFabFileIds = chatHistories
    .map(chatHistory => chatHistory.fabFileIds)
    .flat()
    .filter(f => f !== undefined);

  const fabFiles = await db.fabFiles.findAllByIds([...(session.knowledgeIds || []), ...(chatHistoryFabFileIds || [])]);

  const result = await Promise.allSettled(
    fabFiles.map(fabFile => getFabFile(userId, { id: fabFile.id }, { db, storage }))
  ).then(results => {
    return results.filter(r => r.status === 'fulfilled').map(r => r.value);
  });

  return result;
};
