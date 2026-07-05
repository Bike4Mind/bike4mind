import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { IChatHistoryItemDocument, IMessage, ISessionDocument } from '@bike4mind/common';
import { z } from 'zod';

const generateTagsSessionSchema = z.object({
  id: z.string(),
});

type GenerateTagsSessionParameters = z.infer<typeof generateTagsSessionSchema>;

interface GenerateTagsSessionAdapters {
  db: {
    sessions: {
      findByIdAndUserId: (id: string, userId: string) => Promise<ISessionDocument | null | undefined>;
      update: (session: ISessionDocument) => Promise<unknown>;
    };
    chatHistories: {
      findBySessionId: (sessionId: string) => Promise<IChatHistoryItemDocument | null>;
    };
  };
  llm: {
    complete: (messages: IMessage[]) => Promise<string>;
  };
}

export const generateTags = async (
  userId: string,
  parameters: GenerateTagsSessionParameters,
  { db, llm }: GenerateTagsSessionAdapters
) => {
  const { id } = secureParameters(parameters, generateTagsSessionSchema);

  const session = await db.sessions.findByIdAndUserId(id, userId);
  if (!session) {
    throw new NotFoundError('Session not found');
  }

  const chatHistory = await db.chatHistories.findBySessionId(session.id);
  if (!chatHistory) throw new UnprocessableEntityError('Chat histories is empty');

  const messages: IMessage[] = [
    {
      role: 'system',
      content:
        'Generate a structure for a word cloud based on the following' +
        'prompt.  The result should be a JSON array without any exposition, ' +
        'and each tag should have a "name" and numeric "strength" field.',
    },
    {
      role: 'user',
      content: chatHistory.prompt,
    },
  ];

  const result = await llm.complete(messages);
  const tags = result.replace(/^.*```json\n/, '').replace(/\n```$/, '');

  session.tags = JSON.parse(tags);

  await db.sessions.update(session);
  return session;
};
