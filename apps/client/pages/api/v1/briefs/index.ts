/**
 * POST /api/v1/briefs - ask the assistant to compose a brief (asynchronous; 202 with the brief `composing`).
 * GET  /api/v1/briefs  - the caller's recent activity briefs; a memo brief is read by id.
 * JWT only; every read is scoped to `req.user`.
 */
import { composeBriefContract, listBriefsContract } from '@bike4mind/common';
import { assistantBriefRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { startBriefComposition } from '@bike4mind/server-utils/briefs/startBriefComposition';
import { serializeBrief, serializeBriefs } from '@server/briefs/serializeBrief';

const LIST_LIMIT = 20;

const composeRoute = nextRouteForContract(composeBriefContract, {
  rateLimit: perUserRateLimit('POST /api/v1/briefs'),
}).post(async (req, res) => {
  const brief = await startBriefComposition(req.user.id);
  return res.status(202).json(await serializeBrief(brief));
});

const listRoute = nextRouteForContract(listBriefsContract, {
  rateLimit: perUserRateLimit('GET /api/v1/briefs'),
  recordsActivity: false,
}).get(async (req, res) => {
  const briefs = await assistantBriefRepository.listByUser(req.user.id, LIST_LIMIT);
  return res.json({ briefs: await serializeBriefs(briefs) });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ POST: composeRoute, GET: listRoute });
