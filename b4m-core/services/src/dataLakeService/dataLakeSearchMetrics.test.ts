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
  StandardUnit: { Count: 'Count' },
}));

import {
  recordDataLakeSearchMetrics,
  DATA_LAKE_SEARCH_NAMESPACE,
  ANN_UNRANKED_FILES_LEFT_OFF_SCAN_METRIC,
  CHUNKS_SCANNED_METRIC,
  ANN_HITS_METRIC,
  ANN_MODELS_QUERIED_METRIC,
  type DataLakeSearchMetrics,
} from './dataLakeSearchMetrics';

const metrics: DataLakeSearchMetrics = {
  backend: 'atlas',
  annUnrankedFilesLeftOffScan: 7,
  chunksScanned: 0,
  annHits: 12,
  annModelsQueried: 2,
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
    expect(Namespace).toBe('Lumina5/DataLakeSearch');
    expect(DATA_LAKE_SEARCH_NAMESPACE).toBe('Lumina5/DataLakeSearch');
    expect(ANN_UNRANKED_FILES_LEFT_OFF_SCAN_METRIC).toBe('AnnUnrankedFilesLeftOffScan');
    expect(CHUNKS_SCANNED_METRIC).toBe('ChunksScanned');
    expect(ANN_HITS_METRIC).toBe('AnnHits');
    expect(ANN_MODELS_QUERIED_METRIC).toBe('AnnModelsQueried');
    expect(new Set(MetricData.map((d: { MetricName: string }) => d.MetricName))).toEqual(
      new Set(['AnnUnrankedFilesLeftOffScan', 'ChunksScanned', 'AnnHits', 'AnnModelsQueried'])
    );
  });

  it('emits an alarmable Stage-only datapoint alongside the Backend breakdown', async () => {
    await recordDataLakeSearchMetrics(metrics);

    for (const name of ['AnnUnrankedFilesLeftOffScan', 'ChunksScanned', 'AnnHits', 'AnnModelsQueried']) {
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
});
