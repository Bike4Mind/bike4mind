/**
 * Hand-offs between loops: the one way a ticket moves from one of the owner's loops to another
 * (`handoffTicket`), and the stage triggers that file a linked copy into a listening loop when a ticket
 * reaches a stage (`fireStageTriggers`). Store-level, over the repositories, so the client routes, the
 * `loop_ticket_*` tools (apps/workers/src/queueHandlers/agentExecutor.loopTicketTools.ts), the scheduler's
 * folds and the desktop runner share one contract. Stage rule: ./loopTickets.
 */
import type { ILoop, IWorkItem, IWorkItemHandoff, WorkItemPatch } from '@bike4mind/common';
import { loopEventRepository, loopRepository, workItemRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import { pushLoopChanged, requestLoopDispatch } from './loopDispatch';
import {
  assertCloudRunMayChange,
  initialStageHistory,
  makeDueIfReady,
  priorityPatch,
  ticketMovePatch,
} from './loopTickets';

/** Run hand-offs of one ticket before the next one blocks it for its owner; an owner hand-off resets the count. */
export const MAX_HANDOFFS_PER_TICKET = 4;
/** A trigger copy at this depth is filed blocked, and a ticket at it fires no triggers, so a chain ends here. */
export const TRIGGER_DEPTH_MAX = 3;
export const HANDOFF_NOTE_MAX = 1000;
const HISTORY_MAX = 20;
const DESCRIPTION_MAX = 10_000;

export const CROSS_OWNER_HANDOFF = 'Loops can only hand off to your own loops for now';

/** The refusal for a run's cross-loop write to a loop outside its loop's `handoffTargets`. */
export function assertHandoffAllowed(from: Pick<ILoop, 'handoffTargets'>, toLoopId: string): void {
  const targets = from.handoffTargets ?? [];
  if (!targets.includes(toLoopId)) {
    throw new BadRequestError(
      `this loop may only hand tickets to the loops in its hand-off list (handoffTargets: ${
        targets.length ? targets.join(', ') : 'none'
      }); the owner sets that list, so do not retry with this loop`
    );
  }
}

export const handoffNote = (note: unknown): string | undefined =>
  typeof note === 'string' && note.trim() ? note.trim().slice(0, HANDOFF_NOTE_MAX) : undefined;

const ownLoop = async (id: string, userId: string): Promise<ILoop> => {
  const loop = await loopRepository.findByIdAndUserId(id, userId);
  // Names the id: a run that passed a loop's name read the bare ownership message as "that loop is not yours".
  if (!loop) {
    throw new NotFoundError(
      `${CROSS_OWNER_HANDOFF}: none of your loops has the id ${JSON.stringify(id.slice(0, 64))} (pass a loop id, not its name)`
    );
  }
  return loop;
};

export interface HandoffResult {
  ticket: IWorkItem;
  /** Set when the run hand-off cap blocked the ticket in place instead of moving it. */
  capped?: string;
}

/**
 * Moves an open ticket of `fromLoopId` to `toLoopId`, into `stage` (default the target's first stage): same id,
 * priority, dependencies and links; run count, run and any hold reset. A run (`by: 'run'`) may only hand off to
 * its loop's `handoffTargets` (re-read here, so an owner edit applies mid-run), never a ticket another run is
 * working or one blocked for the owner, and at most MAX_HANDOFFS_PER_TICKET times before the ticket is blocked for the owner instead. The write is conditional
 * on the status, loop and run read, so a concurrent claim or fold makes it a 409, not a lost update.
 */
export async function handoffTicket({
  userId,
  ticketId,
  fromLoopId,
  toLoopId,
  stage,
  by,
  executionId,
  note,
  logger = new Logger(),
}: {
  userId: string;
  ticketId: string;
  fromLoopId: string;
  toLoopId: string;
  stage?: unknown;
  by: 'run' | 'owner';
  executionId?: string;
  note?: unknown;
  logger?: Logger;
}): Promise<HandoffResult> {
  const ticket = await workItemRepository.findByIdForUser(ticketId, userId);
  if (!ticket || ticket.loopId !== fromLoopId) throw new NotFoundError('ticket not found');
  const from = await ownLoop(fromLoopId, userId);
  const to = await ownLoop(toLoopId, userId);
  if (from.id === to.id) throw new BadRequestError('the ticket is already in that loop');
  if (ticket.epic) throw new BadRequestError('an epic stays in its loop; hand off its child tickets');
  if (ticket.status === 'closed') throw new BadRequestError('a closed ticket cannot be handed off');
  // A run must not clear an owner's block (an open question, a human-only step) by passing the ticket on.
  if (by === 'run' && ticket.status === 'blocked' && ticket.blockedOn !== 'dependencies') {
    throw new BadRequestError('the ticket is blocked for the owner; only the owner can hand it off');
  }
  if (by === 'run') assertCloudRunMayChange(from, ticket);
  if (ticket.status === 'in_progress' && !(by === 'run' && executionId && ticket.executionId === executionId)) {
    throw new ConflictError('the ticket is being worked by a run; hand it off once that run ends');
  }
  if (by === 'run') assertHandoffAllowed(from, to.id);
  const guard = { loopId: from.id, executionId: ticket.executionId ?? null };

  const count = by === 'run' ? (ticket.handoffCount ?? 0) + 1 : 0;
  if (count > MAX_HANDOFFS_PER_TICKET) {
    const reason = `Handed off ${count - 1} times; the owner decides where it goes`;
    const blocked = await workItemRepository.updateForUser(
      ticket.id,
      userId,
      { ...ticketMovePatch(from, ticket, { status: 'blocked', reason }, by), executionId: null },
      ticket.status,
      guard
    );
    if (!blocked) throw new ConflictError('ticket changed while saving; list it again and retry');
    await pushLoopChanged(userId, from.id, logger);
    return { ticket: blocked, capped: reason };
  }

  const move = ticketMovePatch(to, undefined, { stage }, 'handoff');
  if (move.status === 'closed') throw new BadRequestError('a ticket cannot be handed off into the last stage');
  const at = new Date();
  const text = handoffNote(note);
  const entry: IWorkItemHandoff = {
    fromLoopId: from.id,
    fromLoopName: from.name,
    toLoopId: to.id,
    toLoopName: to.name,
    stage: move.stage!,
    by,
    ...(executionId && { executionId }),
    ...(text && { note: text }),
    at,
  };
  const patch: WorkItemPatch = {
    loopId: to.id,
    ...move,
    runCount: 0,
    executionId: null,
    handoffs: [...(ticket.handoffs ?? []), entry].slice(-HISTORY_MAX),
    handoffCount: count,
  };
  let moved: IWorkItem | null;
  try {
    moved = await workItemRepository.updateForUser(ticket.id, userId, patch, ticket.status, guard);
  } catch (error) {
    // A trigger copy into a loop that already holds a copy of the same source ticket and stage.
    if (isDuplicateKey(error)) throw new BadRequestError('that loop already has a copy of this ticket');
    throw error;
  }
  if (!moved) throw new ConflictError('ticket changed while saving; list it again and retry');

  // The move is committed; what follows is best effort.
  try {
    await loopEventRepository.recordHandoff({
      userId,
      fromLoop: from,
      toLoop: to,
      workItemId: moved.id,
      ticketTitle: moved.title,
      stage: entry.stage,
      by,
      executionId,
      note: text,
      at,
    });
  } catch (error) {
    logger.warn(`[Loops] Could not log the hand-off of ticket ${moved.id}`, { error });
  }
  try {
    // A question the ticket was parked on can no longer be answered here; the answer would not reach it.
    await loopEventRepository.closeAskedForHandoff(userId, from.id, moved.id, at);
  } catch (error) {
    logger.warn(`[Loops] Could not close the open questions of handed-off ticket ${moved.id}`, { error });
  }
  await ticketsArrived(to, logger);
  await pushLoopChanged(userId, from.id, logger);
  await fireStageTriggers({ userId, ticket: moved, loop: to, logger });
  return { ticket: moved };
}

/** A ticket landed in `loop`: make it due if it has ready work, ask for a dispatch, refresh its open page. */
async function ticketsArrived(loop: ILoop, logger: Logger): Promise<void> {
  try {
    if (await makeDueIfReady(loop)) await requestLoopDispatch(loop.id, logger);
  } catch (error) {
    logger.warn(`[Loops] Could not make loop ${loop.id} due`, { error });
  }
  await pushLoopChanged(loop.userId, loop.id, logger);
}

const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

/**
 * Files a linked copy of `ticket` into every loop with a trigger on (`loop`, the ticket's stage). Call it after a
 * write that put a ticket in a stage (created it, moved it, closed it). Idempotent: the partial unique index on
 * (`origin.ticketId`, `origin.stage`, `loopId`) allows one copy, so a ticket that re-reaches the stage files
 * nothing. Best effort: a failure is logged and never fails the write that called it.
 * ponytail: in-process hook; a process dying between the ticket write and this call loses that fire. Add an outbox
 * if missed fires matter.
 */
export async function fireStageTriggers({
  userId,
  ticket,
  loop,
  logger = new Logger(),
}: {
  userId: string;
  ticket: IWorkItem;
  loop: ILoop;
  logger?: Logger;
}): Promise<void> {
  const stage = ticket.stage;
  const depth = (ticket.origin?.depth ?? 0) + 1;
  if (!stage || depth > TRIGGER_DEPTH_MAX) return;
  let listeners: ILoop[];
  try {
    listeners = await loopRepository.listTriggeredBy(userId, loop.id, stage);
  } catch (error) {
    logger.warn(`[Loops] Stage triggers failed for ticket ${ticket.id}`, { error });
    return;
  }
  // Per listener, so one failing target never costs the others their copy (a fire is not retried).
  for (const target of listeners) {
    try {
      await fileTriggerCopy({ userId, ticket, loop, target, stage, depth, logger });
    } catch (error) {
      logger.warn(`[Loops] Stage trigger into loop ${target.id} failed for ticket ${ticket.id}`, { error });
    }
  }
}

async function fileTriggerCopy({
  userId,
  ticket,
  loop,
  target,
  stage,
  depth,
  logger,
}: {
  userId: string;
  ticket: IWorkItem;
  loop: ILoop;
  target: ILoop;
  stage: string;
  depth: number;
  logger: Logger;
}): Promise<void> {
  const trigger = target.triggers?.find(entry => entry.fromLoopId === loop.id && entry.stage === stage);
  if (!trigger) return;
  const move = ticketMovePatch(
    target,
    undefined,
    {
      stage: trigger.toStage,
      ...(depth >= TRIGGER_DEPTH_MAX && {
        status: 'blocked' as const,
        reason: `Trigger chain stopped at depth ${TRIGGER_DEPTH_MAX}; check the loops' triggers`,
      }),
    },
    'handoff'
  );
  let copy: IWorkItem;
  try {
    copy = await workItemRepository.create({
      userId,
      loopId: target.id,
      title: ticket.title,
      ...(ticket.description && { description: ticket.description.slice(0, DESCRIPTION_MAX) }),
      dependencies: [],
      stage: move.stage!,
      status: move.status!,
      ...(move.statusReason && { statusReason: move.statusReason }),
      ...(ticket.priority && priorityPatch(ticket.priority, 'agent')),
      origin: { loopId: loop.id, loopName: loop.name, ticketId: ticket.id, stage, kind: 'trigger', depth },
      ...initialStageHistory(move),
    } as Omit<IWorkItem, 'id' | 'createdAt' | 'updatedAt'>);
  } catch (error) {
    if (isDuplicateKey(error)) return;
    throw error;
  }
  // The copy is filed; the links and log rows after it are best effort.
  const at = new Date();
  try {
    await workItemRepository.pushHandedTo(ticket.id, {
      loopId: target.id,
      loopName: target.name,
      ticketId: copy.id,
      at,
    });
    await loopEventRepository.recordHandoff({
      userId,
      fromLoop: loop,
      toLoop: target,
      workItemId: copy.id,
      ticketTitle: copy.title,
      stage: copy.stage!,
      by: 'owner',
      via: 'trigger',
      at,
    });
  } catch (error) {
    logger.warn(`[Loops] Could not link or log trigger copy ${copy.id}`, { error });
  }
  await ticketsArrived(target, logger);
  await pushLoopChanged(userId, loop.id, logger);
  await fireStageTriggers({ userId, ticket: copy, loop: target, logger });
}
