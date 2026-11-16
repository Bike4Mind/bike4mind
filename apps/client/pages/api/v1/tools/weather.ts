/**
 * POST /api/v1/tools/weather - the public twin of POST /api/tools/weather. Both run runWeatherTool
 * (server/tools/webToolRoutes.ts) behind the same scopes, outbound-action gate and hourly budget.
 */
import { getCurrentWeatherContract } from '@bike4mind/common';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { toolRoutesRateLimit } from '@server/middlewares/toolRoutesRateLimit';
import { runWeatherTool } from '@server/tools/webToolRoutes';

const handler = nextRouteForContract(getCurrentWeatherContract, { rateLimit: toolRoutesRateLimit() }).post(
  outboundActionGate(),
  async (req, res) => res.json(await runWeatherTool(req, req.validated))
);

export default handler;
