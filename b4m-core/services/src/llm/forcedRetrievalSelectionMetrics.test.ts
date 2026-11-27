import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
// Both are invoked with `new`, so the mocks have to be constructible - an arrow function is not.
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn(function (this: { send: typeof send }) {
    this.send = send;
  }),
  PutMetricDataCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
  StandardUnit: { Count: 'Count', Milliseconds: 'Milliseconds' },
}));

import {
  FORCED_RETRIEVAL_ANN_PICK_DURATION_METRIC,
  FORCED_RETRIEVAL_BY_NAME_CUT_METRIC,
  recordForcedRetrievalCutMetrics,
} from './forcedRetrievalSelectionMetrics';
import { DATA_LAKE_RETRIEVAL_NAMESPACE } from '../dataLakeService/scanTruncationMetrics';

type Datum = { MetricName: string; Value: number; Unit: string; Dimensions: { Name: string; Value: string }[] };
const sentData = (): Datum[] => send.mock.calls[0][0].input.MetricData;
const dimensionNames = (d: Datum) => d.Dimensions.map(x => x.Name).join(',');

describe('forcedRetrievalSelectionMetrics literals', () => {
  // infra/ cannot import this module, so the dashboard carries these strings by hand.
  it('pins the published names', () => {
    expect(FORCED_RETRIEVAL_BY_NAME_CUT_METRIC).toBe('ForcedRetrievalByNameCut');
    expect(FORCED_RETRIEVAL_ANN_PICK_DURATION_METRIC).toBe('ForcedRetrievalAnnPickDurationMs');
  });

  it.each([[FORCED_RETRIEVAL_BY_NAME_CUT_METRIC], [FORCED_RETRIEVAL_ANN_PICK_DURATION_METRIC]])(
    'infra/dataLakeSearchDashboard.ts graphs %s',
    name => {
      const dashboard = readFileSync(new URL('../../../../infra/dataLakeSearchDashboard.ts', import.meta.url), 'utf8');
      expect(dashboard).toContain(`'${name}'`);
    }
  );

  // An alarm on a name nobody publishes sits in INSUFFICIENT_DATA and never fires.
  it('infra/alarms.ts alarms on the by-name share for the Stage-only set', () => {
    const alarms = readFileSync(new URL('../../../../infra/alarms.ts', import.meta.url), 'utf8');
    const start = alarms.indexOf('-forced-retrieval-by-name-cut`');
    expect(start).toBeGreaterThan(-1);
    const end = alarms.indexOf('new aws.cloudwatch', start);
    const block = alarms.slice(start, end === -1 ? undefined : end);

    expect(block).toContain(`metricName: '${FORCED_RETRIEVAL_BY_NAME_CUT_METRIC}'`);
    expect(block).toContain(`namespace: '${DATA_LAKE_RETRIEVAL_NAMESPACE}'`);
    expect(block).toContain('dimensions: { Stage: $app.stage }');
    expect(block).not.toMatch(/Reason\s*:/);
    expect(block).toContain("expression: 'IF(turns >= 2, byName / turns, 0)'");
    expect(block).toContain('threshold: 0.5');
    expect(block).toContain('alarmActions: [dlqAlarmTopic.arn]');
  });
});

describe('recordForcedRetrievalCutMetrics', () => {
  beforeEach(() => {
    vi.stubEnv('SEED_STAGE_NAME', 'production');
    send.mockResolvedValue({});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('publishes a relevance pick as a 0 cut plus its duration, Stage-only', async () => {
    await recordForcedRetrievalCutMetrics({ selection: 'relevance', annPickMs: 412 });

    expect(sentData().map(d => [d.MetricName, d.Value, dimensionNames(d)])).toEqual([
      ['ForcedRetrievalByNameCut', 0, 'Stage'],
      ['ForcedRetrievalAnnPickDurationMs', 412, 'Stage'],
    ]);
  });

  it('publishes a by-name cut as a 1 on the Stage set and on the Reason set', async () => {
    await recordForcedRetrievalCutMetrics({ selection: 'fileName', reason: 'deadline', annPickMs: 3001 });

    const data = sentData();
    expect(data.filter(d => d.MetricName === 'ForcedRetrievalByNameCut').map(d => [d.Value, d.Dimensions])).toEqual([
      [1, [{ Name: 'Stage', Value: 'production' }]],
      [
        1,
        [
          { Name: 'Stage', Value: 'production' },
          { Name: 'Reason', Value: 'deadline' },
        ],
      ],
    ]);
    expect(data.find(d => d.MetricName === 'ForcedRetrievalAnnPickDurationMs')?.Value).toBe(3001);
  });

  it('skips the duration when no ANN query ran', async () => {
    await recordForcedRetrievalCutMetrics({ selection: 'fileName', reason: 'relevance-unavailable', annPickMs: null });

    expect(sentData().some(d => d.MetricName === 'ForcedRetrievalAnnPickDurationMs')).toBe(false);
  });

  it('no-ops outside a deployed stage', async () => {
    vi.stubEnv('SEED_STAGE_NAME', '');
    await recordForcedRetrievalCutMetrics({ selection: 'relevance', annPickMs: 1 });

    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when CloudWatch rejects', async () => {
    send.mockRejectedValue(new Error('throttled'));
    const logger = { warn: vi.fn() };

    // Partial logger: only warn is reached.
    await expect(
      recordForcedRetrievalCutMetrics({ selection: 'relevance', annPickMs: 1 }, logger as never)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
