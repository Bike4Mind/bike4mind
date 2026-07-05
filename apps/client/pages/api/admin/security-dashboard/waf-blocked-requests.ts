import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { resolveStage } from '@server/security/resolveStage';
import { getWafBlockedRequests } from '@server/security/wafLogsInsights';
import { parseRangeParam } from '@server/security/wafApiHelpers';

const handler = baseApi<Request, Response>().get(async (req: Request, res: Response) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const stage = resolveStage();

  const { range, error } = parseRangeParam(req);
  if (!range) {
    return res.status(400).json({ error });
  }

  const result = await getWafBlockedRequests({ stage, range });
  return res.status(200).json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
