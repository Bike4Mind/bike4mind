// @vitest-environment node
import { describe, it, expect } from 'vitest';
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
    const req = mockReq({ headers: { 'x-real-ip': '203.0.113.50' } });
    expect(getClientIp(req)).toBe('203.0.113.50');
  });

  it('prefers cf-connecting-ip over a spoofed x-forwarded-for', () => {
    // Attacker prepends a forged IP to x-forwarded-for. The CDN-injected
    // cf-connecting-ip must win so the spoofed value is never recorded.
    const req = mockReq({
      headers: {
        'x-forwarded-for': '1.1.1.1, 203.0.113.7',
        'cf-connecting-ip': '203.0.113.7',
      },
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('uses a public x-forwarded-for when it is the only header present', () => {
    const req = mockReq({
      headers: { 'x-forwarded-for': '198.51.100.23' },
    });
    expect(getClientIp(req)).toBe('198.51.100.23');
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

  it('uses a public IPv6 x-forwarded-for when it is the only header present', () => {
    const req = mockReq({ headers: { 'x-forwarded-for': '2001:db8::1' } });
    expect(getClientIp(req)).toBe('2001:db8::1');
  });

  it.each([
    ['loopback ::1', '::1'],
    ['link-local fe80::/10', 'fe80::abcd'],
    ['unique-local fc00::/7', 'fc00::1'],
    ['unique-local fd00::/8', 'fd12:3456::1'],
  ])('filters a private/reserved IPv6 (%s) and falls back to the socket', (_label, addr) => {
    const req = mockReq({
      headers: { 'x-forwarded-for': addr },
      socketIp: '203.0.113.7',
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('does NOT blindly trust the leftmost x-forwarded-for when a higher-priority header exists', () => {
    const req = mockReq({
      headers: {
        'x-forwarded-for': '1.1.1.1',
        'true-client-ip': '203.0.113.50',
      },
    });
    expect(getClientIp(req)).toBe('203.0.113.50');
  });

  it('strips a port from the resolved IP', () => {
    const req = mockReq({ headers: { 'x-real-ip': '203.0.113.99:54321' } });
    expect(getClientIp(req)).toBe('203.0.113.99');
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
