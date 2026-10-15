import { describe, it, expect, beforeEach, vi } from 'vitest';

// Literal PUBLIC IPs on purpose: `validateUrlForFetch` skips DNS for an address literal, so these
// exercise the real guard rather than a mocked one.
const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGet } }));

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

    await ssrfSafeDownload(PUBLIC_URL, { ...OPTIONS, headers: { Authorization: 'Bearer t' } });

    expect(axiosGet).toHaveBeenCalledWith(
      PUBLIC_URL,
      expect.objectContaining({
        httpAgent: ssrfSafeHttpAgent,
        httpsAgent: ssrfSafeHttpsAgent,
        proxy: false,
        maxRedirects: 0,
        maxContentLength: 1024,
        maxBodyLength: 1024,
        headers: { Authorization: 'Bearer t' },
      })
    );
  });

  it('refuses a private target before any request is made', async () => {
    await expect(ssrfSafeDownload(METADATA_URL, OPTIONS)).rejects.toThrow(/blocked for security reasons/);
    expect(axiosGet).not.toHaveBeenCalled();
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
});
