/**
 * POST /api/v1/tools/web-fetch - the public twin of POST /api/tools/web-fetch. Both run runWebFetchTool
 * (server/tools/webToolRoutes.ts) behind the same scopes, outbound-action gate and hourly budget.
 */
import { fetchWebPageContract } from '@bike4mind/common';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { toolRoutesRateLimit } from '@server/middlewares/toolRoutesRateLimit';
import { runWebFetchTool } from '@server/tools/webToolRoutes';

const handler = nextRouteForContract(fetchWebPageContract, { rateLimit: toolRoutesRateLimit() }).post(
  outboundActionGate(),
  async (req, res) => res.json(await runWebFetchTool(req, req.validated))
);

export default handler;
