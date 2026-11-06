import {
  desktopStagesOf,
  type ILoop,
  type ILoopEvent,
  type IWorkItem,
  type LoopUnsureFields,
  type WorkItemBlocker,
  type WorkItemPatch,
  type WorkItemPriority,
  type WorkItemPrioritySetter,
  type WorkItemStatus,
} from '@bike4mind/common';
import { loopRepository, workItemRepository, type IPendingGate } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLoopsEnabled } from './loopValidation';
import { validateWorkItemBlocker } from './workItemValidation';

/**
 * The stage rule for loop tickets (WorkItems with a `loopId`), shared by the work-items routes, the
 * tickets route, the loop scheduler's fold and the loop run's `loop_ticket_*` tools:
 * a ticket sits in one of its loop's `stages`; the last stage means closed, and closed means the last stage.
 */

/** Closed tickets returned per loop by the tickets route; older ones stay in the DB. */
export const LOOP_TICKET_CLOSED_WINDOW = 50;

/** Runs a ticket gets per stage it moves through before the loop scheduler blocks it for its owner. */
export const TICKET_RUNS_PER_STAGE = 3;
export const ticketRunLimit = (stages: string[]): number => TICKET_RUNS_PER_STAGE * (stages.length - 1);

export const lastStageOf = (loop: Pick<ILoop, 'stages'>): string => loop.stages.at(-1) ?? '';

/** A requested stage checked against the loop; omitted means the first stage. */
export function resolveTicketStage(loop: Pick<ILoop, 'stages'>, requested?: unknown): string {
  if (loop.stages.length < 2) throw new BadRequestError('A loop needs at least two stages to hold tickets');
  if (requested === undefined || requested === null) return loop.stages[0];
  if (typeof requested !== 'string' || !loop.stages.includes(requested)) {
    throw new BadRequestError(`stage must be one of: ${loop.stages.join(', ')}`);
  }
  return requested;
}

const WAITING_ON_DEPENDENCIES = 'Waiting on dependencies';

/**
 * The stage/status/closedAt/statusReason/blockedOn patch for moving a ticket. `current` is the ticket as stored
 * (omitted on create). Moving to the last stage closes it; closing moves it to the last stage; reopening a
 * closed ticket puts it back one stage. `in_progress` is the scheduler's alone. `blockedOn` parks a blocked
 * ticket on a condition the scheduler reopens it from; any other move clears it. The caller checks the
 * condition can still come true (assertBlockedOnSatisfiable).
 */
export function ticketMovePatch(
  loop: Pick<ILoop, 'stages'>,
  current: Pick<IWorkItem, 'stage' | 'status'> | undefined,
  move: { stage?: unknown; status?: WorkItemStatus; reason?: unknown; blockedOn?: unknown }
): WorkItemPatch {
  const stages = loop.stages;
  const last = lastStageOf(loop);
  if (stages.length < 2) throw new BadRequestError('A loop needs at least two stages to hold tickets');
  if (move.status === 'in_progress') throw new BadRequestError('A loop ticket is set in_progress by its loop');

  let stage =
    move.stage !== undefined && move.stage !== null
      ? resolveTicketStage(loop, move.stage)
      : current?.stage && stages.includes(current.stage)
        ? current.stage
        : resolveTicketStage(loop);
  // A plain stage move keeps the ticket's status (blocked stays blocked, a running ticket keeps its run);
  // only the last stage closes it and leaving it reopens it.
  const status: WorkItemStatus =
    move.status ??
    (stage === last && move.stage !== undefined
      ? 'closed'
      : current?.status === 'closed' && move.stage !== undefined
        ? 'open'
        : (current?.status ?? 'open'));
  const blockedOn = validateWorkItemBlocker(move.blockedOn);
  if (blockedOn && status !== 'blocked') throw new BadRequestError('blockedOn is only valid with status blocked');
  const reason = blockedOn && !move.reason ? WAITING_ON_DEPENDENCIES : move.reason;
  const keepsReason = status === 'blocked' && current?.status === 'blocked' && reason === undefined;

  if (status === 'closed') stage = last;
  else if (stage === last) stage = stages.at(-2)!;

  if (status === 'blocked' && !keepsReason && (typeof reason !== 'string' || !reason.trim())) {
    throw new BadRequestError('A reason is required to block a ticket');
  }

  return {
    stage,
    status,
    closedAt: status === 'closed' ? (current?.status === 'closed' ? undefined : new Date()) : null,
    statusReason: keepsReason ? undefined : status === 'blocked' ? (reason as string).trim().slice(0, 1000) : null,
    blockedOn: blockedOn ?? (keepsReason ? undefined : null),
  };
}

/**
 * The one way a ticket's priority is written: with who set it and when, which the p2 demote (only an owner
 * priority is sticky) and the service-level clock read. `null` clears all three.
 */
export const priorityPatch = (
  priority: WorkItemPriority | null,
  by: Exclude<WorkItemPrioritySetter, 'demote'>,
  now = new Date()
): Pick<WorkItemPatch, 'priority' | 'prioritySetAt' | 'prioritySetBy'> =>
  priority === null
    ? { priority: null, prioritySetAt: null, prioritySetBy: null }
    : { priority, prioritySetAt: now, prioritySetBy: by };

/** A ticket parked on its dependencies needs at least one still open, or nothing would ever reopen it. */
export async function assertBlockedOnSatisfiable(
  userId: string,
  dependencies: string[],
  blockedOn: WorkItemBlocker | null | undefined
): Promise<void> {
  if (blockedOn !== 'dependencies') return;
  const deps = await workItemRepository.findManyByIdsForUser(dependencies, userId);
  if (!deps.some(dep => dep.status !== 'closed')) {
    throw new BadRequestError('blockedOn dependencies needs an open dependency');
  }
}

/**
 * A cloud loop run (its `loop_ticket_*` tools) never changes a ticket in a desktop stage: only the desktop
 * runner (`loopRunner.ts` claim/complete) and the owner (work-items routes) do. Moving a ticket into one is fine.
 */
export function assertCloudRunMayChange(loop: Pick<ILoop, 'stageConfig'>, ticket: Pick<IWorkItem, 'stage'>): void {
  if (ticket.stage && desktopStagesOf(loop).includes(ticket.stage)) {
    throw new BadRequestError(
      `this ticket is in the "${ticket.stage}" stage, which the owner's desktop app works; do not work, edit or move it`
    );
  }
}

/** A completed run moves its ticket one stage on; reaching the last stage closes it. */
export function advancePatch(loop: Pick<ILoop, 'stages'>, ticket: Pick<IWorkItem, 'stage'>): WorkItemPatch {
  const index = Math.max(loop.stages.indexOf(ticket.stage ?? ''), 0);
  const next = loop.stages[index + 1] ?? lastStageOf(loop);
  const closes = next === lastStageOf(loop);
  return {
    stage: next,
    status: closes ? 'closed' : 'open',
    ...(closes && { closedAt: new Date() }),
    statusReason: null,
  };
}

/**
 * The caller's loop for a ticket write or a `loopId` filter. Same 404 as the loops routes when
 * `EnableLoops` is off, for another user's loop, and for any API-key caller: the loops API is
 * session-only, and an API key must not reach around the stage rule through the work-items routes.
 */
export async function assertLoopTicketAccess(
  req: { user?: { id: string }; apiKeyInfo?: unknown },
  loopId: unknown
): Promise<ILoop> {
  await assertLoopsEnabled();
  if (req.apiKeyInfo || typeof loopId !== 'string') throw new NotFoundError('Loop not found');
  const loop = await loopRepository.findByIdAndUserId(loopId, req.user!.id);
  if (!loop) throw new NotFoundError('Loop not found');
  return loop;
}

/**
 * Makes a live loop due now when it has a ticket ready for a cloud run or one to triage, so a new ticket does not
 * wait out the interval. Ready desktop-stage tickets never make it due: the cloud run would not work them.
 */
export async function makeDueIfReady(loop: ILoop, now = new Date()): Promise<void> {
  if (loop.status !== 'live') return;
  const ready =
    (await workItemRepository.findNextReadyForLoop(loop.userId, loop.id, loop.stages, desktopStagesOf(loop))) ??
    (await workItemRepository.listUntriagedForLoop(loop.userId, loop.id, 1))[0];
  if (ready) await loopRepository.makeDueNow(loop.id, now);
}

/** A blocked ticket's reason when its run paused at the confidence gate; the full reason is in the loop log. */
export const UNSURE_PREFIX = 'Unsure';
export const unsureReason = (gateReason?: string): string =>
  (gateReason ? `${UNSURE_PREFIX}: ${gateReason}` : UNSURE_PREFIX).slice(0, 1000);

/** An unsure/auto-resumed event as the events API returns it (no `userId`). */
export const unsureRow = (event: ILoopEvent) => ({
  id: event.id,
  kind: event.kind,
  source: event.source,
  executionId: event.executionId,
  workItemId: event.workItemId,
  ticketTitle: event.ticketTitle,
  iteration: event.iteration,
  confidence: event.confidence,
  reason: event.reason,
  resolution: event.resolution,
  createdAt: event.createdAt,
});

/**
 * The `unsure` loop event for a gate. Written by the loop scheduler (on detach) and by `gate_response`
 * (on resolve); both upsert on `executionId` + `requestedAt`, so whichever lands first creates it.
 */
export const unsureEventFields = (
  run: { loopId: string; userId: string; executionId: string },
  gate: IPendingGate,
  ticket: Pick<IWorkItem, 'id' | 'title'> | null
): LoopUnsureFields => ({
  ...run,
  iteration: gate.iteration,
  confidence: gate.confidence,
  reason: gate.reason,
  requestedAt: gate.requestedAt,
  ...(ticket && { workItemId: ticket.id, ticketTitle: ticket.title }),
});
