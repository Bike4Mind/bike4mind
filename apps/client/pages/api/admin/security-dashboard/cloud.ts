import type { Request, Response } from 'express';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { securityDashboardSnapshotRepository } from '@bike4mind/database';
import { getCooldownStatus } from '@bike4mind/server-utils/security/cooldown';
import { resolveStage } from '@bike4mind/server-utils/security/resolveStage';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { Logger } from '@bike4mind/observability';
import { ApiKeyScope } from '@bike4mind/common';

const logger = new Logger({ metadata: { service: 'cloud-scan-api' } });
const lambdaClient = new LambdaClient({});

const handler = adminApi<Request, Response>({
  adminPermissions: { GET: 'support:read', POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(async (req: Request, res: Response) => {
    const stage = resolveStage();
    const snapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'cloud');

    if (!snapshot) {
      throw new NotFoundError('No cloud security snapshot found for this stage.');
    }

    return res.status(200).json(snapshot);
  })
  .post(async (req: Request, res: Response) => {
    const stage = resolveStage();

    const latest = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'cloud');
    const { canRun, hoursRemaining } = getCooldownStatus(latest?.checkedAt);
    if (!canRun) {
      return res.status(429).json({
        canRun: false,
        reason: 'cooldown',
        hoursRemaining,
      });
    }

    try {
      // The generated SST types learn this Linkable key on the next deploy.
      const functionName = (Resource as unknown as { lambdaFunctionNames?: Record<string, string> }).lambdaFunctionNames
        ?.cloudSecurityScan;
      if (!functionName) throw new Error('Cloud security scan function is not configured');

      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ trigger: 'manual' })),
        })
      );

      await recordAdminActionFromRequest(req, {
        action: 'settings.security_scan.triggered',
        target: { kind: 'system', id: 'security-scan:cloud', displayName: 'cloud security scan' },
        summary: 'triggered a manual cloud scan',
        details: { scanType: 'cloud', stage },
      });

      return res.status(202).json({ canRun: true, queued: true });
    } catch (error) {
      logger.error('Error running cloud security scan from API', {
        message: error instanceof Error ? error.message : 'Unknown error',
      });

      return res.status(500).json({
        canRun: false,
        error: 'Failed to run cloud security scan',
      });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
