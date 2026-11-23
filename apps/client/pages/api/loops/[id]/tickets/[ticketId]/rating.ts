import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopRepository, workItemRepository } from '@bike4mind/database';
import { BadRequestError, ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { pushLoopChanged } from '@server/utils/loopDispatch';

const NOTE_MAX = 500;

const Body = z.object({ value: z.enum(['up', 'down']).nullable(), note: z.string().optional() });

/** The owner's thumbs up or down (and optional note) on a closed loop ticket; `value: null` clears it. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-ticket-rating' }))
  .put(async (req, res) => {
    await assertLoopsEnabled();
    const userId = req.user!.id;
    const loopId = String(req.query.id);
    const ticketId = String(req.query.ticketId);
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
    const note = parsed.data.note?.trim();
    if (note && note.length > NOTE_MAX) throw new BadRequestError(`note must be at most ${NOTE_MAX} characters`);

    const loop = await loopRepository.findByIdAndUserId(loopId, userId);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + loopId);
    const ticket = await workItemRepository.findByIdForUser(ticketId, userId);
    if (!ticket || ticket.loopId !== loop.id) throw new NotFoundError('Ticket not found for id: ' + ticketId);
    if (ticket.status !== 'closed') throw new BadRequestError('Only a closed ticket can be rated');

    const rating = parsed.data.value && { value: parsed.data.value, ...(note && { note }), at: new Date() };
    const updated = await workItemRepository.setOwnerRating(ticket.id, userId, loop.id, rating);
    if (!updated) throw new ConflictError('Ticket changed while saving; reload and try again');
    await pushLoopChanged(userId, loop.id, req.logger);
    res.json({ id: updated.id, ownerRating: updated.ownerRating ?? null });
  });

export default handler;
