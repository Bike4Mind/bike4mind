/**
 * API Endpoint: GET /api/admin/security-scan-schedules
 *
 * Returns all security scan schedules in a single request.
 * Replaces individual API calls with one batch request (N+1 fix).
 *
 * Response format:
 * {
 *   web: { enabled: boolean, nextRunAt: string, ... },
 *   cloud: { enabled: boolean, nextRunAt: string, ... }
 * }
 */

import { Request, Response } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { securityScanScheduleRepository } from '@bike4mind/database';
import { resolveStage } from '@bike4mind/server-utils/security/resolveStage';

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req: Request, res: Response) => {
  const stage = resolveStage();

  const [web, cloud] = await Promise.all([
    securityScanScheduleRepository.findByStageAndScanType(stage, 'web'),
    securityScanScheduleRepository.findByStageAndScanType(stage, 'cloud'),
  ]);

  return res.status(200).json({
    web: web
      ? {
          enabled: web.enabled,
          nextRunAt: web.nextRunAt?.toISOString() ?? null,
          lastRunAt: web.lastRunAt?.toISOString() ?? null,
          dayOfWeek: web.dayOfWeek,
          timeOfDay: web.timeOfDay,
        }
      : null,
    cloud: cloud
      ? {
          enabled: cloud.enabled,
          nextRunAt: cloud.nextRunAt?.toISOString() ?? null,
          lastRunAt: cloud.lastRunAt?.toISOString() ?? null,
          dayOfWeek: cloud.dayOfWeek,
          timeOfDay: cloud.timeOfDay,
        }
      : null,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
