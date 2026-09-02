import type { PromptMeta } from '../types/entities/PromptMetaTypes';

/**
 * Rebind a copied quest's `promptMeta.session` to the session it is being copied INTO.
 *
 * Used by the in-app copy paths: fork, snip, and clone. Two reasons, one hard and one soft:
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
 * KNOWN COST of rewriting `userId`: admin cost/model rollups filter on
 * `promptMeta.session.userId` (analytics.ts, model-metrics.ts), so cloning a session that several
 * people contributed turns to moves every contributor's `creditsUsed`/`estimatedCost` history onto
 * the cloner's filtered view. Accepted deliberately - reason 2 above is a correctness/visibility
 * bug for the copy's owner on every copy, while this is an admin-only attribution smear on the
 * multi-author-clone case, and the whole row (including `creditsUsed`) is duplicated by the copy
 * regardless. Revisit if per-author attribution on clones ever has to be exact.
 *
 * NOT used by notebook import, deliberately. `notebookImportService` rebuilds the block as
 * `{ id, userId }` and DROPS `organizationId`/`projectId`/`agentId`/`agentName`, because an import
 * can land in a different tenant than the export came from and carrying a foreign `organizationId`
 * into the rollups would be worse than losing it. If import ever becomes same-tenant-only, collapse
 * it onto this helper.
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
