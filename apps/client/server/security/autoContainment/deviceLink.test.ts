import { describe, expect, it, vi } from 'vitest';
import type { DeviceLinkRow } from '@bike4mind/database';

vi.mock('@bike4mind/database', () => ({
  cacheRepository: {},
  shadowDetectionRepository: {},
  countSignupsWithFingerprint: vi.fn(),
  findBannedDeviceLinkAccounts: vi.fn(),
  findDeviceBaselineAccounts: vi.fn(),
  loadDeviceLinkAccounts: vi.fn(),
}));
vi.mock('@server/security/abuseAssessment/abuseAssessment', () => ({ assessShadowDetection: vi.fn() }));
vi.mock('@server/security/abuseAssessment/linkedAccountEvidence', () => ({ linkedAccountGroupEvidence: vi.fn() }));
vi.mock('./executor', () => ({
  applyAutoContainment: vi.fn(),
  liveAutoContainmentDeps: vi.fn(),
  loadAutoContainmentConfig: vi.fn(),
}));

import { checkDeviceLink, sweepDeviceLinks, type DeviceLinkDeps } from './deviceLink';

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-11-05T12:00:00Z');
// Synthetic rare profile (an Android phone in desktop mode) and a mainstream phone profile.
const RARE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const RARE_DEVICE = { screenResolution: '376x835', devicePixelRatio: 3.25, userAgent: RARE_UA };
const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const PHONE_DEVICE = { screenResolution: '390x844', devicePixelRatio: 3, userAgent: PHONE_UA };

const row = (userId: string, overrides: Partial<DeviceLinkRow> = {}): DeviceLinkRow => ({
  userId,
  createdAt: new Date(NOW.getTime() - HOUR_MS),
  signupIp: '192.0.2.10',
  asn: 13335,
  isDatacenter: true,
  ja4: null,
  devices: [RARE_DEVICE],
  ...overrides,
});

const newcomer = row('new-user');
const banned = row('banned-user', {
  createdAt: new Date(NOW.getTime() - 28 * HOUR_MS),
  signupIp: '198.51.100.20',
  asn: 64501,
  isDatacenter: false,
});

function makeDeps(overrides: Partial<DeviceLinkDeps> = {}): DeviceLinkDeps {
  return {
    loadConfig: vi.fn(async () => ({ windowHours: 168, commonNetworks: 5 })),
    loadAccounts: vi.fn(async () => [newcomer]),
    findBanned: vi.fn(async () => [banned]),
    findBaseline: vi.fn(async () => [newcomer, banned]),
    isCommonFingerprint: vi.fn(async () => false),
    claimOnce: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => undefined),
    recordDetection: vi.fn(async () => 'detection-1'),
    assessAndContain: vi.fn(async () => ({ assessed: true, contained: false })),
    now: () => NOW,
    ...overrides,
  };
}

describe('checkDeviceLink', () => {
  it("records and assesses a new account on a banned account's rare device despite a rotated VPN exit", async () => {
    const deps = makeDeps();

    const result = await checkDeviceLink('new-user', deps);

    expect(result).toEqual({ status: 'recorded', detectionId: 'detection-1', assessed: true, contained: false });
    expect(deps.findBanned).toHaveBeenCalledWith([RARE_UA]);
    const detection = vi.mocked(deps.recordDetection).mock.calls[0][0];
    expect(detection).toMatchObject({
      detector: 'deviceLinkedToBlocked',
      wouldAction: 'contain',
      userIds: ['new-user'],
    });
    expect(detection.summary).toBe(
      'Used the same device as 1 banned account, the closest 27 hours apart, with signups close in time'
    );
    expect(Object.fromEntries(detection.signals.map(signal => [signal.key, signal.observed]))).toEqual({
      bannedDeviceLinks: 1,
      deviceNetworkSpread: 2,
      corroboratingSignals: 1,
      sameFingerprint: 0,
      sameSignupNetwork: 0,
      hoursToBannedDeviceLink: 27,
    });
    expect(deps.assessAndContain).toHaveBeenCalledWith('detection-1');
  });

  it('skips an OAuth signup with no recorded device without reading banned accounts', async () => {
    const deps = makeDeps({ loadAccounts: vi.fn(async () => [row('new-user', { devices: [] })]) });

    expect(await checkDeviceLink('new-user', deps)).toEqual({ status: 'skipped', reason: 'no_device' });
    expect(deps.findBanned).not.toHaveBeenCalled();
  });

  it('does not link on a mainstream device seen across many networks', async () => {
    const phone = { devices: [PHONE_DEVICE] };
    const baseline = [64510, 64511, 64512, 64513, 64514].map(asn => row(`other-${asn}`, { ...phone, asn }));
    const deps = makeDeps({
      loadAccounts: vi.fn(async () => [row('new-user', phone)]),
      findBanned: vi.fn(async () => [{ ...banned, ...phone }]),
      findBaseline: vi.fn(async () => baseline),
    });

    expect(await checkDeviceLink('new-user', deps)).toEqual({ status: 'skipped', reason: 'common_device_only' });
    expect(deps.recordDetection).not.toHaveBeenCalled();
  });

  it('does not link on a device match alone, long after the ban and on another network', async () => {
    const deps = makeDeps({
      findBanned: vi.fn(async () => [{ ...banned, createdAt: new Date(NOW.getTime() - 60 * 24 * HOUR_MS) }]),
    });

    expect(await checkDeviceLink('new-user', deps)).toEqual({ status: 'skipped', reason: 'uncorroborated' });
  });

  it('is off when the config is off', async () => {
    const deps = makeDeps({ loadConfig: vi.fn(async () => null) });

    expect(await checkDeviceLink('new-user', deps)).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(deps.loadAccounts).not.toHaveBeenCalled();
  });

  it('records an account once', async () => {
    const deps = makeDeps({ claimOnce: vi.fn(async () => false) });

    expect(await checkDeviceLink('new-user', deps)).toEqual({ status: 'skipped', reason: 'already_recorded' });
    expect(deps.recordDetection).not.toHaveBeenCalled();
  });

  it('releases the claim when recording fails, so a later pass retries', async () => {
    const deps = makeDeps({ recordDetection: vi.fn(async () => Promise.reject(new Error('write failed'))) });

    await expect(checkDeviceLink('new-user', deps)).rejects.toThrow('write failed');
    expect(deps.releaseClaim).toHaveBeenCalledWith('new-user');
  });
});

describe('sweepDeviceLinks', () => {
  it('counts linked, recorded and failed accounts and keeps going after a failure', async () => {
    const second = row('second-user');
    const onError = vi.fn();
    const deps = makeDeps({
      recordDetection: vi.fn(async input =>
        input.userIds[0] === 'second-user' ? Promise.reject(new Error('write failed')) : 'detection-1'
      ),
    });

    const report = await sweepDeviceLinks({
      ...deps,
      loadRecent: vi.fn(async () => ({
        rows: [newcomer, second, row('oauth-user', { devices: [] })],
        truncated: false,
      })),
      onError,
    });

    expect(report).toEqual({
      status: 'done',
      scanned: 3,
      scanTruncated: false,
      linked: 2,
      recorded: 1,
      alreadyRecorded: 0,
      failed: 1,
    });
    expect(onError).toHaveBeenCalledWith('second-user', expect.any(Error));
  });

  it('reads nothing when disabled', async () => {
    const loadRecent = vi.fn();
    const report = await sweepDeviceLinks({ ...makeDeps({ loadConfig: vi.fn(async () => null) }), loadRecent });

    expect(report.status).toBe('disabled');
    expect(loadRecent).not.toHaveBeenCalled();
  });
});
