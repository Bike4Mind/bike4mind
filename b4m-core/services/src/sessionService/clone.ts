import {
  IChatHistoryItemDocument,
  IFabFileRepository,
  ISessionRepository,
  IUserRepository,
  PromptMeta,
  rebindPromptMetaSession,
  redactPromptMetaForViewer,
} from '@bike4mind/common';
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

  // A share/subscribe grant (findAccessibleById also matches on session.users[]/groups[], not
  // just ownership) authorizes reading the session, not walking away with an unredacted copy of
  // whatever the owner's tools returned - see promptMetaRedaction.ts's OWNER_ONLY_FUNCTION_CALL_FIELDS.
  const isOwner = session.userId === userId;

  // Clone all messages from the session
  await Promise.all(
    messagesToClone.map(async ({ id, promptMeta, ...messageData }) => {
      await db.chatHistories.create({
        ...messageData,
        // The clone is a NEW session owned by the caller, so promptMeta.session must name it -
        // create() requires session.{id,userId} and databaseSearcher scopes deep research's quest
        // search by session.userId. See rebindPromptMetaSession.
        //
        // redactPromptMetaForViewer's generic re-derives functionCalls via Omit<>, which produces
        // a structurally-identical but nominally distinct type from the zod-inferred PromptMeta
        // here - TS can't reconcile the two through the generic, so this cast bridges them.
        promptMeta: rebindPromptMetaSession(redactPromptMetaForViewer(promptMeta, isOwner) as PromptMeta | undefined, {
          sessionId: clonedSession.id,
          userId,
        }),
        sessionId: clonedSession.id,
      });
    })
  );

  return clonedSession;
};
