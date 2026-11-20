import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopMirrorRepository } from '@bike4mind/database';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';

/** The caller's Desktop-owned loops as their Desktops last reported them ([localLoopId].ts), newest first. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-mirror-list' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    res.json({ loops: await loopMirrorRepository.listForUser(req.user!.id) });
  });

export default handler;
