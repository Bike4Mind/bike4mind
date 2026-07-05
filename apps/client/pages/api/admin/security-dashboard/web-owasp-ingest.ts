import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import {
  securityDashboardSnapshotRepository,
  type ISecurityDashboardSnapshotDocument,
  type SecurityDashboardStatus,
} from '@bike4mind/database';
import { Resource } from 'sst';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import { computeDeterministicStatus, computeWebsiteScore } from '@server/security/securityDashboardScoring';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'web-owasp-ingest' } });
const sqsClient = new SQSClient({});

interface ZapCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface ZapAlertInstance {
  uri: string;
  param?: string;
  evidence?: string;
  otherinfo?: string;
}

interface ZapAlertInput {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  recommendation?: string;
  documentationUrl?: string;
  /** Full instance details from ZAP report - stripped before MongoDB, forwarded to SQS for triage */
  instances?: ZapAlertInstance[];
}

interface ZapIngestBody {
  stage?: string;
  targetUrl: string;
  counts: ZapCounts;
  alerts: ZapAlertInput[];
  startedAt?: string;
  finishedAt?: string;
}

function stripHtml(input?: string): string | undefined {
  if (!input) return input;
  // Remove common block tags but preserve spacing
  const withoutParagraphs = input.replace(/<\/?p[^>]*>/gi, ' ');
  // Replace <br> with newlines
  const withNewlines = withoutParagraphs.replace(/<br\s*\/?>/gi, '\n');
  // Strip any remaining tags
  const withoutTags = withNewlines.replace(/<[^>]+>/g, '');
  return withoutTags.replace(/\s+/g, ' ').trim();
}

function computeStatusAndScore(counts: ZapCounts): {
  status: SecurityDashboardStatus;
  score: number;
  summary: string;
} {
  const score = computeWebsiteScore(counts);
  const status = computeDeterministicStatus(counts, score);
  const summary =
    counts.critical === 0 && counts.high === 0 && counts.medium === 0 && counts.low === 0
      ? 'No OWASP ZAP alerts detected in the latest scan.'
      : `${[
          counts.critical ? `${counts.critical} critical` : null,
          counts.high ? `${counts.high} high` : null,
          counts.medium ? `${counts.medium} medium` : null,
          counts.low ? `${counts.low} low` : null,
        ]
          .filter(Boolean)
          .join(', ')} OWASP ZAP alerts in the latest scan.`;

  return { status, score, summary };
}

const handler = baseApi<Request, Response>({ auth: false }).post(async (req: Request, res: Response) => {
  const ingestToken =
    // Prefer SST Resource binding in deployed environments
    Resource.SECOPS_ZAP_INGEST_TOKEN?.value || process.env.SECOPS_ZAP_INGEST_TOKEN;
  if (!ingestToken) {
    return res.status(500).json({ error: 'Security ingest token is not configured.' });
  }

  const providedTokenHeader = req.headers['x-security-ingest-token'];
  const providedToken = Array.isArray(providedTokenHeader) ? providedTokenHeader[0] : providedTokenHeader;
  if (!providedToken || !safeCompareTokens(String(providedToken), ingestToken)) {
    return res.status(403).json({ error: 'Invalid ingest token.' });
  }

  const body = req.body as Partial<ZapIngestBody> | undefined;
  const { targetUrl, counts, alerts, stage: rawStage, startedAt, finishedAt } = body || {};

  if (!targetUrl || !counts || typeof counts !== 'object') {
    return res.status(400).json({ error: 'Invalid payload: targetUrl and counts are required.' });
  }

  const stage = rawStage || process.env.SST_STAGE || process.env.NODE_ENV || process.env.SEED_STAGE_NAME || 'unknown';

  const safeCounts: ZapCounts = {
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
    description: stripHtml(alert.description) || alert.description,
    recommendation: stripHtml(alert.recommendation) || alert.recommendation,
    documentationUrl: alert.documentationUrl,
  }));

  const checkedAt =
    (finishedAt && !Number.isNaN(Date.parse(finishedAt)) && new Date(finishedAt)) || new Date(startedAt || Date.now());

  const snapshot = await securityDashboardSnapshotRepository.create({
    stage,
    scanType: 'web-owasp',
    targetUrl,
    status,
    score,
    summary,
    findings, // instances stripped - not stored in MongoDB (security concern)
    checkedAt,
  } as unknown as ISecurityDashboardSnapshotDocument);

  // Always fan out full payload (with instances) to SecOps Triage queue.
  // The triage Lambda reads secopsTriageConfig from AdminSettings and decides whether to act.
  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: getSourceQueueUrl('secopsTriageQueue'),
        MessageBody: JSON.stringify({
          stage,
          scanSource: 'web-owasp' as const,
          snapshotId: snapshot.id,
          targetUrl,
          findings: (alerts || []).map(alert => ({
            id: alert.id,
            title: alert.title,
            severity: alert.severity,
            description: stripHtml(alert.description) || alert.description,
            recommendation: stripHtml(alert.recommendation) || alert.recommendation,
            documentationUrl: alert.documentationUrl,
            instances: alert.instances ?? [],
          })),
        }),
      })
    );
    logger.info('SecOps Triage: published ZAP findings to SQS', { stage, findingCount: alerts?.length ?? 0 });
  } catch (err) {
    // Non-fatal: triage fan-out failure must never block the ingest response
    logger.error('SecOps Triage: failed to publish to SQS (non-fatal)', {
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
