import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_LINK_POLICY,
  deviceKey,
  deviceKeysOf,
  deviceNetworkSpread,
  findBanEvasionLinks,
  type DeviceLinkAccount,
} from './deviceLinkage';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-11-04T10:00:00Z');
// A rare profile (Android in desktop mode) and a mainstream one; both synthetic.
const RARE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const RARE = deviceKey({ screenResolution: '376x835', devicePixelRatio: 3.25, userAgent: RARE_UA })!;
const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const COMMON = deviceKey({ screenResolution: '390x844', devicePixelRatio: 3, userAgent: PHONE_UA })!;

const account = (userId: string, overrides: Partial<DeviceLinkAccount> = {}): DeviceLinkAccount => ({
  userId,
  signedUpAt: T0,
  deviceKeys: [RARE],
  networkPrefix: '198.51.100.0/24',
  asn: 64500,
  hosting: false,
  fingerprint: null,
  ...overrides,
});

const spread = (entries: [string, number][]) => new Map(entries);

describe('deviceKey', () => {
  it('normalizes the screen, ratio and whitespace', () => {
    expect(deviceKey({ screenResolution: ' 376X835 ', devicePixelRatio: 3.2500001, userAgent: `  ${RARE_UA}  ` })).toBe(
      RARE
    );
  });

  it.each([
    { screenResolution: 'Unknown', devicePixelRatio: 2, userAgent: RARE_UA },
    { screenResolution: '376x835', devicePixelRatio: 0, userAgent: RARE_UA },
    { screenResolution: '376x835', devicePixelRatio: 2, userAgent: 'curl/8' },
    { screenResolution: null, devicePixelRatio: null, userAgent: null },
  ])('is null for a placeholder or missing part (%o)', record => {
    expect(deviceKey(record)).toBeNull();
  });

  it('dedupes the keys of several sign-ins', () => {
    const record = { screenResolution: '376x835', devicePixelRatio: 3.25, userAgent: RARE_UA };
    expect(deviceKeysOf([record, record, { ...record, screenResolution: 'Unknown' }])).toEqual([RARE]);
  });
});

describe('deviceNetworkSpread', () => {
  it('counts distinct networks, by ASN or else by prefix', () => {
    const result = deviceNetworkSpread([
      account('a', { asn: 1 }),
      account('b', { asn: 1 }),
      account('c', { asn: null, networkPrefix: '203.0.113.0/24' }),
      account('d', { asn: null, networkPrefix: null }),
    ]);
    expect(result.get(RARE)).toBe(2);
  });
});

describe('findBanEvasionLinks', () => {
  it('links the VPN farm case: same rare device as a banned account a day earlier, different network', () => {
    const banned = account('banned', { signedUpAt: new Date(T0.getTime() - 27 * HOUR), asn: 64501 });
    const newcomer = account('new', { asn: 13335, hosting: true, networkPrefix: '192.0.2.0/24' });

    const result = findBanEvasionLinks({
      account: newcomer,
      blocked: [banned],
      networkSpread: spread([[RARE, 2]]),
      commonFingerprints: new Set(),
    });

    expect(result).toEqual({
      linked: true,
      matches: [{ blockedUserId: 'banned', corroboration: ['timing'], hoursApart: 27 }],
      deviceNetworkSpread: 2,
    });
  });

  it('never links on a mainstream device, however close in time and network', () => {
    const banned = account('banned', { deviceKeys: [COMMON] });
    const result = findBanEvasionLinks({
      account: account('new', { deviceKeys: [COMMON] }),
      blocked: [banned],
      networkSpread: spread([[COMMON, DEFAULT_DEVICE_LINK_POLICY.commonDeviceMinNetworks]]),
      commonFingerprints: new Set(),
    });
    expect(result).toEqual({ linked: false, reason: 'common_device_only' });
  });

  it('needs a corroborating signal besides the device', () => {
    const banned = account('banned', { signedUpAt: new Date(T0.getTime() - 30 * 24 * HOUR), asn: 64501 });
    const result = findBanEvasionLinks({
      account: account('new', { networkPrefix: '192.0.2.0/24', asn: 64502 }),
      blocked: [banned],
      networkSpread: spread([[RARE, 1]]),
      commonFingerprints: new Set(),
    });
    expect(result).toEqual({ linked: false, reason: 'uncorroborated' });
  });

  it('does not count a shared hosting ASN or a common JA4 as corroboration', () => {
    const old = new Date(T0.getTime() - 30 * 24 * HOUR);
    const banned = account('banned', {
      signedUpAt: old,
      asn: 13335,
      hosting: true,
      networkPrefix: '192.0.2.0/24',
      fingerprint: 'ja4-common',
    });
    const result = findBanEvasionLinks({
      account: account('new', { asn: 13335, hosting: true, networkPrefix: '192.0.3.0/24', fingerprint: 'ja4-common' }),
      blocked: [banned],
      networkSpread: spread([[RARE, 1]]),
      commonFingerprints: new Set(['ja4-common']),
    });
    expect(result).toEqual({ linked: false, reason: 'uncorroborated' });
  });

  it('counts a residential ASN, a /24 and an uncommon JA4, strongest match first', () => {
    const old = new Date(T0.getTime() - 30 * 24 * HOUR);
    const weak = account('weak', { signedUpAt: new Date(T0.getTime() - 5 * HOUR), asn: 1, networkPrefix: null });
    const strong = account('strong', { signedUpAt: old, fingerprint: 'ja4-rare' });
    const result = findBanEvasionLinks({
      account: account('new', { fingerprint: 'ja4-rare' }),
      blocked: [weak, strong],
      networkSpread: spread([[RARE, 1]]),
      commonFingerprints: new Set(),
    });
    expect(result.linked && result.matches).toEqual([
      { blockedUserId: 'strong', corroboration: ['fingerprint', 'network'], hoursApart: 720 },
      { blockedUserId: 'weak', corroboration: ['timing'], hoursApart: 5 },
    ]);
  });

  it('ignores the account itself and accounts with no device', () => {
    expect(
      findBanEvasionLinks({
        account: account('new', { deviceKeys: [] }),
        blocked: [account('banned')],
        networkSpread: spread([]),
        commonFingerprints: new Set(),
      })
    ).toEqual({ linked: false, reason: 'no_device' });
    expect(
      findBanEvasionLinks({
        account: account('same'),
        blocked: [account('same')],
        networkSpread: spread([]),
        commonFingerprints: new Set(),
      })
    ).toEqual({ linked: false, reason: 'no_blocked_device_match' });
  });

  it('respects a narrower timing window', () => {
    const banned = account('banned', { signedUpAt: new Date(T0.getTime() - 27 * HOUR), asn: 64501 });
    const result = findBanEvasionLinks({
      account: account('new', { asn: 64502, networkPrefix: '192.0.2.0/24' }),
      blocked: [banned],
      networkSpread: spread([[RARE, 1]]),
      commonFingerprints: new Set(),
      policy: { ...DEFAULT_DEVICE_LINK_POLICY, timingWindowHours: 24 },
    });
    expect(result).toEqual({ linked: false, reason: 'uncorroborated' });
  });
});
