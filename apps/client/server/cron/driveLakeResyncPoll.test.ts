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

  it('scans with a 6h cutoff and the 200-per-run limit', async () => {
    const before = Date.now();
    await handler();
    const after = Date.now();

    expect(h.findDueForPoll).toHaveBeenCalledTimes(1);
    const [cutoff, limit] = h.findDueForPoll.mock.calls[0];
    expect(cutoff).toBeInstanceOf(Date);
    // Pin the actual interval, not just "in the past": the cutoff is now - 6h, within the window the
    // handler ran in. A regression in POLL_INTERVAL_MS (e.g. dropping to minutes) now fails here.
    const sixHoursMs = 6 * 60 * 60 * 1000;
    const age = after - (cutoff as Date).getTime();
    expect(age).toBeGreaterThanOrEqual(sixHoursMs);
    expect(age).toBeLessThanOrEqual(sixHoursMs + (after - before) + 1000);
    // Pin the enqueue bound, not just "positive": a regression in MAX_ENQUEUE_PER_RUN fails here.
    expect(limit).toBe(200);
  });

  it('keeps sweeping past a connection whose enqueue fails, and counts it', async () => {
    // One unroutable id used to reject out of a sequential loop and abandon every connection behind
    // it, so a single bad row stalled the whole sweep - tick after tick, since nothing else clears it.
    h.findDueForPoll.mockResolvedValue([{ id: 'conn1' }, { id: 'bad' }, { id: 'conn3' }]);
    h.sendToQueue.mockImplementation(async (_url: string, body: { connectionId: string }) => {
      if (body.connectionId === 'bad') throw new Error('queue does not exist');
    });

    const res = await handler();

    expect(h.sendToQueue).toHaveBeenCalledTimes(3);
    expect(h.sendToQueue).toHaveBeenCalledWith('ingest-queue-url', { connectionId: 'conn3' });
    expect(JSON.parse(res.body)).toMatchObject({ enqueued: 2, failed: 1 });
  });

  it('bounds how many enqueues are in flight at once', async () => {
    // A full 200-connection run one-at-a-time is a round trip per connection inside the cron's
    // timeout; unbounded would be a burst against SQS itself.
    let inFlight = 0;
    let peak = 0;
    h.findDueForPoll.mockResolvedValue(Array.from({ length: 25 }, (_, i) => ({ id: `conn${i}` })));
    h.sendToQueue.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;
    });

    const res = await handler();

    expect(JSON.parse(res.body)).toMatchObject({ enqueued: 25 });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(10);
  });

  it('heartbeats with zero enqueued when nothing is due', async () => {
    const res = await handler();

    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ enqueued: 0 });
  });
});
