import { Request, Response } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import mongoose from 'mongoose';

export interface TestDatabaseResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
}

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000, // 5 attempts per minute
    })
  )
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const startTime = Date.now();

      // Run a ping command to test database connectivity
      if (mongoose.connection.readyState !== 1) {
        return res.json({
          success: false,
          error: 'Database not connected',
          timestamp: new Date().toISOString(),
        });
      }

      await mongoose.connection.db?.admin().ping();
      const latencyMs = Date.now() - startTime;

      await recordAdminActionFromRequest(req, {
        action: 'system_health.test_run',
        target: { kind: 'system', id: 'system-health', displayName: 'System health' },
        summary: 'tested the database connection',
        details: { testType: 'database', latencyMs },
      });

      return res.json({
        success: true,
        latencyMs,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error testing database connection:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test database connection',
        timestamp: new Date().toISOString(),
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
