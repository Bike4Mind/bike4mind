import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const {
  loadCampaignScanAccounts,
  findSignupFingerprintClusters,
  recordCampaignGroup,
  getSettingsMap,
  sweepDeviceLinks,
  gradeStaleSignupBursts,
} = vi.hoisted(() => ({
  sweepDeviceLinks: vi.fn(),
  loadCampaignScanAccounts: vi.fn(),
  findSignupFingerprintClusters: vi.fn(),
  recordCampaignGroup: vi.fn(),
  getSettingsMap: vi.fn(),
  gradeStaleSignupBursts: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  connectDB: vi.fn(async () => undefined),
  findSignupFingerprintClusters,
  loadCampaignScanAccounts,
  loadRecentDeviceLinkAccounts: vi.fn(),
  // No userRepository: the sweep has no way to rescore, hold or change an account.
  shadowDetectionRepository: { recordCampaignGroup },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap,
}));
vi.mock('@server/security/autoContainment/deviceLink', () => ({
  sweepDeviceLinks,
  liveDeviceLinkDeps: () => ({}),
  DeviceLinkAssessError: class DeviceLinkAssessError extends Error {},
}));
vi.mock('@server/security/shadowDetectionAutoGrade', () => ({
  gradeStaleSignupBursts,
  liveStaleDetectionGradeDeps: (deps: unknown) => deps,
}));
vi.mock('@server/utils/systemAuditWriter', () => ({ systemAuditWriter: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%' } }));

import type { Context } from 'aws-lambda';
import type { CampaignScanRow } from '@bike4mind/database';
import {
  ACCOUNT_CAMPAIGN_WINDOW_HOURS,
  handler,
  sweepAccountCampaigns,
  toCampaignAccount,
} from './accountCampaignSweep';

const NOW = new Date('2026-11-03T12:00:00Z');
const RARE_JA4 = 't13d1516h2_8daaf6152771_02713d6af862';

const row = (n: number, overrides: Partial<CampaignScanRow> = {}): CampaignScanRow => {
  const createdAt = new Date(NOW.getTime() - 2 * 60 * 60_000 + n * 60_000);
  const plus = (ms: number) => new Date(createdAt.getTime() + ms);
  return {
    userId: n.toString(16).padStart(24, '0'),
    email: `user${n}@gmail.com`,
    createdAt,
    emailVerifiedAt: plus(20_000),
    ip: `198.51.${n}.7`,
    asn: 64500,
    isDatacenter: false,
    ja4: RARE_JA4,
    firstApiKeyAt: plus(180_000),
    firstUsageAt: plus(240_000),
    ...overrides,
  };
};

const campaignRows = [1, 2, 3, 4].map(n => row(n));

beforeEach(() => {
  vi.clearAllMocks();
  loadCampaignScanAccounts.mockResolvedValue({ rows: campaignRows, truncated: false });
  findSignupFingerprintClusters.mockResolvedValue([]);
  recordCampaignGroup.mockResolvedValue('created');
  getSettingsMap.mockResolvedValue({});
  sweepDeviceLinks.mockResolvedValue({ status: 'done', failed: 0, assessFailed: 0 });
  gradeStaleSignupBursts.mockReset().mockResolvedValue({ considered: 0 });
});

describe('toCampaignAccount', () => {
  it('reduces a scan row to its network prefix and registrable mail domain', () => {
    expect(
      toCampaignAccount(row(7, { ip: '203.0.113.77', email: 'a@mail.Example.co.uk', isDatacenter: null, ja4: null }))
    ).toMatchObject({
      networkPrefix: '203.0.113.0',
      mailDomain: 'example.co.uk',
      hosting: null,
      fingerprint: null,
    });
    expect(toCampaignAccount(row(8, { ip: null })).networkPrefix).toBeNull();
  });
});

describe('sweepAccountCampaigns', () => {
  it('scans the window within its bounds and records each group as a campaign detection', async () => {
    const report = await sweepAccountCampaigns({ now: NOW });

    expect(loadCampaignScanAccounts).toHaveBeenCalledWith({
      since: new Date(NOW.getTime() - ACCOUNT_CAMPAIGN_WINDOW_HOURS * 60 * 60_000),
      until: NOW,
      limit: 2_000,
    });
    expect(recordCampaignGroup).toHaveBeenCalledTimes(1);
    expect(recordCampaignGroup.mock.calls[0][0]).toMatchObject({
      detector: 'accountCampaign',
      userIds: campaignRows.map(entry => entry.userId),
      windowMinutes: ACCOUNT_CAMPAIGN_WINDOW_HOURS * 60,
    });
    expect(report).toMatchObject({ accounts: 4, groups: 1, scanTruncated: false, recorded: { created: 1 } });
  });

  it('ignores a fingerprint the baseline says is common', async () => {
    findSignupFingerprintClusters.mockResolvedValue([{ ja4: RARE_JA4, signupCount: 900 }]);

    const report = await sweepAccountCampaigns({ now: NOW });

    expect(report.groups).toBe(0);
    expect(recordCampaignGroup).not.toHaveBeenCalled();
  });

  it('keeps recording the remaining groups when one write throws', async () => {
    const otherJa4 = 't13d1715h2_5b57614c22b0_3d5424432f57';
    loadCampaignScanAccounts.mockResolvedValue({
      rows: [...campaignRows, ...[100, 101, 102, 103].map(n => row(n, { ja4: otherJa4 }))],
      truncated: false,
    });
    recordCampaignGroup.mockRejectedValueOnce(new Error('write failed'));
    const onRecordError = vi.fn();

    const report = await sweepAccountCampaigns({ now: NOW, onRecordError });

    expect(report.groups).toBe(2);
    expect(recordCampaignGroup).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ failed: 1, recorded: { created: 1 } });
    expect(onRecordError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ detector: 'accountCampaign' })
    );
  });
});

describe('handler', () => {
  const context = { awsRequestId: 'r1', functionName: 'accountCampaignSweep' } as Context;

  it('records detections when recording is on', async () => {
    await handler({}, context);

    expect(recordCampaignGroup).toHaveBeenCalledTimes(1);
    expect(sweepDeviceLinks).toHaveBeenCalledTimes(1);
  });

  it('fails the invocation when a device-link detection failed to record', async () => {
    sweepDeviceLinks.mockResolvedValue({ status: 'done', failed: 2 });

    await expect(handler({}, context)).rejects.toThrow('Device-link sweep failed to record 2 account(s)');
  });

  it('warns without failing when the device-link sweep stops with skipped accounts', async () => {
    sweepDeviceLinks.mockResolvedValue({ status: 'stopped', skipped: 3, failed: 0, assessFailed: 0 });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      await expect(handler({}, context)).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledExactlyOnceWith('Device-link sweep stopped before recording all linked accounts', {
        skipped: 3,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('fails the invocation when a device-link detection was recorded but failed to assess', async () => {
    sweepDeviceLinks.mockResolvedValue({ status: 'done', failed: 0, assessFailed: 3 });

    await expect(handler({}, context)).rejects.toThrow('Device-link sweep recorded but failed to assess 3 account(s)');
  });

  it('fails the invocation when the device-link pass cannot read, after campaign groups are recorded', async () => {
    sweepDeviceLinks.mockRejectedValue(new Error('read down'));

    await expect(handler({}, context)).rejects.toThrow('read down');
    expect(recordCampaignGroup).toHaveBeenCalledTimes(1);
  });

  it('fails the invocation after the run when a group failed to record', async () => {
    recordCampaignGroup.mockRejectedValue(new Error('write failed'));

    await expect(handler({}, context)).rejects.toThrow('failed to record 1 group(s)');
  });

  it('records nothing while shadow detection recording is off, but still auto-grades stale detections', async () => {
    getSettingsMap.mockResolvedValue({ shadowDetectionRecordingEnabled: 'false' });

    await handler({}, context);

    expect(loadCampaignScanAccounts).not.toHaveBeenCalled();
    expect(recordCampaignGroup).not.toHaveBeenCalled();
    expect(sweepDeviceLinks).not.toHaveBeenCalled();
    expect(gradeStaleSignupBursts).toHaveBeenCalledTimes(1);
  });

  it('auto-grades with the configured age, defaulting to 7 days', async () => {
    await handler({}, context);
    expect(gradeStaleSignupBursts).toHaveBeenLastCalledWith(expect.objectContaining({ afterDays: 7 }));

    getSettingsMap.mockResolvedValue({ shadowDetectionAutoGradeAfterDays: 14 });
    await handler({}, context);
    expect(gradeStaleSignupBursts).toHaveBeenLastCalledWith(expect.objectContaining({ afterDays: 14 }));
  });

  it('still runs the campaign sweep when the auto-grade throws', async () => {
    gradeStaleSignupBursts.mockRejectedValue(new Error('read failed'));

    await handler({}, context);

    expect(recordCampaignGroup).toHaveBeenCalledTimes(1);
  });
});
