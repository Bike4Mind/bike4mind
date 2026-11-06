import type { Request, Response } from 'express';
import { adminApi } from '@server/middlewares/adminApi';
import { resolveStage } from '@bike4mind/server-utils/security/resolveStage';
import { getWafBlockedRequests } from '@server/security/wafLogsInsights';
import { parseRangeParam } from '@server/security/wafApiHelpers';
import { ApiKeyScope } from '@bike4mind/common';

const handler = adminApi<Request, Response>({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req: Request, res: Response) => {
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
