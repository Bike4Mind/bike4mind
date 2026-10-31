import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { INetworkMeta } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  countRecentSignups: vi.fn(),
  claimDedup: vi.fn(),
  deleteByKey: vi.fn(),
  postMessageToSlackWithOutcome: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { claimDedup: mocks.claimDedup, deleteByKey: mocks.deleteByKey },
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
  evaluateSignupNetworkBursts,
  formatSignupNetworkAlert,
  readSignupNetworkAlertThresholds,
  type SignupNetworkAlertThresholds,
} from './signupNetworkAlerts';

const THRESHOLDS: SignupNetworkAlertThresholds = {
  enabled: true,
  windowMinutes: 180,
  maxPerIp: 1,
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
    ).toEqual({ enabled: false, windowMinutes: 60, maxPerIp: 3, maxPerHostingAsn: 0, maxPerAsn: 50 });
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
      { scope: 'ip', signups: 2, max: 1 },
      { scope: 'asn', signups: 3, max: 2, hosting: true },
    ]);
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
      burst: { scope: 'ip', signups: 3, max: 1 },
      network: HOSTED,
      userId: 'u1',
      windowMinutes: 180,
    });
    expect(text).toContain('*Signup burst from one IP*');
    expect(text).toContain('3 self-serve accounts in the last 180 minutes (alerts above 1)');
    expect(text).toContain('*IP:* `203.0.113.7`');
    expect(text).toContain('*Network:* AS64500 (Example Cloud), hosting/VPN: yes');
    expect(text).toContain('`u1`');
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
    mocks.countRecentSignups.mockResolvedValue({ ipSignups: 2, prefixSignups: null, asnSignups: null });
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
});
