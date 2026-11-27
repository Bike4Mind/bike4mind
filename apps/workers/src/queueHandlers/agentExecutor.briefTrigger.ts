import { agentExecutionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { startEventBriefForCompletedRun } from '@bike4mind/server-utils/briefs/eventBriefTrigger';
import { startEventBrief, type ScheduledBriefOutcome } from '@bike4mind/server-utils/briefs/startBriefComposition';
import type { AgentPushSender } from './agentExecutor.push';

// How long flush() waits for in-flight brief starts before the invocation exits (ms).
export const BRIEF_TRIGGER_FLUSH_TIMEOUT_MS = 5_000;

export type AgentBriefTriggerDeps = {
  findExecution(executionId: string): Promise<{
    userId: string;
    parentExecutionId?: unknown;
    spawnedByExecutionId?: unknown;
    dagNodeId?: string;
  } | null>;
  startEventBrief(userId: string): Promise<ScheduledBriefOutcome>;
};

export function createAgentBriefTriggerDeps(): AgentBriefTriggerDeps {
  return {
    findExecution: executionId => agentExecutionRepository.findById(executionId),
    startEventBrief: userId => startEventBrief(userId),
  };
}

/**
 * Wraps a run's sender so a top-level run reaching `completed` starts an event brief for its user.
 * Subagent and DAG-node children are skipped, as are failed runs. The start is not awaited by the send,
 * so the terminal frame is never delayed and a failure is only logged; `flush()` waits for pending starts,
 * capped at BRIEF_TRIGGER_FLUSH_TIMEOUT_MS, so the Lambda does not freeze mid-publish.
 */
export function withAgentBriefTrigger(
  inner: AgentPushSender,
  deps: AgentBriefTriggerDeps,
  logger: Pick<Logger, 'info' | 'warn'>
): AgentPushSender {
  const pending = new Set<Promise<void>>();

  const trigger = async (executionId: string) => {
    const execution = await deps.findExecution(executionId);
    await startEventBriefForCompletedRun(executionId, execution, logger, deps.startEventBrief);
  };

  const send = async (action: string, payload: Record<string, unknown> = {}) => {
    await inner(action, payload);
    if (action !== 'completed' || typeof payload.executionId !== 'string') return;
    const executionId = payload.executionId;
    const run = trigger(executionId).catch((error: unknown) => {
      logger.warn('[EventBrief] agent completion brief start failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  const flush = async () => {
    await inner.flush();
    if (pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, BRIEF_TRIGGER_FLUSH_TIMEOUT_MS);
    });
    try {
      await Promise.race([Promise.allSettled([...pending]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.assign(send, { flush });
}
