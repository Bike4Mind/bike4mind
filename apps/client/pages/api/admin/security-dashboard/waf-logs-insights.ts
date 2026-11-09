import type { Request, Response } from 'express';
import { adminApi } from '@server/middlewares/adminApi';
import { resolveStage } from '@bike4mind/server-utils/security/resolveStage';
import { getWafLogsInsightsOverview } from '@server/security/wafLogsInsights';
import { parseRangeParam, wafQueryRateLimit, isWafDebugRequest } from '@server/security/wafApiHelpers';
import { ApiKeyScope } from '@bike4mind/common';

const handler = adminApi<Request, Response>({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(wafQueryRateLimit('admin-waf-logs-insights'))
  .get(async (req: Request, res: Response) => {
    const stage = resolveStage();

    const { range, error } = parseRangeParam(req);
    if (!range) {
      return res.status(400).json({ error });
    }

    const debug = isWafDebugRequest(req, stage);

    const overview = await getWafLogsInsightsOverview({ stage, range, debug });
    return res.status(200).json(overview);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
