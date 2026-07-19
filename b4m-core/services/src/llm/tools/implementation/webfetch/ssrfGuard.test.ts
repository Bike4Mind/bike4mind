import { afterEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => lookup(...args) }));

import { unsafeFetchUrlReason, unsafeHostnameReason } from './ssrfGuard';

afterEach(() => lookup.mockReset());

describe('unsafeHostnameReason (literal, no DNS)', () => {
  it.each([
    'localhost',
    '0.0.0.0',
    '::1',
    '[::1]',
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254', // AWS metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '0.0.0.1',
    '100.64.0.1', // carrier-grade NAT (RFC 6598) 100.64.0.0/10
    '100.127.255.255', // top of the CGNAT range
    'fd00::1',
    'fe80::1',
    '::ffff:169.254.169.254',
  ])('rejects %s', host => {
    expect(unsafeHostnameReason(host)).not.toBeNull();
  });

  it.each([
    'example.com',
    '8.8.8.8',
    '1.1.1.1',
    'en.wikipedia.org',
    '172.32.0.1',
    '100.63.255.255', // just below the CGNAT range
    '100.128.0.1', // just above the CGNAT range
    '2606:4700::1111',
  ])('allows %s', host => {
    expect(unsafeHostnameReason(host)).toBeNull();
  });
});

describe('unsafeFetchUrlReason (protocol + literal + resolved)', () => {
  it('rejects non-http(s) protocols', async () => {
    expect(await unsafeFetchUrlReason(new URL('ftp://example.com/x'))).toBe('unsupported protocol');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a literal private host without resolving DNS', async () => {
    expect(await unsafeFetchUrlReason(new URL('http://169.254.169.254/latest/meta-data/'))).toContain('private');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allows a public host that resolves to a public address', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await unsafeFetchUrlReason(new URL('https://example.com/llms.txt'))).toBeNull();
  });

  it('rejects a public host that resolves to a private address (rebinding-style)', async () => {
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    expect(await unsafeFetchUrlReason(new URL('https://rebind.attacker.com/llms.txt'))).toBe(
      'resolves to a private/reserved address'
    );
  });

  it('rejects when any resolved address is private', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]);
    expect(await unsafeFetchUrlReason(new URL('https://example.com/llms.txt'))).toBe(
      'resolves to a private/reserved address'
    );
  });

  it('rejects when DNS resolution fails', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await unsafeFetchUrlReason(new URL('https://nope.invalid/llms.txt'))).toBe('dns resolution failed');
  });
});
