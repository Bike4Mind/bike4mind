import { afterEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => lookup(...args) }));

import { RefusedFetchTargetError, UnsafeScrapeTargetError } from './errors';
import { refuseFetch, resolveAndVetUrl, unsafeFetchUrlReason, unsafeHostnameReason } from './ssrfGuard';

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
    'fe00::1', // bottom of fe00::/9 (#1969)
    'fe40::1', // mid fe00::/9 (#1969)
    'fe7f::1', // top of fe00::/9, just below fe80::/10 (#1969)
    'fec0::1', // fec0::/10 site-local (#1969)
    'feff::1', // top of fec0::/10 (#1969)
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
    '2001:4860::8888',
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

  it('allows a public host that resolves to a public AAAA record', async () => {
    lookup.mockResolvedValue([{ address: '2606:4700::1111', family: 6 }]);
    expect(await unsafeFetchUrlReason(new URL('https://example.com/llms.txt'))).toBeNull();
  });

  it('rejects a public host that resolves to a private AAAA record (rebinding-style, #1969)', async () => {
    lookup.mockResolvedValue([{ address: 'fec0::1', family: 6 }]);
    expect(await unsafeFetchUrlReason(new URL('https://rebind.attacker.com/llms.txt'))).toBe(
      'resolves to a private/reserved address'
    );
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

describe('encoded and alternate address forms', () => {
  // The WHATWG URL parser canonicalises numeric IPv4 forms and IPv6 literals before the guard sees
  // the hostname, so each of these must be refused without a DNS lookup.
  it.each([
    'http://2852039166/latest/meta-data/', // decimal 169.254.169.254
    'http://0xA9FEA9FE/latest/meta-data/', // hex
    'http://0xa9.0xfe.0xa9.0xfe/', // dotted hex
    'http://0251.0376.0251.0376/', // octal
    'http://169.254.43518/', // two-part short form
    'http://127.1/', // short loopback
    'http://0/', // 0.0.0.0
    'http://0.0.0.0:8080/',
    'http://[::]/',
    'http://[::1]:8080/',
    'http://[::ffff:169.254.169.254]/', // IPv4-mapped, serialised as ::ffff:a9fe:a9fe
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fd00:ec2::254]/', // AWS IPv6 metadata endpoint
  ])('refuses %s', async url => {
    const vetted = await resolveAndVetUrl(new URL(url));
    expect(vetted.safe).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('refuseFetch', () => {
  it('gives a private target and an unresolvable host the same caller-facing message', async () => {
    lookup.mockResolvedValueOnce([{ address: '10.0.0.8', family: 4 }]);
    const privateTarget = await resolveAndVetUrl(new URL('http://svc.internal.example/healthz'));
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const unresolved = await resolveAndVetUrl(new URL('http://svc.internal.example/healthz'));
    if (privateTarget.safe || unresolved.safe) throw new Error('expected both targets to be refused');

    const privateError = refuseFetch('http://svc.internal.example/healthz', privateTarget);
    const unresolvedError = refuseFetch('http://svc.internal.example/healthz', unresolved);

    expect(privateError.message).toBe(unresolvedError.message);
    expect(privateError.message).not.toMatch(/private|reserved|dns/i);
  });

  it('keeps a DNS failure retryable and a blocked target permanent', () => {
    const transient = refuseFetch('https://a.example', {
      safe: false,
      reason: 'dns resolution failed',
      retryable: true,
    });
    const blocked = refuseFetch('http://127.0.0.1', { safe: false, reason: 'loopback host' });

    expect(transient).toBeInstanceOf(RefusedFetchTargetError);
    expect(transient).not.toBeInstanceOf(UnsafeScrapeTargetError);
    expect(blocked).toBeInstanceOf(UnsafeScrapeTargetError);
    expect(blocked).toBeInstanceOf(RefusedFetchTargetError);
  });
});
