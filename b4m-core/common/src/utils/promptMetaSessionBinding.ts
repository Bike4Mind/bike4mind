import type { PromptMeta } from '../types/entities/PromptMetaTypes';

/**
 * Rebind a copied quest's `promptMeta.session` to the session it is being copied INTO.
 *
 * Every path that duplicates quests into a new session (fork, snip, clone, notebook import)
 * must run its promptMeta through this. Two reasons, one hard and one soft:
 *
 * 1. The store REQUIRES it. `PromptMetaSchema.session.id`/`.userId` are `required: true`
 *    (QuestModel), and a copy is inserted through `create()` - the only quest write that runs
 *    Mongoose validators. Live quest writes go through `update()` (findOneAndUpdate + $set,
 *    validators off), and several writers materialize promptMeta from nothing
 *    (`quest.promptMeta = quest.promptMeta ?? {}` in ChatCompletionFeatures, addStatusToQuest in
 *    Image/VideoGeneration, applyQuestStatusChanges' no-existing-meta branch), so quests DO exist
 *    on disk carrying promptMeta with no session block at all. Copying one verbatim threw
 *    ValidationError and failed the whole fork.
 *
 * 2. `session.userId` is a scoping key, not just telemetry: `databaseSearcher.ts` scopes
 *    deep-research's internal quest search by `promptMeta.session.userId`. A copy that keeps the
 *    SOURCE owner's id is searchable by that owner (in a session they no longer own) and invisible
 *    to the copy's actual owner.
 *
 * `organizationId`/`projectId`/`agentId`/`agentName` are deliberately carried over unchanged: they
 * describe where the original turn ran, which is what the analytics rollups keyed off them mean.
 * Only the two ownership/identity fields are rewritten.
 *
 * Returns `undefined` for absent input, so callers can pass an optional promptMeta straight through.
 */
export function rebindPromptMetaSession(
  promptMeta: PromptMeta | null | undefined,
  destination: { sessionId: string; userId: string }
): PromptMeta | undefined {
  if (promptMeta == null) return undefined;
  return {
    ...promptMeta,
    session: {
      ...promptMeta.session,
      id: destination.sessionId,
      userId: destination.userId,
    },
  };
}
