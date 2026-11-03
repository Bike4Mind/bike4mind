import { FirstRunEvents } from '@bike4mind/common';
import { hasAcceptedPolicy } from '@bike4mind/server-utils/auth/consentGate';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import * as z from 'zod';

const shownBodySchema = z.object({}).strict();

// The acceptance bootstrap prefix permits this route before consent. Keep the event and
// metadata server-owned so that exception never opens the generic analytics write surface.
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['POST'] })
  .use(rateLimit({ limit: 5, windowMs: 60 * 60 * 1000, bucket: '/api/user/accept-policies/shown' }))
  .post(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    shownBodySchema.parse(req.body);
    if (hasAcceptedPolicy(req.user)) return res.status(204).send();

    await logEvent(
      { type: FirstRunEvents.POLICIES_SHOWN, userId: req.user.id, metadata: { path: 'interstitial' } },
      { ability: req.ability }
    );
    return res.status(204).send();
  });

export const config = { api: { externalResolver: true } };

export default handler;
