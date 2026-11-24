import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getOrCreateReferralCode, referralLinkUrl, type ReferralLinkResponse } from '@server/referrals/shareLink';

/** GET /api/referrals/link - the signed-in user's share link, minted on first request. */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const user = req.user;
    // Same bar the email-invite flow sets before minting a credit-bearing code (reg-invites/refer.ts).
    if (!user.emailVerified && (user.authProviders?.length ?? 0) === 0) {
      throw new BadRequestError('Please verify your email address to get a share link');
    }
    const code = await getOrCreateReferralCode(user.id);
    const body: ReferralLinkResponse = { code, url: referralLinkUrl(code) };
    return res.status(200).json(body);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
