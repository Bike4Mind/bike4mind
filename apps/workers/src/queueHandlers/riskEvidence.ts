/**
 * riskEvidenceQueue worker: rebuilds an account's behavioral evidence summary off the request path.
 *
 * Two message shapes arrive:
 * - `{ kind: 'refresh', ... }` from requestRiskEvidenceRefresh (apps/client/server/auth/riskEvidence.ts),
 *   already debounced: it runs userService.refreshRiskEvidence.
 * - `{ kind: 'completion', userId }`, which the completion.completed rule's input transformer sends
 *   (infra/eventBus.ts), so the event's prompt never reaches the queue. Completions are frequent, so
 *   these only request a debounced refresh, sent back to this queue as a `refresh`.
 *
 * A failed refresh is recorded on the user and its record reported as a batch item failure, so SQS
 * retries it a bounded number of times before the DLQ. Shadow-only: nothing here writes riskScore.
 */

import {
  riskEvidenceCompletionMessageSchema,
  riskEvidenceRefreshMessageSchema,
  type RiskEvidenceSummary,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { emitMetrics } from '@bike4mind/server-utils/utils/cloudwatch';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { requestRiskEvidenceRefresh, riskEvidenceDb } from '@server/auth/riskEvidence';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';
import type { SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { z } from 'zod';

export const RISK_EVIDENCE_NAMESPACE = 'Lumina5/RiskEvidence';

export const RiskEvidenceMetrics = {
  /** One per refresh, by Outcome: stored, superseded (a newer summary won), no_user, failed. */
  REFRESHES: 'Refreshes',
  /** Seconds from the triggering request to the stored summary, debounce delay included. */
  LAG_SECONDS: 'RefreshLagSeconds',
  /** Facts whose source read failed in a stored summary. */
  FACTS_FAILED: 'FactsFailed',
  /** Source records the summary was built from: the work a refresh did. */
  SOURCE_ROWS: 'SourceRowsRead',
  /** Serialized summary size: the storage it costs on the user document. */
  SUMMARY_BYTES: 'SummaryBytes',
  /** Completion-triggered requests, by Outcome: queued, deduped, failed. */
  REQUESTS: 'Requests',
} as const;

const recordSchema = z.discriminatedUnion('kind', [
  riskEvidenceRefreshMessageSchema,
  riskEvidenceCompletionMessageSchema,
]);

type RiskEvidenceMetric = {
  name: string;
  value: number;
  dimensions: Record<string, string>;
  unit: StandardUnit;
};

const outcome = (name: string, value: string): RiskEvidenceMetric => ({
  name,
  value: 1,
  dimensions: { Stage: Resource.App.stage, Outcome: value },
  unit: StandardUnit.Count,
});

function summaryMetrics(summary: RiskEvidenceSummary, requestedAt: Date): RiskEvidenceMetric[] {
  const facts = Object.values(summary.facts);
  const dimensions = { Stage: Resource.App.stage };
  return [
    {
      name: RiskEvidenceMetrics.LAG_SECONDS,
      value: Math.max(0, (summary.computedAt.getTime() - requestedAt.getTime()) / 1000),
      dimensions,
      unit: StandardUnit.Seconds,
    },
    {
      name: RiskEvidenceMetrics.FACTS_FAILED,
      value: facts.filter(fact => fact.status === 'failed').length,
      dimensions,
      unit: StandardUnit.Count,
    },
    {
      name: RiskEvidenceMetrics.SOURCE_ROWS,
      value: facts.reduce((sum, fact) => sum + (fact.status === 'observed' ? fact.sampleCount : 0), 0),
      dimensions,
      unit: StandardUnit.Count,
    },
    {
      name: RiskEvidenceMetrics.SUMMARY_BYTES,
      value: Buffer.byteLength(JSON.stringify(summary)),
      dimensions,
      unit: StandardUnit.Bytes,
    },
  ];
}

/** Handle one record, appending its metrics to `metrics`; throws only for a failure SQS should retry. */
export async function processRiskEvidenceRecord(
  record: Pick<SQSRecord, 'body'>,
  logger: Logger,
  metrics: RiskEvidenceMetric[]
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(record.body);
  } catch {
    body = undefined;
  }
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success) {
    // Retrying cannot fix a malformed message; drop it loudly.
    logger.warn('Dropping malformed risk evidence message', { issues: parsed.error.issues.length });
    return;
  }
  const message = parsed.data;

  if (message.kind === 'completion') {
    const result = await requestRiskEvidenceRefresh(message.userId, 'completion', logger);
    metrics.push(outcome(RiskEvidenceMetrics.REQUESTS, result));
    return;
  }

  try {
    const result = await userService.refreshRiskEvidence(message.userId, message.trigger, {
      db: riskEvidenceDb(),
      requestedAt: message.requestedAt,
    });
    metrics.push(
      outcome(RiskEvidenceMetrics.REFRESHES, result.status),
      ...(result.status === 'stored' ? summaryMetrics(result.summary, message.requestedAt) : [])
    );
  } catch (error) {
    // userId and trigger only: the message carries nothing else, and no source payload is logged.
    logger.warn('Risk evidence refresh failed', {
      userId: message.userId,
      trigger: message.trigger,
      error: error instanceof Error ? error.message : String(error),
    });
    metrics.push(outcome(RiskEvidenceMetrics.REFRESHES, 'failed'));
    throw error;
  }
}

export const dispatch = dispatchWithLogger<SQSBatchResponse>(async (event, _context, logger) => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  const metrics: RiskEvidenceMetric[] = [];
  for (const record of event.Records) {
    try {
      await processRiskEvidenceRecord(record, logger, metrics);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  await emitMetrics(RISK_EVIDENCE_NAMESPACE, metrics);
  return { batchItemFailures };
});
