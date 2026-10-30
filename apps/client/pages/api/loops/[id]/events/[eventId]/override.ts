import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopDirectiveRepository, loopRepository } from '@bike4mind/database';
import { LOOP_DIRECTIVE_TRANSITIONS, type LoopDirectiveOwnerAction } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { directiveRow } from '../../events';

const NOTE_MAX = 1000;

/**
 * The owner's override of a directive sent or received by this loop: `withdraw` cancels it, `overrule`
 * reopens a pushed-back one so the worker sees it again as "owner insists".
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-events-override' }))
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const userId = req.user!.id;
    const id = String(req.query.id);
    const eventId = String(req.query.eventId);
    const body = (req.body ?? {}) as { action?: unknown; note?: unknown };

    const action = body.action as LoopDirectiveOwnerAction;
    if (action !== 'withdraw' && action !== 'overrule') {
      throw new BadRequestError('action must be one of: withdraw, overrule');
    }
    if (body.note !== undefined && typeof body.note !== 'string') throw new BadRequestError('note must be a string');
    const note = body.note?.trim();
    if (note && note.length > NOTE_MAX) throw new BadRequestError(`note must be ${NOTE_MAX} characters or fewer`);

    const loop = await loopRepository.findByIdAndUserId(id, userId);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);
    const directive = await loopDirectiveRepository.findByIdForUser(eventId, userId);
    if (!directive || (directive.loopId !== loop.id && directive.fromLoopId !== loop.id)) {
      throw new NotFoundError('Event not found for id: ' + eventId);
    }

    const from = LOOP_DIRECTIVE_TRANSITIONS[action];
    if (!from.includes(directive.state))
      throw new ConflictError(`Cannot ${action} a directive that is ${directive.state}`);
    const updated = await loopDirectiveRepository.transition(
      directive.id,
      userId,
      from,
      action === 'withdraw' ? 'withdrawn' : 'open',
      {
        by: 'owner',
        outcome: action === 'withdraw' ? 'withdrawn' : 'overruled',
        ...(note && { note }),
        userId,
        at: new Date(),
      }
    );
    if (!updated) throw new ConflictError('Directive changed while saving; reload and try again');
    res.json(directiveRow(updated));
  });

export default handler;
