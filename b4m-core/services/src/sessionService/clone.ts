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
  adapters: CloneSessionAdapters
) => {
  const { db } = adapters;
  const { id } = secureParameters(parameters, cloneSessionSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const session = await db.sessions.shareable.findAccessibleById(user, id);
  if (!session) throw new NotFoundError('Session not found');

  // A share/subscribe grant (findAccessibleById also matches on session.users[]/groups[], not just
  // ownership) authorizes reading the session, not walking away with an unredacted copy of whatever
  // the owner's tools returned - see promptMetaRedaction.ts's OWNER_ONLY_FUNCTION_CALL_FIELDS.
  // Hoisted above the clone params because the lake scope below keys on it for the same reason.
  const isOwner = session.userId === userId;

  const buildCloneSession = {
    name: `Cloned ${session.name}`,
    knowledgeIds: session.knowledgeIds,
    tags: session.tags ? session.tags : [],
    summary: session.summary,
    summaryAt: session.summaryAt,
    clonedSourceId: session.id,
    // Carried from the source, not re-derived: the owner's scope is already correct and explicit,
    // and re-deriving here would go through the OWNERSHIP arm alone (no resolveLakeAccess is threaded
    // to this path), which cannot see a teammate-authored organization-lake file. That derives an
    // EMPTY list, and an empty list is not a narrow scope - fabFileSearchQuery skips its tag clause,
    // so it would silently widen to every lake the caller can reach. Copying also takes
    // createSession's "explicit wins" arm, so it costs no DB read.
    //
    // OWNER ONLY, unlike fork/snip which read the source with `findByIdAndUserId` and so are
    // same-user by construction. A share grant lets you read this session, not inherit its lake
    // scope: the cloner may not reach that lake at all.
    //
    // This gate is half the mechanism and does nothing on its own. `createSession`'s explicit-wins
    // arm skips the derivation whenever tags are supplied, so a copied tag gets NO reachability
    // check; the gate's only job is to route a non-owner into the derivation instead, where the
    // intersection against their own reachable lakes can drop a tag they cannot use. That
    // intersection needs `resolveLakeAccess`, which is why this function now forwards the whole
    // adapters object and the route supplies one. Without both halves a non-owner ends up narrowed
    // to a lake they cannot read, with their personal-corpus fallback off (a non-empty
    // retrievalTags reads as "already lake-scoped") and no way to clear either from the UI.
    ...(isOwner ? { retrievalTags: session.retrievalTags } : {}),
  };
  if (session.summary) buildCloneSession.summary = session.summary;
  if (session.summaryAt) buildCloneSession.summaryAt = session.summaryAt;

  // Forward the WHOLE adapters object, not just `db`: `resolveLakeAccess` and `logger` live on
  // CreateSessionAdapters and clone previously dropped them here, so a non-owner's derivation ran
  // with no lake arm and - crucially - no intersection, persisting a tag for a lake they may not
  // reach. fork/snip already forwarded; this brings clone in line.
  const clonedSession = await createSession(user, buildCloneSession, adapters);

  const messagesToClone = await db.chatHistories.findAllBySessionId(id);

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
