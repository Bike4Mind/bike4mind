import type { Request, Response } from 'express';
import { adminApi } from '@server/middlewares/adminApi';
import { resolveStage } from '@bike4mind/server-utils/security/resolveStage';
import { getWafTrafficOverview, resolveDefaultPeriod, type WafTrafficPeriod } from '@server/security/wafTraffic';
import { parseRangeParam } from '@server/security/wafApiHelpers';
import { ApiKeyScope } from '@bike4mind/common';

function isWafTrafficPeriod(value: unknown): value is WafTrafficPeriod {
  return value === '1m' || value === '5m' || value === '1h';
}

const handler = adminApi<Request, Response>({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req: Request, res: Response) => {
  const stage = resolveStage();

  const { range, error } = parseRangeParam(req);
  if (!range) {
    return res.status(400).json({ error });
  }

  const rawPeriod = req.query.period;
  if (rawPeriod !== undefined && !isWafTrafficPeriod(rawPeriod)) {
    return res.status(400).json({ error: `Invalid period. Must be one of: 1m, 5m, 1h` });
  }
  const period: WafTrafficPeriod = isWafTrafficPeriod(rawPeriod) ? rawPeriod : resolveDefaultPeriod(range);
  const includeRules = req.query.includeRules === 'true';
  // Debug mode is gated to non-production to prevent leaking internal metadata.
  const debug = stage !== 'production' && req.query.debug === 'true';

  const overview = await getWafTrafficOverview({ stage, range, period, includeRules, debug });
  return res.status(200).json(overview);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
