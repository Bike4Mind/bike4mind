import { describe, it, expect, beforeEach, vi } from 'vitest';

// Literal PUBLIC IPs on purpose: `validateUrlForFetch` skips DNS for an address literal, so these
// exercise the real guard rather than a mocked one.
const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGet } }));

import { BadRequestError, UrlBlockedError } from '@bike4mind/common';
import { ssrfSafeDownload } from './ssrfSafeDownload';
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from './ssrfProtection';

const PUBLIC_URL = 'https://93.184.216.34/file.pdf';
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';
const OPTIONS = { maxBytes: 1024, timeoutMs: 5_000 };

const ok = (body: string, contentType = 'application/pdf') => ({
  status: 200,
  data: Buffer.from(body),
  headers: { 'content-type': contentType },
});
const redirectTo = (location: string) => ({ status: 302, data: Buffer.alloc(0), headers: { location } });

describe('ssrfSafeDownload', () => {
  beforeEach(() => {
    axiosGet.mockReset();
  });

  it('returns the body, content type and final url of a direct 200', async () => {
    axiosGet.mockResolvedValueOnce(ok('%PDF-1.7'));

    const result = await ssrfSafeDownload(PUBLIC_URL, OPTIONS);

    expect(result.data.toString()).toBe('%PDF-1.7');
    expect(result.contentType).toBe('application/pdf');
    expect(result.finalUrl).toBe(PUBLIC_URL);
  });

  it('pins every request through the safe agents with no proxy, no auto-redirects and the byte cap', async () => {
    axiosGet.mockResolvedValueOnce(ok('x'));

    await ssrfSafeDownload(PUBLIC_URL, OPTIONS);

    expect(axiosGet).toHaveBeenCalledWith(
      PUBLIC_URL,
      expect.objectContaining({
        httpAgent: ssrfSafeHttpAgent,
        httpsAgent: ssrfSafeHttpsAgent,
        proxy: false,
        maxRedirects: 0,
        maxContentLength: 1024,
        maxBodyLength: 1024,
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('refuses a private target before any request is made', async () => {
    await expect(ssrfSafeDownload(METADATA_URL, OPTIONS)).rejects.toThrow(/blocked for security reasons/);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('surfaces a blocked URL as a BadRequestError so it answers 400, not 500', async () => {
    const err = await ssrfSafeDownload(METADATA_URL, OPTIONS).catch(e => e);
    expect(err).toBeInstanceOf(UrlBlockedError);
    expect(err).toBeInstanceOf(BadRequestError);
  });

  it('refuses a redirect into a private address without fetching it', async () => {
    axiosGet.mockResolvedValueOnce(redirectTo(METADATA_URL));

    await expect(ssrfSafeDownload(PUBLIC_URL, OPTIONS)).rejects.toThrow(/blocked for security reasons/);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('follows a public relative redirect and reports the final url', async () => {
    axiosGet.mockResolvedValueOnce(redirectTo('/moved.pdf')).mockResolvedValueOnce(ok('moved'));

    const result = await ssrfSafeDownload(PUBLIC_URL, OPTIONS);

    expect(axiosGet).toHaveBeenLastCalledWith('https://93.184.216.34/moved.pdf', expect.anything());
    expect(result.finalUrl).toBe('https://93.184.216.34/moved.pdf');
  });

  it('gives up after maxRedirects hops', async () => {
    axiosGet.mockResolvedValue(redirectTo(PUBLIC_URL));

    await expect(ssrfSafeDownload(PUBLIC_URL, { ...OPTIONS, maxRedirects: 2 })).rejects.toThrow(/Too many redirects/);
    expect(axiosGet).toHaveBeenCalledTimes(3);
  });

  it('rejects a 3xx with no Location', async () => {
    axiosGet.mockResolvedValueOnce({ status: 302, data: Buffer.alloc(0), headers: {} });

    await expect(ssrfSafeDownload(PUBLIC_URL, OPTIONS)).rejects.toThrow(/no redirect target/);
  });

  it('accepts a 3xx status through validateStatus but not a 4xx/5xx final', async () => {
    axiosGet.mockResolvedValueOnce(ok('x'));

    await ssrfSafeDownload(PUBLIC_URL, OPTIONS);

    const validateStatus = (axiosGet.mock.calls[0][1] as { validateStatus: (s: number) => boolean }).validateStatus;
    expect(validateStatus(200)).toBe(true);
    expect(validateStatus(302)).toBe(true);
    expect(validateStatus(399)).toBe(true);
    expect(validateStatus(400)).toBe(false);
    expect(validateStatus(404)).toBe(false);
    expect(validateStatus(500)).toBe(false);
  });

  it('surfaces a non-2xx final response rather than returning it as a body', async () => {
    axiosGet.mockRejectedValueOnce(new Error('Request failed with status code 404'));

    await expect(ssrfSafeDownload(PUBLIC_URL, OPTIONS)).rejects.toThrow(/404/);
  });

  it('stops when the deadline runs out between hops instead of fetching the next one', async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    axiosGet.mockImplementationOnce(async () => {
      now = 5_000; // the first hop alone burns the whole budget
      return redirectTo('/next.pdf');
    });

    await expect(ssrfSafeDownload(PUBLIC_URL, { maxBytes: 1024, timeoutMs: 5_000 })).rejects.toThrow(/Timed out/);
    expect(axiosGet).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it('narrows the per-hop timeout to the remaining budget and re-pins the next hop', async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    axiosGet.mockImplementationOnce(async () => {
      now = 1_000;
      return redirectTo('/moved.pdf');
    });
    axiosGet.mockResolvedValueOnce(ok('moved'));

    await ssrfSafeDownload(PUBLIC_URL, { maxBytes: 1024, timeoutMs: 5_000 });

    const hop1 = axiosGet.mock.calls[0][1] as { timeout: number };
    const hop2 = axiosGet.mock.calls[1][1] as {
      timeout: number;
      httpAgent: unknown;
      httpsAgent: unknown;
      proxy: boolean;
      maxRedirects: number;
      signal: unknown;
    };
    expect(hop1.timeout).toBe(5_000);
    expect(hop2.timeout).toBe(4_000);
    expect(hop2.timeout).toBeLessThan(5_000);
    expect(hop2.httpAgent).toBe(ssrfSafeHttpAgent);
    expect(hop2.httpsAgent).toBe(ssrfSafeHttpsAgent);
    expect(hop2.proxy).toBe(false);
    expect(hop2.maxRedirects).toBe(0);
    expect(hop2.signal).toBeInstanceOf(AbortSignal);

    nowSpy.mockRestore();
  });
});
