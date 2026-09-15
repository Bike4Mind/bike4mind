import { IChatHistoryItemRepository, ISessionRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const deleteSessionMessageSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});

type DeleteSessionMessageParams = z.infer<typeof deleteSessionMessageSchema>;

interface DeleteSessionMessageAdapters {
  db: {
    sessions: Pick<ISessionRepository, 'findByIdAndUserId'>;
    chatHistories: Pick<IChatHistoryItemRepository, 'findBySessionIdAndId' | 'update'>;
  };
}

export const deleteSessionMessage = async (
  userId: string,
  params: DeleteSessionMessageParams,
  { db }: DeleteSessionMessageAdapters
) => {
  const { sessionId, messageId } = secureParameters(params, deleteSessionMessageSchema);

  const session = await db.sessions.findByIdAndUserId(sessionId, userId);
  if (!session) throw new NotFoundError('Session not found');

  const message = await db.chatHistories.findBySessionIdAndId(sessionId, messageId);
  if (!message) throw new NotFoundError('Message not found');

  message.deletedAt = new Date();

  // update() matches by _id alone and can return null if nothing matched. Quest documents are
  // normally only soft-deleted, but notebookImportComplete.ts's session-replace flow does hard
  // delete matching rows, so this guards a narrow real race rather than dead code - report it as
  // a real failure rather than success on a write that touched nothing.
  const updated = await db.chatHistories.update(message);
  if (!updated) throw new NotFoundError('Message not found');

  return updated;
};
