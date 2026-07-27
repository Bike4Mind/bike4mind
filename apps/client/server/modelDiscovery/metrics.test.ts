/**
 * T8: the run result maps onto the sec 10 metric names. Pure mapping, so the
 * assertion is the metric list itself - if a name drifts, the alarm that watches
 * it silently stops matching, which is the failure this test exists to catch.
 */

import { describe, expect, it } from 'vitest';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { modelDiscoveryService } from '@bike4mind/services';
import { buildDiscoveryMetricData } from './metrics';

type RunResult = modelDiscoveryService.ModelDiscoveryRunResult;

const result = (overrides: Partial<RunResult> = {}, metrics: Partial<RunResult['metrics']> = {}): RunResult =>
  ({
    outcome: 'ok',
    mode: 'write',
    autoEnable: 'priced',
    sources: [],
    skippedSources: [],
    diff: [],
    droppedRecords: [],
    absence: { sighted: [], missed: [], frozenBackends: [] },
    ...overrides,
    metrics: {
      ModelsDiscovered: 3,
      ModelsPromoted: 2,
      ModelsBlockedByDispatch: 1,
      ModelsDeprecated: 0,
      PriceRowsAppended: 0,
      PriceFlagged: 4,
      CatalogRowsRejected: 5,
      DocsParserRowShift: 0,
      AggregatorJoinCoverage: {},
      SourceFailures: {},
      RunDuration: 4321,
      ...metrics,
    },
  }) as RunResult;

const byName = (data: ReturnType<typeof buildDiscoveryMetricData>, name: string) => data.filter(d => d.name === name);

describe('buildDiscoveryMetricData', () => {
  it('maps every run counter to its sec 10 metric name', () => {
    const data = buildDiscoveryMetricData(result(), 'production', 'hosted');
    const values = Object.fromEntries(data.map(d => [d.name, d.value]));

    expect(values).toMatchObject({
      ModelsDiscovered: 3,
      ModelsPromoted: 2,
      ModelsBlockedByDispatch: 1,
      ModelsDeprecated: 0,
      PriceRowsAppended: 0,
      PriceFlagged: 4,
      CatalogRowsRejected: 5,
      DocsParserRowShift: 0,
      RunDuration: 4321,
    });
  });

  it('publishes the docs-parser row shift the page-restructure alarm watches', () => {
    const data = buildDiscoveryMetricData(result({}, { DocsParserRowShift: 2 }), 'production', 'hosted');
    expect(byName(data, 'DocsParserRowShift')[0].value).toBe(2);
  });

  it('dimensions every datum by stage and host', () => {
    const data = buildDiscoveryMetricData(result(), 'dev', 'hosted');
    // infra/alarms.ts repeats this set verbatim; CloudWatch never rolls dimensions up.
    for (const datum of data) expect(datum.dimensions).toMatchObject({ Stage: 'dev', Host: 'hosted' });
  });

  it('takes the host from the driver rather than assuming the hosted one', () => {
    const data = buildDiscoveryMetricData(result(), 'selfhost', 'selfhost');
    for (const datum of data) expect(datum.dimensions).toMatchObject({ Stage: 'selfhost', Host: 'selfhost' });
  });

  it('emits zeros so an alarm can tell "nothing happened" from "the cron stopped"', () => {
    const data = buildDiscoveryMetricData(result({}, { ModelsDiscovered: 0, PriceFlagged: 0 }), 'production', 'hosted');
    expect(byName(data, 'ModelsDiscovered')[0].value).toBe(0);
    expect(byName(data, 'PriceFlagged')[0].value).toBe(0);
  });

  it('reports RunDuration in milliseconds', () => {
    const [duration] = byName(buildDiscoveryMetricData(result(), 'production', 'hosted'), 'RunDuration');
    expect(duration.unit).toBe(StandardUnit.Milliseconds);
  });

  it('fans SourceFailures out per source', () => {
    const data = buildDiscoveryMetricData(
      result({}, { SourceFailures: { anthropic: 0, xai: 1 } }),
      'production',
      'hosted'
    );
    const failures = byName(data, 'SourceFailures');
    expect(failures).toHaveLength(2);
    expect(failures.find(d => d.dimensions?.Source === 'xai')?.value).toBe(1);
    expect(failures.find(d => d.dimensions?.Source === 'anthropic')?.value).toBe(0);
  });

  it('converts join coverage from a ratio to the CloudWatch percent unit', () => {
    const data = buildDiscoveryMetricData(
      result({}, { AggregatorJoinCoverage: { 'models.dev': 0.92 } }),
      'production',
      'hosted'
    );
    const [coverage] = byName(data, 'AggregatorJoinCoverage');
    expect(coverage.value).toBeCloseTo(92);
    expect(coverage.unit).toBe(StandardUnit.Percent);
    expect(coverage.dimensions?.Aggregator).toBe('models.dev');
  });

  it('flags a failed run, which no per-source counter can express', () => {
    const failed = buildDiscoveryMetricData(result({ outcome: 'failed' }), 'production', 'hosted');
    expect(byName(failed, 'RunFailures')[0].value).toBe(1);
    expect(byName(failed, 'RunPartial')[0].value).toBe(0);

    const partial = buildDiscoveryMetricData(result({ outcome: 'partial' }), 'production', 'hosted');
    expect(byName(partial, 'RunFailures')[0].value).toBe(0);
    expect(byName(partial, 'RunPartial')[0].value).toBe(1);
  });
});
