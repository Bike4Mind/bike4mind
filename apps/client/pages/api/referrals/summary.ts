import { getInviterSummary } from '@server/referrals/inviterSummary';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const summary = await getInviterSummary(req.user.id);
    return res.status(200).json(summary);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
