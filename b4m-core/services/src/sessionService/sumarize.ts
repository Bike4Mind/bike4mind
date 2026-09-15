import { IChatHistoryItem, IMessage, ISession } from '@bike4mind/common';
import { z } from 'zod';
import { secureParameters } from '@bike4mind/utils';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';

const sumarizeSessionSchema = z.object({
  id: z.string(),
});

type SumarizeSessionParameters = z.infer<typeof sumarizeSessionSchema>;

interface SumarizeSessionAdapters {
  db: {
    sessions: {
      findByIdAndUserId: (id: string, userId: string) => Promise<ISession | null | undefined>;
      update: (session: ISession) => Promise<ISession | null>;
    };
    chatHistories: {
      findAllBySessionIdAndCreatedAtGreaterThanDate: (
        sessionId: string,
        createdAt: Date
      ) => Promise<IChatHistoryItem[]>;
    };
  };
  llm: {
    complete: (messages: IMessage[]) => Promise<string>;
  };
}

export const summarizeSession = async (
  userId: string,
  parameters: SumarizeSessionParameters,
  { db, llm }: SumarizeSessionAdapters
) => {
  const { id } = secureParameters(parameters, sumarizeSessionSchema);

  const session = await db.sessions.findByIdAndUserId(id, userId);
  if (!session) {
    throw new NotFoundError('Session not found');
  }

  const chatHistories = await db.chatHistories.findAllBySessionIdAndCreatedAtGreaterThanDate(
    session.id,
    session.summaryAt ?? session.firstCreated
  );

  if (!chatHistories.length) {
    throw new UnprocessableEntityError('Chat histories is empty');
  }

  const summaryLength = [150, 300];
  const messages: IMessage[] = [
    {
      role: 'system',
      content:
        'Generate an abstract summary of this session as text' +
        (session.summary ? ' based on the previous summary and the following updates' : '.') +
        `  It should be between ${summaryLength.join('-')} words in length.`,
    },
  ];

  if (session.summary) {
    messages.push({
      role: 'system',
      content: `Previous summary:\n${session.summary}`,
    });
  }

  const content = chatHistories
    .map(quest =>
      [`Question: ${quest.prompt}`, `Answer: ${quest.reply || quest.replies?.join('\n') || 'No reply'}`].join('\n')
    )
    .join('\n');

  messages.push({
    role: 'user',
    content,
  });

  const summary = await llm.complete(messages);

  session.summary = summary;
  session.summaryAt = new Date();

  await db.sessions.update(session);

  return session;
};
