import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { listRunnerTickets } from '@server/utils/loopRunner';

/** The tickets the caller's desktop runner may claim (server/utils/loopRunner.ts). */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-runner-list' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    res.json(await listRunnerTickets(req.user!.id, new Date()));
  });

export default handler;
