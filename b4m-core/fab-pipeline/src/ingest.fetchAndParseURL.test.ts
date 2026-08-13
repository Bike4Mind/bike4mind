import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * SSRF coverage for `fetchAndParseURL`, whose guard used to run against the caller-supplied URL
 * ONLY. axios followed the redirect chain itself, so a public host answering
 * `302 Location: http://169.254.169.254/...` reached the metadata endpoint unchecked.
 *
 * The URLs here are literal PUBLIC IPs on purpose: `validateUrlForFetch` skips DNS resolution for
 * an address literal, so these exercise the real guard rather than a mocked one.
 */

const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGet } }));

import { fetchAndParseURL } from './ingest';

const logger = { updateMetadata: vi.fn(), log: vi.fn(), debug: vi.fn() } as never;

const PUBLIC_URL = 'http://93.184.216.34/article';
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';
const PAGE = '<html><head><title>An Article</title></head><body><p>Hello</p></body></html>';

const ok = (data: string) => ({ status: 200, data, headers: {} });
const redirectTo = (location: string) => ({ status: 302, data: '', headers: { location } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchAndParseURL redirect handling', () => {
  it('BLOCKS a redirect to the cloud metadata endpoint', async () => {
    axiosGet.mockResolvedValueOnce(redirectTo(METADATA_URL));

    await expect(fetchAndParseURL(PUBLIC_URL, { logger })).rejects.toThrow(/blocked for security reasons/i);

    // The first hop was fetched (it is a legitimate public address); the metadata endpoint was NOT.
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosGet.mock.calls[0][0]).toBe(PUBLIC_URL);
  });

  it('BLOCKS a redirect to a private network address', async () => {
    axiosGet.mockResolvedValueOnce(redirectTo('http://10.0.0.5/internal'));

    await expect(fetchAndParseURL(PUBLIC_URL, { logger })).rejects.toThrow(/private or internal network/i);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('never requests a private URL the caller passed directly', async () => {
    await expect(fetchAndParseURL(METADATA_URL, { logger })).rejects.toThrow(/blocked for security reasons/i);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('FOLLOWS an ordinary public redirect and returns the final content', async () => {
    // The regression that matters most: legitimate redirects (http->https, /a -> /a/) must still
    // resolve, or every real URL breaks in exchange for the guard.
    axiosGet.mockResolvedValueOnce(redirectTo('http://93.184.216.35/article/')).mockResolvedValueOnce(ok(PAGE));

    const result = await fetchAndParseURL(PUBLIC_URL, { logger });

    expect(axiosGet).toHaveBeenCalledTimes(2);
    expect(axiosGet.mock.calls[1][0]).toBe('http://93.184.216.35/article/');
    expect(result.title).toBe('An Article');
    expect(result.textContent).toContain('Hello');
  });

  it('resolves a RELATIVE Location against the current URL', async () => {
    axiosGet.mockResolvedValueOnce(redirectTo('/moved/here')).mockResolvedValueOnce(ok(PAGE));

    await fetchAndParseURL(PUBLIC_URL, { logger });

    expect(axiosGet.mock.calls[1][0]).toBe('http://93.184.216.34/moved/here');
  });

  it('does not follow redirects internally - every request opts out', async () => {
    axiosGet.mockResolvedValueOnce(ok(PAGE));

    await fetchAndParseURL(PUBLIC_URL, { logger });

    // Without this, axios follows up to 21 hops on its own and the guard sees only the first.
    expect(axiosGet.mock.calls[0][1]).toMatchObject({ maxRedirects: 0 });
  });

  it('gives up after too many redirects instead of looping', async () => {
    axiosGet.mockResolvedValue(redirectTo('http://93.184.216.34/again'));

    await expect(fetchAndParseURL(PUBLIC_URL, { logger })).rejects.toThrow(/too many redirects/i);
  });

  it('bounds the response size so an unbounded body cannot be buffered', async () => {
    axiosGet.mockResolvedValueOnce(ok(PAGE));

    await fetchAndParseURL(PUBLIC_URL, { logger });

    // axios defaults both of these to -1 (unlimited); a linked URL comes from any Slack user.
    const config = axiosGet.mock.calls[0][1];
    expect(config.maxContentLength).toBe(50 * 1024 * 1024);
    expect(config.maxBodyLength).toBe(50 * 1024 * 1024);
  });

  it('shares ONE timeout budget across the chain rather than restarting it per hop', async () => {
    axiosGet.mockResolvedValueOnce(redirectTo('http://93.184.216.35/next')).mockResolvedValueOnce(ok(PAGE));

    await fetchAndParseURL(PUBLIC_URL, { logger });

    // A per-hop timeout would give hop 2 a fresh full allowance, multiplying the worst case by
    // MAX_REDIRECTS + 1 - long enough to trip a caller's Mongo transaction lifetime.
    const first = axiosGet.mock.calls[0][1].timeout;
    const second = axiosGet.mock.calls[1][1].timeout;
    expect(first).toBeLessThanOrEqual(10_000);
    expect(second).toBeLessThanOrEqual(first);
  });

  it('always requests bytes, so a cross-content-type redirect cannot be mis-decoded', async () => {
    axiosGet.mockResolvedValueOnce(ok(PAGE));

    await fetchAndParseURL(PUBLIC_URL, { logger });

    // The response type used to be picked from the CALLER's url extension, before any redirect was
    // known. Fetching bytes every time is what lets the parse decision wait for the real response.
    expect(axiosGet.mock.calls[0][1]).toMatchObject({ responseType: 'arraybuffer' });
  });

  it('treats a 3xx with no Location as the final response', async () => {
    axiosGet.mockResolvedValueOnce({ status: 302, data: PAGE, headers: {} });

    const result = await fetchAndParseURL(PUBLIC_URL, { logger });

    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(result.title).toBe('An Article');
  });
});

/**
 * Content typing and naming are decided from the FINAL response rather than the caller's URL. Both
 * used to read the pasted URL, which is wrong the moment a redirect changes where we land.
 */
describe('fetchAndParseURL content typing and naming after redirects', () => {
  const html = (body: string) => ({ status: 200, data: body, headers: { 'content-type': 'text/html' } });

  it('does NOT parse as PDF when a .pdf URL redirects to an HTML page', async () => {
    axiosGet.mockResolvedValueOnce(redirectTo('http://93.184.216.35/gateway')).mockResolvedValueOnce(html(PAGE));

    const result = await fetchAndParseURL('http://93.184.216.34/report.pdf', { logger });

    expect(result.mimeType).toBe('text/plain');
    expect(result.title).toBe('An Article');
  });

  it('DOES parse as PDF when the server says so, even with no extension in the URL', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from('%PDF-1.4 fake'),
      headers: { 'content-type': 'application/pdf' },
    });

    const result = await fetchAndParseURL('http://93.184.216.34/download?id=9', { logger });

    expect(result.mimeType).toBe('application/pdf');
    expect(Buffer.isBuffer(result.textContent)).toBe(true);
  });

  it('does not treat a .pdf in the QUERY STRING as a PDF', async () => {
    // The old extension test split on '.' and looked at the last segment, so `?doc=report.pdf`
    // matched and an HTML page was handed to the PDF branch.
    axiosGet.mockResolvedValueOnce(ok(PAGE));

    const result = await fetchAndParseURL('http://93.184.216.34/view?doc=report.pdf', { logger });

    expect(result.mimeType).toBe('text/plain');
  });

  it('names an untitled page from the FINAL url, not the pasted one', async () => {
    axiosGet
      .mockResolvedValueOnce(redirectTo('http://93.184.216.35/final-document'))
      .mockResolvedValueOnce(html('<html><body><p>no title element here</p></body></html>'));

    const result = await fetchAndParseURL('http://93.184.216.34/pasted-link', { logger });

    expect(result.title).toBe('final-document');
  });
});
