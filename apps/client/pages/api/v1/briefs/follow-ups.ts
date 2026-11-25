/**
 * POST /api/v1/briefs/follow-ups - compose follow-ups from a dictated memo (asynchronous; 202 with the brief
 * `composing`). JWT only. Nothing is sent or scheduled here: every proposed follow-up waits for approval.
 */
import { composeFollowUpBriefContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { startFollowUpComposition } from '@bike4mind/server-utils/briefs/startBriefComposition';
import { serializeBrief } from '@server/briefs/serializeBrief';

const composeFollowUpRoute = nextRouteForContract(composeFollowUpBriefContract, {
  rateLimit: perUserRateLimit('POST /api/v1/briefs/follow-ups'),
}).post(async (req, res) => {
  const brief = await startFollowUpComposition(req.user.id, req.validated);
  return res.status(202).json(await serializeBrief(brief));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ POST: composeFollowUpRoute });
