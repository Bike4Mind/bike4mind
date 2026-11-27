import { getRequestActiveSubscriptions } from '@bike4mind/server-utils/entitlements/activeSubscriptions';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveSeatPlan } from '@server/subscriptions/seatPlan';

/** GET /api/subscriptions/seat-plan - the plan the caller holds through an organization seat, or null. */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const seatPlan = await resolveSeatPlan(await getRequestActiveSubscriptions(req));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ seatPlan });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
