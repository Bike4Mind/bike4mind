import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { securityDashboardSnapshotRepository, type ISecurityDashboardSnapshotDocument } from '@bike4mind/database';
import { Resource } from 'sst';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import { computeDeterministicStatus, computeSecretsScoreFromFindings } from '@server/security/securityDashboardScoring';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'secrets-ingest' } });
const sqsClient = new SQSClient({});

interface SecretsCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export type SecretCategory = 'apiKey' | 'password' | 'token' | 'webhook' | 'privateKey' | 'other';

interface SecretsAlertInput {
  id: string;
  secretType: SecretCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  filePath?: string;
  line?: number;
  commitId?: string;
  description?: string;
  recommendation?: string;
  documentationUrl?: string;
}

interface SecretsIngestBody {
  stage?: string;
  tool?: 'gitleaks' | 'trufflehog' | 'github-secret-scanning';
  targetUrl?: string;
  counts: SecretsCounts;
  alerts: SecretsAlertInput[];
  startedAt?: string;
  finishedAt?: string;
}

const handler = baseApi<Request, Response>({ auth: false }).post(async (req: Request, res: Response) => {
  const ingestToken = Resource.SECOPS_SECRETS_INGEST_TOKEN?.value || process.env.SECOPS_SECRETS_INGEST_TOKEN;

  if (!ingestToken) {
    return res.status(500).json({ error: 'Security secrets ingest token is not configured.' });
  }

  const providedTokenHeader = req.headers['x-security-ingest-token'];
  const providedToken = Array.isArray(providedTokenHeader) ? providedTokenHeader[0] : providedTokenHeader;
  if (!providedToken || !safeCompareTokens(String(providedToken), ingestToken)) {
    return res.status(403).json({ error: 'Invalid ingest token.' });
  }

  const body = req.body as Partial<SecretsIngestBody> | undefined;
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

  // Secret values must already be redacted by the scanning tool / ingest script;
  // we only store metadata here.
  const findings: ISecurityDashboardSnapshotDocument['findings'] = (alerts || []).map(alert => {
    const { id, secretType, severity, filePath, line, commitId, description, recommendation, documentationUrl } = alert;

    const locationParts: string[] = [];
    if (filePath) {
      locationParts.push(filePath + (typeof line === 'number' ? `:${line}` : ''));
    }
    if (commitId) {
      locationParts.push(`commit ${commitId}`);
    }

    const locationLabel = locationParts.length > 0 ? locationParts.join(', ') : undefined;

    const baseDescriptionParts: string[] = [];
    if (description) {
      baseDescriptionParts.push(description);
    }
    if (locationLabel) {
      baseDescriptionParts.push(`Location: ${locationLabel}`);
    }

    const baseDescription =
      baseDescriptionParts.length > 0
        ? `${baseDescriptionParts.join(' – ')} (secret value redacted).`
        : `Potential ${secretType} exposure detected (secret value redacted).`;

    return {
      id,
      title: `${secretType} exposure`,
      severity,
      description: baseDescription,
      recommendation,
      documentationUrl,
      metadata: {
        secretType,
        filePath,
        line,
        commitId,
      },
    } as unknown as ISecurityDashboardSnapshotDocument['findings'][number];
  });

  const { score, counts: dedupedCounts } = computeSecretsScoreFromFindings(
    findings as unknown as Array<{
      severity?: string;
      metadata?: Record<string, unknown>;
      id?: string;
      title?: string;
    }>
  );
  const status = computeDeterministicStatus(dedupedCounts, score);
  const summary =
    dedupedCounts.critical === 0 && dedupedCounts.high === 0 && dedupedCounts.medium === 0 && dedupedCounts.low === 0
      ? 'No exposed secrets detected in the latest scan.'
      : `${[
          dedupedCounts.critical ? `${dedupedCounts.critical} critical` : null,
          dedupedCounts.high ? `${dedupedCounts.high} high` : null,
          dedupedCounts.medium ? `${dedupedCounts.medium} medium` : null,
          dedupedCounts.low ? `${dedupedCounts.low} low` : null,
        ]
          .filter(Boolean)
          .join(', ')} exposed secrets (unique) detected in the latest scan (values redacted).`;

  const checkedAt =
    (finishedAt && !Number.isNaN(Date.parse(finishedAt)) && new Date(finishedAt)) || new Date(startedAt || Date.now());

  const snapshot = await securityDashboardSnapshotRepository.create({
    stage,
    scanType: 'secrets',
    targetUrl: targetUrl || 'repository: lumina5',
    status,
    score,
    summary,
    findings,
    checkedAt,
  } as unknown as ISecurityDashboardSnapshotDocument);

  // Fan out all severity findings to SecOps Triage queue - secrets are always actionable.
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
          scanSource: 'secrets' as const,
          snapshotId: snapshot.id,
          targetUrl: targetUrl || 'repository: lumina5',
          findings: (alerts || []).map(alert => ({
            id: alert.id,
            title: `${alert.secretType} exposure`,
            severity: alert.severity,
            description: alert.description
              ? `${alert.description} (secret value redacted)`
              : `Potential ${alert.secretType} exposure detected (secret value redacted).`,
            recommendation: alert.recommendation,
            documentationUrl: alert.documentationUrl,
            instances: [],
          })),
        }),
      })
    );
    logger.info('SecOps Triage: published Secrets findings to SQS', {
      stage,
      findingCount: findings.length,
    });
  } catch (err) {
    logger.error('SecOps Triage: failed to publish Secrets findings to SQS (non-fatal)', {
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
