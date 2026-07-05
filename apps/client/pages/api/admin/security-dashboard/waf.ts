import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { securityDashboardSnapshotRepository } from '@bike4mind/database';
import { getCooldownStatus } from '@server/security/cooldown';
import { resolveStage } from '@server/security/resolveStage';
import { handler as runWafScan } from '@server/security/wafScan';

const handler = baseApi<Request, Response>()
  .get(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const stage = resolveStage();
    const snapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'waf');

    if (!snapshot) {
      throw new NotFoundError('No WAF security snapshot found for this stage.');
    }

    return res.status(200).json(snapshot);
  })
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const stage = resolveStage();

    const latest = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'waf');
    const { canRun, hoursRemaining } = getCooldownStatus(latest?.checkedAt);
    if (!canRun) {
      return res.status(429).json({
        canRun: false,
        reason: 'cooldown',
        hoursRemaining,
      });
    }

    try {
      // Run the WAF scan inline (synchronous). Reuses the scheduled WafSecurityScan Cron
      // implementation so admins can trigger a scan on demand without extra infrastructure.
      await runWafScan();

      // Return 200 (not 202) since the scan completed synchronously, not queued.
      return res.status(200).json({ canRun: true, completed: true });
    } catch (error) {
      console.error('Error running WAF security scan from API', {
        message: error instanceof Error ? error.message : 'Unknown error',
      });

      return res.status(500).json({
        canRun: false,
        error: 'Failed to run WAF security scan',
      });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
