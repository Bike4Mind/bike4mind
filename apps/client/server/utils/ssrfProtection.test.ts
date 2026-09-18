import { describe, it, expect, vi, afterEach } from 'vitest';

// `validateTargetUrl`/`assertUrlAllowed` resolve DNS via `promisify(dns.resolve4/resolve6)`, so the
// mock keeps dns's Node-callback shape. Defaults: *.nip.io / internal.example -> loopback,
// rebind.example -> private, everything else -> a public IP. Individual tests override a resolver
// with `mockImplementationOnce` (e.g. to pin an AAAA record).
const dnsMock = vi.hoisted(() => ({
  resolve4: vi.fn((host: string, cb: (err: unknown, addrs?: string[]) => void) => {
    if (/(^|\.)nip\.io$/.test(host) || host === 'internal.example') cb(null, ['127.0.0.1']);
    else if (host === 'rebind.example') cb(null, ['10.0.0.5']);
    else cb(null, ['93.184.216.34']);
  }),
  resolve6: vi.fn((_host: string, cb: (err: unknown, addrs?: string[]) => void) => cb(null, [])),
}));
vi.mock('dns', () => ({ default: dnsMock, ...dnsMock }));

import {
  isPrivateIP,
  isPrivateOrInternalHostname,
  validateTargetUrl,
  assertUrlAllowed,
  safeFetch,
  SsrfError,
} from './ssrfProtection';

// isPrivateIP / isPrivateOrInternalHostname are re-exported from @bike4mind/fab-pipeline (the
// classifier is single-sourced there, #1969). These pin that the re-export is wired to the hardened
// classifier at this boundary; fab-pipeline owns the exhaustive suite.
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

describe('isPrivateIP - 6to4 2002::/16 is blocked as a whole prefix (not decoded)', () => {
  // The shared classifier blocks the entire 6to4 range rather than decoding the embedded IPv4 and
  // allowing a public-embedded one: a 6to4 address routes through relay infrastructure this process
  // never validates. Pins the reconciliation of an earlier local fork that decoded it.
  it('blocks 6to4 regardless of the embedded IPv4', () => {
    expect(isPrivateIP('2002:7f00:1::')).toBe(true); // 6to4-wrapped 127.0.0.1
    expect(isPrivateIP('2002:808:808::')).toBe(true); // 6to4-wrapped 8.8.8.8: blocked as a prefix
    expect(isPrivateOrInternalHostname('[2002:808:808::]')).toBe(true);
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
