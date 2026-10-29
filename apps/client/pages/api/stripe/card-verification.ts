import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { Config } from '@bike4mind/server-utils/utils/config';
import { readNetworkMeta } from '@server/auth/networkMeta';
import { beginCardVerification } from '@server/billing/cardVerificationLifecycle';
import {
  cardNetworkDigest,
  cardVerificationRuntime,
  finishCardVerification,
  verificationFailure,
  verificationIdSchema,
  verificationOffer,
} from '@server/billing/cardVerificationRuntime';

const start = z.object({
  saveCard: z.boolean().default(false),
  turnstileToken: z.string().min(1).max(2048),
  entry: z.enum(['exhaustion', 'billing']).default('billing'),
});

const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 30, windowMs: 60000 }))
  .get(async (req, res) => res.json(await verificationOffer(req.user.id)))
  .post(async (req, res) => {
    try {
      if (req.body?.verificationId) {
        const id = verificationIdSchema.parse(req.body.verificationId);
        const outcome = await finishCardVerification(id, req.user.id);
        return res.json({ outcome });
      }
      const body = start.parse(req.body);
      const network = readNetworkMeta(req);
      const result = await beginCardVerification(
        {
          userId: req.user.id,
          turnstileToken: body.turnstileToken,
          ip: network.ip ?? '',
          asn: network.asn?.toString() ?? '',
          ipDigest: cardNetworkDigest(network.ip ?? ''),
          entry: body.entry,
        },
        body.saveCard,
        await cardVerificationRuntime()
      );
      return res.json({ ...result, publishableKey: Config.STRIPE_PUBLISHABLE_KEY });
    } catch (error) {
      const failure = verificationFailure(error);
      return res.status(failure.status).json({ error: failure.error });
    }
  })
  .delete(async (req, res) => {
    try {
      await finishCardVerification(verificationIdSchema.parse(req.body?.verificationId), req.user.id, true);
      return res.json({ removed: true });
    } catch (error) {
      const failure = verificationFailure(error);
      return res.status(failure.status).json({ error: failure.error });
    }
  });

export const config = { api: { externalResolver: true } };
export default handler;
