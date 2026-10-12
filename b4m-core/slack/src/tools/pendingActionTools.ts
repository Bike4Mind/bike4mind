import type { ToolDefinition } from '@bike4mind/services/llm';
import { Logger } from '@bike4mind/observability';

export interface PendingActionResult {
  success: boolean;
  message: string;
}

export interface PendingActionDeps {
  /** The sessionId (notebookId) to search for pending actions in */
  sessionId: string;
  cancelPendingAction: (questId: string, logger: Logger) => Promise<PendingActionResult>;
  findQuestWithPendingAction: (sessionId: string) => Promise<{ _id: unknown; pendingAction?: unknown } | null>;
}

/**
 * Create the cancel pending action tool definition.
 * There is deliberately no confirm tool: a pending action executes only from the human's Confirm
 * button click, never from model output.
 * Uses dependency injection so the tool definitions can live in @bike4mind/slack
 * while the actual execution logic lives in apps/client/server.
 */
export function createPendingActionToolDefs(deps: PendingActionDeps): Record<string, ToolDefinition> {
  const cancelToolDef: ToolDefinition = {
    name: 'cancel_pending_action',
    implementation: context => ({
      toolFn: async () => {
        const quest = await deps.findQuestWithPendingAction(deps.sessionId);
        if (!quest?.pendingAction) {
          return 'No pending action found. There is nothing to cancel.';
        }

        const result = await deps.cancelPendingAction(String(quest._id), context.logger);
        return result.message;
      },
      toolSchema: {
        name: 'cancel_pending_action',
        description:
          'Cancel the currently pending action. Call this when the user wants to cancel, abort, or discard the previewed action by saying things like "no", "cancel", "nevermind", "stop", "forget it". Also call this before re-invoking a tool with modified parameters when the user wants to change details of a pending action.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }),
  };

  return {
    cancel_pending_action: cancelToolDef,
  };
}
