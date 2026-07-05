import { IFabFileRepository, IChatHistoryItemRepository, ISessionRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { getFabFile, GetFabFileAdapter } from './get';

const listFabFilesByQuestSchema = z.object({
  questId: z.string(),
});

type ListFabFilesByQuestParameters = z.infer<typeof listFabFilesByQuestSchema>;

type ListFabFilesByQuestAdapters = GetFabFileAdapter & {
  db: GetFabFileAdapter['db'] & {
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    chatHistories: IChatHistoryItemRepository;
  };
};

export const listFabFilesByQuest = async (
  userId: string,
  parameters: ListFabFilesByQuestParameters,
  { db, storage }: ListFabFilesByQuestAdapters
) => {
  const { questId } = secureParameters(parameters, listFabFilesByQuestSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const quest = await db.chatHistories.findById(questId);
  if (!quest) {
    throw new NotFoundError('Quest not found');
  }

  // Check if user has access to the session containing this quest
  const session = await db.sessions.shareable.findAccessibleById(user, quest.sessionId);
  if (!session) {
    throw new NotFoundError('Quest not found');
  }

  // Get fabFileIds from the quest (message-level files)
  const fabFileIds = quest.fabFileIds || [];

  if (fabFileIds.length === 0) {
    return [];
  }

  const fabFiles = await db.fabFiles.findAllByIds(fabFileIds);

  const result = await Promise.allSettled(
    fabFiles.map(fabFile => getFabFile(userId, { id: fabFile.id }, { db, storage }))
  ).then(results => {
    return results.filter(r => r.status === 'fulfilled').map(r => r.value);
  });

  return result;
};
