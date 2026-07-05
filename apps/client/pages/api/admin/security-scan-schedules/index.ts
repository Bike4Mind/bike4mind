/**
 * API Endpoint: GET /api/admin/security-scan-schedules
 *
 * Returns all security scan schedules in a single request.
 * Replaces 5 individual API calls with one batch request (N+1 fix).
 *
 * Response format:
 * {
 *   web: { enabled: boolean, nextRunAt: string, ... },
 *   code: { enabled: boolean, nextRunAt: string, ... },
 *   packages: { enabled: boolean, nextRunAt: string, ... },
 *   secrets: { enabled: boolean, nextRunAt: string, ... },
 *   cloud: { enabled: boolean, nextRunAt: string, ... }
 * }
 */

import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { securityScanScheduleRepository } from '@bike4mind/database';
import { resolveStage } from '@server/security/resolveStage';

const handler = baseApi().get(async (req: Request, res: Response) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const stage = resolveStage();

  const [web, code, packages, secrets, cloud] = await Promise.all([
    securityScanScheduleRepository.findByStageAndScanType(stage, 'web'),
    securityScanScheduleRepository.findByStageAndScanType(stage, 'code'),
    securityScanScheduleRepository.findByStageAndScanType(stage, 'packages'),
    securityScanScheduleRepository.findByStageAndScanType(stage, 'secrets'),
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
    code: code
      ? {
          enabled: code.enabled,
          nextRunAt: code.nextRunAt?.toISOString() ?? null,
          lastRunAt: code.lastRunAt?.toISOString() ?? null,
          dayOfWeek: code.dayOfWeek,
          timeOfDay: code.timeOfDay,
        }
      : null,
    packages: packages
      ? {
          enabled: packages.enabled,
          nextRunAt: packages.nextRunAt?.toISOString() ?? null,
          lastRunAt: packages.lastRunAt?.toISOString() ?? null,
          dayOfWeek: packages.dayOfWeek,
          timeOfDay: packages.timeOfDay,
        }
      : null,
    secrets: secrets
      ? {
          enabled: secrets.enabled,
          nextRunAt: secrets.nextRunAt?.toISOString() ?? null,
          lastRunAt: secrets.lastRunAt?.toISOString() ?? null,
          dayOfWeek: secrets.dayOfWeek,
          timeOfDay: secrets.timeOfDay,
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
