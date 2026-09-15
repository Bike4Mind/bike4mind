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

// The private-IP classifier is not reimplemented here - it is re-exported from @bike4mind/fab-pipeline
// so the hardened IPv6 range logic lives in one place (the #1969 drift). fab-pipeline owns the
// exhaustive classifier suite; these smoke tests only pin that the re-export is wired to the shared,
// stricter classifier at this boundary - in particular that 6to4 (2002::/16) is blocked as a whole
// prefix here, the reconciliation of the earlier local fork that decoded it and let public-embedded
// 6to4 through.
describe('classifier is the shared fab-pipeline one (no local fork)', () => {
  it('blocks private literals and allows public ones', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('169.254.169.254')).toBe(true);
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateOrInternalHostname('localhost')).toBe(true);
    expect(isPrivateOrInternalHostname('metadata.google.internal')).toBe(true);
    expect(isPrivateOrInternalHostname('blog.example.com')).toBe(false);
  });

  it('blocks the entire 6to4 2002::/16 prefix (reconciled policy, not the decode-and-allow fork)', () => {
    expect(isPrivateIP('2002:7f00:1::')).toBe(true); // 6to4-wrapped 127.0.0.1
    expect(isPrivateIP('2002:808:808::')).toBe(true); // 6to4-wrapped 8.8.8.8: blocked as a prefix, not decoded
    expect(isPrivateOrInternalHostname('[2002:808:808::]')).toBe(true);
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
