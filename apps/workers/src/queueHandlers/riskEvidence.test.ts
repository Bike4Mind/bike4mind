import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { refreshRiskEvidence, requestRiskEvidenceRefresh, emitMetrics } = vi.hoisted(() => ({
  refreshRiskEvidence: vi.fn(),
  requestRiskEvidenceRefresh: vi.fn(),
  emitMetrics: vi.fn(async () => undefined),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/services', () => ({ userService: { refreshRiskEvidence } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetrics }));
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh, riskEvidenceDb: () => ({}) }));
vi.mock('@server/queueHandlers/utils', () => ({ dispatchWithLogger: (fn: unknown) => fn }));

import { dispatch, processRiskEvidenceRecord as processRecord, RiskEvidenceMetrics } from './riskEvidence';

const USER_ID = '64b7f0c2a1b2c3d4e5f60718';
const REQUESTED_AT = '2026-10-30T12:00:00.000Z';
const logger = { warn: vi.fn() } as unknown as Logger;
const body = (value: unknown) => ({ body: JSON.stringify(value) });
const refreshMessage = { kind: 'refresh', userId: USER_ID, trigger: 'login', requestedAt: REQUESTED_AT };

type CollectedMetric = { name: string; value: number; dimensions?: object };
let collected: CollectedMetric[] = [];
const processRiskEvidenceRecord = (record: { body: string }, log: Logger) => processRecord(record, log, collected);
const metricNames = () => collected;

beforeEach(() => {
  vi.clearAllMocks();
  collected = [];
});

describe('processRiskEvidenceRecord', () => {
  it('runs a refresh message and reports lag and volume for a stored summary', async () => {
    refreshRiskEvidence.mockResolvedValue({
      status: 'stored',
      summary: {
        computedAt: new Date('2026-10-30T12:01:30.000Z'),
        facts: {
          a: { status: 'observed', sampleCount: 4 },
          b: { status: 'failed' },
          c: { status: 'missing' },
        },
      },
    });

    await processRiskEvidenceRecord(body(refreshMessage), logger);

    expect(refreshRiskEvidence).toHaveBeenCalledWith(USER_ID, 'login', {
      db: {},
      requestedAt: new Date(REQUESTED_AT),
    });
    expect(metricNames()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: RiskEvidenceMetrics.REFRESHES,
          dimensions: { Stage: 'test', Outcome: 'stored' },
        }),
        expect.objectContaining({ name: RiskEvidenceMetrics.LAG_SECONDS, value: 90 }),
        expect.objectContaining({ name: RiskEvidenceMetrics.FACTS_FAILED, value: 1 }),
        expect.objectContaining({ name: RiskEvidenceMetrics.SOURCE_ROWS, value: 4 }),
      ])
    );
  });

  it('turns a completion message into a debounced request, not a refresh', async () => {
    requestRiskEvidenceRefresh.mockResolvedValue('deduped');

    await processRiskEvidenceRecord(body({ kind: 'completion', userId: USER_ID }), logger);

    expect(requestRiskEvidenceRefresh).toHaveBeenCalledWith(USER_ID, 'completion', logger);
    expect(refreshRiskEvidence).not.toHaveBeenCalled();
    expect(metricNames()).toEqual([expect.objectContaining({ dimensions: { Stage: 'test', Outcome: 'deduped' } })]);
  });

  it('rethrows a failed refresh so SQS retries it, counting the failure', async () => {
    refreshRiskEvidence.mockRejectedValue(new Error('mongo down'));

    await expect(processRiskEvidenceRecord(body(refreshMessage), logger)).rejects.toThrow('mongo down');
    expect(metricNames()).toEqual([
      expect.objectContaining({
        name: RiskEvidenceMetrics.REFRESHES,
        dimensions: { Stage: 'test', Outcome: 'failed' },
      }),
    ]);
  });

  it.each([
    ['not JSON', { body: '{' }],
    ['an unknown shape', body({ kind: 'other' })],
    ['a bad user id', body({ ...refreshMessage, userId: 'nope' })],
  ])('drops %s without retrying', async (_label, record) => {
    await expect(processRiskEvidenceRecord(record, logger)).resolves.toBeUndefined();
    expect(refreshRiskEvidence).not.toHaveBeenCalled();
    expect(requestRiskEvidenceRefresh).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  const record = (messageId: string, userId: string) => ({
    messageId,
    body: JSON.stringify({ ...refreshMessage, userId }),
  });
  const run = (records: ReturnType<typeof record>[]) =>
    (dispatch as unknown as (event: unknown, context: unknown, log: Logger) => Promise<unknown>)(
      { Records: records },
      {},
      logger
    );

  it('reports only the failed record as a batch item failure and emits metrics once', async () => {
    refreshRiskEvidence
      .mockResolvedValueOnce({ status: 'superseded', summary: {} })
      .mockRejectedValueOnce(new Error('mongo down'));

    const result = await run([record('m1', USER_ID), record('m2', '64b7f0c2a1b2c3d4e5f60719')]);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(emitMetrics).toHaveBeenCalledTimes(1);
  });
});
