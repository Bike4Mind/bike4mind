import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { baseApi } from '@server/middlewares/baseApi';
import { ApiKeyScope, WeatherToolRequestSchema } from '@bike4mind/common';
import { toolRoutesRateLimit } from '@server/middlewares/toolRoutesRateLimit';
import { runWeatherTool } from '@server/tools/webToolRoutes';

// The SPA-internal door (voice modal, desktop app). Its public twin is POST /api/v1/tools/weather; both
// share runWeatherTool, this scope gate and one hourly budget (see toolRoutesRateLimit). Embed (confined) keys
// hold neither scope, so they are refused.
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE] })
  .use(toolRoutesRateLimit())
  .post(outboundActionGate(), async (req, res) =>
    res.json(await runWeatherTool(req, WeatherToolRequestSchema.parse(req.body)))
  );

export default handler;
