import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import { type ILogger, Logger } from '@bike4mind/observability';
import { DATA_LAKE_RETRIEVAL_NAMESPACE } from '../dataLakeService/scanTruncationMetrics';
import type { ForcedRetrievalFallbackReason } from './forcedRetrievalCandidateSelection';

/**
 * Telemetry for how forced retrieval cut a lake that overflows its candidate cap.
 *
 * A by-name cut answers from the same alphabetical prefix of the library on every turn, and it
 * reads like any other turn - only a warn line said it happened, so the fallback rate was
 * invisible without reading logs. On production it was 7 of 16 large-lake turns, all on the ANN
 * deadline after an idle index (see apps/workers/src/cron/dataLakeVectorIndexKeepWarm.ts).
 *
 * Keep the names below in sync with infra/dataLakeSearchDashboard.ts and the
 * forcedRetrievalByNameCut alarm in infra/alarms.ts; the tests pin the literals because infra/
 * cannot import them.
 */

/** 1 for a by-name cut, 0 for a relevance pick, so Average is the fallback rate and Sum the count. */
export const FORCED_RETRIEVAL_BY_NAME_CUT_METRIC = 'ForcedRetrievalByNameCut';
/**
 * Wall time of the ANN candidate pick, in ms. Skipped when no query ran; a deadline overrun
 * reports the time spent until the deadline cut it.
 */
export const FORCED_RETRIEVAL_ANN_PICK_DURATION_METRIC = 'ForcedRetrievalAnnPickDurationMs';

export type ForcedRetrievalCutMetrics =
  | { selection: 'relevance'; annPickMs: number }
  | { selection: 'fileName'; reason: ForcedRetrievalFallbackReason; annPickMs: number | null };

/**
 * Emits one datapoint set per turn whose candidates were cut to the cap: servable files over it, or
 * a single-lake listing the query already cut at it. Never throws, and no-ops outside
 * deployed stages (`SEED_STAGE_NAME`, as in dataLakeSearchMetrics.ts, whose bounded-client
 * rationale applies here too: this is awaited on the chat turn).
 */
export async function recordForcedRetrievalCutMetrics(
  metrics: ForcedRetrievalCutMetrics,
  logger?: ILogger
): Promise<void> {
  const stage = process.env.SEED_STAGE_NAME;
  if (!stage) return;

  try {
    const client = new CloudWatchClient({
      region: process.env.AWS_REGION || 'us-east-2',
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 500, requestTimeout: 1000 },
    });
    const timestamp = new Date();
    const stageOnly = [{ Name: 'Stage', Value: stage }];
    // The Stage-only set is the one an alarm can match; Reason attributes the by-name cuts.
    const cutDimensionSets =
      metrics.selection === 'fileName'
        ? [stageOnly, [...stageOnly, { Name: 'Reason', Value: metrics.reason }]]
        : [stageOnly];
    const cutData = cutDimensionSets.map(Dimensions => ({
      MetricName: FORCED_RETRIEVAL_BY_NAME_CUT_METRIC,
      Value: metrics.selection === 'fileName' ? 1 : 0,
      Unit: StandardUnit.Count,
      Timestamp: timestamp,
      Dimensions,
    }));
    const annPickMs = metrics.annPickMs;
    const durationData =
      annPickMs === null
        ? []
        : [
            {
              MetricName: FORCED_RETRIEVAL_ANN_PICK_DURATION_METRIC,
              Value: annPickMs,
              Unit: StandardUnit.Milliseconds,
              Timestamp: timestamp,
              Dimensions: stageOnly,
            },
          ];

    await client.send(
      new PutMetricDataCommand({ Namespace: DATA_LAKE_RETRIEVAL_NAMESPACE, MetricData: [...cutData, ...durationData] })
    );
  } catch (error) {
    (logger ?? Logger.globalInstance)?.warn?.('🔒 Forced retrieval: failed to emit candidate-cut metrics', {
      selection: metrics.selection,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
