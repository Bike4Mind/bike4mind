/**
 * POST /api/v1/tools/web-search - the public twin of POST /api/tools/web-search. Both run runWebSearchTool
 * (server/tools/webToolRoutes.ts) behind the same scopes, outbound-action gate and hourly budget.
 */
import { searchWebContract } from '@bike4mind/common';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { toolRoutesRateLimit } from '@server/middlewares/toolRoutesRateLimit';
import { runWebSearchTool } from '@server/tools/webToolRoutes';

const handler = nextRouteForContract(searchWebContract, { rateLimit: toolRoutesRateLimit() }).post(
  outboundActionGate(),
  async (req, res) => res.json(await runWebSearchTool(req, req.validated))
);

export default handler;
