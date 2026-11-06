import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopEventRepository, loopRepository, workItemRepository } from '@bike4mind/database';
import { LOOP_DIRECTIVE_NOTE_MAX, type LoopGateOutcome } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { makeDueIfReady, unsureReason, unsureRow } from '@server/utils/loopTickets';
import { requestLoopDispatch } from '@server/utils/loopDispatch';

/**
 * The owner's answer to a question a loop run asked with `loop_ticket_unsure`. `resumed` (with the answer as
 * `note`) reopens the ticket, and its next run is shown the answer; `rejected` leaves it blocked. Gate-sourced
 * unsure events are resolved through the paused run's gate card instead.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-events-resolve' }))
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const userId = req.user!.id;
    const id = String(req.query.id);
    const eventId = String(req.query.eventId);
    const body = (req.body ?? {}) as { outcome?: unknown; note?: unknown };

    const outcome = body.outcome as LoopGateOutcome;
    if (outcome !== 'resumed' && outcome !== 'rejected') {
      throw new BadRequestError('outcome must be one of: resumed, rejected');
    }
    if (body.note !== undefined && typeof body.note !== 'string') throw new BadRequestError('note must be a string');
    const note = body.note?.trim();
    if (note && note.length > LOOP_DIRECTIVE_NOTE_MAX)
      throw new BadRequestError(`note must be ${LOOP_DIRECTIVE_NOTE_MAX} characters or fewer`);
    if (outcome === 'resumed' && !note) throw new BadRequestError('An answer is required to resume');

    const loop = await loopRepository.findByIdAndUserId(id, userId);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);
    const event = await loopEventRepository.findById(eventId);
    if (!event || event.userId !== userId || event.loopId !== loop.id) {
      throw new NotFoundError('Event not found for id: ' + eventId);
    }
    if (event.kind !== 'unsure' || event.source !== 'asked' || event.resolution) {
      throw new ConflictError('Only an unanswered question can be resolved here');
    }

    const now = new Date();
    const resolved = await loopEventRepository.resolveAsked(event.id, userId, loop.id, {
      outcome,
      by: userId,
      at: now,
      ...(note && { note }),
    });
    if (!resolved) throw new ConflictError('Event changed while saving; reload and try again');

    if (resolved.workItemId) {
      // Only while the ticket is still parked on this question in this loop: one the owner moved by hand, or a
      // later run blocked for another reason, is left alone.
      const guard = { statusReason: unsureReason(resolved.reason), loopId: loop.id };
      let reopened = false;
      let ticketSkipped = false;
      try {
        const patch =
          outcome === 'resumed'
            ? { status: 'open' as const, statusReason: null }
            : { statusReason: `Rejected by owner${note ? `: ${note}` : ''}`.slice(0, 1000) };
        const updated = await workItemRepository.updateForUser(resolved.workItemId, userId, patch, 'blocked', guard);
        ticketSkipped = !updated;
        reopened = !!updated && outcome === 'resumed';
      } catch (error) {
        // The ticket is still parked on the question, so reopen it for the owner to answer again.
        await loopEventRepository.reopenAsked(resolved.id, now).catch(() => undefined);
        throw error;
      }
      if (reopened && (await makeDueIfReady(loop, now))) await requestLoopDispatch(loop.id, req.logger);
      // `ticketSkipped` tells the owner the answer was saved but the ticket was left as it is.
      if (ticketSkipped) return res.json({ ...unsureRow(resolved), ticketSkipped });
    }

    res.json(unsureRow(resolved));
  });

export default handler;
