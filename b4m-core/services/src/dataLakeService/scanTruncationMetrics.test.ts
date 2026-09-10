import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
// Both are invoked with `new`, so the mocks have to be constructible - an arrow function is not.
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
  DATA_LAKE_RETRIEVAL_NAMESPACE,
  SCAN_TRUNCATED_METRIC,
  reportScanTruncation,
  scanTruncationCause,
  type ScanTruncationReport,
} from './scanTruncationMetrics';

const report = (overrides: Partial<ScanTruncationReport> = {}): ScanTruncationReport => ({
  fileBudgetHit: true,
  chunkBudgetHit: false,
  filesScanned: 10,
  filesMatching: 50,
  chunksScanned: 100,
  maxFiles: 10,
  maxChunks: 1000,
  ...overrides,
});

const makeLogger = () => ({ warn: vi.fn() });

describe('scanTruncationMetrics literals', () => {
  // infra/alarms.ts cannot import from a b4m-core package, so its `dataLakeScanTruncated` alarm
  // hard-codes these two strings. A rename here that only touched the package would leave that
  // alarm watching a metric nobody publishes - which is exactly the silent failure the alarm
  // exists to catch. Pin them.
  it('pins the namespace and metric name that infra/alarms.ts hard-codes', () => {
    expect(DATA_LAKE_RETRIEVAL_NAMESPACE).toBe('Lumina5/DataLakeRetrieval');
    expect(SCAN_TRUNCATED_METRIC).toBe('ScanTruncated');
  });
});

describe('scanTruncationCause', () => {
  it.each([
    { fileBudgetHit: true, chunkBudgetHit: false, expected: 'files' },
    { fileBudgetHit: false, chunkBudgetHit: true, expected: 'chunks' },
    { fileBudgetHit: true, chunkBudgetHit: true, expected: 'files-and-chunks' },
  ])('maps files=$fileBudgetHit chunks=$chunkBudgetHit to $expected', ({ fileBudgetHit, chunkBudgetHit, expected }) => {
    expect(scanTruncationCause(fileBudgetHit, chunkBudgetHit)).toBe(expected);
  });
});

describe('reportScanTruncation', () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    delete process.env.SEED_STAGE_NAME;
  });

  it('publishes nothing outside a deployed stage, but still logs', async () => {
    const logger = makeLogger();

    await reportScanTruncation('lake-scoped', report(), logger as never);

    expect(send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'), {
      entrypoint: 'lake-scoped',
      cause: 'files',
    });
  });

  it('publishes a Stage-only datapoint for the alarm plus a wider set for attribution', async () => {
    process.env.SEED_STAGE_NAME = 'production';

    await reportScanTruncation('file-scoped', report({ chunkBudgetHit: true }), makeLogger() as never);

    const { input } = send.mock.calls[0][0];
    expect(input.Namespace).toBe('Lumina5/DataLakeRetrieval');
    expect(input.MetricData).toHaveLength(2);
    expect(input.MetricData.every((d: { MetricName: string }) => d.MetricName === 'ScanTruncated')).toBe(true);

    // A CloudWatch alarm matches ONE exact dimension set and never rolls up, so the alarm's
    // datapoint has to carry Stage and nothing else. If a Cause/Entrypoint dimension leaked onto
    // it the alarm would silently stop matching.
    expect(input.MetricData[0].Dimensions).toEqual([{ Name: 'Stage', Value: 'production' }]);
    expect(input.MetricData[1].Dimensions).toEqual([
      { Name: 'Stage', Value: 'production' },
      { Name: 'Cause', Value: 'files-and-chunks' },
      { Name: 'Entrypoint', Value: 'file-scoped' },
    ]);
  });

  it('never throws when CloudWatch rejects the publish - the search it reports on must still return', async () => {
    process.env.SEED_STAGE_NAME = 'production';
    send.mockRejectedValue(new Error('AccessDenied'));
    const logger = makeLogger();

    await expect(reportScanTruncation('lake-scoped', report(), logger as never)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to emit ScanTruncated metric'),
      expect.objectContaining({ error: 'AccessDenied' })
    );
  });
});
