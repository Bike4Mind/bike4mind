import type { LiveActivityPushEvent, PushNotificationEvent } from '@bike4mind/common';
import { agentExecutionRepository, sessionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import {
  createLiveActivityThrottle,
  publishLiveActivityUpdate,
  type LiveActivityThrottle,
} from '@server/utils/liveActivityPush';
import {
  isPushDeliveryConfigured,
  publishPushNotification,
  sessionDeepLink,
  truncateForPush,
} from '@server/utils/pushNotifications';

/**
 * Agent-run push notifications (`agent_completed` / `agent_failed`), published from the run's terminal
 * websocket frames so every failure exit is covered by one helper rather than one call per site.
 * Unlike chat turns (questProcessor.push.ts), these push even while the user has a live websocket and
 * for runs started over an API key: a run outlives the tab that started it.
 * The same frame interception drives the run's live activity (`notification.liveActivity`).
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
  /** Without it the run publishes no live activity frames. Must not throw (publishLiveActivityUpdate). */
  publishLiveActivity?(event: LiveActivityPushEvent): Promise<void>;
};

/** The production wiring of AgentPushDeps. */
export function createAgentPushDeps(logger: Pick<Logger, 'warn'>): AgentPushDeps {
  return {
    findExecution: executionId => agentExecutionRepository.findById(executionId),
    findSessionName: async sessionId => (await sessionRepository.findById(sessionId))?.name,
    sessionDeepLink,
    publish: event => publishPushNotification(event, logger),
    publishLiveActivity: event => publishLiveActivityUpdate(event, logger),
  };
}

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
  if (!isPushDeliveryConfigured()) return;
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

const MAX_STAGE_LABEL_LENGTH = 60;

type LiveActivityTarget = { userId: string; questId: string };

/** Only a top-level run with a real Quest has a live activity; children report through the parent. */
async function resolveLiveActivityTarget(executionId: string, deps: AgentPushDeps): Promise<LiveActivityTarget | null> {
  const execution = await deps.findExecution(executionId);
  if (!execution?.linkedQuestId) return null;
  if (execution.parentExecutionId || execution.spawnedByExecutionId || execution.dagNodeId) return null;
  return { userId: execution.userId, questId: execution.linkedQuestId };
}

type LiveActivityFrame = {
  contentState: LiveActivityPushEvent['contentState'];
  event: LiveActivityPushEvent['event'];
  /** The invocation may exit on this state, so it must not wait for a trailing flush. */
  immediate?: boolean;
};

/** Maps a websocket frame to the live activity state it implies, or null when the frame is not progress. */
function liveActivityFrameFor(
  action: string,
  payload: Record<string, unknown>,
  lastToolName: { current?: string }
): LiveActivityFrame | null {
  switch (action) {
    case 'completed':
      return { event: 'end', contentState: { status: 'completed' } };
    case 'failed':
      return payload.reason === 'aborted'
        ? { event: 'end', contentState: { status: 'stopped' } }
        : { event: 'end', contentState: { status: 'failed', errored: true } };
    case 'progress': {
      if (payload.pendingAction) {
        return {
          event: 'update',
          immediate: true,
          contentState: { status: 'approval_needed', stageLabel: 'Waiting for your approval' },
        };
      }
      if (typeof payload.status !== 'string' || !payload.status.trim()) return null;
      if (payload.status === 'paused') {
        return {
          event: 'update',
          immediate: true,
          contentState: { status: 'paused', stageLabel: 'Waiting for your input' },
        };
      }
      return {
        event: 'update',
        contentState: { status: 'running', stageLabel: truncateForPush(payload.status.trim(), MAX_STAGE_LABEL_LENGTH) },
      };
    }
    case 'iteration_step': {
      const step = payload.step;
      if (typeof step !== 'object' || step === null || !('type' in step)) return null;
      const toolName =
        'metadata' in step && typeof step.metadata === 'object' && step.metadata !== null && 'toolName' in step.metadata
          ? step.metadata.toolName
          : undefined;
      if (step.type === 'action' && typeof toolName === 'string') {
        lastToolName.current = toolName;
        return {
          event: 'update',
          contentState: { status: 'running', stageLabel: truncateForPush(`Using ${toolName}`, MAX_STAGE_LABEL_LENGTH) },
        };
      }
      if (step.type === 'observation' && lastToolName.current) {
        return {
          event: 'update',
          contentState: {
            status: 'running',
            stageLabel: truncateForPush(`Finished ${lastToolName.current}`, MAX_STAGE_LABEL_LENGTH),
          },
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Wraps a run's websocket sender: after a `completed` or `failed` frame is sent, the matching push is
 * published for the execution the frame names. The frame goes first and its own error handling is
 * unchanged; the push is awaited (a Lambda may freeze an unawaited promise) but cannot throw.
 *
 * With `deps.publishLiveActivity`, the same frames also feed the run's live activity: status lines,
 * tool steps, an approval or confidence-gate pause and the terminal frame become throttled updates and
 * a final `end`. The throttle lives as long as the wrapper, i.e. one invocation of the run.
 * With push unconfigured the sender is returned as-is: no lookups, no publishes, no added latency.
 */
export function withAgentTerminalPush(sendWs: SendWs, deps: AgentPushDeps, logger: Pick<Logger, 'warn'>): SendWs {
  if (!isPushDeliveryConfigured()) return sendWs;
  const throttle: LiveActivityThrottle | undefined = deps.publishLiveActivity
    ? createLiveActivityThrottle(deps.publishLiveActivity)
    : undefined;
  const targets = new Map<string, Promise<LiveActivityTarget | null>>();
  const lastToolName: { current?: string } = {};

  const emitLiveActivity = async (action: string, payload: Record<string, unknown>) => {
    if (!throttle || typeof payload.executionId !== 'string') return;
    try {
      const frame = liveActivityFrameFor(action, payload, lastToolName);
      if (!frame) return;
      const executionId = payload.executionId;
      if (!targets.has(executionId)) targets.set(executionId, resolveLiveActivityTarget(executionId, deps));
      const target = await targets.get(executionId);
      if (!target) return;
      await throttle.emit(
        { userId: target.userId, questId: target.questId, event: frame.event, contentState: frame.contentState },
        { immediate: frame.immediate }
      );
    } catch (error) {
      logger.warn('[LiveActivity] agent progress frame failed', {
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return async (action, payload = {}) => {
    await sendWs(action, payload);
    await emitLiveActivity(action, payload);
    if (action !== 'completed' && action !== 'failed') return;
    if (typeof payload.executionId !== 'string') return;
    await publishAgentTerminalPush(
      { executionId: payload.executionId, outcome: action, reason: payload.reason },
      deps,
      logger
    );
  };
}

/** Ends the live activity of a run whose terminal frame bypassed the wrapped sender. Never throws. */
export async function endAgentLiveActivity(
  args: { executionId: string; outcome: 'failed' },
  deps: AgentPushDeps,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  if (!deps.publishLiveActivity || !isPushDeliveryConfigured()) return;
  try {
    const target = await resolveLiveActivityTarget(args.executionId, deps);
    if (!target) return;
    await deps.publishLiveActivity({
      userId: target.userId,
      questId: target.questId,
      event: 'end',
      contentState: { status: args.outcome, errored: true },
    });
  } catch (error) {
    logger.warn('[LiveActivity] ending the agent live activity failed', {
      executionId: args.executionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
