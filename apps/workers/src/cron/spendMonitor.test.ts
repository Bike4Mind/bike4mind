import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resource: { App: { stage: 'production' } },
  connect: vi.fn(),
  getSettingsMap: vi.fn(),
  getSettingsValue: vi.fn(),
  rollupBucket: vi.fn(),
  latestBucketStart: vi.fn(),
  log: vi.fn(),
  evaluateSpend: vi.fn(),
  postAlarmToSlack: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  adminSettingsRepository: {},
  spendAlertRepository: {},
  spendRollupRepository: { rollupBucket: mocks.rollupBucket, latestBucketStart: mocks.latestBucketStart },
}));
vi.mock('../events/alarmSlackMessage', () => ({
  resolveAlarmWebhookUrl: () => 'https://hooks.example.com/alarms',
  appUrlFromEnv: () => 'https://app.example.com',
  postAlarmToSlack: mocks.postAlarmToSlack,
}));
vi.mock('../events/alarmSlackMention', () => ({ readAlarmMention: async () => undefined }));
vi.mock('./spendMonitor/resolveScope', () => ({ defaultResolveScopeDeps: () => ({}) }));
vi.mock('./spendMonitor/evaluate', () => ({ evaluateSpend: mocks.evaluateSpend }));
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

const defaultSettings: Record<string, boolean | number> = {
  spendMonitorEnabled: true,
  spendMonitorSlackEnabled: false,
  spendMonitorPlatformSpikeRatio: 3,
  spendMonitorPlatformCriticalRatio: 6,
  spendMonitorPlatformSpikeFloorCredits: 5000,
  spendMonitorPlatformCostFloorUsd: 20,
  spendMonitorAccountSpikeRatio: 10,
  spendMonitorAccountSpikeFloorCredits: 1000,
  spendMonitorAccountCeilingCredits: 5000,
};

const useSettings = (overrides: Record<string, boolean | number> = {}) => {
  const settings = { ...defaultSettings, ...overrides };
  mocks.getSettingsValue.mockImplementation((key: string) => settings[key]);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettingsMap.mockResolvedValue({});
  useSettings();
  mocks.rollupBucket.mockResolvedValue({ docs: 3 });
  mocks.evaluateSpend.mockResolvedValue({ breaches: 0, posted: 0 });
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
    useSettings({ spendMonitorEnabled: false });

    await expect(handler(event)).resolves.toEqual({ status: 'disabled', rolled: 0 });
    expect(mocks.getSettingsValue.mock.calls.map(([key]) => key)).toEqual(['spendMonitorEnabled']);
    expect(mocks.rollupBucket).not.toHaveBeenCalled();
  });

  it('logs the buckets the catch-up cap leaves unrolled after an outage', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T07:00:00.000Z'));

    await expect(handler(event)).resolves.toEqual({ status: 'ok', rolled: 24 });

    expect(mocks.log).toHaveBeenCalledWith('spend-monitor-catch-up-capped', {
      latestRolled: '2026-10-30T07:00:00.000Z',
      firstRolled: '2026-10-30T08:10:00.000Z',
      droppedBuckets: 13,
    });
  });

  it('does not log a capped catch-up when the rolled buckets are contiguous', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T09:55:00.000Z'));

    await handler(event);

    expect(mocks.log).not.toHaveBeenCalledWith('spend-monitor-catch-up-capped', expect.anything());
  });

  it('evaluates after rolling, with thresholds read from settings', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T09:55:00.000Z'));
    useSettings({ spendMonitorPlatformSpikeRatio: 4 });

    await handler(event);

    expect(mocks.evaluateSpend).toHaveBeenCalledTimes(1);
    const [now, , thresholds] = mocks.evaluateSpend.mock.calls[0];
    expect(now).toEqual(new Date(event.time));
    expect(thresholds).toEqual({
      platformSpikeRatio: 4,
      platformCriticalRatio: 6,
      platformSpikeFloorCredits: 5000,
      platformCostFloorUsd: 20,
      accountSpikeRatio: 10,
      accountSpikeFloorCredits: 1000,
      accountCeilingCredits: 5000,
    });
    expect(mocks.rollupBucket.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.evaluateSpend.mock.invocationCallOrder[0]
    );
  });

  it('wires the post to Slack only when spendMonitorSlackEnabled is true', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T10:05:00.000Z'));
    const sendWith = async (slackEnabled: boolean) => {
      useSettings({ spendMonitorSlackEnabled: slackEnabled });
      mocks.evaluateSpend.mockClear();
      await handler(event);
      const [, deps] = mocks.evaluateSpend.mock.calls[0];
      await deps.post({ text: 'x', blocks: [] });
    };

    await sendWith(false);
    expect(mocks.postAlarmToSlack).not.toHaveBeenCalled();

    await sendWith(true);
    expect(mocks.postAlarmToSlack).toHaveBeenCalledWith('https://hooks.example.com/alarms', { text: 'x', blocks: [] });
  });

  it('fails loudly when evaluation throws', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T10:05:00.000Z'));
    mocks.evaluateSpend.mockRejectedValue(new Error('boom'));

    await expect(handler(event)).rejects.toThrow('boom');
  });

  it('does not evaluate when spendMonitorEnabled is false', async () => {
    useSettings({ spendMonitorEnabled: false });
    await handler(event);
    expect(mocks.evaluateSpend).not.toHaveBeenCalled();
  });

  it('throws on an event without a time', async () => {
    await expect(handler({})).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
