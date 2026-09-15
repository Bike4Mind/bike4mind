import { describe, it, expect, vi } from 'vitest';

// `validateTargetUrl` resolves DNS via `promisify(dns.resolve4/resolve6)`, so the mock below must
// keep dns's Node-callback shape rather than returning a promise directly.
const dnsMock = vi.hoisted(() => ({
  resolve4: vi.fn((_host: string, cb: (err: unknown, addrs: string[]) => void) => cb(null, [])),
  resolve6: vi.fn((_host: string, cb: (err: unknown, addrs: string[]) => void) => cb(null, [])),
}));
vi.mock('dns', () => ({ default: dnsMock, ...dnsMock }));

import { isPrivateIP, isPrivateOrInternalHostname, validateTargetUrl } from './ssrfProtection';

describe('isPrivateIP - RFC 2544 benchmarking range', () => {
  it('blocks 198.18.0.0/15', () => {
    expect(isPrivateIP('198.18.0.0')).toBe(true);
    expect(isPrivateIP('198.18.0.1')).toBe(true);
    expect(isPrivateIP('198.18.255.255')).toBe(true);
    expect(isPrivateIP('198.19.0.0')).toBe(true);
    expect(isPrivateIP('198.19.255.255')).toBe(true);
  });

  it('blocks the IPv4-mapped IPv6 form of the range', () => {
    expect(isPrivateIP('::ffff:198.18.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:198.17.0.1')).toBe(false);
  });

  it('does not over-block adjacent public ranges', () => {
    expect(isPrivateIP('198.17.255.255')).toBe(false);
    expect(isPrivateIP('198.20.0.0')).toBe(false);
  });

  it('blocks 198.18.x.x literal hostnames', () => {
    expect(isPrivateOrInternalHostname('198.18.0.1')).toBe(true);
    expect(isPrivateOrInternalHostname('198.19.42.42')).toBe(true);
  });
});

describe('isPrivateIP - fe00::/9 and fec0::/10 (#1969)', () => {
  it.each(['fe00::1', 'fe40::1', 'fe7f::1', 'fec0::1', 'feff::1'])('blocks %s', ip => {
    expect(isPrivateIP(ip)).toBe(true);
  });

  it('blocks the uncompressed IPv4-mapped loopback spelling', () => {
    expect(isPrivateIP('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
  });

  it('does not over-block public IPv6 hosts', () => {
    expect(isPrivateIP('2001:4860::8888')).toBe(false);
    expect(isPrivateIP('2606:4700::1111')).toBe(false);
  });
});

describe('validateTargetUrl - resolved AAAA records (#1969)', () => {
  it('allows a hostname that resolves to a public AAAA record', async () => {
    dnsMock.resolve6.mockImplementationOnce((_host, cb) => cb(null, ['2606:4700::1111']));
    expect(await validateTargetUrl('https://example.com/webhook')).toEqual({ valid: true });
  });

  it('rejects a hostname that resolves to a private AAAA record', async () => {
    dnsMock.resolve6.mockImplementationOnce((_host, cb) => cb(null, ['fec0::1']));
    expect(await validateTargetUrl('https://rebind.attacker.com/webhook')).toEqual({
      valid: false,
      error: 'Hostname resolves to private IP address (fec0::1)',
    });
  });
});
