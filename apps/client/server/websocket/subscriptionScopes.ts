import type { mongoose } from '@bike4mind/database';

/**
 * Fan-out scope for QuestMasterPlan change-stream subscriptions.
 *
 * Plan access is user-based (owner, shared collaborator, or public
 * visibility), while legacy plans (no userId) and session-visibility plans
 * are reachable through session membership. The subscription scope must
 * cover both dimensions; a session-only scope silently drops live updates
 * for shared collaborators who work from their own sessions and for plans
 * attached to placeholder notebook ids.
 *
 * The scope is ANDed with the client-supplied query, so the public arm only
 * streams documents the client explicitly subscribed to.
 */
export function questMasterPlanSubscriptionScope(
  userId: string,
  accessibleSessionIds: mongoose.Types.ObjectId[]
): mongoose.FilterQuery<unknown> {
  return {
    $or: [
      { userId },
      { sharedWith: userId },
      { visibility: 'public' },
      // Legacy plans (no userId) and session-visibility plans remain
      // reachable through the sessions the user can access
      { notebookId: { $in: accessibleSessionIds } },
    ],
  };
}
