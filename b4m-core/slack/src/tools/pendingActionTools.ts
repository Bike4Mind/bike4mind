import { ToolDefinition } from '@bike4mind/services';
import { IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

export interface PendingActionResult {
  success: boolean;
  message: string;
}

export interface PendingActionDeps {
  /** The sessionId (notebookId) to search for pending actions in */
  sessionId: string;
  executePendingAction: (questId: string, dbUser: IUserDocument, logger: Logger) => Promise<PendingActionResult>;
  cancelPendingAction: (questId: string, logger: Logger) => Promise<PendingActionResult>;
  findQuestWithPendingAction: (sessionId: string) => Promise<{ _id: unknown; pendingAction?: unknown } | null>;
  findUserById: (userId: string) => Promise<IUserDocument | null>;
}

/**
 * Create confirm/cancel pending action tool definitions.
 * Uses dependency injection so the tool definitions can live in @bike4mind/slack
 * while the actual execution logic lives in apps/client/server.
 */
export function createPendingActionToolDefs(deps: PendingActionDeps): Record<string, ToolDefinition> {
  const confirmToolDef: ToolDefinition = {
    name: 'confirm_pending_action',
    implementation: context => ({
      toolFn: async () => {
        const quest = await deps.findQuestWithPendingAction(deps.sessionId);
        if (!quest?.pendingAction) {
          return 'No pending action found. There is nothing to confirm.';
        }

        const dbUser = await deps.findUserById(context.userId);
        if (!dbUser) {
          return 'User not found.';
        }

        const result = await deps.executePendingAction(String(quest._id), dbUser, context.logger);

        return result.success ? result.message : `Failed: ${result.message}`;
      },
      toolSchema: {
        name: 'confirm_pending_action',
        description:
          'Execute the currently pending action (e.g., create GitHub issue, Jira ticket, Confluence page). Call this when the user confirms they want to proceed with the previewed action by saying things like "yes", "do it", "go ahead", "confirm", "looks good".',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }),
  };

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
    confirm_pending_action: confirmToolDef,
    cancel_pending_action: cancelToolDef,
  };
}
