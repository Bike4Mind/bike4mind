import { TURNSTILE_ACTION_OAUTH_START, TURNSTILE_ACTION_OTC_SEND } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

// Must stay in sync with TurnstileFailureReason in apps/client/app/utils/turnstile.ts.
const turnstileClientFailureSchema = z.object({
  action: z.enum([TURNSTILE_ACTION_OTC_SEND, TURNSTILE_ACTION_OAUTH_START]),
  reason: z.enum(['script-error', 'script-timeout', 'unavailable', 'error', 'expired', 'timeout', 'render-failed']),
  // Cloudflare's client-side error codes are short numerics (e.g. 110200, 300030).
  errorCode: z
    .string()
    .regex(/^[0-9a-z]{1,16}$/i)
    .optional(),
  attempts: z.number().int().min(1).max(10),
});

export type TurnstileClientFailure = z.infer<typeof turnstileClientFailureSchema>;

/**
 * Records a Turnstile challenge the browser could not complete. Those failures stop sign-in before
 * any gated request is sent, so without this the server never sees them (requireTurnstile only
 * logs tokens it rejects). Unauthenticated because it runs on the sign-in page; it only writes a log line.
 */
const handler = baseApi({ auth: false })
  .use(rateLimit({ limit: 20, windowMs: 15 * 60 * 1000 }))
  .post(async (req, res) => {
    const parsed = turnstileClientFailureSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid request body');
    }

    req.logger.warn('turnstile-client-failure', { ...parsed.data, ip: getClientIp(req) });
    return res.status(204).send();
  });

export default handler;
