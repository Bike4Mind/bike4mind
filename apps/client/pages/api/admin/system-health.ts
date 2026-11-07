import { Request, Response } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { getSystemHealthStatus } from '@server/admin/systemHealth/getSystemHealthStatus';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req: Request, res: Response) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  try {
    return res.json(await getSystemHealthStatus());
  } catch (error) {
    console.error('Error getting system health:', error);
    return res.status(500).json({
      error: 'Failed to get system health status',
    });
  }
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
