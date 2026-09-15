import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { securityDashboardSnapshotRepository, type ISecurityDashboardSnapshotDocument } from '@bike4mind/database';
import { Resource } from 'sst';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import { isPlaceholderValue } from '@bike4mind/common';
import { computeStatusScoreAndSummary } from '@server/security/securityDashboardScoring';
import { resolveStage } from '@server/security/resolveStage';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'cloud-prowler-ingest' } });
const sqsClient = new SQSClient({});

interface ProwlerFinding {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'FAIL' | 'PASS';
  description?: string;
  recommendation?: string;
  documentationUrl?: string;
  region?: string;
  resourceArn?: string;
}

interface ProwlerCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface ProwlerIngestBody {
  stage?: string;
  counts: ProwlerCounts;
  findings: ProwlerFinding[];
  startedAt?: string;
  finishedAt?: string;
}

const handler = baseApi<Request, Response>({ auth: false }).post(async (req: Request, res: Response) => {
  const prowlerResource = Resource as typeof Resource & {
    SECOPS_PROWLER_INGEST_TOKEN?: { value: string };
  };

  const ingestToken = prowlerResource.SECOPS_PROWLER_INGEST_TOKEN?.value || process.env.SECOPS_PROWLER_INGEST_TOKEN;

  if (!ingestToken || isPlaceholderValue(ingestToken)) {
    return res.status(500).json({ error: 'Prowler ingest token is not configured.' });
  }

  const providedTokenHeader = req.headers['x-security-ingest-token'];
  const providedToken = Array.isArray(providedTokenHeader) ? providedTokenHeader[0] : providedTokenHeader;
  if (!providedToken || !safeCompareTokens(String(providedToken), ingestToken)) {
    return res.status(403).json({ error: 'Invalid ingest token.' });
  }

  const body = req.body as Partial<ProwlerIngestBody> | undefined;
  const { counts, findings: rawFindings, stage: rawStage, startedAt, finishedAt } = body || {};

  if (!counts || typeof counts !== 'object' || !Array.isArray(rawFindings)) {
    return res.status(400).json({ error: 'Invalid payload: counts and findings are required.' });
  }

  // Prefer the stage sent in the body (script-level override for cross-stage testing).
  // Fall back to resolveStage() - same source of truth as the read endpoint, which
  // uses Resource.App.stage. The previous fallback chain hit process.env.NODE_ENV
  // (always 'production' on a built Next.js Lambda) and silently mislabeled snapshots.
  const rawStageValue = rawStage || resolveStage();

  const stagePattern = /^[a-z0-9-]+$/i;
  if (!stagePattern.test(rawStageValue)) {
    return res.status(400).json({ error: 'Invalid stage value.' });
  }

  const stage = rawStageValue;

  const MAX_FINDINGS = 2000;
  const cappedFindings = rawFindings.slice(0, MAX_FINDINGS);
  if (rawFindings.length > MAX_FINDINGS) {
    logger.warn('Prowler ingest: findings array exceeded cap, truncating', {
      received: rawFindings.length,
      cap: MAX_FINDINGS,
    });
  }

  // Filter to FAIL findings only - passed checks do not create findings
  const failedFindings = cappedFindings.filter(f => f.status === 'FAIL');

  const findings: ISecurityDashboardSnapshotDocument['findings'] = failedFindings.map(f => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    description: f.description || `Prowler check failed: ${f.title}`,
    recommendation: f.recommendation,
    documentationUrl: f.documentationUrl,
    metadata: {
      region: f.region,
      resourceArn: f.resourceArn,
    },
  }));

  const safeCounts: ProwlerCounts = {
    critical: Number(counts.critical) || 0,
    high: Number(counts.high) || 0,
    medium: Number(counts.medium) || 0,
    low: Number(counts.low) || 0,
  };

  const { status, score, summary } = computeStatusScoreAndSummary(safeCounts, 'Prowler cloud findings', {
    noneDetectedSentence: 'No Prowler cloud misconfigurations detected in the latest scan.',
  });

  const checkedAt =
    (finishedAt && !Number.isNaN(Date.parse(finishedAt)) && new Date(finishedAt)) || new Date(startedAt || Date.now());

  const snapshot = await securityDashboardSnapshotRepository.create({
    stage,
    scanType: 'cloud-prowler',
    targetUrl: 'aws:cloud-infrastructure',
    status,
    score,
    summary,
    findings,
    checkedAt,
  });

  logger.info('Prowler findings ingested', { stage, findingCount: findings.length });

  const triageFindings = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
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
            findings: triageFindings.map(f => ({
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
      logger.info('SecOps Triage: published Cloud findings to SQS', { stage, findingCount: triageFindings.length });
    } catch (err) {
      logger.error('SecOps Triage: failed to publish Cloud findings to SQS (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return res.status(201).json(snapshot);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
