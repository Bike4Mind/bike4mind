import {
  desktopStagesOf,
  type ILoop,
  type IWorkItem,
  type LoopUnsureFields,
  type WorkItemBlocker,
} from '@bike4mind/common';
import { loopRepository, workItemRepository, type IPendingGate } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLoopsEnabled } from './loopValidation';

export {
  advancePatch,
  assertCloudRunMayChange,
  initialStageHistory,
  lastStageOf,
  priorityPatch,
  resolveTicketStage,
  TICKET_RUNS_PER_STAGE,
  ticketMovePatch,
  ticketRunLimit,
  UNSURE_PREFIX,
  unsureReason,
  unsureRow,
} from '@bike4mind/common/loops';

/** Closed tickets returned per loop by the tickets route; older ones stay in the DB. */
export const LOOP_TICKET_CLOSED_WINDOW = 50;

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
 * Returns whether it did, so callers only ask for a dispatch when one could start.
 */
export async function makeDueIfReady(loop: ILoop, now = new Date()): Promise<boolean> {
  if (loop.status !== 'live') return false;
  const ready =
    (await workItemRepository.findNextReadyForLoop(loop.userId, loop.id, loop.stages, desktopStagesOf(loop))) ??
    (await workItemRepository.listUntriagedForLoop(loop.userId, loop.id, 1))[0];
  return ready ? loopRepository.makeDueNow(loop.id, now) : false;
}

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
