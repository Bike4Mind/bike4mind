import type { PushNotificationEvent } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { truncateForPush } from '@server/utils/pushNotifications';

/**
 * Agent-run push notifications (`agent_completed` / `agent_failed`), published from the run's terminal
 * websocket frames so every failure exit is covered by one helper rather than one call per site.
 */

type SendWs = (action: string, payload?: Record<string, unknown>) => Promise<void>;

export type AgentPushDeps = {
  findExecution(executionId: string): Promise<{
    userId: string;
    sessionId: string;
    /** The real Quest id (`IAgentExecution.questId` is ambiguous across dispatch lineages). */
    linkedQuestId?: string;
    parentExecutionId?: unknown;
    spawnedByExecutionId?: unknown;
    dagNodeId?: string;
  } | null>;
  findSessionName(sessionId: string): Promise<string | undefined>;
  sessionDeepLink(sessionId: string): string;
  publish(event: PushNotificationEvent): Promise<void>;
};

/** One collapse id per run, so repeated failure frames and a late completion replace each other on the device. */
export const agentRunCollapseId = (executionId: string) => `agent-run:${executionId}`;

/**
 * Publishes the push for a top-level run reaching `completed` or `failed`. Never throws. A user abort
 * is skipped (the user ended the run themselves), and so are subagent (foreground or background) and
 * DAG-node children, whose outcome reaches the user through the parent run.
 */
export async function publishAgentTerminalPush(
  args: { executionId: string; outcome: 'completed' | 'failed'; reason?: unknown },
  deps: AgentPushDeps,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  if (args.outcome === 'failed' && args.reason === 'aborted') return;
  try {
    const execution = await deps.findExecution(args.executionId);
    if (!execution || execution.parentExecutionId || execution.spawnedByExecutionId || execution.dagNodeId) return;

    const sessionName = (await deps.findSessionName(execution.sessionId))?.trim();
    const where = sessionName ? ` in "${truncateForPush(sessionName, 60)}"` : '';
    const completed = args.outcome === 'completed';
    await deps.publish({
      userId: execution.userId,
      category: completed ? 'agent_completed' : 'agent_failed',
      title: completed ? 'Agent finished' : 'Agent run failed',
      body: completed ? `Your agent finished its task${where}.` : `Your agent could not finish its task${where}.`,
      deepLink: deps.sessionDeepLink(execution.sessionId),
      collapseId: agentRunCollapseId(args.executionId),
      sessionId: execution.sessionId,
      ...(execution.linkedQuestId && { questId: execution.linkedQuestId }),
    });
  } catch (error) {
    logger.warn('[Push] agent terminal push failed', {
      executionId: args.executionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Wraps a run's websocket sender: after a `completed` or `failed` frame is sent, the matching push is
 * published for the execution the frame names. The frame goes first and its own error handling is
 * unchanged; the push is awaited (a Lambda may freeze an unawaited promise) but cannot throw.
 */
export function withAgentTerminalPush(sendWs: SendWs, deps: AgentPushDeps, logger: Pick<Logger, 'warn'>): SendWs {
  return async (action, payload = {}) => {
    await sendWs(action, payload);
    if (action !== 'completed' && action !== 'failed') return;
    if (typeof payload.executionId !== 'string') return;
    await publishAgentTerminalPush(
      { executionId: payload.executionId, outcome: action, reason: payload.reason },
      deps,
      logger
    );
  };
}
