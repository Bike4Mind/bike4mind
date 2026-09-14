import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPrivateIP, isPrivateOrInternalHostname, rejectSsrfUrl, safeFetch, SsrfError } from './ssrfProtection';

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

describe('isPrivateOrInternalHostname - bracketed IPv6 literals', () => {
  // URL.hostname wraps IPv6 literals in brackets; without stripping them the IPv6 checks miss.
  it('strips the brackets so loopback/link-local/ULA literals are still caught', () => {
    expect(isPrivateOrInternalHostname('[::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[fe80::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[fc00::1]')).toBe(true);
  });
});

describe('rejectSsrfUrl', () => {
  it('allows a public https host', () => {
    expect(rejectSsrfUrl(new URL('https://blog.example.com/api'))).toBeNull();
  });

  it('rejects non-https', () => {
    expect(rejectSsrfUrl(new URL('http://blog.example.com'))).toMatch(/https/i);
  });

  it('rejects private/internal hosts (including bracketed IPv6)', () => {
    for (const u of ['https://localhost', 'https://169.254.169.254', 'https://10.0.0.1', 'https://[::1]']) {
      expect(rejectSsrfUrl(new URL(u))).toMatch(/private or internal/i);
    }
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
    await expect(safeFetch('https://blog.example.com')).resolves.toBe(res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows one redirect to a public host with redirect:error on the second hop', async () => {
    const final = okResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://cdn.example.net/img'))
      .mockResolvedValueOnce(final);
    global.fetch = fetchMock as never;
    await expect(safeFetch('https://blog.example.com')).resolves.toBe(final);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.example.net/img');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'error' });
  });

  it('blocks a redirect to a private host without following it (the follow-fetch bypass)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo('https://169.254.169.254/'));
    global.fetch = fetchMock as never;
    await expect(safeFetch('https://blog.example.com')).rejects.toThrow(/blocked redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
