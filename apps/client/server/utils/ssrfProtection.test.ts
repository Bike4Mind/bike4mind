import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPrivateIP, isPrivateOrInternalHostname, assertUrlAllowed, safeFetch, SsrfError } from './ssrfProtection';

// validateTargetUrl (used by assertUrlAllowed) resolves DNS; stub it deterministically so a
// public NAME resolves public and known-bad names resolve to loopback/private, without real DNS.
vi.mock('dns', () => {
  const resolve4 = (host: string, cb: (e: Error | null, a?: string[]) => void) => {
    if (/(^|\.)nip\.io$/.test(host) || host === 'internal.example') cb(null, ['127.0.0.1']);
    else if (host === 'rebind.example') cb(null, ['10.0.0.5']);
    else cb(null, ['93.184.216.34']);
  };
  const resolve6 = (_host: string, cb: (e: Error | null, a?: string[]) => void) => cb(null, []);
  return { default: { resolve4, resolve6 }, resolve4, resolve6 };
});

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

describe('isPrivateIP - IPv4-mapped IPv6 (hex and dotted spellings)', () => {
  // new URL('https://[::ffff:127.0.0.1]').hostname is '[::ffff:7f00:1]', not the dotted form,
  // so the guard must recognize the hex spelling or it is dead code for every URL-derived host.
  it('blocks private mapped addresses in the hex form new URL() produces', () => {
    expect(isPrivateIP('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isPrivateIP('::ffff:a00:5')).toBe(true); // 10.0.0.5
    expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254 (cloud metadata)
  });

  it('blocks private mapped addresses in the dotted form', () => {
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
  });

  it('does not over-block a genuinely public mapped address', () => {
    expect(isPrivateIP('::ffff:808:808')).toBe(false); // 8.8.8.8
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
  });

  it('catches the bracketed hostname forms through the hostname check', () => {
    expect(isPrivateOrInternalHostname('[::ffff:7f00:1]')).toBe(true); // 127.0.0.1
    expect(isPrivateOrInternalHostname('[::ffff:a9fe:a9fe]')).toBe(true); // 169.254.169.254
    expect(isPrivateOrInternalHostname('[::ffff:808:808]')).toBe(false); // 8.8.8.8 public
  });
});

describe('isPrivateIP - IPv4-compatible and 6to4 IPv6 (embedded IPv4)', () => {
  it('blocks IPv4-compatible ::a.b.c.d embedding a private IPv4 (hex + dotted)', () => {
    expect(isPrivateIP('::7f00:1')).toBe(true); // ::127.0.0.1
    expect(isPrivateIP('::a00:5')).toBe(true); // ::10.0.0.5
    expect(isPrivateIP('::127.0.0.1')).toBe(true);
    expect(isPrivateOrInternalHostname('[::7f00:1]')).toBe(true);
  });

  it('blocks 6to4 2002:: embedding a private IPv4', () => {
    expect(isPrivateIP('2002:7f00:1::')).toBe(true); // 127.0.0.1
    expect(isPrivateIP('2002:a00:5::')).toBe(true); // 10.0.0.5
    expect(isPrivateOrInternalHostname('[2002:7f00:1::]')).toBe(true);
  });

  it('does not over-block a public embedded address', () => {
    expect(isPrivateIP('::808:808')).toBe(false); // ::8.8.8.8 (compat, public)
    expect(isPrivateIP('2002:808:808::')).toBe(false); // 6to4 8.8.8.8 (public)
  });
});

describe('alternate IPv4 encodings normalize and are blocked', () => {
  // WHATWG new URL() parses integer/hex/octal hosts into dotted-decimal, so the guard sees the
  // canonical form and the range check applies - no separate decoder needed.
  it('normalizes integer/hex/octal hosts to dotted-decimal', () => {
    expect(new URL('https://2130706433').hostname).toBe('127.0.0.1');
    expect(new URL('https://0x7f000001').hostname).toBe('127.0.0.1');
    expect(new URL('https://0177.0.0.1').hostname).toBe('127.0.0.1');
  });

  it('so the hostname check catches them', () => {
    for (const u of ['https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1']) {
      expect(isPrivateOrInternalHostname(new URL(u).hostname)).toBe(true);
    }
  });
});

describe('isPrivateOrInternalHostname - trailing-dot FQDN', () => {
  it('strips a trailing dot so localhost. / metadata. are still caught', () => {
    expect(isPrivateOrInternalHostname('localhost.')).toBe(true);
    expect(isPrivateOrInternalHostname('metadata.google.internal.')).toBe(true);
    expect(isPrivateOrInternalHostname('foo.local.')).toBe(true);
  });

  it('does not over-block a public host with a trailing dot', () => {
    expect(isPrivateOrInternalHostname('blog.example.com.')).toBe(false);
  });
});

describe('isPrivateOrInternalHostname - bracketed IPv6 literals', () => {
  // URL.hostname wraps IPv6 literals in brackets; without stripping them the IPv6 checks miss.
  it('strips the brackets so loopback/link-local/ULA literals are still caught', () => {
    expect(isPrivateOrInternalHostname('[::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[fe80::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[fc00::1]')).toBe(true);
  });

  it('blocks the whole fe00::/8 (link-local + deprecated site-local fec0::/10)', () => {
    // fec0::/10 site-local (RFC 3879) is an IPv6 literal, so DNS resolution never backstops it;
    // nothing in fe00::/8 is global-unicast, so the guard blocks the entire /8.
    for (const ip of ['fe80::1', 'febf::1', 'fec0::1', 'fed0::1', 'fee0::1', 'feff::1']) {
      expect(isPrivateIP(ip)).toBe(true);
      expect(isPrivateOrInternalHostname(`[${ip}]`)).toBe(true);
    }
    expect(isPrivateOrInternalHostname('[2606:4700:4700::1111]')).toBe(false); // public, not over-blocked
  });
});

describe('assertUrlAllowed (DNS-resolving gate)', () => {
  it('allows a public https host', async () => {
    await expect(assertUrlAllowed('https://good.example/api')).resolves.toBeUndefined();
  });

  it('rejects non-https before any resolution', async () => {
    await expect(assertUrlAllowed('http://good.example')).rejects.toThrow(/https/i);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertUrlAllowed('not a url')).rejects.toThrow(/not a valid url/i);
  });

  it('rejects private/internal literals (including bracketed IPv6)', async () => {
    for (const u of ['https://localhost', 'https://169.254.169.254', 'https://10.0.0.1', 'https://[::1]']) {
      await expect(assertUrlAllowed(u)).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it('rejects a public NAME that resolves to a private IP (the hostname-only-guard gap)', async () => {
    // 127.0.0.1.nip.io has a real A record pointing at loopback; the sync hostname check passed
    // it, DNS resolution catches it.
    await expect(assertUrlAllowed('https://127.0.0.1.nip.io')).rejects.toThrow(/private ip/i);
  });
});

describe('safeFetch - initial-host and redirect-hop SSRF protection', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const redirectTo = (location: string) => ({
    status: 302,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
  });
  const okResponse = () => ({ status: 200, ok: true });

  it('rejects a non-https target before fetching', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    await expect(safeFetch('http://blog.example.com')).rejects.toBeInstanceOf(SsrfError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a private target before fetching', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    await expect(safeFetch('https://169.254.169.254/')).rejects.toBeInstanceOf(SsrfError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches with redirect:manual and returns a non-redirect response directly', async () => {
    const res = okResponse();
    const fetchMock = vi.fn().mockResolvedValueOnce(res);
    global.fetch = fetchMock as never;
    // public IP literals so the guard's DNS path is not exercised here (covered separately)
    await expect(safeFetch('https://93.184.216.34')).resolves.toBe(res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows one redirect to a public host with redirect:error on the second hop', async () => {
    const final = okResponse();
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo('https://8.8.8.8/img')).mockResolvedValueOnce(final);
    global.fetch = fetchMock as never;
    await expect(safeFetch('https://93.184.216.34')).resolves.toBe(final);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://8.8.8.8/img');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'error' });
  });

  it('blocks a redirect to a private host without following it (the follow-fetch bypass)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo('https://169.254.169.254/'));
    global.fetch = fetchMock as never;
    await expect(safeFetch('https://93.184.216.34')).rejects.toThrow(/blocked redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
