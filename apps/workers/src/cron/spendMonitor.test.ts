import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resource: { App: { stage: 'production' } },
  connect: vi.fn(),
  getSettingsMap: vi.fn(),
  getSettingsValue: vi.fn(),
  rollupBucket: vi.fn(),
  latestBucketStart: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  evaluateSpend: vi.fn(),
  postAlarmToSlack: vi.fn(),
  runMarginCheck: vi.fn(),
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
vi.mock('@bike4mind/server-utils/lib/accounts/accountContext', () => ({ defaultAccountContextDeps: () => ({}) }));
vi.mock('./spendMonitor/paidScopes', () => ({ defaultPaidScopeDeps: () => ({}) }));
vi.mock('./spendMonitor/resolveScope', () => ({ defaultResolveScopeDeps: () => ({}) }));
vi.mock('./spendMonitor/evaluate', () => ({ evaluateSpend: mocks.evaluateSpend }));
vi.mock('./spendMonitor/marginCheck', async importOriginal => ({
  ...(await importOriginal<typeof import('./spendMonitor/marginCheck')>()),
  runMarginCheck: mocks.runMarginCheck,
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: mocks.getSettingsMap,
  getSettingsValue: mocks.getSettingsValue,
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return { log: mocks.log, warn: mocks.warn, error: vi.fn() };
    }
  },
}));

import type { AccountContext } from '@bike4mind/server-utils/lib/accounts/accountContext';
import { handler } from './spendMonitor';
import { selectSpendAccountPolicy } from './spendMonitor/accountPolicy';
import type { SpendThresholds } from './spendMonitor/rules';

const event = { time: '2026-10-30T10:12:00Z' };

const defaultSettings: Record<string, unknown> = {
  spendMonitorEnabled: true,
  spendMonitorSlackEnabled: false,
  spendMonitorPlatformSpikeRatio: 3,
  spendMonitorPlatformCriticalRatio: 6,
  spendMonitorPlatformSpikeFloorCredits: 5000,
  spendMonitorPlatformCostFloorUsd: 20,
  signupRiskScoring: { reviewThreshold: 50 },
  spendMonitorPaidAccountMinAgeDays: 7,
  spendMonitorAccountSpikeRatio: 10,
  spendMonitorAccountSpikeFloorCredits: 1000,
  spendMonitorAccountCeilingCredits: 5000,
  spendMonitorPaidAccountSpikeFloorCredits: 20000,
  spendMonitorPaidAccountCeilingCredits: 40000,
  spendMonitorTrustedEmailDomains: '',
  spendMonitorTrustedAccountIds: '',
  spendMonitorTrustedAccountSpikeFloorCredits: 20000,
  spendMonitorTrustedAccountCeilingCredits: 40000,
  spendMonitorMarginEnabled: true,
  spendMonitorMarginMinRatio: 1,
  spendMonitorMarginWindowHours: 24,
  spendMonitorMarginCostFloorUsd: 5,
};

const useSettings = (overrides: Record<string, unknown> = {}) => {
  const settings = { ...defaultSettings, ...overrides };
  mocks.getSettingsValue.mockImplementation((key: string) => settings[key]);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettingsMap.mockResolvedValue({});
  useSettings();
  mocks.rollupBucket.mockResolvedValue({ docs: 3 });
  mocks.evaluateSpend.mockResolvedValue({ breaches: 0, posted: 0 });
  mocks.runMarginCheck.mockResolvedValue({ checked: 0, flagged: 0 });
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

  it('warns with the skipped range when the gap exceeds the catch-up cap', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T06:00:00.000Z'));

    await expect(handler(event)).resolves.toEqual({ status: 'ok', rolled: 24 });

    expect(mocks.warn).toHaveBeenCalledWith(
      'spend-monitor-gap-skipped',
      expect.objectContaining({ from: '2026-10-30T06:05:00.000Z', to: '2026-10-30T08:10:00.000Z' })
    );
  });

  it('does not warn when the gap fits within the cap', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T09:55:00.000Z'));

    await handler(event);

    expect(mocks.warn).not.toHaveBeenCalled();
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

  it('evaluates after rolling, with thresholds read from settings', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T09:55:00.000Z'));
    useSettings({ spendMonitorPlatformSpikeRatio: 4, spendMonitorPaidAccountCeilingCredits: 45000 });

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
      paidAccountMinAgeDays: 7,
      riskReviewScoreThreshold: 50,
      accountSpikeFloorCredits: 1000,
      accountCeilingCredits: 5000,
      paidAccountSpikeFloorCredits: 20000,
      paidAccountCeilingCredits: 45000,
      trustedAccountSpikeFloorCredits: 20000,
      trustedAccountCeilingCredits: 40000,
    });
    expect(mocks.rollupBucket.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.evaluateSpend.mock.invocationCallOrder[0]
    );
  });

  it('passes the trusted domains and account ids parsed from settings', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T09:55:00.000Z'));
    useSettings({
      spendMonitorTrustedEmailDomains: 'Example.com, @corp.example.org',
      spendMonitorTrustedAccountIds: 'org-1 user-2',
    });

    await handler(event);

    const [, , , trust] = mocks.evaluateSpend.mock.calls[0];
    expect(trust).toEqual({
      emailDomains: new Set(['example.com', 'corp.example.org']),
      accountIds: new Set(['org-1', 'user-2']),
    });
  });

  it('applies the paid minimum age and risk review threshold from settings to the account tier', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T10:05:00.000Z'));
    const establishedFor10Days: AccountContext = {
      accountAgeDays: 10,
      responsibleAccountAgeDays: 10,
      emailVerified: true,
      reviewState: 'none',
      riskScore: 40,
      reviewReopened: false,
      banned: false,
      paymentRiskEvent: false,
      hasCreditPurchase: false,
      lastCreditPurchaseAgeDays: null,
      payments: {
        status: 'observed',
        succeeded: 0,
        failed: 0,
        radarBlocked: 0,
        elevatedRisk: 0,
        latestSucceededAgeDays: null,
      },
      evidence: { status: 'observed', ageHours: 1 },
    };
    const tierUnder = async (overrides: Record<string, unknown>) => {
      useSettings(overrides);
      mocks.evaluateSpend.mockClear();
      await handler(event);
      const thresholds: SpendThresholds = mocks.evaluateSpend.mock.calls[0][2];
      return selectSpendAccountPolicy({
        context: establishedFor10Days,
        subscribed: true,
        explicitlyTrusted: false,
        minimumPaidAgeDays: thresholds.paidAccountMinAgeDays,
        riskReviewScoreThreshold: thresholds.riskReviewScoreThreshold,
      }).tier;
    };

    expect(await tierUnder({})).toBe('paid');
    expect(await tierUnder({ spendMonitorPaidAccountMinAgeDays: 14 })).toBe('standard');
    expect(await tierUnder({ signupRiskScoring: { reviewThreshold: 30 } })).toBe('standard');
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

describe('spendMonitor handler margin check', () => {
  const midnightEvent = { time: '2026-10-31T00:03:00Z' };

  beforeEach(() => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T23:55:00.000Z'));
  });

  it('runs once a day on the midnight UTC tick with the admin thresholds', async () => {
    useSettings({
      spendMonitorMarginMinRatio: 1.1,
      spendMonitorMarginWindowHours: 48,
      spendMonitorMarginCostFloorUsd: 10,
    });

    await handler(midnightEvent);

    expect(mocks.runMarginCheck).toHaveBeenCalledOnce();
    const [deps, thresholds] = mocks.runMarginCheck.mock.calls[0];
    expect(thresholds).toEqual({ minRatio: 1.1, windowHours: 48, costFloorUsd: 10 });
    expect(deps.messageContext).toEqual({ creditUsd: expect.any(Number), stage: 'production' });
  });

  it('skips every other tick', async () => {
    mocks.latestBucketStart.mockResolvedValue(new Date('2026-10-30T09:55:00.000Z'));

    await handler(event);

    expect(mocks.runMarginCheck).not.toHaveBeenCalled();
  });

  it('skips when the margin check is disabled', async () => {
    useSettings({ spendMonitorMarginEnabled: false });

    await handler(midnightEvent);

    expect(mocks.runMarginCheck).not.toHaveBeenCalled();
  });

  it('routes the digest through the Slack toggle, so a disabled integration only logs', async () => {
    mocks.runMarginCheck.mockImplementation(async (deps: { post: (message: { text: string }) => Promise<void> }) => {
      await deps.post({ text: 'margin digest' });
      return { checked: 1, flagged: 1 };
    });

    await handler(midnightEvent);

    expect(mocks.postAlarmToSlack).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith('spend-monitor-slack-disabled', { text: 'margin digest' });
  });

  it('fails loudly when a margin threshold resolves to no value', async () => {
    useSettings({ spendMonitorMarginWindowHours: undefined });

    await expect(handler(midnightEvent)).rejects.toThrow('spendMonitorMarginWindowHours');
  });
});
