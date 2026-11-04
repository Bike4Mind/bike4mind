import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { claimRunnerTicket, isRefusal } from '@server/utils/loopRunner';

const ClaimBody = z.object({ ticketId: z.string().min(1).max(200) });

/** Claims a ticket for a desktop run; 409 `{ error, reason }` when it is not claimable. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-runner-claim' }))
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const body = ClaimBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.issues[0]?.message || 'Invalid request body');
    const claim = await claimRunnerTicket(req.user!.id, body.data.ticketId, new Date(), req.logger);
    if (isRefusal(claim)) return res.status(claim.status).json({ error: claim.error, reason: claim.reason });
    res.json(claim);
  });

export default handler;
