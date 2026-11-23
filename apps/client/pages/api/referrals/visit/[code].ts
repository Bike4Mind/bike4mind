import { User } from '@bike4mind/database';
import { emitProductEvent, HOST_PRODUCT_ID } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { normalizeReferralCode, setReferralCookie } from '@server/referrals/shareLink';
import { z } from 'zod';

/**
 * GET /r/<code> (rewritten here in next.config). Stores a known code in the referral cookie, then sends
 * the visitor to signup. An unknown code still redirects, so a stale link never strands anyone.
 */
const handler = baseApi({ auth: false })
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000, bucket: 'GET /r' }))
  .get(
    asyncHandler<{}, unknown, unknown, { code: string }>(async (req, res) => {
      const code = normalizeReferralCode(req.query.code);
      const known = code ? Boolean(await User.exists({ referralCode: code })) : false;
      if (code && known) setReferralCookie(res, code);

      // A visit happens again on the next click, so a lost emit is not worth delaying the redirect for.
      void emitProductEvent({
        productId: HOST_PRODUCT_ID,
        event: 'referral_link_visit',
        metadata: { known },
        metadataFields: { known: z.boolean() },
      }).catch(() => undefined);

      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, '/register');
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
