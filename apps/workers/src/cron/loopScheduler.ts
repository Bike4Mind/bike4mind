import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import {
  ACTIVE_AGENT_EXECUTION_STATUSES,
  desktopStagesOf,
  loopRunModel,
  nextUtcMidnight,
  stageConfigOf,
  type ILoop,
  type ILoopEvent,
  type IWorkItem,
  type WorkItemPatch,
  type WorkItemPriority,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  agentExecutionRepository,
  connectDB,
  loopDirectiveRepository,
  loopEventRepository,
  loopRepository,
  workItemRepository,
  type IAgentExecution,
  type IPendingGate,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { HEADLESS_CONNECTION_ID } from '@bike4mind/server-utils/utils/headlessConnection';
import { startAgentExecution } from '@server/utils/startAgentExecution';
import { STALE_ACTIVE_MS } from '@server/utils/executionLimits';
import { toCallerSafeError } from '@server/utils/loadAgentExecutionTrace';
import {
  advancePatch,
  makeDueIfReady,
  ticketRunLimit,
  unsureEventFields,
  unsureReason,
  UNSURE_PREFIX,
} from '@server/utils/loopTickets';
import { Resource } from 'sst';
import {
  canPayAgain,
  iterationPrice,
  loopAdmission,
  p2RunsLeft,
  PRIORITIES_OVER_P2_CAP,
} from '@server/utils/loopBudget';
import { releaseExpiredRunnerLeases } from '@server/utils/loopRunner';
import {
  buildLoopQuery,
  buildTriageQuery,
  LOOP_PROMPT_ANSWERS,
  LOOP_PROMPT_DIRECTIVES,
  parseLoopMemory,
} from '@server/utils/loopMemory';
import { syncLoopNotices, USER_BUDGET_PAUSE_REASON } from './loopNotices';

/** Claim lease; covers one dispatch, after which `activeExecutionId` keeps the loop from overlapping. */
export const LOOP_LEASE_MS = 5 * 60 * 1000;
export const MAX_DISPATCH_PER_TICK = 25;
/** Non-credit failures in a row before a loop stops at `error`. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Resumed unsure runs folded per tick; the rest wait for the next one. */
export const MAX_RESUMED_FOLDS_PER_TICK = 100;
/**
 * Loop runs in flight at once across all users. Loop and interactive runs share the AgentExecutor's
 * `reserved` concurrency (infra/agentExecutor.ts); keep this well below it so interactive runs keep most slots.
 */
export const MAX_ACTIVE_LOOP_RUNS = 4;
/** Due loops claimed per tick, started or not (a deferred or paused loop does not use a run slot). */
export const MAX_CLAIMS_PER_TICK = 100;
/** ponytail: tickets parked on dependencies reopened per tick across all users; the rest wait for later ticks. */
export const MAX_REOPENS_PER_TICK = 200;
/** Ceiling on the idle back-off, as a multiple of the loop's interval (and never past a day). */
export const MAX_BACKOFF_FACTOR = 8;
/** A live loop past due by this many intervals (and at least the floor, in minutes) with ready tickets is flagged. */
export const LOOP_IDLE_ALARM_INTERVALS = 3;
export const LOOP_IDLE_ALARM_FLOOR_MIN = 30;
/** A cloud run older than the floor and this many times the loop's median run (last few completed) is flagged. */
export const LOOP_LONG_RUN_FLOOR_MS = 60 * 60 * 1000;
export const LOOP_LONG_RUN_FACTOR = 3;
const LOOP_LONG_RUN_SAMPLE = 5;
const LOOP_LONG_RUN_MIN_SAMPLES = 3;
/**
 * ponytail: loops or tickets each liveness sweep reads per tick, oldest first; the rest wait for later ticks.
 * 100+ long-held in_progress tickets (desktop runs, long cloud runs) would starve the stranded sweep; page past
 * them if that ever happens.
 */
export const MAX_LIVENESS_SWEEP = 100;
/** ponytail: untriaged tickets one triage run is shown, oldest first; the rest go to the next triage run. */
export const LOOP_TRIAGE_BATCH = 20;
/** ponytail: p2 tickets the cap demotes per loop per tick; the rest wait for later ticks. */
export const MAX_DEMOTES_PER_LOOP_TICK = 50;

const MINUTE_MS = 60 * 1000;
export const BUDGET_PAUSE_REASON = 'Daily budget reached; resumes 00:00 UTC';
export { USER_BUDGET_PAUSE_REASON };
export { TICKET_RUNS_PER_STAGE, ticketRunLimit } from '@server/utils/loopTickets';
export { pacedAllowance, pacedReadyAt, runCreditCap } from '@server/utils/loopBudget';
export { LOOP_PROMPT_ANSWERS, LOOP_PROMPT_DIRECTIVES } from '@server/utils/loopMemory';

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Run age past which a run is flagged as long: the floor alone until the loop has a few completed runs. */
export const longRunThresholdMs = (durationsMs: number[]): number =>
  durationsMs.length < LOOP_LONG_RUN_MIN_SAMPLES
    ? LOOP_LONG_RUN_FLOOR_MS
    : Math.max(LOOP_LONG_RUN_FLOOR_MS, LOOP_LONG_RUN_FACTOR * median(durationsMs));

export const idleAlarmThresholdMin = (intervalMinutes: number): number =>
  Math.max(LOOP_IDLE_ALARM_INTERVALS * intervalMinutes, LOOP_IDLE_ALARM_FLOOR_MIN);

/**
 * The idle-with-work rule minus the ready-ticket lookup: a live loop with no run in flight and no claim, held
 * back by nothing deliberate (no pacing or capacity hold, no idle back-off), and far past its due time.
 * Paused, needs_you and error loops never match.
 */
export function idleAlarmCandidate(
  loop: Pick<
    ILoop,
    'status' | 'activeExecutionId' | 'leaseUntil' | 'hold' | 'idleStreak' | 'nextRunAt' | 'intervalMinutes'
  >,
  now: Date
): boolean {
  if (loop.status !== 'live' || loop.activeExecutionId || !loop.nextRunAt) return false;
  if (loop.leaseUntil && new Date(loop.leaseUntil) > now) return false;
  // A capacity hold is rewritten every tick. A live pacing hold sets nextRunAt to its `until`, so the past-due
  // check below excludes it; one left behind after an owner reschedule must not hide an idle loop.
  if (loop.hold?.kind === 'capacity') return false;
  if (loop.idleStreak) return false;
  return new Date(loop.nextRunAt).getTime() <= now.getTime() - idleAlarmThresholdMin(loop.intervalMinutes) * MINUTE_MS;
}

/** Minutes until the next run after `idleStreak` idle runs in a row: doubling, capped at 8x and at a day. */
export function backoffMinutes(intervalMinutes: number, idleStreak: number): number {
  return Math.max(
    intervalMinutes,
    Math.min(intervalMinutes * 2 ** idleStreak, MAX_BACKOFF_FACTOR * intervalMinutes, 24 * 60)
  );
}

/**
 * Loop scheduler (5-minute cron). Each tick first folds finished runs back into their
 * loops (and resumed unsure runs back into their tickets), then claims due `live` loops
 * and dispatches each as a headless agent execution.
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

  // First, so a ticket whose desktop runner died is open again before this tick's folds and claims.
  await releaseExpiredRunnerLeases(now, logger).catch(error =>
    logger.error('[Loops] Desktop lease sweep failed', error as Error)
  );

  for (const loop of await loopRepository.listAutoPaused()) {
    try {
      await resumeIfDue(loop, now);
    } catch (error) {
      logger.error(`[Loops] Failed to auto-resume loop ${loop.id}`, error as Error);
    }
  }

  // ponytail: oldest first and still-running resumed runs are skipped unfolded, so 100+ of those across all
  // users would hold back newer folds; page past skipped events if that ever happens.
  for (const event of await loopEventRepository.listResumedUnfolded(MAX_RESUMED_FOLDS_PER_TICK)) {
    try {
      await foldResumedRun(event, now);
    } catch (error) {
      logger.error(`[Loops] Failed to fold resumed run ${event.executionId}`, error as Error);
    }
  }

  for (const loop of await loopRepository.listInFlight()) {
    try {
      await reconcileLoop(loop, now);
    } catch (error) {
      logger.error(`[Loops] Failed to reconcile loop ${loop.id}`, error as Error);
    }
  }

  // Before dispatch, so a reopened ticket at the top of its loop runs this tick.
  await reopenParkedTickets(now, logger).catch(error => logger.error('[Loops] Reopen sweep failed', error as Error));
  await recoverStrandedTickets(now, logger).catch(error =>
    logger.error('[Loops] Stranded ticket sweep failed', error as Error)
  );

  // Capacity holds are recomputed every tick: only loops the run cap kept out of this tick carry one.
  await loopRepository
    .clearCapacityHolds()
    .catch(error => logger.error('[Loops] Clearing capacity holds failed', error as Error));
  const allowance = Math.min(MAX_DISPATCH_PER_TICK, MAX_ACTIVE_LOOP_RUNS - (await loopRepository.countInFlight()));
  const { claimed, capped } = allowance > 0 ? await dispatchDue(now, allowance, logger) : { claimed: [], capped: true };
  if (capped) {
    await loopRepository
      .setCapacityHolds(now, claimed)
      .catch(error => logger.error('[Loops] Setting capacity holds failed', error as Error));
  }

  // After the capacity holds, which it reads.
  await raiseIdleAlarms(now, logger).catch(error => logger.error('[Loops] Idle alarm sweep failed', error as Error));

  // Last, so notices reflect this tick's state changes.
  await syncLoopNotices(logger).catch(error => logger.error('[Loops] Notice sync failed', error as Error));
}

/** Reopens tickets whose `blockedOn` condition now holds, and makes their loops due. Never touches a plain block. */
async function reopenParkedTickets(now: Date, logger: Logger): Promise<void> {
  const reopened = await workItemRepository.reopenSatisfiedBlocks(MAX_REOPENS_PER_TICK);
  const loopIds = [...new Set(reopened.map(ticket => ticket.loopId!))];
  if (loopIds.length === 0) return;
  for (const loop of await loopRepository.find({ _id: { $in: loopIds } })) {
    try {
      await makeDueIfReady(loop, now);
    } catch (error) {
      logger.error(`[Loops] Failed to make loop ${loop.id} due after a reopen`, error as Error);
    }
  }
}

/**
 * Starts up to `allowance` due loops, round-robin by owner: each pass claims at most one loop per user, so
 * one user's many due loops cannot keep another user's loop out of the tick. A loop not started (deferred,
 * paused, lease released) is still skipped for the rest of the tick so it is not re-claimed in a hot loop,
 * and does not use up the allowance.
 */
async function dispatchDue(
  now: Date,
  allowance: number,
  logger: Logger
): Promise<{ claimed: string[]; capped: boolean }> {
  const claimed: string[] = [];
  let served: string[] = [];
  let started = 0;
  while (started < allowance && claimed.length < MAX_CLAIMS_PER_TICK) {
    const loop = await loopRepository.claimDue(now, LOOP_LEASE_MS, claimed, served);
    if (!loop) {
      if (served.length === 0) break;
      served = [];
      continue;
    }
    claimed.push(loop.id);
    served.push(loop.userId);
    try {
      if (await dispatchLoop(loop, now, logger)) started++;
    } catch (error) {
      logger.error(`[Loops] Failed to dispatch loop ${loop.id}`, error as Error);
    }
  }
  // Stopping at MAX_CLAIMS_PER_TICK is not the run cap, so it does not count as capped.
  return { claimed, capped: started >= allowance };
}

/**
 * Reopens loop tickets left `in_progress` with no run working them: (a) claimed but never linked to a run
 * (a crash between claim and `setExecution`), once the claim is older than a lease and the loop has no run
 * in flight that could still link it; (b) linked to a cloud run that is gone or finished and is not the
 * loop's active run, with no resumed event waiting to fold it. Desktop runs belong to the runner lease sweep.
 */
async function recoverStrandedTickets(now: Date, logger: Logger): Promise<void> {
  const loops = new Map<string, ILoop | null>();
  for (const ticket of await workItemRepository.listInProgressForLoops(MAX_LIVENESS_SWEEP)) {
    try {
      const loopId = ticket.loopId!;
      if (!loops.has(loopId)) loops.set(loopId, await loopRepository.findById(loopId));
      const loop = loops.get(loopId);
      if (!loop || !(await isStranded(ticket, loop, now))) continue;
      if (!(await workItemRepository.releaseStranded(ticket.id, ticket.executionId))) continue;
      await makeDueIfReady(loop, now);
      logger.warn(`[Loops] Reopened stranded ticket ${ticket.id} of loop ${loop.id}`, {
        executionId: ticket.executionId,
      });
    } catch (error) {
      logger.error(`[Loops] Failed to check ticket ${ticket.id} for a stranded claim`, error as Error);
    }
  }
}

async function isStranded(ticket: IWorkItem, loop: ILoop, now: Date): Promise<boolean> {
  const claimExpired = new Date(ticket.updatedAt).getTime() < now.getTime() - LOOP_LEASE_MS;
  if (!ticket.executionId) return !loop.activeExecutionId && claimExpired;
  if (ticket.executionId === loop.activeExecutionId) return false;
  const execution = await agentExecutionRepository.findById(ticket.executionId);
  // A desktop claim links its ticket before the run doc exists, so a missing run only counts once the claim is old.
  if (!execution && !claimExpired) return false;
  if (execution && (execution.runner === 'desktop' || ACTIVE_AGENT_EXECUTION_STATUSES.includes(execution.status))) {
    return false;
  }
  return !(await loopEventRepository.hasUnfolded(ticket.executionId));
}

/**
 * Flags live loops that should be running ready tickets but are not (`idleAlarmCandidate` plus a ready
 * ticket), and clears the flag once that stops holding. No self-heal: such a loop is already due, so
 * something outside the scheduler's holds keeps it from running and its owner should look.
 */
async function raiseIdleAlarms(now: Date, logger: Logger): Promise<void> {
  const [pastDue, alarmed] = await Promise.all([
    loopRepository.listPastDueLive(new Date(now.getTime() - LOOP_IDLE_ALARM_FLOOR_MIN * MINUTE_MS), MAX_LIVENESS_SWEEP),
    loopRepository.listAlarmed(['idle_with_work']),
  ]);
  const candidates = new Map([...alarmed, ...pastDue].map(loop => [loop.id, loop]));
  for (const loop of candidates.values()) {
    try {
      // An untriaged ticket is work too: the loop's next run triages it.
      const ready =
        idleAlarmCandidate(loop, now) &&
        ((await workItemRepository.findNextReadyForLoop(loop.userId, loop.id, loop.stages, desktopStagesOf(loop))) ??
          (await workItemRepository.listUntriagedForLoop(loop.userId, loop.id, 1))[0]);
      if (ready) {
        const minutes = Math.round((now.getTime() - new Date(loop.nextRunAt!).getTime()) / MINUTE_MS);
        await loopRepository.setAlarm(loop.id, {
          kind: 'idle_with_work',
          reason: `Ready tickets waiting, but no run for ${minutes} min past its schedule`,
          since: now,
        });
      } else if (loop.alarm?.kind === 'idle_with_work') {
        await loopRepository.clearAlarm(loop.id, 'idle_with_work');
      }
    } catch (error) {
      logger.error(`[Loops] Failed to check loop ${loop.id} for idling`, error as Error);
    }
  }
}

/**
 * Flags the loop's active cloud run once it has gone far longer than its usual runs. Raised, never aborted:
 * the heartbeat rule already folds a dead run and the credit cap bounds spend, so a long live run is the
 * owner's call. The fold clears the alarm (`foldRun`).
 */
async function raiseLongRun(loop: ILoop, execution: IAgentExecution, executionId: string, now: Date): Promise<void> {
  if (execution.status === 'paused' || execution.runner === 'desktop') return;
  const ageMs = now.getTime() - new Date(execution.createdAt).getTime();
  if (ageMs <= LOOP_LONG_RUN_FLOOR_MS) return;
  const durations = (
    await agentExecutionRepository.listRecentForLoop(loop.id, loop.sessionId, LOOP_LONG_RUN_SAMPLE + 1)
  )
    .filter(run => run.id !== executionId && run.status === 'completed' && run.completedAt && run.createdAt)
    .slice(0, LOOP_LONG_RUN_SAMPLE)
    .map(run => new Date(run.completedAt!).getTime() - new Date(run.createdAt).getTime());
  if (ageMs <= longRunThresholdMs(durations)) return;
  const usual = durations.length >= LOOP_LONG_RUN_MIN_SAMPLES ? median(durations) : 0;
  const minutes = Math.round(ageMs / MINUTE_MS);
  await loopRepository.setAlarm(loop.id, {
    kind: 'long_run',
    reason:
      usual > 0
        ? `Run going for ${minutes} min, about ${Math.round(ageMs / usual)}x longer than usual`
        : `Run going for ${minutes} min`,
    since: now,
    executionId,
  });
}

/** Parents waiting on children legitimately idle for hours; the executor's own stale sweep skips them too. */
const WAITING_ON_CHILDREN = ['awaiting_subagent', 'awaiting_dag_children'];

async function reconcileLoop(loop: ILoop, now: Date): Promise<void> {
  const executionId = loop.activeExecutionId!;
  const execution = await agentExecutionRepository.findById(executionId);

  // A run paused at the confidence gate waits on its owner, possibly for days: park its ticket as unsure
  // and free the loop for its other tickets. Checked before the stale rule so it is never folded as stalled.
  if (execution?.status === 'paused' && execution.pendingGate) {
    const ticket = await workItemRepository.findByExecutionId(executionId);
    await parkUnsure(loop.id, execution, executionId, execution.pendingGate, ticket);
    await loopRepository.foldRun(loop.id, executionId, { $set: { lastRunAt: now } });
    if (ticket) await makeDueIfReady(loop, now);
    return;
  }

  if (execution && ACTIVE_AGENT_EXECUTION_STATUSES.includes(execution.status)) {
    if (WAITING_ON_CHILDREN.includes(execution.status)) return;
    // ponytail: updatedAt heuristic, same threshold and statuses as the start-time stale sweep, which
    // aborts the doc on the owner's next start. A legitimately long-quiet run is folded as failed here.
    if (now.getTime() - new Date(execution.updatedAt).getTime() < STALE_ACTIVE_MS) {
      return raiseLongRun(loop, execution, executionId, now);
    }
  }

  // The ticket this run worked, if any. Its fold is conditional on it still being in_progress under this
  // run, so a run that blocked or closed its own ticket through loop_ticket_update is not overwritten.
  const ticket = await workItemRepository.findByExecutionId(executionId);

  if (execution?.status === 'completed' && stoppedByGate(execution)) {
    // The owner stopped it at the gate before a tick detached it: a rejected unsure, not a success.
    const gate = execution.gateHistory?.at(-1);
    // Resolved from gateHistory too, in case gate_response's best-effort log write failed.
    if (gate)
      await loopEventRepository.resolveUnsure(unsureEventFields(runOf(loop.id, execution, executionId), gate, ticket), {
        outcome: gate.resolution,
        by: gate.resolvedBy,
        at: gate.resolvedAt,
      });
    if (ticket) await workItemRepository.foldTicketRun(ticket.id, executionId, gateStopPatch(execution));
    await loopRepository.foldRun(loop.id, executionId, { $set: { lastRunAt: execution.completedAt ?? now } });
    if (ticket) await makeDueIfReady(loop, now);
    return;
  }

  if (execution?.status === 'completed') {
    if (ticket) await workItemRepository.foldTicketRun(ticket.id, executionId, advancePatch(loop, ticket));
    const answer = (execution.result as { answer?: unknown } | undefined)?.answer;
    // A triage run's answer is a summary of priorities set, not the loop's memory.
    const triage = execution.loopRunKind === 'triage';
    const memory = triage
      ? { notes: loop.memory?.notes ?? '', nextAction: loop.memory?.nextAction ?? '' }
      : parseLoopMemory(typeof answer === 'string' ? answer : '', loop.memory);
    const lastRunAt = execution.completedAt ?? now;
    // Idle: no ticket, memory unchanged, and no ticket of the loop touched from the run's start to this
    // fold (to now, not completedAt, so a ticket change since the run ended is not overwritten below).
    const idle =
      !ticket &&
      !(loop.idleResetAt && new Date(loop.idleResetAt) > new Date(execution.createdAt)) &&
      memory.notes === (loop.memory?.notes ?? '') &&
      memory.nextAction === (loop.memory?.nextAction ?? '') &&
      (await workItemRepository.countTouchedForLoop(loop.userId, loop.id, new Date(execution.createdAt), now)) === 0;
    const idleStreak = idle ? (loop.idleStreak ?? 0) + 1 : 0;
    await loopRepository.foldRun(loop.id, executionId, {
      $set: {
        ...(!triage && { memory: { ...memory, updatedAt: now } }),
        lastRunAt,
        consecutiveFailures: 0,
        idleStreak,
        ...(idle && {
          nextRunAt: new Date(
            new Date(lastRunAt).getTime() + backoffMinutes(loop.intervalMinutes, idleStreak) * MINUTE_MS
          ),
        }),
      },
      $inc: { runCount: 1 },
      $unset: { statusReason: '' },
    });
    // After the idle check, so a triage run that set nothing still backs off.
    if (triage) await workItemRepository.defaultUntriaged(execution.triageWorkItemIds ?? [], now);
    if (ticket) await makeDueIfReady(loop, now);
    return;
  }

  if (execution?.failureReason === 'credit_cap' || execution?.failureReason === 'spend_cap') {
    // Not the ticket's fault either, and not a failure. Not made due now: the interval and the pacing defer
    // decide the next run, or a paced cap would turn into a one-iteration run every tick. A new account's
    // spend cap is a rolling window, so the next run past it simply goes ahead.
    if (ticket) await workItemRepository.foldTicketRun(ticket.id, executionId, { status: 'open' }, true);
    const cap = Math.round((execution.creditCap ?? 0) * 100) / 100;
    await loopRepository.foldRun(loop.id, executionId, {
      $set: {
        lastRunAt: execution.completedAt ?? now,
        statusReason:
          execution.failureReason === 'credit_cap'
            ? `Last run stopped at its credit cap (${cap} credits)`
            : "Last run stopped at the new account's spend cap",
      },
    });
    return;
  }

  if (execution?.failureReason === 'insufficient_credits') {
    // Not the ticket's fault: it goes back to open (uncounted), and the loop pauses.
    if (ticket) await workItemRepository.foldTicketRun(ticket.id, executionId, { status: 'open' }, true);
    const folded = await loopRepository.foldRun(loop.id, executionId, {
      $set: { lastRunAt: execution.completedAt ?? now },
    });
    // Conditional on 'live' so an owner's pause during the run stays an owner pause (no autoResume).
    if (folded) {
      await loopRepository.updateForUser(
        loop.id,
        loop.userId,
        { status: 'paused', statusReason: 'Out of credits', autoResume: 'credits' },
        'live'
      );
    }
    return;
  }

  const reason = failureReason(execution);
  if (ticket) {
    await workItemRepository.foldTicketRun(ticket.id, executionId, { status: 'blocked', statusReason: reason });
  }
  const folded = await loopRepository.foldRun(loop.id, executionId, {
    $set: { statusReason: reason, lastRunAt: execution?.completedAt ?? now },
    $inc: { consecutiveFailures: 1 },
  });
  // A separate conditional write, so an owner's pause landing mid-tick is never overwritten.
  if (folded) await loopRepository.markErroredIfFailing(loop.id, MAX_CONSECUTIVE_FAILURES);
  if (ticket) await makeDueIfReady(loop, now);
}

function failureReason(execution: IAgentExecution | null): string {
  return !execution
    ? 'Run not found'
    : execution.status === 'aborted'
      ? 'Run aborted'
      : execution.status === 'failed'
        ? (toCallerSafeError(execution.error) ?? 'Run failed')
        : 'Run stalled';
}

const stoppedByGate = (execution: IAgentExecution): boolean =>
  (execution.result as { stoppedByGate?: unknown } | undefined)?.stoppedByGate === true;

const gateStopPatch = (execution: IAgentExecution): WorkItemPatch => ({
  status: 'blocked',
  statusReason: unsureReason(execution.gateHistory?.at(-1)?.reason),
});

const runOf = (loopId: string, execution: IAgentExecution, executionId: string) => ({
  loopId,
  userId: execution.userId,
  executionId,
});

/** Logs the gate as an `unsure` loop event and blocks the run's ticket, if it is still in_progress under it. */
async function parkUnsure(
  loopId: string,
  execution: IAgentExecution,
  executionId: string,
  gate: IPendingGate,
  ticket: IWorkItem | null
): Promise<void> {
  await loopEventRepository.recordUnsure(unsureEventFields(runOf(loopId, execution, executionId), gate, ticket));
  if (ticket) {
    await workItemRepository.foldTicketRun(ticket.id, executionId, {
      status: 'blocked',
      statusReason: unsureReason(gate.reason),
    });
  }
}

/**
 * Folds a run its owner resumed from the gate back into its ticket once the run ends, as `reconcileLoop`
 * does for a loop's active run, but without touching the loop's memory, run count or failure count:
 * only the active run feeds those. A resumed run that pauses again is parked under a new event.
 */
async function foldResumedRun(event: ILoopEvent, now: Date): Promise<void> {
  const executionId = event.executionId;
  const loop = await loopRepository.findById(event.loopId);
  // Resumed before any tick detached it, the run is still the loop's active run and reconcileLoop folds it.
  if (!loop || loop.activeExecutionId === executionId) return loopEventRepository.markFolded(event.id, now);

  const execution = await agentExecutionRepository.findById(executionId);
  const ticket = await workItemRepository.findByExecutionId(executionId);

  if (execution && ACTIVE_AGENT_EXECUTION_STATUSES.includes(execution.status)) {
    const gate = execution.pendingGate;
    if (execution.status === 'paused' && gate) {
      if (new Date(gate.requestedAt).getTime() === new Date(event.requestedAt).getTime()) return;
      await parkUnsure(loop.id, execution, executionId, gate, ticket);
      await loopEventRepository.markFolded(event.id, now);
      return;
    }
    // Same stale rule as reconcileLoop, so a resumed run whose executor died does not hold its ticket forever.
    if (WAITING_ON_CHILDREN.includes(execution.status)) return;
    if (now.getTime() - new Date(execution.updatedAt).getTime() < STALE_ACTIVE_MS) return;
  }

  if (ticket) {
    // The owner resumed while a tick was parking the run, so the park blocked the ticket after
    // handleGateResponse tried to move it back: undo that before folding.
    if (ticket.status === 'blocked' && ticket.statusReason?.startsWith(UNSURE_PREFIX)) {
      await workItemRepository.resumeBlockedRun(ticket.id, executionId);
    }
    const patch =
      execution?.status === 'completed'
        ? stoppedByGate(execution)
          ? gateStopPatch(execution)
          : advancePatch(loop, ticket)
        : { status: 'blocked' as const, statusReason: failureReason(execution) };
    await workItemRepository.foldTicketRun(ticket.id, executionId, patch);
  }
  await loopEventRepository.markFolded(event.id, now);
  if (ticket) await makeDueIfReady(loop, now);
}

/**
 * Lifts a pause the scheduler set itself: a budget pause once its `nextRunAt` (the next UTC midnight) has
 * passed, a credit pause once the account the executor bills can pay again. Logs each resume; the notice
 * sweep resolves the pause notice at the end of the tick.
 */
async function resumeIfDue(loop: ILoop, now: Date): Promise<void> {
  const kind = loop.autoResume!;
  // Priced like admit, on the model the next run will use, so a stage-model loop does not resume only to re-pause.
  const canPay = () => canPayAgain(loop, async () => iterationPrice(loop, await nextRunModel(loop)));
  if (kind === 'budget' ? !loop.nextRunAt || new Date(loop.nextRunAt) > now : !(await canPay())) return;
  if (!(await loopRepository.resumeAutoPaused(loop.id, kind, now)) || !loop.lastExecutionId) return;
  await loopEventRepository.recordAutoResumed({
    loopId: loop.id,
    userId: loop.userId,
    executionId: loop.lastExecutionId,
    reason: kind === 'budget' ? 'Daily budget reset' : 'Credits available again',
    requestedAt: now,
  });
}

/** Pauses a claimed loop until its owner (or the scheduler, by `autoResume`) sets it live again. */
async function pauseClaimed(loop: ILoop, patch: Record<string, unknown>): Promise<boolean> {
  // Conditional on 'live' so an owner's pause landing mid-dispatch is not overwritten.
  const paused = await loopRepository.updateForUser(
    loop.id,
    loop.userId,
    { status: 'paused', ...patch, leaseUntil: null },
    'live'
  );
  if (!paused) await loopRepository.releaseLease(loop.id);
  return !!paused;
}

/**
 * Admission before a run (`loopAdmission`), acting on a refusal: an out-of-credits payer pauses the loop
 * for credits (no execution created), a spent loop budget or all-loops budget pauses until 00:00 UTC, and
 * a short paced allowance defers the loop, staying live, to when it covers one iteration. Returns the
 * run's credit cap (undefined: none), or null when it did not admit.
 */
async function admit(loop: ILoop, model: string, now: Date, logger: Logger): Promise<{ creditCap?: number } | null> {
  const admission = await loopAdmission(loop, model, now);
  if (admission.ok) return { creditCap: admission.creditCap };
  const tomorrow = nextUtcMidnight(now);
  switch (admission.kind) {
    case 'credits':
      await pauseClaimed(loop, { statusReason: 'Out of credits', autoResume: 'credits' });
      logger.info(`[Loops] Loop ${loop.id} not started: its payer is out of credits`);
      break;
    case 'loop_budget':
      if (await pauseClaimed(loop, { autoResume: 'budget', statusReason: BUDGET_PAUSE_REASON, nextRunAt: tomorrow })) {
        logger.info(`[Loops] Loop ${loop.id} reached its daily budget`);
      }
      break;
    case 'user_budget': {
      const paused = await loopRepository.pauseAllLiveForUser(loop.userId, {
        statusReason: USER_BUDGET_PAUSE_REASON,
        autoResume: 'budget',
        nextRunAt: tomorrow,
      });
      await loopRepository.releaseLease(loop.id);
      logger.info(`[Loops] User ${loop.userId} reached the all-loops daily budget; paused ${paused} loops`);
      break;
    }
    case 'paced':
      await loopRepository.deferUntil(loop.id, admission.readyAt, now);
      logger.info(`[Loops] Loop ${loop.id} deferred by pacing until ${admission.readyAt.toISOString()}`);
      break;
  }
  return null;
}

/**
 * The model the loop's next ticket run will use (`loopRunModel` on the ticket `claimNextTicket` would claim), else
 * the loop's. Read-only, so pricing a run that does not start writes nothing.
 */
async function nextRunModel(loop: ILoop, onlyPriorities?: WorkItemPriority[]): Promise<string> {
  if (!loop.escalationModel && !loop.stageConfig?.some(entry => entry.model || entry.escalationModel)) {
    return loop.model;
  }
  const limit = ticketRunLimit(loop.stages);
  const ready = await workItemRepository.listReadyForLoop(loop.userId, loop.id, loop.stages, desktopStagesOf(loop), {
    onlyPriorities,
  });
  const next = ready.find(ticket => (ticket.runCount ?? 0) < limit);
  return next ? loopRunModel(loop, stageConfigOf(loop, next.stage), (next.runCount ?? 0) + 1, limit).model : loop.model;
}

/**
 * The loop's p2 daily cap (`p2RunsPerDay`), applied before a claim: the ready p2s beyond today's remaining p2 runs
 * are demoted to p3, newest first and never an owner-set one, and once none remain the pick is limited to p0/p1.
 * `cloudReady` says whether a p2/p3 ticket the limit now holds back was ready for a cloud run.
 */
async function applyP2Cap(
  loop: ILoop,
  now: Date
): Promise<{ onlyPriorities?: WorkItemPriority[]; cloudReady: boolean }> {
  if (loop.p2RunsPerDay === undefined) return { cloudReady: false };
  const left = await p2RunsLeft(loop, now);
  // Desktop stages included: a desktop p2 run uses the same daily runs.
  const ready = await workItemRepository.listReadyForLoop(loop.userId, loop.id, loop.stages);
  const overflow = ready
    .filter(ticket => ticket.priority === 'p2')
    .slice(left)
    .filter(ticket => ticket.prioritySetBy !== 'owner')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_DEMOTES_PER_LOOP_TICK);
  for (const ticket of overflow) await workItemRepository.demoteIfAgentSet(ticket.id, now);
  if (left > 0) return { cloudReady: false };
  const desktopStages = desktopStagesOf(loop);
  const limit = ticketRunLimit(loop.stages);
  return {
    onlyPriorities: PRIORITIES_OVER_P2_CAP,
    // A ticket out of runs is not held back: claimNextTicket blocks it for its owner this tick.
    cloudReady: ready.some(
      ticket =>
        !PRIORITIES_OVER_P2_CAP.includes(ticket.priority!) &&
        !desktopStages.includes(ticket.stage ?? '') &&
        (ticket.runCount ?? 0) < limit
    ),
  };
}

/**
 * Claims the loop's next ready ticket for this run, never one in a desktop stage (and only of `onlyPriorities`
 * when given); null means a plain goal run. A ticket that has used up its runs (`ticketRunLimit`) is blocked for
 * its owner instead, whatever its priority, and the next one is tried.
 */
async function claimNextTicket(loop: ILoop, onlyPriorities?: WorkItemPriority[]): Promise<IWorkItem | null> {
  const limit = ticketRunLimit(loop.stages);
  for (const next of await workItemRepository.listReadyForLoop(
    loop.userId,
    loop.id,
    loop.stages,
    desktopStagesOf(loop)
  )) {
    const runs = next.runCount ?? 0;
    if (runs >= limit) {
      await workItemRepository.updateForUser(
        next.id,
        loop.userId,
        { status: 'blocked', statusReason: `Ran ${runs} times without finishing` },
        'open'
      );
      continue;
    }
    if (onlyPriorities && !onlyPriorities.includes(next.priority!)) continue;
    const claimed = await workItemRepository.claimForRun(next.id, loop.id);
    if (claimed) return claimed;
  }
  return null;
}

/** Best effort: a failed release must not hide the dispatch error or skip the lease release. */
async function releaseTicket(ticket: IWorkItem, logger: Logger): Promise<void> {
  await workItemRepository
    .releaseClaim(ticket.id)
    .catch(error => logger.warn(`[Loops] Could not release ticket ${ticket.id}`, { error }));
}

/** Returns whether an execution now holds a run slot for the loop. */
async function dispatchLoop(loop: ILoop, now: Date, logger: Logger): Promise<boolean> {
  let ticket: IWorkItem | null = null;
  let result: Awaited<ReturnType<typeof startAgentExecution>>;
  try {
    // Untriaged tickets come first: a triage run sets their priorities and works no ticket.
    const untriaged = await workItemRepository.listUntriagedForLoop(loop.userId, loop.id, LOOP_TRIAGE_BATCH);
    if (untriaged.length > 0) return await dispatchTriage(loop, untriaged, now, logger);
    const cap = await applyP2Cap(loop, now);
    // ponytail: priced on the ticket nextRunModel peeks at; an owner edit landing between the peek and the
    // claim can start a run on a differently priced model. Claim first and release on refusal if that bites.
    const admission = await admit(loop, await nextRunModel(loop, cap.onlyPriorities), now, logger);
    if (!admission) return false;
    ticket = await claimNextTicket(loop, cap.onlyPriorities);
    if (!ticket && cap.cloudReady) {
      // Only p2/p3 tickets are ready and today's p2 runs are used up: wait for 00:00 UTC rather than run the goal.
      // A new p0/p1 ticket makes the loop due early (makeDueIfReady), and the next dispatch clears the hold.
      await loopRepository.deferUntil(loop.id, nextUtcMidnight(now), now, 'priority_budget');
      logger.info(`[Loops] Loop ${loop.id} held: its p2 runs for today are used up`);
      return false;
    }
    // The stage's settings apply only to a run working a ticket in it; a plain goal run uses the loop's.
    const stage = ticket ? stageConfigOf(loop, ticket.stage) : {};
    const { model, escalated } = ticket
      ? loopRunModel(loop, stage, ticket.runCount ?? 0, ticketRunLimit(loop.stages))
      : { model: loop.model, escalated: false };
    const [directives, overseen, answered] = await Promise.all([
      loopDirectiveRepository.listOpenForLoop(loop.userId, loop.id, LOOP_PROMPT_DIRECTIVES),
      Promise.all((loop.oversees ?? []).map(id => loopRepository.findByIdAndUserId(id, loop.userId))),
      ticket ? loopEventRepository.listAnsweredForTicket(loop.userId, ticket.id, LOOP_PROMPT_ANSWERS) : [],
    ]);
    result = await startAgentExecution(
      {
        userId: loop.userId,
        sessionId: loop.sessionId,
        questId: loop.sessionId,
        query: buildLoopQuery(
          loop.goal,
          loop.memory,
          ticket
            ? {
                item: ticket,
                stages: loop.stages,
                answers: answered.map(event => ({ question: event.reason, note: event.resolution?.note ?? '' })),
                instructions: stage.instructions,
              }
            : undefined,
          { directives, overseen: overseen.filter((watched): watched is ILoop => !!watched) },
          desktopStagesOf(loop)
        ),
        model,
        connectionId: HEADLESS_CONNECTION_ID,
        apiKeyInfo: undefined,
        ...(loop.organizationId && { organizationId: loop.organizationId }),
        ...(loop.agentId && { agentId: loop.agentId }),
        enabledTools: stage.tools?.length ? stage.tools : loop.tools,
        loopId: loop.id,
        ...(admission.creditCap !== undefined && { creditCap: admission.creditCap }),
        ...(ticket && { workItemId: ticket.id, ticketPriority: ticket.priority }),
        ...(escalated && { escalated: true }),
      },
      logger
    );
  } catch (error) {
    // Nothing was started, so the loop may retry next tick. Once an execution exists the lease is left
    // to run out instead, so a failed markDispatched doesn't free the loop for an immediate second run.
    if (ticket) await releaseTicket(ticket, logger);
    await loopRepository.releaseLease(loop.id);
    throw error;
  }

  const executionId = result.ok || result.reason === 'dispatch_failed' ? result.executionId : undefined;
  if (ticket && !executionId) await releaseTicket(ticket, logger);
  return settleDispatch(loop, ticket, result, now, logger);
}

/**
 * A triage run: shown up to LOOP_TRIAGE_BATCH untriaged tickets, it sets their priorities (or splits them) with the
 * loop ticket tools, which every loop run gets from its `loopId`. It claims no ticket, runs on `triageModel`, and its
 * fold keeps the loop's memory. Its fold sets p2 on any ticket it was shown but left untriaged, so a skipped ticket
 * cannot hold the loop on triage; one that set nothing still folds as idle and backs off.
 */
async function dispatchTriage(loop: ILoop, untriaged: IWorkItem[], now: Date, logger: Logger): Promise<boolean> {
  const model = loop.triageModel ?? loop.model;
  let result: Awaited<ReturnType<typeof startAgentExecution>>;
  try {
    const admission = await admit(loop, model, now, logger);
    if (!admission) return false;
    result = await startAgentExecution(
      {
        userId: loop.userId,
        sessionId: loop.sessionId,
        questId: loop.sessionId,
        query: buildTriageQuery(loop, untriaged, desktopStagesOf(loop)),
        model,
        connectionId: HEADLESS_CONNECTION_ID,
        apiKeyInfo: undefined,
        ...(loop.organizationId && { organizationId: loop.organizationId }),
        ...(loop.agentId && { agentId: loop.agentId }),
        enabledTools: [],
        loopId: loop.id,
        loopRunKind: 'triage',
        triageWorkItemIds: untriaged.map(ticket => ticket.id),
        ...(admission.creditCap !== undefined && { creditCap: admission.creditCap }),
      },
      logger
    );
  } catch (error) {
    await loopRepository.releaseLease(loop.id);
    throw error;
  }
  return settleDispatch(loop, null, result, now, logger);
}

/** Records a started run on the loop (and its ticket), or acts on why it did not start. */
async function settleDispatch(
  loop: ILoop,
  ticket: IWorkItem | null,
  result: Awaited<ReturnType<typeof startAgentExecution>>,
  now: Date,
  logger: Logger
): Promise<boolean> {
  if (result.ok) {
    await loopRepository.markDispatched(
      loop.id,
      result.executionId,
      new Date(now.getTime() + loop.intervalMinutes * MINUTE_MS)
    );
    // Linked after markDispatched so a failure here can't leave the loop free for an overlapping run.
    if (ticket) await workItemRepository.setExecution(ticket.id, result.executionId);
    logger.info(`[Loops] Dispatched loop ${loop.id}`, { executionId: result.executionId });
    return true;
  }

  if (result.reason === 'dispatch_failed' && result.executionId) {
    // The execution doc exists. It may yet run (an unconfirmed self-host HTTP dispatch) or stay
    // pending (a rejected invoke); either way track it rather than risk an overlapping run.
    // Reconcile folds it once terminal or stale, and the loop retries right after.
    await loopRepository.markDispatched(loop.id, result.executionId, now);
    if (ticket) await workItemRepository.setExecution(ticket.id, result.executionId);
    logger.warn(`[Loops] Dispatch of loop ${loop.id} unconfirmed; tracking ${result.executionId}`);
    return true;
  }

  if (result.reason === 'concurrent_limit' || result.reason === 'dispatch_failed') {
    await loopRepository.releaseLease(loop.id);
    logger.info(`[Loops] Loop ${loop.id} not started (${result.reason}); retrying next tick`);
    return false;
  }

  // Conditional on 'live' so an owner's pause landing mid-dispatch is not overwritten.
  const parked = await loopRepository.updateForUser(
    loop.id,
    loop.userId,
    { status: 'needs_you', statusReason: result.message, leaseUntil: null },
    'live'
  );
  if (!parked) await loopRepository.releaseLease(loop.id);
  logger.warn(`[Loops] Loop ${loop.id} needs its owner: ${result.reason}`);
  return false;
}
