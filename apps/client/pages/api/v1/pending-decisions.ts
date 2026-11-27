/**
 * GET /api/v1/pending-decisions - how many decisions wait on the caller (lock-screen widget, badges).
 * JWT only; counts only the caller's own notebooks and briefs.
 */
import { getPendingDecisionCountContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { countPendingDecisions } from '@server/briefs/countPendingDecisions';

const route = nextRouteForContract(getPendingDecisionCountContract, {
  rateLimit: perUserRateLimit('GET /api/v1/pending-decisions'),
  recordsActivity: false,
}).get(async (req, res) => {
  return res.json(await countPendingDecisions(req.user.id));
});

export const config = {
  api: { externalResolver: true },
};

export default route;
