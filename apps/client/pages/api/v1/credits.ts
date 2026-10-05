/**
 * GET /api/v1/credits - the caller's spendable credit balance.
 *
 * The subject is strictly `req.user`: this handler reads no id from the query,
 * body, or path, so a credential can only ever see its own owner's balance.
 */

import { getCreditBalanceContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';

const handler = nextRouteForContract(getCreditBalanceContract, {
  // A pre-flight check before every batch should not burn the daily budget the
  // batch itself needs - same exemption as GET /api/v1/me.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  // User-specific payload behind CloudFront - never cacheable, anywhere.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ balance: req.user.currentCredits });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
