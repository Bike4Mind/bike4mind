import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { modelDiscoveryService } from '@bike4mind/services';
import { emitMetrics, type MetricDimensions } from '@server/utils/cloudwatch';

export const MODEL_DISCOVERY_NAMESPACE = 'Lumina5/ModelDiscovery';

type ModelDiscoveryRunResult = modelDiscoveryService.ModelDiscoveryRunResult;

interface MetricDatum {
  name: string;
  value: number;
  dimensions?: MetricDimensions;
  unit?: StandardUnit;
}

/**
 * Run counters -> the sec 10 metric list. Pure so the mapping is testable
 * without AWS; the per-source and per-aggregator counters fan out to one datum
 * each, dimensioned by name, because "which source is failing" is the question
 * the alarm has to answer.
 *
 * Every counter is emitted every run, zeros included: an alarm on "no data" and
 * an alarm on "zero" are different alarms, and a metric that only appears when
 * something went wrong cannot alarm on the cron having stopped.
 */
export function buildDiscoveryMetricData(result: ModelDiscoveryRunResult, stage: string): MetricDatum[] {
  const { metrics } = result;
  const dimensions: MetricDimensions = { Stage: stage, Host: 'hosted' };
  const count = (name: string, value: number): MetricDatum => ({
    name,
    value,
    dimensions,
    unit: StandardUnit.Count,
  });

  const data: MetricDatum[] = [
    count('ModelsDiscovered', metrics.ModelsDiscovered),
    count('ModelsPromoted', metrics.ModelsPromoted),
    count('ModelsBlockedByDispatch', metrics.ModelsBlockedByDispatch),
    count('ModelsDeprecated', metrics.ModelsDeprecated),
    count('PriceRowsAppended', metrics.PriceRowsAppended),
    count('PriceFlagged', metrics.PriceFlagged),
    count('CatalogRowsRejected', metrics.CatalogRowsRejected),
    // A docs parser whose row count moved sharply run-over-run is the signature
    // of a page restructure, and it must alarm before the bad data is actioned.
    count('DocsParserRowShift', metrics.DocsParserRowShift),
    {
      name: 'RunDuration',
      value: metrics.RunDuration,
      dimensions,
      unit: StandardUnit.Milliseconds,
    },
    // A run that failed outright is the signal the 3-consecutive-failures alarm
    // watches; it cannot be derived from the per-source counters, because a run
    // can fail before any source is reached.
    count('RunFailures', result.outcome === 'failed' ? 1 : 0),
    count('RunPartial', result.outcome === 'partial' ? 1 : 0),
  ];

  for (const [source, failures] of Object.entries(metrics.SourceFailures)) {
    data.push({
      name: 'SourceFailures',
      value: failures,
      dimensions: { ...dimensions, Source: source },
      unit: StandardUnit.Count,
    });
  }

  for (const [aggregator, coverage] of Object.entries(metrics.AggregatorJoinCoverage)) {
    data.push({
      name: 'AggregatorJoinCoverage',
      // The run reports a 0..1 ratio; CloudWatch's Percent unit is 0..100, and
      // a threshold read off a graph labelled "Percent" must mean what it says.
      value: coverage * 100,
      dimensions: { ...dimensions, Aggregator: aggregator },
      unit: StandardUnit.Percent,
    });
  }

  return data;
}

/** Publishes the run's counters. Never throws: emitMetrics swallows its own errors. */
export async function emitDiscoveryMetrics(result: ModelDiscoveryRunResult, stage: string): Promise<void> {
  await emitMetrics(MODEL_DISCOVERY_NAMESPACE, buildDiscoveryMetricData(result, stage));
}
