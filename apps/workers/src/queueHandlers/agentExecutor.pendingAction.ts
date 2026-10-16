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
