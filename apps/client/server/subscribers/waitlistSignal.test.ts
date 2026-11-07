import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { INetworkMeta } from '@bike4mind/common';

const meta = vi.hoisted(() => ({ current: {} as INetworkMeta }));
vi.mock('@server/auth/networkMeta', () => ({ readNetworkMeta: () => meta.current }));
import { recordTurnstileVerification } from '@server/auth/signupChallenge';
import { readSubscriberSignupNetwork, suspiciousNameReasons } from './waitlistSignal';

const request = () => ({ headers: {}, socket: {} }) as Parameters<typeof readSubscriberSignupNetwork>[0];

beforeEach(() => {
  meta.current = {
    ip: '203.0.113.195',
    userAgent: 'curl/8.4',
    asn: 64500,
    asnOrg: null,
    country: 'NL',
    isDatacenter: true,
  };
});

describe('readSubscriberSignupNetwork', () => {
  it('keeps only the /24 of an IPv4 address and nulls the fields the capture did not set', () => {
    expect(readSubscriberSignupNetwork(request())).toEqual({
      ipPrefix: '203.0.113.0',
      userAgent: 'curl/8.4',
      asn: 64500,
      asnOrg: null,
      country: 'NL',
      isDatacenter: true,
      ja4: null,
      wafAnonIp: null,
      wafBotSignal: null,
      challengeVerified: null,
      capturedAt: expect.any(Date),
    });
  });

  it('keeps only the /48 of an IPv6 address', () => {
    meta.current = { ...meta.current, ip: '2001:db8:85a3:1:2:3:4:5' };
    expect(readSubscriberSignupNetwork(request()).ipPrefix).toBe('2001:db8:85a3:0:0:0:0:0');
  });

  it('stores no prefix when the IP is unknown, and bounds a long user agent', () => {
    meta.current = { ...meta.current, ip: null, userAgent: 'A'.repeat(5000) };
    const network = readSubscriberSignupNetwork(request());
    expect(network.ipPrefix).toBeNull();
    expect(network.userAgent).toHaveLength(512);
  });

  it('records a Turnstile pass on this request only', () => {
    const verified = request();
    recordTurnstileVerification(verified, true);
    expect(readSubscriberSignupNetwork(verified).challengeVerified).toBe(true);
    expect(readSubscriberSignupNetwork(request()).challengeVerified).toBeNull();
  });
});

describe('suspiciousNameReasons', () => {
  it('returns no reasons for ordinary names', () => {
    expect(suspiciousNameReasons(['Ada', "O'Brien", 'Jean-Luc', 'a < b'])).toEqual([]);
  });

  it('reports each reason once across all names', () => {
    expect(suspiciousNameReasons(['<b>x</b>', '<i>', '=1', '\t@x', 'a\u007fb'])).toEqual([
      'markup',
      'formula_prefix',
      'control_characters',
    ]);
  });
});
