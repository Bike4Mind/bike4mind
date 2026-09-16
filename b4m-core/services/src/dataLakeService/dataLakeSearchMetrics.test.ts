import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ILogger } from '@bike4mind/observability';

const send = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn(function (this: any) {
    this.send = send;
  }),
  PutMetricDataCommand: vi.fn(function (this: any, input: unknown) {
    this.input = input;
  }),
  StandardUnit: { Count: 'Count', Milliseconds: 'Milliseconds' },
}));

import {
  recordDataLakeSearchMetrics,
  ANN_UNRANKED_FILES_LEFT_OFF_SCAN_METRIC,
  CHUNKS_SCANNED_METRIC,
  ANN_HITS_METRIC,
  ANN_MODELS_QUERIED_METRIC,
  ANN_QUERY_DURATION_METRIC,
  type DataLakeSearchMetrics,
} from './dataLakeSearchMetrics';

const metrics: DataLakeSearchMetrics = {
  backend: 'atlas',
  annUnrankedFilesLeftOffScan: 7,
  chunksScanned: 0,
  annHits: 12,
  annModelsQueried: 2,
  annSlowestQueryMs: 2558,
};

/** Every datapoint published for one metric name, in emit order. */
const dataFor = (name: string) =>
  send.mock.calls[0][0].input.MetricData.filter((d: { MetricName: string }) => d.MetricName === name);

describe('recordDataLakeSearchMetrics', () => {
  const originalStage = process.env.SEED_STAGE_NAME;

  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
    process.env.SEED_STAGE_NAME = 'production';
  });

  afterEach(() => {
    if (originalStage === undefined) delete process.env.SEED_STAGE_NAME;
    else process.env.SEED_STAGE_NAME = originalStage;
  });

  // The dashboard references these strings from infra/, where nothing can import them. A rename
  // that only touches this package would leave the dashboard graphing a metric nobody publishes -
  // the same silent failure this file exists to detect - so pin the literals, not the constants.
  it('publishes under the namespace and metric names infra watches', async () => {
    await recordDataLakeSearchMetrics(metrics);

    const { Namespace, MetricData } = send.mock.calls[0][0].input;
    expect(Namespace).toBe('Lumina5/DataLakeRetrieval');
    expect(ANN_UNRANKED_FILES_LEFT_OFF_SCAN_METRIC).toBe('AnnUnrankedFilesLeftOffScan');
    expect(CHUNKS_SCANNED_METRIC).toBe('ChunksScanned');
    expect(ANN_HITS_METRIC).toBe('AnnHits');
    expect(ANN_MODELS_QUERIED_METRIC).toBe('AnnModelsQueried');
    expect(ANN_QUERY_DURATION_METRIC).toBe('AnnQueryDurationMs');
    expect(new Set(MetricData.map((d: { MetricName: string }) => d.MetricName))).toEqual(
      new Set(['AnnUnrankedFilesLeftOffScan', 'ChunksScanned', 'AnnHits', 'AnnModelsQueried', 'AnnQueryDurationMs'])
    );
  });

  it('emits an alarmable Stage-only datapoint alongside the Backend breakdown', async () => {
    await recordDataLakeSearchMetrics(metrics);

    for (const name of [
      'AnnUnrankedFilesLeftOffScan',
      'ChunksScanned',
      'AnnHits',
      'AnnModelsQueried',
      'AnnQueryDurationMs',
    ]) {
      expect(dataFor(name).map((d: { Dimensions: unknown }) => d.Dimensions)).toEqual([
        [{ Name: 'Stage', Value: 'production' }],
        [
          { Name: 'Stage', Value: 'production' },
          { Name: 'Backend', Value: 'atlas' },
        ],
      ]);
    }
  });

  it('carries each counter through to its own metric', async () => {
    await recordDataLakeSearchMetrics(metrics);

    expect(dataFor('AnnUnrankedFilesLeftOffScan').map((d: { Value: number }) => d.Value)).toEqual([7, 7]);
    expect(dataFor('AnnHits').map((d: { Value: number }) => d.Value)).toEqual([12, 12]);
    expect(dataFor('AnnModelsQueried').map((d: { Value: number }) => d.Value)).toEqual([2, 2]);
  });

  // Zero is the whole point of ChunksScanned: the healthy steady state is "nothing was scanned",
  // and a publisher that skipped zeros would leave a gap in the graph exactly when the cutover is
  // working, making it indistinguishable from the emitter being broken.
  it('publishes a zero counter rather than omitting it', async () => {
    await recordDataLakeSearchMetrics(metrics);

    expect(dataFor('ChunksScanned').map((d: { Value: number }) => d.Value)).toEqual([0, 0]);
  });

  it('tags the datapoints with the backend that served the search', async () => {
    await recordDataLakeSearchMetrics({ ...metrics, backend: 'opensearch' });

    expect(dataFor('ChunksScanned')[1].Dimensions).toContainEqual({ Name: 'Backend', Value: 'opensearch' });
  });

  // Neither ANN gate is reachable with the vector-search flag off, so this is the entire
  // pre-cutover population - not an edge case. A dimension value partitions the metric
  // permanently and CloudWatch cannot relabel published datapoints, so folding it into
  // 'opensearch' would misattribute every one of those searches with no way back.
  it('keeps "no backend ran" as its own dimension value', async () => {
    await recordDataLakeSearchMetrics({ ...metrics, backend: 'none' });

    expect(dataFor('ChunksScanned')[1].Dimensions).toContainEqual({ Name: 'Backend', Value: 'none' });
    expect(dataFor('ChunksScanned')[0].Dimensions).toEqual([{ Name: 'Stage', Value: 'production' }]);
  });

  // Count is the wrong unit for a duration in a way that is invisible on a graph: CloudWatch
  // would still draw the line, but the percentile statistics the alarm reads are only meaningful
  // when the unit says these are milliseconds.
  it('publishes the duration as Milliseconds, not Count', async () => {
    await recordDataLakeSearchMetrics(metrics);

    expect(dataFor('AnnQueryDurationMs').map((d: { Unit: string }) => d.Unit)).toEqual([
      'Milliseconds',
      'Milliseconds',
    ]);
    expect(dataFor('AnnQueryDurationMs').map((d: { Value: number }) => d.Value)).toEqual([2558, 2558]);
    expect(dataFor('ChunksScanned').every((d: { Unit: string }) => d.Unit === 'Count')).toBe(true);
  });

  // The inverse of the ChunksScanned case above, and the reason the field is nullable rather than
  // defaulted to 0. A search where no query reached a backend has no latency to report; publishing
  // 0 would enter the population as an instant query and pull the alarm's statistic away from the
  // searches that actually ran.
  it('omits the duration entirely when no ANN query reached a backend', async () => {
    await recordDataLakeSearchMetrics({ ...metrics, annSlowestQueryMs: null });

    expect(dataFor('AnnQueryDurationMs')).toEqual([]);
    expect(dataFor('ChunksScanned')).toHaveLength(2);
  });

  // 0 is a real measurement (a sub-millisecond cache hit), distinct from null. Folding the two
  // together in a falsy check would drop it.
  it('publishes a zero duration, which is not the same as no query', async () => {
    await recordDataLakeSearchMetrics({ ...metrics, annSlowestQueryMs: 0 });

    expect(dataFor('AnnQueryDurationMs').map((d: { Value: number }) => d.Value)).toEqual([0, 0]);
  });

  // SEED_STAGE_NAME comes from DEFAULT_LAMBDA_ENVIRONMENT, so only an SST deploy sets it. This is
  // also what keeps a CLI, self-host or test run from publishing to a CloudWatch it has no
  // credentials for - and this emitter sits on the search request path.
  it('no-ops outside a deployed stage', async () => {
    delete process.env.SEED_STAGE_NAME;

    await recordDataLakeSearchMetrics(metrics);

    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when CloudWatch rejects', async () => {
    send.mockRejectedValue(new Error('throttled'));
    const logger = { warn: vi.fn() } as unknown as ILogger;

    await expect(recordDataLakeSearchMetrics(metrics, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to emit'), expect.any(Object));
  });

  // The "never throws" contract has to survive a logger that is missing warn, or the handler
  // meant to keep a metrics outage off the request path becomes the thing that fails the search.
  it('never throws when the fallback logger cannot warn', async () => {
    send.mockRejectedValue(new Error('throttled'));

    await expect(recordDataLakeSearchMetrics(metrics, {} as unknown as ILogger)).resolves.toBeUndefined();
  });
});

// The assertions above pin the published literals; these pin the other end of the same contract.
// infra/ cannot import this module (SST loads it outside the package graph), so the dashboard
// carries the strings by hand and nothing links the two - a rename here ships green and leaves
// the dashboard graphing a metric that no longer exists, which is the silent-success failure the
// metrics were added to detect in the first place.
describe('infra/dataLakeSearchDashboard.ts stays in sync', () => {
  const dashboard = readFileSync(new URL('../../../../infra/dataLakeSearchDashboard.ts', import.meta.url), 'utf8');

  it.each([
    ['Lumina5/DataLakeRetrieval'],
    [ANN_UNRANKED_FILES_LEFT_OFF_SCAN_METRIC],
    [CHUNKS_SCANNED_METRIC],
    [ANN_HITS_METRIC],
    [ANN_MODELS_QUERIED_METRIC],
    [ANN_QUERY_DURATION_METRIC],
  ])('graphs %s', literal => {
    expect(dashboard).toContain(literal);
  });
});

// Same contract as the dashboard block above, against the other infra consumer. This one is
// load-bearing in a way the dashboard is not: a dashboard graphing a dead metric is a blank panel
// someone eventually notices, whereas an alarm watching a metric nobody publishes sits in
// INSUFFICIENT_DATA and silently never fires - indistinguishable from the healthy state it is
// supposed to be asserting.
describe('infra/alarms.ts stays in sync', () => {
  const alarms = readFileSync(new URL('../../../../infra/alarms.ts', import.meta.url), 'utf8');

  it('alarms on the duration metric this module publishes', () => {
    expect(alarms).toContain(`metricName: '${ANN_QUERY_DURATION_METRIC}'`);
    expect(alarms).toContain("namespace: 'Lumina5/DataLakeRetrieval'");
  });

  /** The alarm's own threshold, read out of the resource so the assertions below cannot drift. */
  const alarmThresholdMs = () => {
    const match = alarms.match(
      /name: `\$\{\$app\.name\}-\$\{\$app\.stage\}-data-lake-ann-query-slow`[\s\S]*?threshold: (\d+)/
    );
    expect(match).not.toBeNull();
    return Number(match![1]);
  };

  // The dashboard draws this threshold as a horizontal line so the graph can be read against it.
  // Nothing links the two numbers - they are separate files that cannot import each other - so a
  // threshold change would leave the graph annotating a line the alarm no longer fires on, which
  // is worse than no line at all because it reads as authoritative.
  it('draws the same threshold on the dashboard that it alarms at', () => {
    const dashboardBody = readFileSync(
      new URL('../../../../infra/dataLakeSearchDashboard.ts', import.meta.url),
      'utf8'
    );
    expect(dashboardBody).toContain(`{ value: ${alarmThresholdMs()}, label: 'Alarm: dataLakeAnnQuerySlow'`);
  });

  // The threshold only means something relative to the timeout it is protecting. If someone
  // raises the Lambda timeout (option 4 in the originating issue) without revisiting this, the
  // alarm keeps firing at a level that is no longer the danger line.
  it('alarms below the server Lambda timeout it is protecting', () => {
    const web = readFileSync(new URL('../../../../infra/web.ts', import.meta.url), 'utf8');
    expect(web).toContain("timeout: '60 seconds'");

    expect(alarmThresholdMs()).toBeLessThan(60_000);
  });

  // The dashboard's other annotation line. Same drift risk as the threshold, but pinned against
  // infra/web.ts rather than against the alarm, because that is where the real number lives.
  it('draws the server Lambda timeout the graph is read against', () => {
    const dashboardBody = readFileSync(
      new URL('../../../../infra/dataLakeSearchDashboard.ts', import.meta.url),
      'utf8'
    );
    expect(dashboardBody).toContain("{ value: 60000, label: 'Server Lambda timeout'");
  });
});
