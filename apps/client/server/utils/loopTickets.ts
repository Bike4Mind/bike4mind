import type { ILoop, IWorkItem, LoopUnsureFields, WorkItemPatch, WorkItemStatus } from '@bike4mind/common';
import { loopRepository, workItemRepository, type IPendingGate } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLoopsEnabled } from './loopValidation';

/**
 * The stage rule for loop tickets (WorkItems with a `loopId`), shared by the work-items routes, the
 * tickets route, the loop scheduler's fold and the loop run's `loop_ticket_*` tools:
 * a ticket sits in one of its loop's `stages`; the last stage means closed, and closed means the last stage.
 */

/** Closed tickets returned per loop by the tickets route; older ones stay in the DB. */
export const LOOP_TICKET_CLOSED_WINDOW = 50;

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

/**
 * The stage/status/closedAt/statusReason patch for moving a ticket. `current` is the ticket as stored
 * (omitted on create). Moving to the last stage closes it; closing moves it to the last stage; reopening a
 * closed ticket puts it back one stage. `in_progress` is the scheduler's alone.
 */
export function ticketMovePatch(
  loop: Pick<ILoop, 'stages'>,
  current: Pick<IWorkItem, 'stage' | 'status'> | undefined,
  move: { stage?: unknown; status?: WorkItemStatus; reason?: unknown }
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
  const keepsReason = status === 'blocked' && current?.status === 'blocked' && move.reason === undefined;

  if (status === 'closed') stage = last;
  else if (stage === last) stage = stages.at(-2)!;

  if (status === 'blocked' && !keepsReason && (typeof move.reason !== 'string' || !move.reason.trim())) {
    throw new BadRequestError('A reason is required to block a ticket');
  }

  return {
    stage,
    status,
    closedAt: status === 'closed' ? (current?.status === 'closed' ? undefined : new Date()) : null,
    statusReason: keepsReason ? undefined : status === 'blocked' ? (move.reason as string).trim().slice(0, 1000) : null,
  };
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

/** Makes a live loop due now when it has a ticket ready to work, so a new ticket does not wait out the interval. */
export async function makeDueIfReady(loop: ILoop, now = new Date()): Promise<void> {
  if (loop.status !== 'live') return;
  const ready = await workItemRepository.findNextReadyForLoop(loop.userId, loop.id, lastStageOf(loop));
  if (ready) await loopRepository.makeDueNow(loop.id, now);
}

/** A blocked ticket's reason when its run paused at the confidence gate; the full reason is in the loop log. */
export const unsureReason = (gateReason?: string): string =>
  (gateReason ? `Unsure: ${gateReason}` : 'Unsure').slice(0, 1000);

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
