import { z } from 'zod';
import { LOOP_STATS_WINDOWS, type LoopStatsWindow } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  agentExecutionRepository,
  loopDirectiveRepository,
  loopEventRepository,
  loopRepository,
  workItemRepository,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { computeLoopStats } from '@server/utils/loopStats';

const DAY_MS = 24 * 60 * 60 * 1000;
/** ponytail: events and directives read per stats request; a busier loop's eras and directive counts are a prefix. */
const LOOP_STATS_EVENTS = 500;

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

    const now = new Date();
    const since = new Date(now.getTime() - 2 * days * DAY_MS);
    const [runs, tickets, eras, unresolved, directives] = await Promise.all([
      agentExecutionRepository.listLoopRunsSince(loop.id, since),
      workItemRepository.listForLoopStats(userId, loop.id, since),
      loopEventRepository.listForLoopSince(
        userId,
        loop.id,
        new Date(now.getTime() - days * DAY_MS),
        ['config_changed'],
        LOOP_STATS_EVENTS
      ),
      loopEventRepository.listUnresolvedUnsure(userId, loop.id, LOOP_STATS_EVENTS),
      loopDirectiveRepository.listToLoop(userId, loop.id, LOOP_STATS_EVENTS),
    ]);

    res.json(
      computeLoopStats({
        loop,
        days,
        now,
        runs: runs.runs,
        tickets: tickets.items,
        eras,
        unresolved,
        directives,
        truncated: runs.truncated || tickets.truncated,
      })
    );
  });

export default handler;
