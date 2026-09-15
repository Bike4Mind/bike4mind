import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { resolveStage } from '@server/security/resolveStage';
import { getWafTrafficOverview, resolveDefaultPeriod, type WafTrafficPeriod } from '@server/security/wafTraffic';
import { parseRangeParam } from '@server/security/wafApiHelpers';

function isWafTrafficPeriod(value: unknown): value is WafTrafficPeriod {
  return value === '1m' || value === '5m' || value === '1h';
}

const handler = baseApi<Request, Response>().get(async (req: Request, res: Response) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

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
