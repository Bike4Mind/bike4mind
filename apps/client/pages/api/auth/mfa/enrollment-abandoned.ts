import { MfaEnrollmentEvents } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { recordForcedEnrollmentStep } from '@server/auth/mfaEnrollmentFunnel';
import * as z from 'zod';

const abandonedBodySchema = z.object({}).strict();

// Funnel telemetry for leaving forced MFA enrollment without enrolling (the sign-in modal's close,
// or the enforcement screen's sign-out). Reachable with a pending or enrollment-owed credential
// (the allowlists in server/auth/auth.ts), so the event, surface and source are all decided here:
// the body carries nothing, and a user who is not in forced enrollment records nothing.
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['POST'] })
  .use(rateLimit({ limit: 10, windowMs: 15 * 60 * 1000, bucket: '/api/auth/mfa/enrollment-abandoned' }))
  .post(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    abandonedBodySchema.parse(req.body ?? {});
    await recordForcedEnrollmentStep(req, req.user, MfaEnrollmentEvents.ABANDONED);
    return res.status(204).send();
  });

export const config = { api: { externalResolver: true } };

export default handler;
