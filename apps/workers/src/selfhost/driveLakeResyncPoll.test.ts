import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
const h = vi.hoisted(() => ({ getSettingsValue: vi.fn(), findDueForPoll: vi.fn(), sendToQueue: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  orgGoogleDriveConnectionRepository: { findDueForPoll: h.findDueForPoll },
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  sendToQueue: h.sendToQueue,
  receiveFromQueue: vi.fn(),
  deleteFromQueue: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%/db' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' }, driveLakeIngestQueue: { url: 'ingest-queue-url' } } }));
import { SelfHostWorker } from './selfHostWorker';
import { registerDriveLakeResyncPoll } from './driveLakeResyncPoll';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const HOUR = 60 * 60_000;
let worker: SelfHostWorker;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T05:59:00Z'));
  h.getSettingsValue.mockReset().mockResolvedValue(true);
  h.findDueForPoll.mockReset().mockResolvedValue([{ id: 'conn1', lastFullWalkAt: new Date() }]);
  h.sendToQueue.mockReset().mockResolvedValue(undefined);
});
// Stopped here, not at the end of each test, so a failed assertion cannot leave its interval running.
afterEach(async () => {
  await worker.stop();
  vi.useRealTimers();
});

it('polls hourly, not at startup, enqueuing the due connection once per tick', async () => {
  worker = new SelfHostWorker(logger);
  registerDriveLakeResyncPoll(worker);
  worker.start();
  await vi.advanceTimersByTimeAsync(HOUR - 1);
  expect(h.sendToQueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.sendToQueue).toHaveBeenCalledExactlyOnceWith('ingest-queue-url', { connectionId: 'conn1' });
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(h.sendToQueue).toHaveBeenCalledTimes(2);
});

it.each(['EnableDataLakes', 'EnableDataLakeDrivePoll'])('does nothing when %s is off', async flag => {
  h.getSettingsValue.mockImplementation(async (key: string) => key !== flag);
  worker = new SelfHostWorker(logger);
  registerDriveLakeResyncPoll(worker);
  worker.start();
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(h.findDueForPoll).not.toHaveBeenCalled();
  expect(h.sendToQueue).not.toHaveBeenCalled();
});
