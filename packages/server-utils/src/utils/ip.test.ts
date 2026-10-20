// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { getClientIp, truncateIp } from './ip';

// Build a minimal Request-like object for getClientIp. Only the fields the
// resolver reads (headers, socket/connection.remoteAddress, ip) are populated.
function mockReq(opts: { headers?: Record<string, string | undefined>; socketIp?: string; ip?: string }): Request {
  return {
    headers: opts.headers ?? {},
    socket: opts.socketIp ? { remoteAddress: opts.socketIp } : {},
    connection: opts.socketIp ? { remoteAddress: opts.socketIp } : {},
    ip: opts.ip,
  } as unknown as Request;
}

describe('getClientIp', () => {
  it('prefers cloudfront-viewer-address (real IP) over a spoofed x-forwarded-for', () => {
    // Behind CloudFront, cloudfront-viewer-address is the authoritative, unspoofable
    // viewer IP:port. It must win over the client-controlled x-forwarded-for.
    const req = mockReq({
      headers: {
        'cloudfront-viewer-address': '203.0.113.7:19658',
        'x-forwarded-for': '1.1.1.1',
      },
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('strips the trailing port from an IPv6 cloudfront-viewer-address', () => {
    const req = mockReq({
      headers: { 'cloudfront-viewer-address': '2001:db8:85a3::8a2e:370:7334:46532' },
    });
    expect(getClientIp(req)).toBe('2001:db8:85a3::8a2e:370:7334');
  });

  it('falls through to other headers when cloudfront-viewer-address is absent', () => {
    const req = mockReq({ headers: { 'x-real-ip': '8.8.8.8' } });
    expect(getClientIp(req)).toBe('8.8.8.8');
  });

  it('prefers cf-connecting-ip over a spoofed x-forwarded-for', () => {
    // Attacker prepends a forged IP to x-forwarded-for. The CDN-injected
    // cf-connecting-ip must win so the spoofed value is never recorded.
    const req = mockReq({
      headers: {
        'x-forwarded-for': '1.1.1.1, 8.8.4.4',
        'cf-connecting-ip': '8.8.4.4',
      },
    });
    expect(getClientIp(req)).toBe('8.8.4.4');
  });

  it('uses a public x-forwarded-for when it is the only header present', () => {
    const req = mockReq({
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect(getClientIp(req)).toBe('9.9.9.9');
  });

  it('filters a private leftmost x-forwarded-for and falls back to the socket', () => {
    // The resolver reads only the leftmost x-forwarded-for token; a spoofed
    // private/loopback value there is filtered out, falling through to the socket.
    const req = mockReq({
      headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.7' },
      socketIp: '203.0.113.7',
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it.each(['2606:4700::1111', '2001:4860::8888'])(
    'uses a public IPv6 x-forwarded-for when it is the only header present (%s)',
    addr => {
      const req = mockReq({ headers: { 'x-forwarded-for': addr } });
      expect(getClientIp(req)).toBe(addr);
    }
  );

  it('accepts a public IPv4-mapped IPv6 (strip must not over-reject)', () => {
    const req = mockReq({ headers: { 'x-forwarded-for': '::ffff:8.8.8.8' } });
    expect(getClientIp(req)).toBe('::ffff:8.8.8.8');
  });

  it.each([
    ['loopback ::1', '::1'],
    ['expanded loopback', '0:0:0:0:0:0:0:1'],
    ['unspecified ::', '::'],
    ['link-local fe80::/10', 'fe80::abcd'],
    ['unique-local fc00::/7', 'fc00::1'],
    ['unique-local fd00::/8', 'fd12:3456::1'],
    ['IPv4-mapped private', '::ffff:10.0.0.1'],
    ['IETF-reserved fe00::/9', 'fe00::1'], // #1969
    ['site-local fec0::/10', 'fec0::1'], // #1969
  ])('filters a private/reserved IPv6 (%s) and falls back to the socket', (_label, addr) => {
    const req = mockReq({
      headers: { 'x-forwarded-for': addr },
      socketIp: '203.0.113.7',
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  // `isPrivateIP` (delegated to `@bike4mind/fab-pipeline`, see #1969) is wider than the local regex
  // list this file used to carry: it also refuses CGNAT (100.64.0.0/10) and the RFC 5737/3849
  // documentation ranges. Pinned here so reverting that delegation is caught by a failing test, not
  // just by a description in a PR.
  it.each(['100.64.0.1', '203.0.113.7', '198.51.100.23'])(
    'filters a CGNAT/documentation-range x-forwarded-for (%s) and falls back to the socket',
    addr => {
      const req = mockReq({
        headers: { 'x-forwarded-for': addr },
        socketIp: '8.8.8.8',
      });
      expect(getClientIp(req)).toBe('8.8.8.8');
    }
  );

  it('does NOT blindly trust the leftmost x-forwarded-for when a higher-priority header exists', () => {
    const req = mockReq({
      headers: {
        'x-forwarded-for': '1.1.1.1',
        'true-client-ip': '9.9.9.9',
      },
    });
    expect(getClientIp(req)).toBe('9.9.9.9');
  });

  it('strips a port from the resolved IP', () => {
    const req = mockReq({ headers: { 'x-real-ip': '8.8.8.8:54321' } });
    expect(getClientIp(req)).toBe('8.8.8.8');
  });

  it('falls back to the socket address when no usable headers are present', () => {
    const req = mockReq({ socketIp: '203.0.113.200' });
    expect(getClientIp(req)).toBe('203.0.113.200');
  });

  it('falls back to req.ip when headers and socket are unavailable', () => {
    const req = mockReq({ ip: '203.0.113.250' });
    expect(getClientIp(req)).toBe('203.0.113.250');
  });

  it('returns "unknown" when nothing is resolvable', () => {
    const req = mockReq({});
    expect(getClientIp(req)).toBe('unknown');
  });
});

describe('getClientIp on self-host', () => {
  const SPOOFED_HEADERS = {
    'cloudfront-viewer-address': '8.8.8.8:443',
    'cf-connecting-ip': '8.8.4.4',
    'true-client-ip': '9.9.9.9',
    'x-real-ip': '1.0.0.1',
    'x-client-ip': '1.1.1.1',
    'fly-client-ip': '4.4.4.4',
  };

  beforeEach(() => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('without TRUSTED_PROXY_HOPS', () => {
    it('ignores every forwarding header and uses the socket address', () => {
      const req = mockReq({
        headers: { ...SPOOFED_HEADERS, 'x-forwarded-for': '2.2.2.2' },
        socketIp: '192.168.1.20',
      });
      expect(getClientIp(req)).toBe('192.168.1.20');
    });

    it('treats TRUSTED_PROXY_HOPS=0 the same as unset', () => {
      vi.stubEnv('TRUSTED_PROXY_HOPS', '0');
      const req = mockReq({ headers: { 'x-forwarded-for': '2.2.2.2' }, socketIp: '192.168.1.20' });
      expect(getClientIp(req)).toBe('192.168.1.20');
    });

    it('falls back to req.ip, then "unknown", when there is no socket address', () => {
      expect(getClientIp(mockReq({ headers: SPOOFED_HEADERS, ip: '10.0.0.9' }))).toBe('10.0.0.9');
      expect(getClientIp(mockReq({ headers: SPOOFED_HEADERS }))).toBe('unknown');
    });
  });

  describe('with TRUSTED_PROXY_HOPS', () => {
    it('takes the hop the trusted proxy appended, not a client-prepended leftmost token', () => {
      vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
      const req = mockReq({
        headers: { ...SPOOFED_HEADERS, 'x-forwarded-for': '2.2.2.2, 3.3.3.3' },
        socketIp: '172.18.0.5',
      });
      expect(getClientIp(req)).toBe('3.3.3.3');
    });

    it('counts hops from the right through a proxy chain', () => {
      vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
      const req = mockReq({ headers: { 'x-forwarded-for': '2.2.2.2, 3.3.3.3, 172.18.0.9' } });
      expect(getClientIp(req)).toBe('3.3.3.3');
    });

    it('keeps a private client address, which is legitimate on a LAN', () => {
      vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
      const req = mockReq({ headers: { 'x-forwarded-for': '192.168.1.20' }, socketIp: '172.18.0.5' });
      expect(getClientIp(req)).toBe('192.168.1.20');
    });

    it('strips ports from the selected hop', () => {
      vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
      expect(getClientIp(mockReq({ headers: { 'x-forwarded-for': '2.2.2.2, 3.3.3.3:5123' } }))).toBe('3.3.3.3');
      expect(getClientIp(mockReq({ headers: { 'x-forwarded-for': '[2001:db8::1]:5123' } }))).toBe('2001:db8::1');
    });

    it('takes the leftmost token when the chain is shorter than the hop count', () => {
      vi.stubEnv('TRUSTED_PROXY_HOPS', '3');
      const req = mockReq({ headers: { 'x-forwarded-for': '3.3.3.3, 172.18.0.9' } });
      expect(getClientIp(req)).toBe('3.3.3.3');
    });

    it('falls back to the socket address when x-forwarded-for is absent', () => {
      vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
      const req = mockReq({ headers: SPOOFED_HEADERS, socketIp: '172.18.0.5' });
      expect(getClientIp(req)).toBe('172.18.0.5');
    });
  });

  it.each(['-1', '1.5', 'one', '1 2'])('throws on a malformed TRUSTED_PROXY_HOPS (%s)', value => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', value);
    expect(() => getClientIp(mockReq({ headers: { 'x-forwarded-for': '2.2.2.2' } }))).toThrow(
      /TRUSTED_PROXY_HOPS must be a non-negative integer/
    );
  });

  it('leaves deployed stages on the header chain even when TRUSTED_PROXY_HOPS is set', () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    const req = mockReq({ headers: { 'cloudfront-viewer-address': '8.8.8.8:443', 'x-forwarded-for': '2.2.2.2' } });
    expect(getClientIp(req)).toBe('8.8.8.8');
  });
});

describe('truncateIp', () => {
  describe('IPv4', () => {
    it('zeros the last octet', () => {
      expect(truncateIp('192.168.1.42')).toBe('192.168.1.0');
    });

    it('handles already-truncated IPs', () => {
      expect(truncateIp('10.0.0.0')).toBe('10.0.0.0');
    });

    it('handles public IPs', () => {
      expect(truncateIp('203.0.113.195')).toBe('203.0.113.0');
    });

    it('handles loopback', () => {
      expect(truncateIp('127.0.0.1')).toBe('127.0.0.0');
    });
  });

  describe('IPv6', () => {
    it('keeps first 3 groups and zeros the rest', () => {
      expect(truncateIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3:0:0:0:0:0');
    });

    it('handles short IPv6 (loopback)', () => {
      // ::1 expands to 0:0:0:0:0:0:0:1, truncated to /48
      expect(truncateIp('::1')).toBe('0:0:0:0:0:0:0:0');
    });

    it('handles compressed IPv6', () => {
      // fe80::1 expands to fe80:0:0:0:0:0:0:1, truncated to /48
      expect(truncateIp('fe80::1')).toBe('fe80:0:0:0:0:0:0:0');
    });
  });

  describe('edge cases', () => {
    it('returns "unknown" unchanged', () => {
      expect(truncateIp('unknown')).toBe('unknown');
    });

    it('returns empty string unchanged', () => {
      expect(truncateIp('')).toBe('');
    });

    it('handles malformed IPv4 gracefully', () => {
      expect(truncateIp('999.999.999')).toBe('999.999.999');
    });
  });
});
