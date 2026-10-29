import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopRepository } from '@bike4mind/database';
import { ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';

/**
 * Run now: makes the loop due, so the next scheduler tick (at most 5 minutes away) runs it.
 * It does not dispatch inline - the scheduler's claim is what keeps runs from overlapping.
 */
const handler = baseApi()
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-run' }))
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const loop = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);
    if (loop.status !== 'live') throw new ConflictError('Only a live loop can be run; set it live first');

    res.json(await loopRepository.updateForUser(id, req.user!.id, { nextRunAt: new Date() }));
  });

export default handler;
