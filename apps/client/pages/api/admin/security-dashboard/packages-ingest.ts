import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { securityDashboardSnapshotRepository, type ISecurityDashboardSnapshotDocument } from '@bike4mind/database';
import { Resource } from 'sst';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import {
  computeDeterministicStatus,
  computePackagesScoreFromFindings,
} from '@server/security/securityDashboardScoring';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'packages-ingest' } });
const sqsClient = new SQSClient({});

interface PackagesCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface PackagesAlertInput {
  id: string;
  packageName: string;
  currentVersion: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  vulnerableRange?: string;
  recommendedVersion?: string;
  documentationUrl?: string;
}

interface PackagesIngestBody {
  stage?: string;
  tool?: 'pnpm-audit' | 'npm-audit' | 'dependabot';
  targetUrl?: string;
  counts: PackagesCounts;
  alerts: PackagesAlertInput[];
  totalPackages?: number;
  startedAt?: string;
  finishedAt?: string;
}

const handler = baseApi<Request, Response>({ auth: false }).post(async (req: Request, res: Response) => {
  const ingestToken = Resource.SECOPS_PACKAGES_INGEST_TOKEN?.value || process.env.SECOPS_PACKAGES_INGEST_TOKEN;

  if (!ingestToken) {
    return res.status(500).json({ error: 'Security packages ingest token is not configured.' });
  }

  const providedTokenHeader = req.headers['x-security-ingest-token'];
  const providedToken = Array.isArray(providedTokenHeader) ? providedTokenHeader[0] : providedTokenHeader;
  if (!providedToken || !safeCompareTokens(String(providedToken), ingestToken)) {
    return res.status(403).json({ error: 'Invalid ingest token.' });
  }

  const body = req.body as Partial<PackagesIngestBody> | undefined;
  const { targetUrl, counts, alerts, stage: rawStage, startedAt, finishedAt } = body || {};

  if (!counts || typeof counts !== 'object' || !Array.isArray(alerts)) {
    return res.status(400).json({ error: 'Invalid payload: counts and alerts are required.' });
  }

  const rawStageValue =
    rawStage || process.env.SST_STAGE || process.env.NODE_ENV || process.env.SEED_STAGE_NAME || 'unknown';

  // Basic allowlist validation for stage names to prevent unsafe values reaching the database.
  // Accepts alphanumeric characters and dashes only (e.g. dev, pr6015, staging, prod-west).
  const stagePattern = /^[a-z0-9-]+$/i;
  if (!stagePattern.test(rawStageValue)) {
    return res.status(400).json({ error: 'Invalid stage value.' });
  }

  const stage = rawStageValue;

  const findings: ISecurityDashboardSnapshotDocument['findings'] = (alerts || []).map(alert => {
    const { id, packageName, currentVersion, severity, vulnerableRange, recommendedVersion, documentationUrl } = alert;

    const descriptionParts: string[] = [
      `${packageName}@${currentVersion}`,
      vulnerableRange ? `vulnerable range: ${vulnerableRange}` : undefined,
    ].filter(Boolean) as string[];

    const recommendation = recommendedVersion
      ? `Upgrade ${packageName} to ${recommendedVersion}.`
      : 'Review the advisory and upgrade to a safe version.';

    return {
      id,
      title: `${packageName} dependency vulnerability`,
      severity,
      description: descriptionParts.join(' – '),
      recommendation,
      documentationUrl,
      // Optional metadata to power richer UI without changing the core schema.
      metadata: {
        packageName,
        currentVersion,
        vulnerableRange,
        recommendedVersion,
      },
    } as unknown as ISecurityDashboardSnapshotDocument['findings'][number];
  });

  const { score, counts: dedupedCounts } = computePackagesScoreFromFindings(
    findings as unknown as Array<{ severity?: string; metadata?: Record<string, unknown>; id?: string }>
  );
  const status = computeDeterministicStatus(dedupedCounts, score);
  const summary =
    dedupedCounts.critical === 0 && dedupedCounts.high === 0 && dedupedCounts.medium === 0 && dedupedCounts.low === 0
      ? 'No vulnerable packages detected in the latest dependencies scan.'
      : `${[
          dedupedCounts.critical ? `${dedupedCounts.critical} critical` : null,
          dedupedCounts.high ? `${dedupedCounts.high} high` : null,
          dedupedCounts.medium ? `${dedupedCounts.medium} medium` : null,
          dedupedCounts.low ? `${dedupedCounts.low} low` : null,
        ]
          .filter(Boolean)
          .join(', ')} vulnerable packages (unique) in the latest scan.`;

  const checkedAt =
    (finishedAt && !Number.isNaN(Date.parse(finishedAt)) && new Date(finishedAt)) || new Date(startedAt || Date.now());

  const snapshot = await securityDashboardSnapshotRepository.create({
    stage,
    scanType: 'packages',
    targetUrl: targetUrl || 'repository: lumina5',
    status,
    score,
    summary,
    findings,
    checkedAt,
  } as unknown as ISecurityDashboardSnapshotDocument);

  // Fan out all severity findings to SecOps Triage queue - package CVEs are always actionable.
  // The triage Lambda reads secopsTriageConfig from AdminSettings and decides whether to act.
  if ((alerts || []).length === 0) {
    return res.status(201).json(snapshot);
  }
  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: getSourceQueueUrl('secopsTriageQueue'),
        MessageBody: JSON.stringify({
          stage,
          scanSource: 'packages' as const,
          snapshotId: snapshot.id,
          targetUrl: targetUrl || 'repository: lumina5',
          findings: (alerts || []).map(alert => ({
            id: alert.id,
            title: `${alert.packageName} dependency vulnerability`,
            severity: alert.severity,
            description: `${alert.packageName}@${alert.currentVersion}${alert.vulnerableRange ? ` – vulnerable range: ${alert.vulnerableRange}` : ''}`,
            recommendation: alert.recommendedVersion
              ? `Upgrade ${alert.packageName} to ${alert.recommendedVersion}.`
              : 'Review the advisory and upgrade to a safe version.',
            documentationUrl: alert.documentationUrl,
            instances: [],
          })),
        }),
      })
    );
    logger.info('SecOps Triage: published Packages findings to SQS', {
      stage,
      findingCount: findings.length,
    });
  } catch (err) {
    logger.error('SecOps Triage: failed to publish Packages findings to SQS (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return res.status(201).json(snapshot);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
