import { z } from 'zod';
import { LOOP_STATS_WINDOWS, type LoopStatsWindow } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { readLoopStats } from '@server/utils/loopStats';

const Query = z.object({
  days: z.coerce
    .number()
    .refine((days): days is LoopStatsWindow => (LOOP_STATS_WINDOWS as readonly number[]).includes(days), {
      message: `days must be one of: ${LOOP_STATS_WINDOWS.join(', ')}`,
    })
    .default(30),
});

/** A loop's stats over the last `days` (7, 30 or 90) and the equal window before it; see ILoopStats. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-stats' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const parsed = Query.safeParse({ days: req.query.days });
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid days');
    const days = parsed.data.days as LoopStatsWindow;
    const userId = req.user!.id;
    const loop = await loopRepository.findByIdAndUserId(id, userId);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);

    res.json((await readLoopStats(loop, userId, days, new Date())).stats);
  });

export default handler;
