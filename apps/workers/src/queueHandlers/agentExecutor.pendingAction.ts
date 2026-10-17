import type { Logger } from '@bike4mind/observability';
import type { ToolBuilderCallbacks } from '@bike4mind/services/llm';

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

/**
 * Persists the pending action on the run's Quest, then pushes it to the client on a `progress` frame so the Confirm
 * card renders while the run is live (the agent path has no streamed quest, and the run quest is not refetched).
 * The write still throws on failure; a failed send only logs.
 */
export async function publishRunPendingAction({
  executionId,
  questId,
  action,
  questRepository,
  sendWs,
  logger,
}: {
  executionId: string | undefined;
  questId: string | undefined;
  action: McpPendingAction;
  questRepository: { setPendingAction(questId: string, action: McpPendingAction): Promise<void> };
  sendWs: (action: string, payload: Record<string, unknown>) => Promise<void>;
  logger: Logger;
}): Promise<void> {
  await attachPendingActionToRunQuest(action, questId, questRepository, logger);
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
