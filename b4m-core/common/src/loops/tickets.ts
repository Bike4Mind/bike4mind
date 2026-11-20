import { BadRequestError } from '../errors';
import { desktopStagesOf, type ILoop, type ILoopEvent } from '../types/entities/LoopTypes';
import {
  WORK_ITEM_BLOCKERS,
  type IWorkItem,
  type WorkItemBlocker,
  type WorkItemPatch,
  type WorkItemPriority,
  type WorkItemPrioritySetter,
  type WorkItemStageBy,
  type WorkItemStatus,
} from '../types/entities/WorkItemTypes';

/**
 * The stage rule for loop tickets (WorkItems with a `loopId`), shared by the work-items routes, the
 * tickets route, the loop scheduler's fold and the loop run's `loop_ticket_*` tools:
 * a ticket sits in one of its loop's `stages`; the last stage means closed, and closed means the last stage.
 */

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
 * condition can still come true (assertBlockedOnSatisfiable). A changed stage (always, on create) carries a
 * `stageHistoryEntry` made `by` the caller.
 */
export function ticketMovePatch(
  loop: Pick<ILoop, 'stages'>,
  current: Pick<IWorkItem, 'stage' | 'status'> | undefined,
  move: { stage?: unknown; status?: WorkItemStatus; reason?: unknown; blockedOn?: unknown },
  by: WorkItemStageBy
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
    // A rating is on the work as closed; reopened work is rated again when it closes again.
    ...(current?.status === 'closed' && status !== 'closed' && { ownerRating: null }),
    ...stageEntry(current, stage, by),
  };
}

/** The history entry for a write that leaves a ticket in `stage`; none when it was already there. */
const stageEntry = (
  current: Pick<IWorkItem, 'stage'> | undefined,
  stage: string,
  by: WorkItemStageBy
): Pick<WorkItemPatch, 'stageHistoryEntry'> =>
  current?.stage === stage ? {} : { stageHistoryEntry: { stage, at: new Date(), by } };

/** A create's `stageHistory`, from the `ticketMovePatch` it was built with. */
export const initialStageHistory = ({ stageHistoryEntry }: WorkItemPatch): Pick<IWorkItem, 'stageHistory'> =>
  stageHistoryEntry ? { stageHistory: [stageHistoryEntry] } : {};

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

/**
 * A completed run moves its ticket one stage on; reaching the last stage closes it. A ticket whose stage changed
 * after `runStartedAt` (the run's own loop_ticket_update, or the owner) was already put where it belongs, so it is
 * only released there: advancing it again would skip a stage.
 */
export function advancePatch(
  loop: Pick<ILoop, 'stages'>,
  ticket: Pick<IWorkItem, 'stage' | 'stageHistory'>,
  runStartedAt?: Date
): WorkItemPatch {
  const movedAt = ticket.stageHistory?.at(-1)?.at;
  if (runStartedAt && movedAt && new Date(movedAt) > new Date(runStartedAt)) {
    return { status: 'open', statusReason: null };
  }
  const index = Math.max(loop.stages.indexOf(ticket.stage ?? ''), 0);
  const next = loop.stages[index + 1] ?? lastStageOf(loop);
  const closes = next === lastStageOf(loop);
  return {
    stage: next,
    status: closes ? 'closed' : 'open',
    ...(closes && { closedAt: new Date() }),
    statusReason: null,
    ...stageEntry(ticket, next, 'scheduler'),
  };
}

/** A blocked ticket's reason when its run paused at the confidence gate; the full reason is in the loop log. */
export const UNSURE_PREFIX = 'Unsure';

export const unsureReason = (gateReason?: string): string =>
  (gateReason ? `${UNSURE_PREFIX}: ${gateReason}` : UNSURE_PREFIX).slice(0, 1000);

/** An unsure/auto-resumed/handoff event as the events API returns it (no `userId`). */
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
  handoff: event.handoff,
  ...(event.config && { configBy: event.config.by }),
  createdAt: event.createdAt,
});

export function validateWorkItemBlocker(value: unknown): WorkItemBlocker | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !WORK_ITEM_BLOCKERS.includes(value as WorkItemBlocker)) {
    throw new BadRequestError(`blockedOn must be one of: ${WORK_ITEM_BLOCKERS.join(', ')}`);
  }
  return value as WorkItemBlocker;
}
