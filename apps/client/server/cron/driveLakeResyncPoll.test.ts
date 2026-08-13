import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  findDueForPoll: vi.fn(),
  sendToQueue: vi.fn(),
  connectDB: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: h.connectDB,
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  orgGoogleDriveConnectionRepository: { findDueForPoll: h.findDueForPoll },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%/db' } }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' }, driveLakeIngestQueue: { url: 'ingest-queue-url' } },
}));

import { handler } from './driveLakeResyncPoll';

// Both gate flags on unless a test overrides one.
const bothFlagsOn = () =>
  h.getSettingsValue.mockImplementation(
    async (key: string) => key === 'EnableDataLakes' || key === 'EnableDataLakeDrivePoll'
  );

describe('driveLakeResyncPoll cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bothFlagsOn();
    h.findDueForPoll.mockResolvedValue([]);
  });

  it('is dark when the parent EnableDataLakes flag is off (never scans or enqueues)', async () => {
    h.getSettingsValue.mockImplementation(async (key: string) => key === 'EnableDataLakeDrivePoll');

    const res = await handler();

    expect(h.findDueForPoll).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ enqueued: 0, disabled: true });
  });

  it('is dark when the poll opt-in flag is off, even with the feature on', async () => {
    h.getSettingsValue.mockImplementation(async (key: string) => key === 'EnableDataLakes');

    const res = await handler();

    expect(h.findDueForPoll).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ enqueued: 0, disabled: true });
  });

  it('enqueues each due connection by id onto the ingest queue', async () => {
    h.findDueForPoll.mockResolvedValue([{ id: 'conn1' }, { id: 'conn2' }, { id: 'conn3' }]);

    const res = await handler();

    expect(h.sendToQueue).toHaveBeenCalledTimes(3);
    expect(h.sendToQueue).toHaveBeenCalledWith('ingest-queue-url', { connectionId: 'conn1' });
    expect(h.sendToQueue).toHaveBeenCalledWith('ingest-queue-url', { connectionId: 'conn3' });
    expect(JSON.parse(res.body)).toMatchObject({ enqueued: 3 });
  });

  it('scans with a past cutoff and a bounded limit', async () => {
    await handler();

    expect(h.findDueForPoll).toHaveBeenCalledTimes(1);
    const [cutoff, limit] = h.findDueForPoll.mock.calls[0];
    expect(cutoff).toBeInstanceOf(Date);
    expect((cutoff as Date).getTime()).toBeLessThan(Date.now());
    expect(typeof limit).toBe('number');
    expect(limit).toBeGreaterThan(0);
  });

  it('heartbeats with zero enqueued when nothing is due', async () => {
    const res = await handler();

    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ enqueued: 0 });
  });
});
