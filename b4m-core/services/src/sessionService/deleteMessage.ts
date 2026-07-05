import { IChatHistoryItemDocument, ISessionDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const deleteSessionMessageSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});

type DeleteSessionMessageParams = z.infer<typeof deleteSessionMessageSchema>;

interface DeleteSessionMessageAdapters {
  db: {
    sessions: {
      findByIdAndUserId: (id: string, userId: string) => Promise<ISessionDocument | null>;
    };
    chatHistories: {
      findBySessionIdAndId: (sessionId: string, id: string) => Promise<IChatHistoryItemDocument | null>;
      update: (value: IChatHistoryItemDocument) => Promise<unknown>;
    };
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

  await db.chatHistories.update(message);

  return message;
};
