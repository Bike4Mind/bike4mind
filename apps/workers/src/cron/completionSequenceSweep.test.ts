import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';
const mocks = vi.hoisted(() => ({ load: vi.fn(), record: vi.fn(), settings: vi.fn(), synchrony: vi.fn() }));
vi.mock('./completionSynchronySweep', () => ({ sweepCompletionSynchrony: mocks.synchrony }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  connectDB: vi.fn(),
  loadCompletionSequenceEvents: mocks.load,
  shadowDetectionRepository: { recordCompletionSequence: mocks.record },
}));
vi.mock('@bike4mind/utils', async original => ({
  ...(await original<typeof import('@bike4mind/utils')>()),
  getSettingsMap: mocks.settings,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%' } }));
import { handler, sweepCompletionSequences } from './completionSequenceSweep';

const now = new Date('2026-01-01T12:00:00Z');
const events = [0, 180_000].flatMap(offset =>
  ['unknown-a', 'unknown-b', 'unknown-c'].map((userId, i) => ({
    userId,
    requestId: `${offset}-${i}`,
    at: new Date(now.getTime() - 600_000 + offset + i * 1000),
  }))
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({});
  mocks.load.mockResolvedValue({ events, rowsScanned: 6, accountsScanned: 3, truncated: false });
  mocks.record.mockResolvedValue('created');
  mocks.synchrony.mockResolvedValue({ failed: 0 });
});

describe('completion sequence sweep', () => {
  it('discovers an unknown cohort from platform activity and only records an observation', async () => {
    const result = await sweepCompletionSequences({ now });
    expect(mocks.load).toHaveBeenCalledWith(now);
    expect(mocks.record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        detector: 'completionSequence',
        wouldAction: 'none',
        userIds: ['unknown-a', 'unknown-b', 'unknown-c'],
        group: null,
        network: null,
        completionSequence: expect.objectContaining({ rounds: 2, scanTruncated: false }),
      })
    );
    expect(result).toMatchObject({ patterns: 1, recorded: { created: 1 } });
  });

  it('preserves incomplete coverage without inventing an abuse verdict', async () => {
    mocks.load.mockResolvedValue({ events, rowsScanned: 6, accountsScanned: 3, truncated: true });
    expect(await sweepCompletionSequences({ now })).toMatchObject({ scanTruncated: true });
    expect(mocks.record.mock.calls[0][0].completionSequence.scanTruncated).toBe(true);
    expect(mocks.record.mock.calls[0][0]).not.toHaveProperty('verdict');
  });

  it('reports a failed write without silently succeeding', async () => {
    const error = new Error('Storage unavailable');
    const onRecordError = vi.fn();
    mocks.record.mockRejectedValue(error);
    expect(await sweepCompletionSequences({ now, onRecordError })).toMatchObject({
      failed: 1,
      recorded: { created: 0 },
    });
    expect(onRecordError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('does not record a one-off sequence', async () => {
    mocks.load.mockResolvedValue({ events: events.slice(0, 3), rowsScanned: 3, accountsScanned: 3, truncated: false });
    expect(await sweepCompletionSequences({ now })).toMatchObject({ patterns: 0 });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('still runs the synchrony sweep when the sequence sweep throws, then fails the run', async () => {
    mocks.load.mockRejectedValue(new Error('Usage read timed out'));
    await expect(handler({}, { awsRequestId: 'test', functionName: 'test' } as Context)).rejects.toThrow(
      /Completion sequence sweep failed/
    );
    expect(mocks.synchrony).toHaveBeenCalledTimes(1);
  });

  it('fails the run when the synchrony sweep fails to record', async () => {
    mocks.synchrony.mockResolvedValue({ failed: 2 });
    await expect(handler({}, { awsRequestId: 'test', functionName: 'test' } as Context)).rejects.toThrow(
      /Synchrony sweep failed to record 2/
    );
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it('gates the scan before reading usage when shadow recording is disabled', async () => {
    mocks.settings.mockResolvedValue({ shadowDetectionRecordingEnabled: false });
    await handler({}, { awsRequestId: 'test', functionName: 'test' } as Context);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
