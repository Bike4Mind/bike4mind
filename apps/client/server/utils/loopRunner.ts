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
  RUNNER_LEASE_MS,
  stageConfigOf,
  type ILoop,
  type ILoopStageConfig,
  type IMessageDataToClient,
  type IWorkItem,
  type LoopProgressFrame,
  type RunnerClaim,
  type RunnerOutcome,
  type RunnerTicket,
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
import { loopAdmission } from './loopBudget';
import { buildLoopQuery, LOOP_PROMPT_ANSWERS, LOOP_PROMPT_DIRECTIVES, parseLoopMemory } from './loopMemory';
import { advancePatch, makeDueIfReady, ticketRunLimit } from './loopTickets';
import { relayToViewers } from './relayToViewers';

/** Tickets one list returns, across all of the user's loops. */
export const RUNNER_LIST_LIMIT = 50;
/** Lapsed leases the scheduler releases per tick. */
export const RUNNER_SWEEP_LIMIT = 100;
const REASON_MAX = 1000;

/** A refusal the routes answer as `{ error, reason }`: 409 not claimable, 410 lease or run gone, 404 not yours. */
export type RunnerRefusal = { status: 404 | 409 | 410; reason: string; error: string };
const refuse = (status: RunnerRefusal['status'], reason: string, error: string): RunnerRefusal => ({
  status,
  reason,
  error,
});
export const isRefusal = (value: unknown): value is RunnerRefusal =>
  !!value && typeof value === 'object' && 'status' in value && 'reason' in value;

const ACTIVE = new Set(['pending', 'running', 'continuing']);
const isLive = (run: IAgentExecution) => ACTIVE.has(run.status);
const leaseFrom = (now: Date) => new Date(now.getTime() + RUNNER_LEASE_MS);
const clip = (reason: string) => reason.slice(0, REASON_MAX);

/** The open, ready tickets in the desktop stages of the user's live loops that pass admission, finish first. */
export async function listRunnerTickets(userId: string, now: Date): Promise<RunnerTicket[]> {
  const loops = (await loopRepository.listForUser(userId)).filter(
    loop => loop.status === 'live' && desktopStagesOf(loop).length > 0
  );
  const tickets: RunnerTicket[] = [];
  for (const loop of loops) {
    if (tickets.length >= RUNNER_LIST_LIMIT) break;
    // ponytail: priced on the loop's model; the claim re-checks on the stage's model.
    if (!(await loopAdmission(loop, loop.model, now)).ok) continue;
    const ready = await workItemRepository.listReadyInStages(userId, loop.id, loop.stages, desktopStagesOf(loop));
    tickets.push(...ready.map(ticket => runnerTicket(loop, ticket)));
  }
  return tickets.slice(0, RUNNER_LIST_LIMIT);
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
 * What a desktop run of a ticket in `stage` runs on, and whether the loop's budgets admit it. The one place
 * the desktop claim chooses its model and admits, so a later model or cap rule changes only this.
 */
export async function admitDesktopRun(
  loop: ILoop,
  stage: Omit<ILoopStageConfig, 'stage'>,
  now: Date
): Promise<{ model: string; tools: string[]; creditCap?: number } | RunnerRefusal> {
  const model = stage.model ?? loop.model;
  const admission = await loopAdmission(loop, model, now);
  if (!admission.ok) return refuse(409, admission.kind, ADMISSION_ERRORS[admission.kind]);
  return { model, tools: stage.tools?.length ? stage.tools : loop.tools, creditCap: admission.creditCap };
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

  const stage = stageConfigOf(loop, ticket.stage);
  const admitted = await admitDesktopRun(loop, stage, now);
  if (isRefusal(admitted)) return admitted;
  if ((await agentExecutionRepository.countActiveDesktopByUserId(userId)) >= MAX_DESKTOP_RUNS_PER_USER) {
    return refuse(409, 'lanes_full', `You have ${MAX_DESKTOP_RUNS_PER_USER} desktop runs active`);
  }

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
      ...(admitted.creditCap !== undefined && { creditCap: admitted.creditCap }),
      checkpoint: { steps: [], iteration: 0, pendingText: '' },
      runnerLeaseUntil: leaseUntil,
    });
    const org = loop.organizationId ? await organizationRepository.findById(loop.organizationId) : null;
    logger.info(`[Loops] Desktop run ${runId} claimed ticket ${ticket.id} of loop ${loop.id}`);
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
    await workItemRepository
      .foldTicketRun(ticket.id, runId, { status: 'open', executionId: null }, true)
      .catch(releaseError => logger.warn(`[Loops] Could not release ticket ${ticket.id}`, { releaseError }));
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

/** The caller's desktop run while it is still active; a refusal otherwise. Folds a run at its credit cap. */
async function liveRun(userId: string, runId: string, logger: Logger): Promise<IAgentExecution | RunnerRefusal> {
  const run = await agentExecutionRepository.findRunnerRun(runId, userId);
  if (!run) return refuse(404, 'not_found', 'Run not found');
  if (!isLive(run)) return refuse(410, 'run_ended', 'The run is no longer active');
  if (run.creditCap !== undefined && run.totalCreditsUsed >= run.creditCap) {
    await stopAtCreditCap(run, logger);
    return refuse(410, 'credit_cap', 'The run reached its credit cap');
  }
  return run;
}

/** As the scheduler folds a cloud run stopped at its cap: the ticket reopens uncounted and the loop says why. */
async function stopAtCreditCap(run: IAgentExecution, logger: Logger): Promise<void> {
  const cap = Math.round((run.creditCap ?? 0) * 100) / 100;
  const stopped = await agentExecutionRepository.finishRunnerRun(run.id, run.userId, {
    status: 'failed',
    failureReason: 'credit_cap',
    error: { message: `The run reached its credit cap (${cap} credits)`, callerSafe: true },
  });
  if (!stopped) return;
  const ticket = await workItemRepository.findByExecutionId(run.id);
  if (ticket) await workItemRepository.foldTicketRun(ticket.id, run.id, { status: 'open', executionId: null }, true);
  if (run.loopId) {
    await loopRepository.updateForUser(run.loopId, run.userId, {
      statusReason: `Last desktop run stopped at its credit cap (${cap} credits)`,
    });
  }
  await relayToViewers(run.id, [failedFrame(run.id, 'credit_cap', 'The run reached its credit cap')], logger);
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

type RunnerCheckpoint = { steps?: unknown[]; iteration?: number; pendingText?: string };

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
 * for one run are serialized by a compare-and-set on the iteration; a post that loses retries once.
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
    const saved = await agentExecutionRepository.appendRunnerSteps(run.id, userId, now, before, {
      steps: mapped.steps,
      iteration: mapped.iteration,
      pendingText: mapped.pendingText,
      leaseUntil,
    });
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
  const answer = body.outcome === 'advanced' || body.outcome === 'blocked' ? body.answer : undefined;
  const set: Partial<IAgentExecution> =
    body.outcome === 'failed'
      ? { status: 'failed', error: { message: clip(body.reason), callerSafe: true } }
      : body.outcome === 'released'
        ? { status: 'aborted' }
        : { status: 'completed', ...(answer !== undefined && { result: { answer } }) };
  if (
    !(await agentExecutionRepository.finishRunnerRun(run.id, userId, { ...set, runnerDurationMs: body.durationMs }))
  ) {
    return refuse(410, 'run_ended', 'The run is no longer active');
  }

  const [ticket, loop] = await Promise.all([
    workItemRepository.findByExecutionId(run.id),
    run.loopId ? loopRepository.findByIdAndUserId(run.loopId, userId) : null,
  ]);
  if (ticket && loop) {
    const patch =
      body.outcome === 'advanced'
        ? advancePatch(loop, ticket)
        : body.outcome === 'blocked'
          ? { status: 'blocked' as const, statusReason: clip(body.reason) }
          : body.outcome === 'failed'
            ? { status: 'blocked' as const, statusReason: clip(`Desktop run failed: ${body.reason}`) }
            : { status: 'open' as const, executionId: null };
    await workItemRepository.foldTicketRun(ticket.id, run.id, patch, body.outcome === 'released');
  }
  if (loop && answer !== undefined) {
    await loopRepository.foldRunnerRun(
      loop.id,
      userId,
      { ...parseLoopMemory(answer, loop.memory), updatedAt: now },
      now
    );
  }
  // The ticket's next stage may be a cloud one.
  if (loop && body.outcome === 'advanced') await makeDueIfReady(loop, now);

  const checkpoint = (run.checkpoint ?? {}) as RunnerCheckpoint;
  await relayToViewers(
    run.id,
    [
      set.status === 'completed'
        ? {
            action: 'completed',
            executionId: run.id,
            ...(answer !== undefined && { answer }),
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
      const message = 'The desktop runner stopped responding';
      const failed = await agentExecutionRepository.finishRunnerRun(run.id, run.userId, {
        status: 'failed',
        failureReason: 'abandoned',
        error: { message, callerSafe: true },
      });
      if (!failed) continue;
      const ticket = await workItemRepository.findByExecutionId(run.id);
      if (ticket) await workItemRepository.foldTicketRun(ticket.id, run.id, { status: 'open', executionId: null });
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
  if ((await adminSettingsRepository.getSettingsValue('EnableLoops')) !== true) return undefined;
  const run = await agentExecutionRepository.findRunnerRun(runId, userId);
  if (!run || !isLive(run)) {
    logger.info('[Loops] Ignoring a loop run tag that is not an active desktop run of the caller', { runId });
    return undefined;
  }
  if (run.creditCap !== undefined && run.totalCreditsUsed >= run.creditCap) {
    // The completions contract's documented credit refusal, so no new status reaches its public spec.
    throw new HTTPError(422, 'This loop run reached its credit cap', { errorCode: 'insufficient_credits' });
  }
  return run.id;
}
