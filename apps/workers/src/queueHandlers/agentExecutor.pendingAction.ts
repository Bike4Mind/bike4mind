import type { Logger } from '@bike4mind/observability';
import type { ToolBuilderCallbacks } from '@bike4mind/services/llm';
import type { PushNotificationEvent } from '@bike4mind/common';

type McpPendingAction = Parameters<NonNullable<ToolBuilderCallbacks['onPendingAction']>>[0];

/**
 * Persists a GitHub/Atlassian write preview onto the run's Quest, which the chat UI renders the
 * Confirm card from (classic chat assigns it to its in-memory quest instead). Unlike the
 * best-effort generation-job write, this throws on failure: the extractor logs it, and the model
 * then still sees a preview that no card backs.
 */
export async function attachPendingActionToRunQuest(
  action: McpPendingAction,
  questId: string | undefined,
  quests: { setPendingAction(questId: string, action: McpPendingAction): Promise<void> },
  logger: Logger
): Promise<void> {
  if (!questId) {
    logger.warn('[AgentPendingAction] no run quest to attach the pending action to; no Confirm card will render', {
      tool: action.tool,
    });
    return;
  }
  await quests.setPendingAction(questId, action);
}

/** Who to notify when a run parks on a Confirm card; the publisher must not throw (publishPushNotification). */
export type ApprovalPushTarget = {
  userId: string;
  sessionId: string;
  sessionDeepLink(sessionId: string): string;
  publish(event: PushNotificationEvent): Promise<void>;
};

/**
 * Persists the pending action on the run's Quest, then pushes it to the client on a `progress` frame so the Confirm
 * card renders while the run is live (the agent path has no streamed quest, and the run quest is not refetched).
 * With `approvalPush`, also publishes an `approval_needed` push once the card is backed by the quest.
 * The write still throws on failure; a failed send only logs.
 */
export async function publishRunPendingAction({
  executionId,
  questId,
  action,
  questRepository,
  sendWs,
  logger,
  approvalPush,
}: {
  executionId: string | undefined;
  questId: string | undefined;
  action: McpPendingAction;
  questRepository: { setPendingAction(questId: string, action: McpPendingAction): Promise<void> };
  sendWs: (action: string, payload: Record<string, unknown>) => Promise<void>;
  logger: Logger;
  approvalPush?: ApprovalPushTarget;
}): Promise<void> {
  await attachPendingActionToRunQuest(action, questId, questRepository, logger);
  if (questId && approvalPush) {
    await approvalPush.publish({
      userId: approvalPush.userId,
      category: 'approval_needed',
      title: 'Approval needed',
      body: `An agent wants to run ${action.tool} and is waiting for your confirmation.`,
      deepLink: approvalPush.sessionDeepLink(approvalPush.sessionId),
      collapseId: `approval:${questId}`,
      questId,
      sessionId: approvalPush.sessionId,
    });
  }
  // The client keys frames by execution id, so a frame without one would match no run.
  if (!questId || !executionId) return;
  try {
    await sendWs('progress', { executionId, questId, pendingAction: action });
  } catch (error) {
    logger.warn('[AgentPendingAction] failed to send the pending action to the client', {
      questId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
