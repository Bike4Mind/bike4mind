/**
 * The server side of a desktop loop runner: the user's desktop app works the tickets in a loop's
 * `runner: 'desktop'` stages. It lists them, claims one with a lease (a run doc no executor touches),
 * heartbeats and posts progress against the lease, and completes the run. Routes:
 * apps/client/pages/api/loops/runner. Cloud runs of the same loop are the scheduler's
 * (apps/workers/src/cron/loopScheduler.ts); a desktop run never becomes the loop's `activeExecutionId`.
 */
import { Types } from 'mongoose';
import {
  desktopStagesOf,
  effectiveMergePolicy,
  MAX_DESKTOP_RUNS_PER_USER,
  HTTPError,
  loopRunModel,
  RUNNER_LEASE_MS,
  stageConfigOf,
  type ILoop,
  type ILoopStageConfig,
  type IMessageDataToClient,
  type IWorkItem,
  type LoopProgressFrame,
  type RunnerClaim,
  type RunnerHeldLoop,
  type RunnerOutcome,
  type RunnerTicket,
  type WorkItemPatch,
  workItemPriorityRank,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  agentExecutionRepository,
  loopDirectiveRepository,
  loopEventRepository,
  loopRepository,
  organizationRepository,
  workItemRepository,
  type IAgentExecution,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { HEADLESS_CONNECTION_ID } from '@bike4mind/server-utils/utils/headlessConnection';
import { loopAdmission, p2RunsLeft, PRIORITIES_OVER_P2_CAP } from './loopBudget';
import { buildLoopQuery, LOOP_PROMPT_ANSWERS, LOOP_PROMPT_DIRECTIVES, parseLoopMemory } from './loopMemory';
import { advancePatch, makeDueIfReady, ticketRunLimit } from './loopTickets';
import { pushLoopChanged, requestLoopDispatch } from './loopDispatch';
import { relayToViewers } from './relayToViewers';

/** Tickets one list returns, across all of the user's loops. */
export const RUNNER_LIST_LIMIT = 50;
/** Lapsed leases the scheduler releases per tick. */
export const RUNNER_SWEEP_LIMIT = 100;
const REASON_MAX = 1000;

/** A refusal the routes answer as `{ error, reason }`: 409 not claimable, 410 lease or run gone, 404 not yours. */
export type RunnerRefusal = { refused: true; status: 404 | 409 | 410; reason: string; error: string };
const refuse = (status: RunnerRefusal['status'], reason: string, error: string): RunnerRefusal => ({
  refused: true,
  status,
  reason,
  error,
});
export const isRefusal = (value: unknown): value is RunnerRefusal =>
  !!value && typeof value === 'object' && (value as { refused?: unknown }).refused === true;

const ACTIVE = new Set(['pending', 'running', 'continuing']);
const isLive = (run: IAgentExecution) => ACTIVE.has(run.status);
const leaseFrom = (now: Date) => new Date(now.getTime() + RUNNER_LEASE_MS);
const clip = (reason: string) => reason.slice(0, REASON_MAX);

/**
 * The open, ready tickets in the desktop stages of the user's live loops that pass admission: highest priority
 * across loops, then each loop's own order (finish first). A loop with ready tickets that admission holds back is
 * `held`, with the reason, so the desktop can say why it is not running them.
 */
export async function listRunnerTickets(
  userId: string,
  now: Date
): Promise<{ tickets: RunnerTicket[]; held: RunnerHeldLoop[] }> {
  const loops = (await loopRepository.listForUser(userId)).filter(
    loop => loop.status === 'live' && desktopStagesOf(loop).length > 0
  );
  const ready: { loop: ILoop; ticket: IWorkItem }[] = [];
  const held: RunnerHeldLoop[] = [];
  for (const loop of loops) {
    const tickets = await workItemRepository.listReadyInStages(userId, loop.id, loop.stages, desktopStagesOf(loop));
    if (tickets.length === 0) continue;
    // ponytail: priced on the loop's model; the claim re-checks on the stage's model.
    const admission = await loopAdmission(loop, loop.model, now);
    if (!admission.ok) {
      const { repoHint } = stageConfigOf(loop, tickets[0].stage);
      held.push({
        loopId: loop.id,
        loopName: loop.name,
        ...(repoHint && { repoHint }),
        reason: ADMISSION_ERRORS[admission.kind],
      });
      continue;
    }
    // Over the loop's p2 cap, p2 and p3 wait for tomorrow (the claim re-checks).
    const capped = tickets.some(ticket => !PRIORITIES_OVER_P2_CAP.includes(ticket.priority!))
      ? (await p2RunsLeft(loop, now)) === 0
      : false;
    for (const ticket of tickets) {
      if (!capped || PRIORITIES_OVER_P2_CAP.includes(ticket.priority!)) ready.push({ loop, ticket });
    }
  }
  // Array.prototype.sort is stable, so equal priorities keep each loop's order.
  const tickets = ready
    .sort((a, b) => workItemPriorityRank(a.ticket.priority) - workItemPriorityRank(b.ticket.priority))
    .slice(0, RUNNER_LIST_LIMIT)
    .map(({ loop, ticket }) => runnerTicket(loop, ticket));
  return { tickets, held };
}

const runnerTicket = (loop: ILoop, ticket: IWorkItem): RunnerTicket => {
  const { repoHint } = stageConfigOf(loop, ticket.stage);
  return {
    ticketId: ticket.id,
    title: ticket.title,
    loopId: loop.id,
    loopName: loop.name,
    stage: ticket.stage ?? '',
    ...(repoHint && { repoHint }),
  };
};

/**
 * What a desktop run of a ticket in `stage` runs on (`loopRunModel`; `runsAfterClaim` counts this run), and whether
 * the loop's budgets admit it. The one place the desktop claim chooses its model and admits, so a later model or cap
 * rule changes only this.
 */
export async function admitDesktopRun(
  loop: ILoop,
  stage: Omit<ILoopStageConfig, 'stage'>,
  runsAfterClaim: number,
  now: Date
): Promise<{ model: string; escalated: boolean; tools: string[]; creditCap?: number } | RunnerRefusal> {
  const { model, escalated } = loopRunModel(loop, stage, runsAfterClaim, ticketRunLimit(loop.stages));
  const admission = await loopAdmission(loop, model, now);
  if (!admission.ok) return refuse(409, admission.kind, ADMISSION_ERRORS[admission.kind]);
  return { model, escalated, tools: stage.tools?.length ? stage.tools : loop.tools, creditCap: admission.creditCap };
}

const ADMISSION_ERRORS: Record<'credits' | 'loop_budget' | 'user_budget' | 'paced', string> = {
  credits: "The loop's payer is out of credits",
  loop_budget: 'The loop has spent its daily budget',
  user_budget: 'Your loops have spent their daily budget',
  paced: 'The loop is ahead of its paced budget; try again later',
};

/**
 * Claims a ticket for a desktop run: the ticket goes `in_progress` under a new run doc with a lease, and the
 * runner gets the same prompt a cloud run of it would. Every check runs before anything is written.
 */
export async function claimRunnerTicket(
  userId: string,
  ticketId: string,
  now: Date,
  logger: Logger
): Promise<RunnerClaim | RunnerRefusal> {
  const ticket = Types.ObjectId.isValid(ticketId) ? await workItemRepository.findByIdForUser(ticketId, userId) : null;
  const loop = ticket?.loopId ? await loopRepository.findByIdAndUserId(ticket.loopId, userId) : null;
  if (!ticket || !loop) return refuse(404, 'not_found', 'Ticket not found');
  if (loop.status !== 'live') return refuse(409, 'loop_not_live', 'The loop is not live');
  const stages = desktopStagesOf(loop);
  if (!stages.includes(ticket.stage ?? ''))
    return refuse(409, 'not_desktop_stage', 'The ticket is not in a desktop stage');
  if (ticket.status !== 'open') return refuse(409, 'not_open', 'The ticket is not open');
  const deps = await workItemRepository.findManyByIdsForUser(ticket.dependencies, userId);
  if (deps.some(dep => dep.status !== 'closed')) return refuse(409, 'dependencies_open', 'The ticket waits on others');

  const runs = ticket.runCount ?? 0;
  if (runs >= ticketRunLimit(loop.stages)) {
    // Blocked for its owner the same way the scheduler blocks a cloud ticket at its limit.
    await workItemRepository.updateForUser(
      ticket.id,
      userId,
      { status: 'blocked', statusReason: `Ran ${runs} times without finishing` },
      'open'
    );
    return refuse(409, 'run_limit', `The ticket ran ${runs} times without finishing`);
  }
  if (!ticket.priority) return refuse(409, 'untriaged', 'The ticket waits for a triage run to set its priority');
  if (!PRIORITIES_OVER_P2_CAP.includes(ticket.priority) && (await p2RunsLeft(loop, now)) === 0) {
    return refuse(409, 'p2_budget', "The loop's p2 runs for today are used up; p2 and p3 tickets wait until 00:00 UTC");
  }

  const stage = stageConfigOf(loop, ticket.stage);
  const admitted = await admitDesktopRun(loop, stage, runs + 1, now);
  if (isRefusal(admitted)) return admitted;
  if ((await agentExecutionRepository.countActiveDesktopByUserId(userId)) >= MAX_DESKTOP_RUNS_PER_USER) {
    return refuse(409, 'lanes_full', `You have ${MAX_DESKTOP_RUNS_PER_USER} desktop runs active`);
  }

  const org = loop.organizationId ? await organizationRepository.findById(loop.organizationId) : null;
  const runId = new Types.ObjectId().toString();
  const claimed = await workItemRepository.claimForRunner(ticket.id, userId, loop.id, stages, runId);
  if (!claimed) return refuse(409, 'claimed', 'The ticket was claimed by another run');

  const leaseUntil = leaseFrom(now);
  try {
    const prompt = await loopPrompt(loop, claimed, stage);
    await agentExecutionRepository.createRunnerRun(runId, {
      userId,
      ...(loop.organizationId && { organizationId: loop.organizationId }),
      sessionId: loop.sessionId,
      questId: loop.sessionId,
      query: prompt,
      model: admitted.model,
      status: 'running',
      connectionId: HEADLESS_CONNECTION_ID,
      approvedTools: [],
      deniedTools: [],
      iterationBilling: [],
      totalCreditsUsed: 0,
      lambdaInvocationCount: 0,
      childExecutionIds: [],
      loopId: loop.id,
      workItemId: ticket.id,
      ticketPriority: ticket.priority,
      ...(admitted.escalated && { escalated: true }),
      ...(admitted.creditCap !== undefined && { creditCap: admitted.creditCap }),
      checkpoint: { steps: [], iteration: 0, pendingText: '', seq: 0 },
      runnerLeaseUntil: leaseUntil,
    });
    logger.info(`[Loops] Desktop run ${runId} claimed ticket ${ticket.id} of loop ${loop.id}`);
    await pushLoopChanged(userId, loop.id, logger);
    return {
      ticket: runnerTicket(loop, claimed),
      runId,
      leaseExpiresAt: leaseUntil.toISOString(),
      prompt,
      model: admitted.model,
      tools: admitted.tools,
      stage: {
        mergePolicy: effectiveMergePolicy(stage.mergePolicy, org?.loopsGreenCiMergeDisabled),
        ...((stage.deployWorkflow || stage.smoke || stage.holdLabels) && {
          guards: {
            ...(stage.deployWorkflow && { deployWorkflow: stage.deployWorkflow }),
            ...(stage.smoke && { smoke: stage.smoke }),
            ...(stage.holdLabels && { holdLabels: stage.holdLabels }),
          },
        }),
      },
    };
  } catch (error) {
    // The create may have landed before it threw (a timeout), so its run is ended too.
    await Promise.all([
      agentExecutionRepository.finishRunnerRun(runId, userId, { status: 'failed' }),
      workItemRepository.foldTicketRun(ticket.id, runId, { status: 'open', executionId: null }, true),
    ]).catch(releaseError => logger.warn(`[Loops] Could not release ticket ${ticket.id}`, { releaseError }));
    throw error;
  }
}

/** The prompt a cloud run of this ticket gets (dispatchLoop in apps/workers/src/cron/loopScheduler.ts). */
async function loopPrompt(loop: ILoop, ticket: IWorkItem, stage: Omit<ILoopStageConfig, 'stage'>): Promise<string> {
  const [directives, overseen, answered] = await Promise.all([
    loopDirectiveRepository.listOpenForLoop(loop.userId, loop.id, LOOP_PROMPT_DIRECTIVES),
    Promise.all((loop.oversees ?? []).map(id => loopRepository.findByIdAndUserId(id, loop.userId))),
    loopEventRepository.listAnsweredForTicket(loop.userId, ticket.id, LOOP_PROMPT_ANSWERS),
  ]);
  return buildLoopQuery(
    loop.goal,
    loop.memory,
    {
      item: ticket,
      stages: loop.stages,
      answers: answered.map(event => ({ question: event.reason, note: event.resolution?.note ?? '' })),
      instructions: stage.instructions,
    },
    { directives, overseen: overseen.filter((watched): watched is ILoop => !!watched) }
  );
}

/**
 * The caller's desktop run while it is still active; a refusal otherwise. Folds a run stopped from the web run
 * view (no executor polls its abort flag) and one at its credit cap.
 */
async function liveRun(userId: string, runId: string, logger: Logger): Promise<IAgentExecution | RunnerRefusal> {
  const run = await agentExecutionRepository.findRunnerRun(runId, userId);
  if (!run) return refuse(404, 'not_found', 'Run not found');
  if (!isLive(run)) return refuse(410, 'run_ended', 'The run is no longer active');
  if (run.abortedAt) {
    await stopAborted(run, logger);
    return refuse(410, 'aborted', 'The run was stopped');
  }
  if (run.creditCap !== undefined && run.totalCreditsUsed >= run.creditCap) {
    await stopAtCreditCap(run, logger);
    return refuse(410, 'credit_cap', 'The run reached its credit cap');
  }
  return run;
}

/** As the scheduler folds a cloud run stopped at its cap: the ticket reopens uncounted and the loop says why. */
async function stopAtCreditCap(run: IAgentExecution, logger: Logger): Promise<void> {
  const cap = Math.round((run.creditCap ?? 0) * 100) / 100;
  await foldRunTicket(run.id, { status: 'open', executionId: null }, true);
  const stopped = await agentExecutionRepository.finishRunnerRun(run.id, run.userId, {
    status: 'failed',
    failureReason: 'credit_cap',
    error: { message: `The run reached its credit cap (${cap} credits)`, callerSafe: true },
  });
  if (!stopped) return;
  if (run.loopId) {
    await loopRepository.updateForUser(run.loopId, run.userId, {
      statusReason: `Last desktop run stopped at its credit cap (${cap} credits)`,
    });
  }
  await relayToViewers(run.id, [failedFrame(run.id, 'credit_cap', 'The run reached its credit cap')], logger);
}

/** As the scheduler folds an aborted cloud run: its ticket is blocked, so no runner picks it up again. */
async function stopAborted(run: IAgentExecution, logger: Logger): Promise<void> {
  await foldRunTicket(run.id, { status: 'blocked', statusReason: 'Run aborted' });
  if (await agentExecutionRepository.finishRunnerRun(run.id, run.userId, { status: 'aborted' })) {
    await relayToViewers(run.id, [failedFrame(run.id, 'aborted', 'Run aborted')], logger);
  }
}

/**
 * Folds the ticket still `in_progress` under a desktop run. Every end of a run folds its ticket BEFORE it
 * ends the run: a crash in between leaves the run active, so a retry or the lease sweep folds again (a no-op
 * on the ticket), where the other order would strand the ticket under an ended run no sweep looks at.
 */
async function foldRunTicket(runId: string, patch: WorkItemPatch, uncount?: boolean): Promise<void> {
  const ticket = await workItemRepository.findByExecutionId(runId);
  if (ticket?.status === 'in_progress') await workItemRepository.foldTicketRun(ticket.id, runId, patch, uncount);
}

/** Renews the lease of the caller's active desktop run. */
export async function heartbeatRunnerRun(
  userId: string,
  runId: string,
  now: Date,
  logger: Logger
): Promise<{ leaseExpiresAt: string } | RunnerRefusal> {
  const run = await liveRun(userId, runId, logger);
  if (isRefusal(run)) return run;
  const renewed = await agentExecutionRepository.renewRunnerLease(run.id, userId, now, leaseFrom(now));
  if (!renewed?.runnerLeaseUntil) return refuse(410, 'lease_lost', 'The lease lapsed');
  return { leaseExpiresAt: new Date(renewed.runnerLeaseUntil).toISOString() };
}

type RunnerCheckpoint = { steps?: unknown[]; iteration?: number; pendingText?: string; seq?: number };

/** A persisted progress step, in the executor's checkpoint step shape (AgentStep, b4m-core/agents/src/types.ts). */
type RunnerStep = {
  type: 'thought' | 'action' | 'observation';
  content: string;
  metadata: { timestamp: number; iteration: number; toolName?: string; toolInput?: unknown; toolFailed?: boolean };
};

/**
 * Maps a runner's progress frames to the executor's steps and live frames, so the web run view needs no
 * desktop-specific code. Text streams as `agent_text_delta` and becomes a `thought` once a tool starts; a tool
 * call is an `action` then an `observation`, which ends the iteration. `usage` is ignored: credits come from
 * the completion calls (LOOP_RUN_HEADER). `state` is the run's checkpoint before these frames.
 */
export function runnerFramesToSteps(
  executionId: string,
  frames: LoopProgressFrame[],
  state: { iteration: number; pendingText: string },
  now: number
): { steps: RunnerStep[]; relay: IMessageDataToClient[]; iteration: number; pendingText: string } {
  let { iteration, pendingText } = state;
  const steps: RunnerStep[] = [];
  const relay: IMessageDataToClient[] = [];
  const push = (step: Omit<RunnerStep, 'metadata'> & { metadata?: Partial<RunnerStep['metadata']> }) => {
    const full: RunnerStep = { ...step, metadata: { ...step.metadata, timestamp: now, iteration } };
    steps.push(full);
    relay.push({ action: 'iteration_step', executionId, iteration, step: full, isComplete: false });
  };
  for (const frame of frames) {
    if (frame.type === 'text') {
      pendingText += frame.text;
      relay.push({ action: 'agent_text_delta', executionId, iteration, delta: frame.text });
    } else if (frame.type === 'tool-start') {
      if (pendingText.trim()) push({ type: 'thought', content: pendingText });
      pendingText = '';
      push({
        type: 'action',
        content: frame.name,
        metadata: { toolName: frame.name, toolInput: parseInput(frame.input) },
      });
    } else if (frame.type === 'tool-end') {
      const failed = frame.status === 'error' || frame.status === 'denied';
      push({
        type: 'observation',
        content: frame.preview ?? frame.error ?? '',
        metadata: { toolName: frame.name, ...(failed && { toolFailed: true }) },
      });
      iteration += 1;
    }
  }
  return { steps, relay, iteration, pendingText };
}

function parseInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/**
 * Persists a batch of progress (renewing the lease) and relays it to the run's viewers. Concurrent posts
 * for one run are serialized by a compare-and-set on the checkpoint's append sequence; a post that loses
 * retries once.
 */
export async function progressRunnerRun(
  userId: string,
  runId: string,
  frames: LoopProgressFrame[],
  now: Date,
  logger: Logger
): Promise<{ leaseExpiresAt: string } | RunnerRefusal> {
  const leaseUntil = leaseFrom(now);
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = await liveRun(userId, runId, logger);
    if (isRefusal(run)) return run;
    const checkpoint = (run.checkpoint ?? {}) as RunnerCheckpoint;
    const before = { iteration: checkpoint.iteration ?? 0, pendingText: checkpoint.pendingText ?? '' };
    const mapped = runnerFramesToSteps(run.id, frames, before, now.getTime());
    const saved = await agentExecutionRepository.appendRunnerSteps(
      run.id,
      userId,
      now,
      { seq: checkpoint.seq ?? 0 },
      {
        steps: mapped.steps,
        iteration: mapped.iteration,
        pendingText: mapped.pendingText,
        leaseUntil,
      }
    );
    if (saved) {
      await relayToViewers(run.id, mapped.relay, logger);
      return { leaseExpiresAt: leaseUntil.toISOString() };
    }
  }
  return refuse(410, 'lease_lost', 'The lease lapsed or another progress post won');
}

const failedFrame = (executionId: string, reason: string, message: string): IMessageDataToClient => ({
  action: 'failed',
  executionId,
  reason,
  message,
});

/**
 * Ends the caller's desktop run with the runner's outcome. The ticket write is conditional on it still
 * being `in_progress` under this run, so a ticket its owner moved mid-run is left alone; the run is closed
 * either way. A `failed` run blocks its ticket but never counts toward the loop's `consecutiveFailures`.
 */
export async function completeRunnerRun(
  userId: string,
  runId: string,
  body: RunnerOutcome,
  now: Date,
  logger: Logger
): Promise<{ ok: true } | RunnerRefusal> {
  const run = await agentExecutionRepository.findRunnerRun(runId, userId);
  if (!run) return refuse(404, 'not_found', 'Run not found');
  if (!isLive(run)) return refuse(410, 'run_ended', 'The run is no longer active');
  // A web Stop wins over whatever the runner reports after it.
  if (run.abortedAt) {
    await stopAborted(run, logger);
    return refuse(410, 'aborted', 'The run was stopped');
  }
  const loop = run.loopId ? await loopRepository.findByIdAndUserId(run.loopId, userId) : null;
  const ticket = await workItemRepository.findByExecutionId(run.id);
  if (ticket?.status === 'in_progress' && loop) {
    const patch: WorkItemPatch =
      body.outcome === 'advanced'
        ? advancePatch(loop, ticket)
        : body.outcome === 'blocked'
          ? { status: 'blocked', statusReason: clip(body.reason) }
          : body.outcome === 'failed'
            ? { status: 'blocked', statusReason: clip(`Desktop run failed: ${body.reason}`) }
            : { status: 'open', executionId: null };
    await workItemRepository.foldTicketRun(ticket.id, run.id, patch, body.outcome === 'released');
  }

  const answer = body.outcome === 'advanced' || body.outcome === 'blocked' ? body.answer : undefined;
  const set: Partial<IAgentExecution> =
    body.outcome === 'failed'
      ? { status: 'failed', error: { message: clip(body.reason), callerSafe: true } }
      : body.outcome === 'released'
        ? { status: 'aborted' }
        : {
            status: 'completed',
            ...(body.outcome === 'blocked' && { failureReason: 'blocked' as const }),
            ...(answer !== undefined && { result: { answer } }),
          };
  if (
    !(await agentExecutionRepository.finishRunnerRun(run.id, userId, { ...set, runnerDurationMs: body.durationMs }))
  ) {
    return refuse(410, 'run_ended', 'The run is no longer active');
  }
  // Every run that did work counts as the loop's last run, with or without an answer; a release did none.
  if (loop && body.outcome !== 'released') {
    await loopRepository.foldRunnerRun(
      loop.id,
      userId,
      answer !== undefined ? { ...parseLoopMemory(answer, loop.memory), updatedAt: now } : undefined,
      now
    );
  }
  if (loop) {
    // The ticket's next stage may be a cloud one.
    if (body.outcome === 'advanced' && (await makeDueIfReady(loop, now))) await requestLoopDispatch(loop.id, logger);
    await pushLoopChanged(userId, loop.id, logger);
  }

  const checkpoint = (run.checkpoint ?? {}) as RunnerCheckpoint;
  await relayToViewers(
    run.id,
    [
      set.status === 'completed'
        ? {
            action: 'completed',
            executionId: run.id,
            ...(answer !== undefined && { answer }),
            ...(set.failureReason === 'blocked' && { failureReason: 'blocked' as const }),
            totalIterations: checkpoint.iteration ?? 0,
            totalCreditsUsed: run.totalCreditsUsed,
          }
        : failedFrame(run.id, body.outcome, body.outcome === 'failed' ? body.reason : 'Released by the desktop runner'),
    ],
    logger
  );
  return { ok: true };
}

/**
 * Fails the desktop runs whose lease lapsed and reopens their tickets (still counted, so a runner that keeps
 * dying reaches the ticket's run limit). Run first in each scheduler tick.
 */
export async function releaseExpiredRunnerLeases(now: Date, logger: Logger): Promise<void> {
  for (const run of await agentExecutionRepository.listExpiredRunnerRuns(now, RUNNER_SWEEP_LIMIT)) {
    try {
      if (run.abortedAt) {
        await stopAborted(run, logger);
        continue;
      }
      const message = 'The desktop runner stopped responding';
      await foldRunTicket(run.id, { status: 'open', executionId: null });
      const failed = await agentExecutionRepository.finishRunnerRun(run.id, run.userId, {
        status: 'failed',
        failureReason: 'abandoned',
        error: { message, callerSafe: true },
      });
      if (!failed) continue;
      await relayToViewers(run.id, [failedFrame(run.id, 'abandoned', message)], logger);
      logger.info(`[Loops] Released desktop run ${run.id}: its lease lapsed`);
    } catch (error) {
      logger.error(`[Loops] Failed to release desktop run ${run.id}`, error as Error);
    }
  }
}

/**
 * The desktop run a completion call is tagged with (LOOP_RUN_HEADER), when it is the caller's active one;
 * undefined otherwise, so a stale or foreign tag never breaks chat. Only a first-party (JWT) caller can tag,
 * and only while EnableLoops is on. Throws a 422 `insufficient_credits` when the run already reached its credit
 * cap, so the call is refused before it streams.
 */
export async function resolveLoopRunTag(
  runId: string | undefined,
  userId: string,
  viaApiKey: boolean,
  logger: Logger
): Promise<string | undefined> {
  if (!runId || viaApiKey) return undefined;
  const run = await activeTaggedRun(runId, userId, logger);
  if (!run) {
    logger.info('[Loops] Ignoring a loop run tag that is not an active desktop run of the caller', { runId });
    return undefined;
  }
  if (run.creditCap !== undefined && run.totalCreditsUsed >= run.creditCap) {
    // The completions contract's documented credit refusal, so no new status reaches its public spec.
    throw new HTTPError(422, 'This loop run reached its credit cap', { errorCode: 'insufficient_credits' });
  }
  return run.id;
}

/** A lookup failure counts as no tag: the tag only tallies budgets, so it must never fail the completion. */
async function activeTaggedRun(runId: string, userId: string, logger: Logger): Promise<IAgentExecution | null> {
  try {
    if ((await adminSettingsRepository.getSettingsValue('EnableLoops')) !== true) return null;
    const run = await agentExecutionRepository.findRunnerRun(runId, userId);
    return run && isLive(run) && !run.abortedAt ? run : null;
  } catch (error) {
    logger.warn('[Loops] Could not resolve a loop run tag; ignoring it', { runId, error });
    return null;
  }
}
