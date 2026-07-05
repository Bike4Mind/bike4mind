import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import {
  securityDashboardSnapshotRepository,
  type ISecurityDashboardSnapshotDocument,
  type SecurityDashboardStatus,
} from '@bike4mind/database';
import { Resource } from 'sst';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import { computeCodeScore, computeDeterministicStatus } from '@server/security/securityDashboardScoring';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'code-semgrep-ingest' } });
const sqsClient = new SQSClient({});

interface SemgrepCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface SemgrepAlertInput {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  filePath: string;
  line?: number;
  documentationUrl?: string;
}

interface SemgrepIngestBody {
  stage?: string;
  tool?: 'semgrep';
  targetUrl?: string;
  counts: SemgrepCounts;
  alerts: SemgrepAlertInput[];
  startedAt?: string;
  finishedAt?: string;
}

function computeStatusAndScore(counts: SemgrepCounts): {
  status: SecurityDashboardStatus;
  score: number;
  summary: string;
} {
  const score = computeCodeScore(counts);
  const status = computeDeterministicStatus(counts, score);
  const summary =
    counts.critical === 0 && counts.high === 0 && counts.medium === 0 && counts.low === 0
      ? 'No Semgrep findings detected in the latest scan.'
      : `${[
          counts.critical ? `${counts.critical} critical` : null,
          counts.high ? `${counts.high} high` : null,
          counts.medium ? `${counts.medium} medium` : null,
          counts.low ? `${counts.low} low` : null,
        ]
          .filter(Boolean)
          .join(', ')} Semgrep findings in the latest scan.`;

  return { status, score, summary };
}

const handler = baseApi<Request, Response>({ auth: false }).post(async (req: Request, res: Response) => {
  const ingestToken =
    // Prefer SST Resource binding in deployed environments
    Resource.SECOPS_CODE_INGEST_TOKEN?.value || process.env.SECOPS_CODE_INGEST_TOKEN;

  if (!ingestToken) {
    return res.status(500).json({ error: 'Security code ingest token is not configured.' });
  }

  const providedTokenHeader = req.headers['x-security-ingest-token'];
  const providedToken = Array.isArray(providedTokenHeader) ? providedTokenHeader[0] : providedTokenHeader;
  if (!providedToken || !safeCompareTokens(String(providedToken), ingestToken)) {
    return res.status(403).json({ error: 'Invalid ingest token.' });
  }

  const body = req.body as Partial<SemgrepIngestBody> | undefined;
  const { targetUrl, counts, alerts, stage: rawStage, startedAt, finishedAt } = body || {};

  if (!counts || typeof counts !== 'object' || !Array.isArray(alerts)) {
    return res.status(400).json({ error: 'Invalid payload: counts and alerts are required.' });
  }

  const rawStageValue =
    rawStage || process.env.SST_STAGE || process.env.NODE_ENV || process.env.SEED_STAGE_NAME || 'unknown';

  const stagePattern = /^[a-z0-9-]+$/i;
  if (!stagePattern.test(rawStageValue)) {
    return res.status(400).json({ error: 'Invalid stage value.' });
  }

  const stage = rawStageValue;

  const safeCounts: SemgrepCounts = {
    critical: Number(counts.critical || 0),
    high: Number(counts.high || 0),
    medium: Number(counts.medium || 0),
    low: Number(counts.low || 0),
  };

  const { status, score, summary } = computeStatusAndScore(safeCounts);

  const findings: ISecurityDashboardSnapshotDocument['findings'] = (alerts || []).map(alert => ({
    id: alert.id,
    title: alert.title,
    severity: alert.severity,
    // Compact description; can enrich later with more Semgrep context.
    description: `${alert.filePath}${alert.line ? `:${alert.line}` : ''} – ${alert.title}`,
    documentationUrl: alert.documentationUrl,
  }));

  const checkedAt =
    (finishedAt && !Number.isNaN(Date.parse(finishedAt)) && new Date(finishedAt)) || new Date(startedAt || Date.now());

  const snapshot = await securityDashboardSnapshotRepository.create({
    stage,
    scanType: 'code-semgrep',
    targetUrl: targetUrl || 'repository: lumina5',
    status,
    score,
    summary,
    findings,
    checkedAt,
  } as unknown as ISecurityDashboardSnapshotDocument);

  // Fan out critical/high Semgrep findings to SecOps Triage queue.
  // Pre-filter to critical + high only - Semgrep produces many medium/low findings
  // (style, best-practice rules) that would flood the triage queue.
  const triageAlerts = (alerts || []).filter(alert => alert.severity === 'critical' || alert.severity === 'high');

  if (triageAlerts.length > 0) {
    try {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: getSourceQueueUrl('secopsTriageQueue'),
          MessageBody: JSON.stringify({
            stage,
            scanSource: 'code-semgrep' as const,
            snapshotId: snapshot.id,
            targetUrl: targetUrl || 'repository: lumina5',
            findings: triageAlerts.map(alert => ({
              id: alert.id,
              title: alert.title,
              severity: alert.severity,
              description: `${alert.filePath}${alert.line ? `:${alert.line}` : ''} – ${alert.title}`,
              documentationUrl: alert.documentationUrl,
              instances: [],
            })),
          }),
        })
      );
      logger.info('SecOps Triage: published Semgrep findings to SQS', {
        stage,
        triageFindingCount: triageAlerts.length,
        totalFindingCount: findings.length,
      });
    } catch (err) {
      logger.error('SecOps Triage: failed to publish Semgrep findings to SQS (non-fatal)', {
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
