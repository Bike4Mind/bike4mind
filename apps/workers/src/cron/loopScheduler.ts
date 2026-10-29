import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { ACTIVE_AGENT_EXECUTION_STATUSES, type ILoop } from '@bike4mind/common';
import { adminSettingsRepository, agentExecutionRepository, connectDB, loopRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { HEADLESS_CONNECTION_ID } from '@bike4mind/server-utils/utils/headlessConnection';
import { startAgentExecution } from '@server/utils/startAgentExecution';
import { STALE_ACTIVE_MS } from '@server/utils/executionLimits';
import { toCallerSafeError } from '@server/utils/loadAgentExecutionTrace';
import { Resource } from 'sst';
import { buildLoopSystemContext, parseLoopMemory } from './loopMemory';

/** Claim lease; covers one dispatch, after which `activeExecutionId` keeps the loop from overlapping. */
export const LOOP_LEASE_MS = 5 * 60 * 1000;
export const MAX_DISPATCH_PER_TICK = 25;
/** Non-credit failures in a row before a loop stops at `error`. */
export const MAX_CONSECUTIVE_FAILURES = 3;

const MINUTE_MS = 60 * 1000;

/**
 * Loop scheduler (5-minute cron). Each tick first folds finished runs back into their
 * loops, then claims due `live` loops and dispatches each as a headless agent execution.
 * The executor knows nothing of loops: completion is observed here, by polling the
 * execution doc, the same pull-based approach as QuestMaster v5's reconcileQuestNodes.
 */
export async function handler(_event: never, context: Context) {
  const logger = new Logger().withMetadata({
    requestId: context.awsRequestId ?? randomUUID(),
    functionName: context.functionName,
    stage: Resource.App.stage,
  });

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  await runLoopSchedulerTick(new Date(), logger);
}

export async function runLoopSchedulerTick(now: Date, logger: Logger): Promise<void> {
  if ((await adminSettingsRepository.getSettingsValue('EnableLoops')) !== true) {
    logger.info('[Loops] EnableLoops is off; skipping tick');
    return;
  }

  for (const loop of await loopRepository.listInFlight()) {
    try {
      await reconcileLoop(loop, now);
    } catch (error) {
      logger.error(`[Loops] Failed to reconcile loop ${loop.id}`, error as Error);
    }
  }

  // A loop not started this tick (lease released) is still due; skipping it keeps it from being
  // re-claimed in a hot loop and starving every other due loop.
  const claimed: string[] = [];
  for (let dispatched = 0; dispatched < MAX_DISPATCH_PER_TICK; dispatched++) {
    const loop = await loopRepository.claimDue(now, LOOP_LEASE_MS, claimed);
    if (!loop) break;
    claimed.push(loop.id);
    try {
      await dispatchLoop(loop, now, logger);
    } catch (error) {
      logger.error(`[Loops] Failed to dispatch loop ${loop.id}`, error as Error);
    }
  }
}

/** Parents waiting on children legitimately idle for hours; the executor's own stale sweep skips them too. */
const WAITING_ON_CHILDREN = ['awaiting_subagent', 'awaiting_dag_children'];

async function reconcileLoop(loop: ILoop, now: Date): Promise<void> {
  const executionId = loop.activeExecutionId!;
  const execution = await agentExecutionRepository.findById(executionId);

  if (execution && ACTIVE_AGENT_EXECUTION_STATUSES.includes(execution.status)) {
    if (WAITING_ON_CHILDREN.includes(execution.status)) return;
    // ponytail: updatedAt heuristic, same threshold and statuses as the start-time stale sweep, which
    // aborts the doc on the owner's next start. A legitimately long-quiet run is folded as failed here.
    if (now.getTime() - new Date(execution.updatedAt).getTime() < STALE_ACTIVE_MS) return;
  }

  if (execution?.status === 'completed') {
    const answer = (execution.result as { answer?: unknown } | undefined)?.answer;
    const memory = parseLoopMemory(typeof answer === 'string' ? answer : '', loop.memory);
    await loopRepository.foldRun(loop.id, executionId, {
      $set: {
        memory: { ...memory, updatedAt: now },
        lastRunAt: execution.completedAt ?? now,
        consecutiveFailures: 0,
      },
      $inc: { runCount: 1 },
      $unset: { statusReason: '' },
    });
    return;
  }

  if (execution?.failureReason === 'insufficient_credits') {
    await loopRepository.foldRun(loop.id, executionId, {
      $set: { status: 'paused', statusReason: 'Out of credits', lastRunAt: execution.completedAt ?? now },
    });
    return;
  }

  const reason = !execution
    ? 'Run not found'
    : execution.status === 'aborted'
      ? 'Run aborted'
      : execution.status === 'failed'
        ? (toCallerSafeError(execution.error) ?? 'Run failed')
        : 'Run stalled';
  const folded = await loopRepository.foldRun(loop.id, executionId, {
    $set: { statusReason: reason, lastRunAt: execution?.completedAt ?? now },
    $inc: { consecutiveFailures: 1 },
  });
  // A separate conditional write, so an owner's pause landing mid-tick is never overwritten.
  if (folded) await loopRepository.markErroredIfFailing(loop.id, MAX_CONSECUTIVE_FAILURES);
}

async function dispatchLoop(loop: ILoop, now: Date, logger: Logger): Promise<void> {
  let result: Awaited<ReturnType<typeof startAgentExecution>>;
  try {
    result = await startAgentExecution(
      {
        userId: loop.userId,
        sessionId: loop.sessionId,
        questId: loop.sessionId,
        query: loop.goal,
        model: loop.model,
        connectionId: HEADLESS_CONNECTION_ID,
        apiKeyInfo: undefined,
        ...(loop.organizationId && { organizationId: loop.organizationId }),
        ...(loop.agentId && { agentId: loop.agentId }),
        enabledTools: loop.tools,
        systemContext: buildLoopSystemContext(loop.memory),
      },
      logger
    );
  } catch (error) {
    // Nothing was started, so the loop may retry next tick. Once an execution exists the lease is left
    // to run out instead, so a failed markDispatched doesn't free the loop for an immediate second run.
    await loopRepository.releaseLease(loop.id);
    throw error;
  }

  if (result.ok) {
    await loopRepository.markDispatched(
      loop.id,
      result.executionId,
      new Date(now.getTime() + loop.intervalMinutes * MINUTE_MS)
    );
    logger.info(`[Loops] Dispatched loop ${loop.id}`, { executionId: result.executionId });
    return;
  }

  if (result.reason === 'dispatch_failed' && result.executionId) {
    // The execution doc exists. It may yet run (an unconfirmed self-host HTTP dispatch) or stay
    // pending (a rejected invoke); either way track it rather than risk an overlapping run.
    // Reconcile folds it once terminal or stale, and the loop retries right after.
    await loopRepository.markDispatched(loop.id, result.executionId, now);
    logger.warn(`[Loops] Dispatch of loop ${loop.id} unconfirmed; tracking ${result.executionId}`);
    return;
  }

  if (result.reason === 'concurrent_limit' || result.reason === 'dispatch_failed') {
    await loopRepository.releaseLease(loop.id);
    logger.info(`[Loops] Loop ${loop.id} not started (${result.reason}); retrying next tick`);
    return;
  }

  await loopRepository.updateForUser(loop.id, loop.userId, {
    status: 'needs_you',
    statusReason: result.message,
    leaseUntil: null,
  });
  logger.warn(`[Loops] Loop ${loop.id} needs its owner: ${result.reason}`);
}
