import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { Logger } from '@bike4mind/observability';

/**
 * Telemetry for a retrieval failure that looks like a success.
 *
 * When a scan hits `maxFiles` or `maxChunks` the search still returns a well-formed,
 * plausibly-ranked result set - it just ranks a budgeted PREFIX of the corpus. Nobody files a
 * ticket for an answer that reads fine, so the first lake to outgrow the budgets degrades
 * quietly. `scan.truncated` has always recorded it; this publishes it as something alarmable.
 *
 * Emitted from the two public search entrypoints rather than from the ranking core, because
 * truncation is decided on three different return paths (a budgeted scan, an empty query
 * embedding, and a scope whose every file was retrieval-excluded) and an emitter wired to only
 * the first would be blind to the other two.
 *
 * Keep the names below in sync with infra/alarms.ts (`dataLakeScanTruncated`); the tests pin
 * the literals, because infra cannot import them.
 */
export const DATA_LAKE_RETRIEVAL_NAMESPACE = 'Lumina5/DataLakeRetrieval';
export const SCAN_TRUNCATED_METRIC = 'ScanTruncated';

/** Which budget stopped the walk - the two need different operator responses. */
export type ScanTruncationCause = 'files' | 'chunks' | 'files-and-chunks';

/** Which search surface truncated. Dimension value, so keep these stable. */
export type SearchEntrypoint = 'lake-scoped' | 'file-scoped';

/**
 * Precondition: at least one flag is set. Guaranteed by `truncated` being their disjunction at
 * every site that builds it, which is also the only condition under which this is called.
 */
export function scanTruncationCause(fileBudgetHit: boolean, chunkBudgetHit: boolean): ScanTruncationCause {
  if (fileBudgetHit && chunkBudgetHit) return 'files-and-chunks';
  return fileBudgetHit ? 'files' : 'chunks';
}

export interface ScanTruncationReport {
  fileBudgetHit: boolean;
  chunkBudgetHit: boolean;
  filesScanned: number;
  filesMatching: number;
  chunksScanned: number;
  maxFiles: number;
  maxChunks: number;
}

/**
 * Reports one truncated search: a warn line naming what was and was not covered, plus the
 * alarmable metric. Never throws - a CloudWatch failure still leaves the log behind. The caller
 * awaits it, which only spends latency on a search that is already returning a short corpus;
 * truncation is rare by construction, so this is not on the hot path.
 *
 * Callers must gate on `scan.truncated` rather than on the two budget flags: the flags are the
 * cause, `truncated` is the signal, and only the caller sees which return path it came from.
 *
 * The metric no-ops outside deployed stages (`SEED_STAGE_NAME` comes from
 * DEFAULT_LAMBDA_ENVIRONMENT in infra/constants.ts) - a CLI, self-host, or test run has no
 * CloudWatch to publish to. The warn keeps semanticDataLakeSearch's own convention of logging
 * only through a caller-supplied logger, so relocating it here changed nothing about when it
 * fires.
 */
export async function reportScanTruncation(
  entrypoint: SearchEntrypoint,
  report: ScanTruncationReport,
  logger?: Logger
): Promise<void> {
  const cause = scanTruncationCause(report.fileBudgetHit, report.chunkBudgetHit);

  logger?.warn?.(
    `[semanticSearch] TRUNCATED scan: ranked ${report.chunksScanned} chunks across ` +
      `${report.filesScanned}/${report.filesMatching} files (maxFiles=${report.maxFiles}, ` +
      `maxChunks=${report.maxChunks}) - results rank an INCOMPLETE corpus`,
    { entrypoint, cause }
  );

  const stage = process.env.SEED_STAGE_NAME;
  if (!stage) return;

  try {
    // Fresh client per call: warm Lambda containers outlive their credentials, and a
    // module-level client captures expired ones (see server/utils/cloudwatch.ts).
    const client = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
    const timestamp = new Date();

    await client.send(
      new PutMetricDataCommand({
        Namespace: DATA_LAKE_RETRIEVAL_NAMESPACE,
        MetricData: [
          // A CloudWatch alarm matches one exact dimension set and never rolls up, so the
          // Stage-only datapoint is the alarmable one; the wider set exists for attribution
          // (which budget, which surface). They are separate metrics to CloudWatch, so
          // neither double-counts the other.
          {
            MetricName: SCAN_TRUNCATED_METRIC,
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: timestamp,
            Dimensions: [{ Name: 'Stage', Value: stage }],
          },
          {
            MetricName: SCAN_TRUNCATED_METRIC,
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: timestamp,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'Cause', Value: cause },
              { Name: 'Entrypoint', Value: entrypoint },
            ],
          },
        ],
      })
    );
  } catch (error) {
    logger?.warn?.(`[semanticSearch] Failed to emit ${SCAN_TRUNCATED_METRIC} metric`, {
      entrypoint,
      cause,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
