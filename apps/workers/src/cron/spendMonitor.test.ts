import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resource: { App: { stage: 'production' } },
  connect: vi.fn(),
  getSettingsMap: vi.fn(),
  getSettingsValue: vi.fn(),
  rollupBucket: vi.fn(),
  latestBucketStart: vi.fn(),
  log: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  adminSettingsRepository: {},
  spendRollupRepository: { rollupBucket: mocks.rollupBucket, latestBucketStart: mocks.latestBucketStart },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: mocks.getSettingsMap,
  getSettingsValue: mocks.getSettingsValue,
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return { log: mocks.log, error: vi.fn() };
    }
  },
}));

import { handler } from './spendMonitor';

const event = { time: '2026-10-30T10:12:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettingsMap.mockResolvedValue({});
  mocks.getSettingsValue.mockReturnValue(true);
  mocks.rollupBucket.mockResolvedValue({ docs: 3 });
});

describe('spendMonitor handler', () => {
  it('rolls each closed bucket after the latest one, oldest first', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T09:55:00.000Z'));

    await expect(handler(event)).resolves.toEqual({ status: 'ok', rolled: 2 });

    expect(mocks.getSettingsMap).toHaveBeenCalledWith({ adminSettings: {} }, { skipCache: true });
    expect(mocks.rollupBucket.mock.calls.map(([bucket]) => (bucket as Date).toISOString())).toEqual([
      '2026-10-30T10:00:00.000Z',
      '2026-10-30T10:05:00.000Z',
    ]);
  });

  it('rolls nothing when already caught up', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T10:05:00.000Z'));

    await expect(handler(event)).resolves.toEqual({ status: 'ok', rolled: 0 });
    expect(mocks.rollupBucket).not.toHaveBeenCalled();
  });

  it('does not roll when spendMonitorEnabled is false', async () => {
    mocks.getSettingsValue.mockReturnValue(false);

    await expect(handler(event)).resolves.toEqual({ status: 'disabled', rolled: 0 });
    expect(mocks.rollupBucket).not.toHaveBeenCalled();
  });

  it('throws on an event without a time', async () => {
    await expect(handler({})).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
