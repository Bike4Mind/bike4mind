import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import { type ILogger, Logger } from '@bike4mind/observability';

/**
 * Telemetry for the ANN cutover's success signal.
 *
 * The cutover's FAILURE signal is already alarmable: rankChunksForFiles warns when ANN returns
 * no hits for ready files. Its success signal was not visible at all. Logger's minLevel defaults
 * to `info` and no deploy sets LOG_LEVEL, so the `debug` lines that carried these counts are
 * dropped before they leave the process in every deployed stage.
 *
 * That matters because the intended steady state is "ANN saturates, nothing is scanned" - and in
 * that state a regression back to full scanning looks exactly like healthy traffic from the
 * outside. ChunksScanned trending back up is the regression detector;
 * AnnUnrankedFilesLeftOffScan going to zero is the same event seen from the other side.
 *
 * Keep the names below in sync with infra/dataLakeSearchDashboard.ts; the tests pin the literals
 * because infra/ cannot import them.
 */
export const DATA_LAKE_SEARCH_NAMESPACE = 'Lumina5/DataLakeSearch';

/**
 * Ready files a saturated ANN result kept off the brute-force scan. Rank-bounded: it is not a
 * count of chunks avoided, and says nothing about index coverage (see
 * SemanticSearchScanAccounting.annUnrankedFilesLeftOffScan).
 */
export const ANN_UNRANKED_FILES_LEFT_OFF_SCAN_METRIC = 'AnnUnrankedFilesLeftOffScan';
/** Brute-force volume. Expected to trend toward zero once the chunk embeddingModel backfill lands. */
export const CHUNKS_SCANNED_METRIC = 'ChunksScanned';
/** Raw ANN hits across every queried model, before minScore/scope filtering. */
export const ANN_HITS_METRIC = 'AnnHits';
/** Distinct embedding models queried - cap pressure on MAX_ALTERNATE_ANN_MODELS. */
export const ANN_MODELS_QUERIED_METRIC = 'AnnModelsQueried';

/** Which retrieval backend served the search. Dimension value - keep stable. */
export type DataLakeSearchBackend = 'atlas' | 'opensearch';

export interface DataLakeSearchMetrics {
  backend: DataLakeSearchBackend;
  annUnrankedFilesLeftOffScan: number;
  chunksScanned: number;
  annHits: number;
  annModelsQueried: number;
}

/**
 * Emits one datapoint set per search. Never throws, so a metrics outage cannot turn a working
 * search into a failed one.
 *
 * Awaited rather than fire-and-forget: a Lambda frozen after its response drops an in-flight
 * PutMetricData, which would lose the datapoint on exactly the search that produced it.
 *
 * No-ops outside deployed stages (`SEED_STAGE_NAME` comes from DEFAULT_LAMBDA_ENVIRONMENT in
 * infra/constants.ts, so only an SST deploy sets it) - a CLI, self-host, or test run has no
 * CloudWatch to publish to, and this sits on the search request path.
 */
export async function recordDataLakeSearchMetrics(metrics: DataLakeSearchMetrics, logger?: ILogger): Promise<void> {
  const stage = process.env.SEED_STAGE_NAME;
  if (!stage) return;

  try {
    // Fresh client per call: warm Lambda containers outlive their credentials,
    // and a module-level client captures expired ones (see server/utils/cloudwatch.ts).
    const client = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
    const timestamp = new Date();
    const stageOnly = [{ Name: 'Stage', Value: stage }];
    // A CloudWatch alarm matches one exact dimension set, so the Stage-only datapoint is the
    // alarmable one; the Backend set exists because Atlas and self-host OpenSearch take
    // materially different paths through the saturation rebucket and their numbers are not
    // comparable. They are separate metrics to CloudWatch, so neither double-counts the other.
    const withBackend = [...stageOnly, { Name: 'Backend', Value: metrics.backend }];

    await client.send(
      new PutMetricDataCommand({
        Namespace: DATA_LAKE_SEARCH_NAMESPACE,
        MetricData: (
          [
            [ANN_UNRANKED_FILES_LEFT_OFF_SCAN_METRIC, metrics.annUnrankedFilesLeftOffScan],
            [CHUNKS_SCANNED_METRIC, metrics.chunksScanned],
            [ANN_HITS_METRIC, metrics.annHits],
            [ANN_MODELS_QUERIED_METRIC, metrics.annModelsQueried],
          ] as const
        ).flatMap(([MetricName, Value]) =>
          [stageOnly, withBackend].map(Dimensions => ({
            MetricName,
            Value,
            Unit: StandardUnit.Count,
            Timestamp: timestamp,
            Dimensions,
          }))
        ),
      })
    );
  } catch (error) {
    (logger ?? Logger.globalInstance).warn('[semanticSearch] Failed to emit data-lake search metrics', {
      backend: metrics.backend,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
