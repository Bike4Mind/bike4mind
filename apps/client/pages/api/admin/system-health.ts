import { Request, Response } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { getSystemHealthStatus } from '@server/admin/systemHealth/getSystemHealthStatus';

const handler = adminApi({ adminPermissions: { GET: 'settings:manage' }, requiredScopes: [ApiKeyScope.ADMIN] }).get(
  async (req: Request, res: Response) => {
    try {
      return res.json(await getSystemHealthStatus());
    } catch (error) {
      console.error('Error getting system health:', error);
      return res.status(500).json({
        error: 'Failed to get system health status',
      });
    }
  }
);

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
