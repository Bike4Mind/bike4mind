import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { INetworkMeta } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  countRecentSignups: vi.fn(),
  claimDedup: vi.fn(),
  deleteByKey: vi.fn(),
  postMessageToSlackWithOutcome: vi.fn(),
  loggerError: vi.fn(),
  recordShadowDetection: vi.fn(),
  userWrite: vi.fn(),
  findRecentSignupsOnIp: vi.fn(),
  findLinkStatesByIds: vi.fn(),
  spendProfileByUsers: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { claimDedup: mocks.claimDedup, deleteByKey: mocks.deleteByKey },
  shadowDetectionRepository: { record: mocks.recordShadowDetection },
  // Shadow recording must never act on the account: any write here fails the no-side-effects test.
  userRepository: {
    update: mocks.userWrite,
    updateOne: mocks.userWrite,
    findByIdAndUpdate: mocks.userWrite,
    findLinkStatesByIds: mocks.findLinkStatesByIds,
  },
  authEventRepository: { findRecentSignupsOnIp: mocks.findRecentSignupsOnIp },
  usageEventRepository: { spendProfileByUsers: mocks.spendProfileByUsers },
  userApiKeyRepository: { update: mocks.userWrite, revokeAllForUser: mocks.userWrite },
  creditTransactionRepository: { create: mocks.userWrite },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => mocks.settings,
}));
vi.mock('@bike4mind/server-utils/auth/signupNetworkSignals', () => ({
  countRecentSignups: mocks.countRecentSignups,
  hashSignupNetwork: (ip: string | null) => ({ ipHash: ip ? `hash:${ip}` : null, prefixHash: null }),
  MAX_COUNTED_ROWS: 5000,
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({
  postMessageToSlackWithOutcome: mocks.postMessageToSlackWithOutcome,
}));

import { Logger } from '@bike4mind/observability';
import {
  alertSignupNetworkBurst,
  asnThresholdFor,
  buildSignupNetworkShadowDetection,
  evaluateSignupNetworkBursts,
  formatSignupNetworkAlert,
  readIpCorroboration,
  readSignupNetworkAlertThresholds,
  SIGNUP_NETWORK_BURST_POLICY_VERSION,
  type SignupNetworkAlertThresholds,
} from './signupNetworkAlerts';

const THRESHOLDS: SignupNetworkAlertThresholds = {
  enabled: true,
  windowMinutes: 180,
  maxPerIp: 1,
  minUncorroboratedPerIp: 3,
  maxPerHostingAsn: 2,
  maxPerAsn: 0,
};

const HOSTED: INetworkMeta = {
  ip: '203.0.113.7',
  userAgent: null,
  asn: 64500,
  asnOrg: 'Example Cloud',
  country: 'US',
  isDatacenter: true,
  ja4: null,
  wafAnonIp: null,
  wafBotSignal: null,
};
const CONSUMER: INetworkMeta = { ...HOSTED, asn: 64501, asnOrg: null, isDatacenter: false, wafAnonIp: false };

describe('readSignupNetworkAlertThresholds', () => {
  it('defaults to alerting on a repeat IP and a third hosted signup, with the any-network check off', () => {
    expect(readSignupNetworkAlertThresholds({})).toEqual(THRESHOLDS);
  });

  it('reads admin overrides', () => {
    expect(
      readSignupNetworkAlertThresholds({
        signupNetworkAlertsEnabled: 'false',
        signupNetworkAlertWindowMinutes: '60',
        signupNetworkAlertMaxPerIp: '3',
        signupNetworkAlertMaxPerHostingAsn: '0',
        signupNetworkAlertMaxPerAsn: '50',
      })
    ).toEqual({
      enabled: false,
      windowMinutes: 60,
      maxPerIp: 3,
      minUncorroboratedPerIp: 3,
      maxPerHostingAsn: 0,
      maxPerAsn: 50,
    });
    expect(
      readSignupNetworkAlertThresholds({ signupNetworkAlertMinUncorroboratedPerIp: '5' }).minUncorroboratedPerIp
    ).toBe(5);
  });
});

describe('asnThresholdFor', () => {
  it('applies the hosting threshold only to a hosted signup', () => {
    expect(asnThresholdFor(THRESHOLDS, true)).toBe(2);
    expect(asnThresholdFor(THRESHOLDS, false)).toBe(0);
    expect(asnThresholdFor(THRESHOLDS, null)).toBe(0);
  });

  it('takes the stricter threshold when both apply, and the any-network one alone otherwise', () => {
    const both = { ...THRESHOLDS, maxPerAsn: 10 };
    expect(asnThresholdFor(both, true)).toBe(2);
    expect(asnThresholdFor(both, false)).toBe(10);
    expect(asnThresholdFor({ ...both, maxPerHostingAsn: 20 }, true)).toBe(10);
  });
});

describe('evaluateSignupNetworkBursts', () => {
  it('trips when a count goes over its threshold, not at it', () => {
    expect(
      evaluateSignupNetworkBursts({ counts: { ipSignups: 1, asnSignups: 2 }, hosting: true, thresholds: THRESHOLDS })
    ).toEqual([]);
    expect(
      evaluateSignupNetworkBursts({ counts: { ipSignups: 2, asnSignups: 3 }, hosting: true, thresholds: THRESHOLDS })
    ).toEqual([
      { scope: 'ip', signups: 2, max: 1, corroboratedBy: ['anonymousNetwork'] },
      { scope: 'asn', signups: 3, max: 2, hosting: true },
    ]);
  });

  it('needs corroboration for a residential IP below the uncorroborated threshold', () => {
    const counts = { ipSignups: 2, asnSignups: null };
    expect(evaluateSignupNetworkBursts({ counts, hosting: false, thresholds: THRESHOLDS })).toEqual([]);
    expect(evaluateSignupNetworkBursts({ counts, hosting: null, thresholds: THRESHOLDS })).toEqual([]);
    expect(
      evaluateSignupNetworkBursts({ counts, hosting: false, thresholds: THRESHOLDS, corroboration: ['sharedMailbox'] })
    ).toEqual([{ scope: 'ip', signups: 2, max: 1, corroboratedBy: ['sharedMailbox'] }]);
  });

  it('fires on the count alone once it reaches the uncorroborated threshold', () => {
    expect(
      evaluateSignupNetworkBursts({
        counts: { ipSignups: 3, asnSignups: null },
        hosting: false,
        thresholds: THRESHOLDS,
      })
    ).toEqual([{ scope: 'ip', signups: 3, max: 1, corroboratedBy: [] }]);
    // A truncated scan is far over any threshold.
    expect(
      evaluateSignupNetworkBursts({
        counts: { ipSignups: Infinity, asnSignups: null },
        hosting: false,
        thresholds: THRESHOLDS,
      })
    ).toHaveLength(1);
  });

  it('restores count-only alerting when the uncorroborated threshold is one over the max', () => {
    expect(
      evaluateSignupNetworkBursts({
        counts: { ipSignups: 2, asnSignups: null },
        hosting: false,
        thresholds: { ...THRESHOLDS, minUncorroboratedPerIp: 2 },
      })
    ).toEqual([{ scope: 'ip', signups: 2, max: 1, corroboratedBy: [] }]);
  });

  it('ignores a busy consumer network unless the any-network check is on', () => {
    const counts = { ipSignups: null, asnSignups: 40 };
    expect(evaluateSignupNetworkBursts({ counts, hosting: false, thresholds: THRESHOLDS })).toEqual([]);
    expect(
      evaluateSignupNetworkBursts({ counts, hosting: false, thresholds: { ...THRESHOLDS, maxPerAsn: 30 } })
    ).toEqual([{ scope: 'asn', signups: 40, max: 30, hosting: false }]);
  });

  it('never trips on an unchecked count or a 0 threshold', () => {
    const off = { ...THRESHOLDS, maxPerIp: 0, maxPerHostingAsn: 0 };
    expect(
      evaluateSignupNetworkBursts({ counts: { ipSignups: 99, asnSignups: 99 }, hosting: true, thresholds: off })
    ).toEqual([]);
    expect(
      evaluateSignupNetworkBursts({
        counts: { ipSignups: null, asnSignups: null },
        hosting: true,
        thresholds: THRESHOLDS,
      })
    ).toEqual([]);
  });
});

describe('formatSignupNetworkAlert', () => {
  it('names the IP, network and latest account for an IP burst', () => {
    const text = formatSignupNetworkAlert({
      burst: { scope: 'ip', signups: 3, max: 1, corroboratedBy: ['anonymousNetwork'] },
      network: HOSTED,
      userId: 'u1',
      windowMinutes: 180,
    });
    expect(text).toContain('*Signup burst from one IP*');
    expect(text).toContain('3 self-serve accounts in the last 180 minutes (alerts above 1)');
    expect(text).toContain('*IP:* `203.0.113.7`');
    expect(text).toContain('*Network:* AS64500 (Example Cloud), hosting/VPN: yes');
    expect(text).toContain('`u1`');
    expect(text).toContain('*Corroborated by:* Hosting or anonymous-IP network');
  });

  it('leaves the IP out of a network burst and reports a truncated count as a floor', () => {
    const text = formatSignupNetworkAlert({
      burst: { scope: 'asn', signups: Infinity, max: 30, hosting: false },
      network: CONSUMER,
      userId: 'u1',
      windowMinutes: 60,
    });
    expect(text).toContain('*Signup burst from one network*');
    expect(text).toContain('more than 5,000 self-serve accounts');
    expect(text).not.toContain('*IP:*');
    expect(text).toContain('hosting/VPN: no');
  });
});

describe('alertSignupNetworkBurst', () => {
  beforeEach(() => {
    mocks.settings = {};
    mocks.countRecentSignups.mockReset().mockResolvedValue({ ipSignups: 2, prefixSignups: null, asnSignups: 3 });
    mocks.claimDedup.mockReset().mockResolvedValue({ claimed: true });
    mocks.deleteByKey.mockReset().mockResolvedValue(undefined);
    mocks.postMessageToSlackWithOutcome.mockReset().mockResolvedValue('sent');
    mocks.loggerError.mockReset();
    mocks.recordShadowDetection.mockReset().mockResolvedValue('d1');
    mocks.userWrite.mockReset();
    mocks.findRecentSignupsOnIp.mockReset().mockResolvedValue([]);
    mocks.findLinkStatesByIds.mockReset().mockResolvedValue([]);
    mocks.spendProfileByUsers.mockReset().mockResolvedValue({});
    vi.spyOn(Logger.globalInstance, 'error').mockImplementation(mocks.loggerError);
  });

  it('counts over the configured window and alerts each tripped network once to the security channel', async () => {
    mocks.settings = { signupNetworkAlertWindowMinutes: '120' };
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });

    expect(mocks.countRecentSignups).toHaveBeenCalledWith(
      expect.objectContaining({
        network: HOSTED,
        windows: { ip: true, prefix: false, asn: true },
        windowMs: { ip: 120 * 60_000, asn: 120 * 60_000 },
      })
    );
    expect(mocks.claimDedup).toHaveBeenCalledWith(
      'signup-network-alert:ip:hash:203.0.113.7',
      { userId: 'u1' },
      7_200_000
    );
    expect(mocks.claimDedup).toHaveBeenCalledWith('signup-network-alert:asn:64500', { userId: 'u1' }, 7_200_000);
    expect(mocks.postMessageToSlackWithOutcome).toHaveBeenCalledTimes(2);
    expect(mocks.postMessageToSlackWithOutcome).toHaveBeenCalledWith(
      expect.stringContaining('Signup burst from one hosting/VPN network'),
      'SlackSecurityAlertsWebhookUrl',
      { timeoutMs: 3000 }
    );
  });

  it('posts nothing when the network already alerted this window', async () => {
    mocks.claimDedup.mockResolvedValue({ claimed: false });
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'google' });
    expect(mocks.postMessageToSlackWithOutcome).not.toHaveBeenCalled();
  });

  it('releases the claim after a failed post so the next signup retries, but keeps it when alerts are off', async () => {
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: 3, prefixSignups: null, asnSignups: null });
    mocks.postMessageToSlackWithOutcome.mockResolvedValueOnce('failed');
    await alertSignupNetworkBurst({ network: CONSUMER, userId: 'u1', method: 'otc' });
    expect(mocks.deleteByKey).toHaveBeenCalledWith('signup-network-alert:ip:hash:203.0.113.7');
    expect(mocks.loggerError).toHaveBeenCalled();

    mocks.deleteByKey.mockClear();
    mocks.postMessageToSlackWithOutcome.mockResolvedValueOnce('unconfigured');
    await alertSignupNetworkBurst({ network: CONSUMER, userId: 'u1', method: 'otc' });
    expect(mocks.deleteByKey).not.toHaveBeenCalled();
  });

  it('skips the ASN count for a consumer network when only the hosting check is on', async () => {
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: 1, prefixSignups: null, asnSignups: null });
    await alertSignupNetworkBurst({ network: CONSUMER, userId: 'u1', method: 'otc' });
    expect(mocks.countRecentSignups).toHaveBeenCalledWith(
      expect.objectContaining({ windows: { ip: true, prefix: false, asn: false } })
    );
    expect(mocks.claimDedup).not.toHaveBeenCalled();
  });

  it('treats a truncated scan as over the threshold', async () => {
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: null, prefixSignups: null, asnSignups: null });
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });
    expect(mocks.postMessageToSlackWithOutcome).toHaveBeenCalledWith(
      expect.stringContaining('more than 5,000'),
      'SlackSecurityAlertsWebhookUrl',
      { timeoutMs: 3000 }
    );
  });

  it.each(['okta', 'saml'])('ignores enterprise SSO signups (%s)', async method => {
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method });
    expect(mocks.countRecentSignups).not.toHaveBeenCalled();
  });

  it('does nothing when the alerts are switched off', async () => {
    mocks.settings = { signupNetworkAlertsEnabled: 'false' };
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });
    expect(mocks.countRecentSignups).not.toHaveBeenCalled();
  });

  it('never throws when the count fails', async () => {
    mocks.countRecentSignups.mockRejectedValue(new Error('db down'));
    await expect(alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' })).resolves.toBeUndefined();
    expect(mocks.loggerError).toHaveBeenCalledWith('[signup-network-alerts] Burst check failed', expect.any(Error));
  });

  it('records one shadow detection per signup, with a signal per tripped burst, under each burst claim', async () => {
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });

    expect(mocks.claimDedup).toHaveBeenCalledWith(
      'shadow-detection:signup-network:ip:hash:203.0.113.7',
      { userId: 'u1' },
      180 * 60_000
    );
    expect(mocks.claimDedup).toHaveBeenCalledWith(
      'shadow-detection:signup-network:asn:64500',
      { userId: 'u1' },
      180 * 60_000
    );
    expect(mocks.recordShadowDetection).toHaveBeenCalledTimes(1);
    expect(mocks.recordShadowDetection).toHaveBeenCalledWith(
      expect.objectContaining({
        detector: 'signupNetworkBurst',
        policyVersion: SIGNUP_NETWORK_BURST_POLICY_VERSION,
        wouldAction: 'contain',
        userIds: ['u1'],
        summary: '2 self-serve signups from one IP and 3 from one network in 180 minutes',
        signals: [
          { key: 'ipSignups', label: expect.any(String), observed: 2, threshold: 1 },
          { key: 'anonymousNetwork', label: expect.any(String), observed: 1, threshold: null },
          { key: 'asnSignups', label: expect.any(String), observed: 3, threshold: 2 },
        ],
      })
    );
    expect(mocks.postMessageToSlackWithOutcome).toHaveBeenCalledTimes(2);
  });

  it('records nothing when every shadow claim is already held, even if the alert claims are free', async () => {
    mocks.claimDedup.mockImplementation(async (key: string) => ({ claimed: !key.startsWith('shadow-detection:') }));
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });
    expect(mocks.recordShadowDetection).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlackWithOutcome).toHaveBeenCalledTimes(2);
  });

  it('still records once, with both signals, when only one shadow claim is won', async () => {
    mocks.claimDedup.mockImplementation(async (key: string) => ({
      claimed: key !== 'shadow-detection:signup-network:ip:hash:203.0.113.7',
    }));
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });
    expect(mocks.recordShadowDetection).toHaveBeenCalledTimes(1);
    expect(mocks.recordShadowDetection).toHaveBeenCalledWith(
      expect.objectContaining({
        signals: [
          expect.objectContaining({ key: 'ipSignups' }),
          expect.objectContaining({ key: 'anonymousNetwork' }),
          expect.objectContaining({ key: 'asnSignups' }),
        ],
      })
    );
  });

  it('keeps the shadow claim when the Slack post fails', async () => {
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: 3, prefixSignups: null, asnSignups: null });
    mocks.postMessageToSlackWithOutcome.mockResolvedValue('failed');
    await alertSignupNetworkBurst({ network: CONSUMER, userId: 'u1', method: 'otc' });
    expect(mocks.recordShadowDetection).toHaveBeenCalledTimes(1);
    expect(mocks.deleteByKey).toHaveBeenCalledTimes(1);
    expect(mocks.deleteByKey).toHaveBeenCalledWith('signup-network-alert:ip:hash:203.0.113.7');
  });

  it('records nothing when shadow recording is switched off, and still alerts', async () => {
    mocks.settings = { shadowDetectionRecordingEnabled: 'false' };
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });
    expect(mocks.recordShadowDetection).not.toHaveBeenCalled();
    expect(mocks.claimDedup).not.toHaveBeenCalledWith(
      expect.stringMatching(/^shadow-detection:/),
      expect.anything(),
      expect.anything()
    );
    expect(mocks.postMessageToSlackWithOutcome).toHaveBeenCalledTimes(2);
  });

  it('records nothing when the alerts are switched off', async () => {
    mocks.settings = { signupNetworkAlertsEnabled: 'false' };
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });
    expect(mocks.recordShadowDetection).not.toHaveBeenCalled();
  });

  it('releases the shadow claims it won when recording fails, still alerts, and logs the failure', async () => {
    mocks.claimDedup.mockImplementation(async (key: string) => ({
      claimed: key !== 'shadow-detection:signup-network:asn:64500',
    }));
    mocks.recordShadowDetection.mockRejectedValue(new Error('db down'));
    await expect(alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' })).resolves.toBeUndefined();
    expect(mocks.postMessageToSlackWithOutcome).toHaveBeenCalledTimes(2);
    expect(mocks.deleteByKey).toHaveBeenCalledTimes(1);
    expect(mocks.deleteByKey).toHaveBeenCalledWith('shadow-detection:signup-network:ip:hash:203.0.113.7');
    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[signup-network-alerts] Shadow detection was not recorded',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('stays silent for two residential signups from one IP with nothing tying them together', async () => {
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: 2, prefixSignups: null, asnSignups: null });
    mocks.findRecentSignupsOnIp.mockResolvedValue([{ userId: 'u0', ja4: null }]);
    mocks.findLinkStatesByIds.mockResolvedValue([
      { id: 'u1', email: 'asha@gmail.com' },
      { id: 'u0', email: 'ravi@gmail.com' },
    ]);
    await alertSignupNetworkBurst({ network: CONSUMER, userId: 'u1', method: 'otc' });
    expect(mocks.findRecentSignupsOnIp).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '203.0.113.7', excludeUserId: 'u1', limit: 20 })
    );
    expect(mocks.postMessageToSlackWithOutcome).not.toHaveBeenCalled();
    expect(mocks.recordShadowDetection).not.toHaveBeenCalled();
  });

  it('fires for two residential signups that share a mailbox, naming the corroboration', async () => {
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: 2, prefixSignups: null, asnSignups: null });
    mocks.findRecentSignupsOnIp.mockResolvedValue([{ userId: 'u0', ja4: null }]);
    mocks.findLinkStatesByIds.mockResolvedValue([
      { id: 'u1', email: 'farm+x7k2q9@outlook.com' },
      { id: 'u0', email: 'farm+p3m8z1@outlook.com' },
    ]);
    await alertSignupNetworkBurst({ network: CONSUMER, userId: 'u1', method: 'otc' });
    expect(mocks.recordShadowDetection).toHaveBeenCalledWith(
      expect.objectContaining({
        policyVersion: 2,
        signals: [
          expect.objectContaining({ key: 'ipSignups', observed: 2 }),
          expect.objectContaining({ key: 'sharedMailbox', observed: 1 }),
        ],
      })
    );
    expect(mocks.postMessageToSlackWithOutcome).toHaveBeenCalledWith(
      expect.stringContaining('*Corroborated by:* Shares a mailbox'),
      'SlackSecurityAlertsWebhookUrl',
      { timeoutMs: 3000 }
    );
  });

  it('does not read corroboration when the count decides alone', async () => {
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: 3, prefixSignups: null, asnSignups: null });
    await alertSignupNetworkBurst({ network: CONSUMER, userId: 'u1', method: 'otc' });
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });
    expect(mocks.findRecentSignupsOnIp).not.toHaveBeenCalled();
    expect(mocks.recordShadowDetection).toHaveBeenCalledTimes(2);
  });

  it('treats a failed corroboration read as uncorroborated and never throws', async () => {
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: 2, prefixSignups: null, asnSignups: null });
    mocks.findRecentSignupsOnIp.mockRejectedValue(new Error('db down'));
    await expect(alertSignupNetworkBurst({ network: CONSUMER, userId: 'u1', method: 'otc' })).resolves.toBeUndefined();
    expect(mocks.recordShadowDetection).not.toHaveBeenCalled();
  });

  it('never writes to the account, its keys or its credits', async () => {
    await alertSignupNetworkBurst({ network: HOSTED, userId: 'u1', method: 'otc' });
    expect(mocks.recordShadowDetection).toHaveBeenCalled();
    expect(mocks.userWrite).not.toHaveBeenCalled();
  });
});

describe('buildSignupNetworkShadowDetection', () => {
  const detectedAt = new Date('2026-10-01T00:00:00Z');

  it('describes a network burst with the network it came from', () => {
    expect(
      buildSignupNetworkShadowDetection({
        bursts: [{ scope: 'asn', signups: 3, max: 2, hosting: true }],
        network: HOSTED,
        userId: 'u1',
        windowMinutes: 60,
        detectedAt,
      })
    ).toEqual({
      detector: 'signupNetworkBurst',
      policyVersion: 2,
      wouldAction: 'contain',
      summary: '3 self-serve signups from one network in 60 minutes',
      userIds: ['u1'],
      network: { ip: '203.0.113.7', asn: 64500, asnOrg: 'Example Cloud', country: 'US', hosting: true },
      signals: [{ key: 'asnSignups', label: 'Self-serve signups from this network', observed: 3, threshold: 2 }],
      windowMinutes: 60,
      group: null,
      payment: null,
      detectedAt,
    });
  });

  it('names every tripped scope and carries a signal for each', () => {
    const detection = buildSignupNetworkShadowDetection({
      bursts: [
        { scope: 'ip', signups: 3, max: 1, corroboratedBy: [] },
        { scope: 'asn', signups: 7, max: 2, hosting: true },
      ],
      network: HOSTED,
      userId: 'u1',
      windowMinutes: 180,
      detectedAt,
    });
    expect(detection.summary).toBe('3 self-serve signups from one IP and 7 from one network in 180 minutes');
    expect(detection.signals).toEqual([
      { key: 'ipSignups', label: 'Self-serve signups from this IP', observed: 3, threshold: 1 },
      { key: 'asnSignups', label: 'Self-serve signups from this network', observed: 7, threshold: 2 },
    ]);
  });

  it('reports a truncated count as a floor with no observed number', () => {
    const detection = buildSignupNetworkShadowDetection({
      bursts: [
        { scope: 'ip', signups: Infinity, max: 1, corroboratedBy: [] },
        { scope: 'asn', signups: Infinity, max: 2, hosting: false },
      ],
      network: CONSUMER,
      userId: 'u1',
      windowMinutes: 180,
      detectedAt,
    });
    expect(detection.summary).toBe(
      'more than 5,000 self-serve signups from one IP and more than 5,000 from one network in 180 minutes'
    );
    expect(detection.signals).toEqual([
      expect.objectContaining({ observed: null, threshold: 1 }),
      expect.objectContaining({ observed: null, threshold: 2 }),
    ]);
    expect(detection.network?.hosting).toBe(false);
  });
});

describe('readIpCorroboration', () => {
  const window = { since: new Date('2026-10-01T00:00:00Z'), until: new Date('2026-10-01T03:00:00Z') };
  const deps = (input: {
    siblings: { userId: string; ja4: string | null }[];
    emails?: { id: string; email: string | null }[];
    spend?: Record<string, { totalCredits: number }>;
  }) => ({
    findRecentSignupsOnIp: vi.fn().mockResolvedValue(input.siblings),
    findEmails: vi.fn().mockResolvedValue(input.emails ?? []),
    spendSince: vi.fn().mockResolvedValue(input.spend ?? {}),
  });

  it('finds nothing for unrelated household signups', async () => {
    const result = await readIpCorroboration({
      network: { ip: '198.51.100.4', ja4: 't13d1516h2_a' },
      userId: 'u1',
      ...window,
      deps: deps({
        siblings: [{ userId: 'u0', ja4: 't13d1516h2_b' }],
        emails: [
          { id: 'u1', email: 'asha@gmail.com' },
          { id: 'u0', email: 'ravi@yahoo.com' },
        ],
      }),
    });
    expect(result).toEqual([]);
  });

  it('names a shared JA4, mailbox, company mail domain and a sibling that already spent', async () => {
    const result = await readIpCorroboration({
      network: { ip: '198.51.100.4', ja4: 't13d1516h2_a' },
      userId: 'u1',
      ...window,
      deps: deps({
        siblings: [
          { userId: 'u0', ja4: 't13d1516h2_a' },
          { userId: 'u2', ja4: null },
          { userId: 'u3', ja4: null },
        ],
        emails: [
          { id: 'u1', email: 'j.doe+1@gmail.com' },
          { id: 'u0', email: 'jdoe@gmail.com' },
          { id: 'u2', email: 'someone@example.org' },
          { id: 'u3', email: 'other@example.net' },
        ],
        spend: { u3: { totalCredits: 900 } },
      }),
    });
    expect(result).toEqual(['sharedJa4', 'sharedMailbox', 'siblingSpent']);
  });

  it('counts a shared company domain but not a shared webmail domain', async () => {
    const run = (emails: { id: string; email: string }[]) =>
      readIpCorroboration({
        network: { ip: '198.51.100.4', ja4: null },
        userId: 'u1',
        ...window,
        deps: deps({ siblings: [{ userId: 'u0', ja4: null }], emails }),
      });
    expect(
      await run([
        { id: 'u1', email: 'a@acme-labs.io' },
        { id: 'u0', email: 'b@acme-labs.io' },
      ])
    ).toEqual(['sharedMailDomain']);
    expect(
      await run([
        { id: 'u1', email: 'a@gmail.com' },
        { id: 'u0', email: 'b@gmail.com' },
      ])
    ).toEqual([]);
  });

  it('reads nothing further when the IP has no earlier signup', async () => {
    const d = deps({ siblings: [] });
    expect(
      await readIpCorroboration({ network: { ip: '198.51.100.4', ja4: null }, userId: 'u1', ...window, deps: d })
    ).toEqual([]);
    expect(d.findEmails).not.toHaveBeenCalled();
  });
});
