import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopRunnerPresenceRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';

const PresenceBody = z.object({
  lanesBusy: z.number().int().min(0).max(100),
  lanesFree: z.number().int().min(0).max(100),
  waitingReason: z.string().max(200).optional(),
  /** The app is quitting: read as offline at once, not after RUNNER_PRESENCE_FRESH_MS. */
  offline: z.literal(true).optional(),
});

/** The caller's desktop runner reporting in; the loop board shows it as online or offline. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-runner-presence' }))
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const body = PresenceBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.issues[0]?.message || 'Invalid request body');
    const { waitingReason, offline, ...lanes } = body.data;
    await loopRunnerPresenceRepository.upsertForUser(req.user!.id, {
      seenAt: offline ? new Date(0) : new Date(),
      ...lanes,
      ...(waitingReason?.trim() && { waitingReason: waitingReason.trim() }),
    });
    res.json({ ok: true });
  });

export default handler;
