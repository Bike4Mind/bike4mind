import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { securityDashboardSnapshotRepository, type ISecurityDashboardFinding } from '@bike4mind/database';
import { getCooldownStatus } from '@server/security/cooldown';
import { resolveStage } from '@server/security/resolveStage';
import { handler as runCloudScan } from '@server/security/cloudScan';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'cloud-scan-api' } });
const sqsClient = new SQSClient({});

const handler = baseApi<Request, Response>()
  .get(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const stage = resolveStage();
    const snapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'cloud');

    if (!snapshot) {
      throw new NotFoundError('No cloud security snapshot found for this stage.');
    }

    return res.status(200).json(snapshot);
  })
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

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
      // Run the cloud scan inline. Reuses the scheduled CloudSecurityScan Lambda
      // implementation so admins can trigger a scan on demand without extra infrastructure.
      await runCloudScan();

      // Re-fetch latest snapshot to fan out critical/high findings to SecOps Triage.
      // runCloudScan() discards the snapshot it creates, so we must query for it.
      // Low-probability race: if the scheduled scan completes between our runCloudScan() and
      // this findLatest, we may publish its snapshot instead of ours. Duplicate triage issues
      // are harmless - the worker deduplicates by fingerprint.
      const snapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'cloud');
      if (snapshot) {
        const triageFindings = snapshot.findings.filter(
          (f: ISecurityDashboardFinding) => f.severity === 'critical' || f.severity === 'high'
        );
        if (triageFindings.length > 0) {
          try {
            await sqsClient.send(
              new SendMessageCommand({
                QueueUrl: getSourceQueueUrl('secopsTriageQueue'),
                MessageBody: JSON.stringify({
                  stage,
                  scanSource: 'cloud' as const,
                  snapshotId: snapshot.id,
                  targetUrl: 'aws:cloud-infrastructure',
                  findings: triageFindings.map((f: ISecurityDashboardFinding) => ({
                    id: f.id,
                    title: f.title,
                    severity: f.severity,
                    description: f.description,
                    recommendation: f.recommendation,
                    documentationUrl: f.documentationUrl,
                    instances: [],
                  })),
                }),
              })
            );
            logger.info('SecOps Triage: published Cloud findings to SQS', {
              stage,
              findingCount: triageFindings.length,
            });
          } catch (err) {
            logger.error('SecOps Triage: failed to publish Cloud findings to SQS (non-fatal)', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Align response shape with other scan endpoints (web, code, packages, secrets),
      // which all return { canRun: true, queued: true } on success.
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
