import {
  IChatHistoryItemRepository,
  IFabFileRepository,
  ISessionRepository,
  IUserRepository,
  rebindPromptMetaSession,
} from '@bike4mind/common';
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
    chatHistories: Pick<
      IChatHistoryItemRepository,
      'findBySessionIdAndId' | 'findAllBySessionIdAndGreaterThanOrEqualToTimestamp' | 'create'
    >;
  };
} & CreateSessionAdapters;

export const snipSession = async (userId: string, parameters: SnipSessionParameters, adapters: SnipSessionAdapters) => {
  const { db } = adapters;
  const { sessionId, messageId } = secureParameters(parameters, snipSessionSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const session = await db.sessions.findByIdAndUserId(sessionId, userId);
  if (!session) throw new NotFoundError('Session not found');

  const message = await db.chatHistories.findBySessionIdAndId(sessionId, messageId);
  if (!message) throw new NotFoundError('Message not found');

  const newSession = await createSession(
    user,
    {
      name: `Snip ${session.name}`,
      knowledgeIds: session.knowledgeIds,
      tags: session.tags,
      summary: session.summary,
      summaryAt: session.summaryAt,
      // Carried from the source, not re-derived: the parent's scope is already correct and explicit,
      // and re-deriving it here would go through the OWNERSHIP arm alone (no resolveLakeAccess is
      // threaded to this path), which cannot see a teammate-authored organization-lake file. That
      // derives an EMPTY list, and an empty list is not a narrow scope - fabFileSearchQuery skips its
      // tag clause, so the copy would silently widen to every lake the caller can reach. Copying also
      // takes createSession's "explicit wins" arm, so it costs no DB read.
      retrievalTags: session.retrievalTags,
    },
    adapters
  );

  const messagesToSnip = await db.chatHistories.findAllBySessionIdAndGreaterThanOrEqualToTimestamp(
    sessionId,
    message.timestamp
  );

  await Promise.all(
    messagesToSnip.map(async ({ id, promptMeta, ...messageData }) => {
      await db.chatHistories.create({
        ...messageData,
        sessionId: newSession.id,
        // See forkSession: create() validates promptMeta.session.{id,userId} and the live
        // update() path does not, so a copied quest must bring its own session block.
        promptMeta: rebindPromptMetaSession(promptMeta, { sessionId: newSession.id, userId }),
      });
    })
  );
  return newSession;
};
