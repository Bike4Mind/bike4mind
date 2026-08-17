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
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from './ssrfProtection';

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

  it('pins every request through the SSRF-safe agents', async () => {
    axiosGet.mockResolvedValueOnce(ok(PAGE));

    await fetchAndParseURL(PUBLIC_URL, { logger });

    // These two options ARE the DNS-rebinding defence: without them the per-hop URL check still runs
    // but the socket re-resolves, so a rebinding host passes validation and connects internally.
    // Asserted here because deleting them from ingest.ts leaves the whole suite green otherwise - the
    // only other backstop is an unused-import lint error, which an IDE autofix removes along with them.
    // BOTH are required: a redirect chain can cross schemes, and axios picks the agent per scheme.
    expect(axiosGet.mock.calls[0][1]).toMatchObject({
      httpAgent: ssrfSafeHttpAgent,
      httpsAgent: ssrfSafeHttpsAgent,
    });
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

  it.each(['application/octet-stream', 'binary/octet-stream', 'APPLICATION/OCTET-STREAM'])(
    'treats a .pdf served as %s as a PDF, not text',
    async ct => {
      // The regression this guards: generic-binary carries no format signal, so keying the fallback on
      // "Content-Type absent" alone sent PDF bytes through toString('utf8') into garbage that was then
      // chunked and vectorized. S3 objects stored without an explicit ContentType and
      // `Content-Disposition: attachment` links both arrive exactly this way.
      axiosGet.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from('%PDF-1.4 fake'),
        headers: { 'content-type': ct },
      });

      const result = await fetchAndParseURL('http://93.184.216.34/report.pdf', { logger });

      expect(result.mimeType).toBe('application/pdf');
      expect(Buffer.isBuffer(result.textContent)).toBe(true);
    }
  );

  it('still parses a NON-pdf url served as octet-stream as text', async () => {
    // The fallback needs a positive PDF signal - a .pdf path OR the PDF signature in the bytes - so
    // generic-binary alone must not promote anything. This body is HTML on both counts.
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: PAGE,
      headers: { 'content-type': 'application/octet-stream' },
    });

    const result = await fetchAndParseURL('http://93.184.216.34/article', { logger });

    expect(result.mimeType).toBe('text/plain');
    expect(result.title).toBe('An Article');
  });

  /**
   * The door left open after the Content-Type fallback: a download endpoint with NO `.pdf` in its
   * path, served as `application/octet-stream`. Neither signal the fallback relies on was present, so
   * PDF bytes went through `toString('utf8')` and were chunked and vectorized as garbage - the exact
   * corruption the fallback exists to prevent, reached by the one remaining route.
   */
  it('treats an EXTENSION-LESS octet-stream download as a PDF when the bytes say so', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'),
      headers: { 'content-type': 'application/octet-stream' },
    });

    const result = await fetchAndParseURL('http://93.184.216.34/download?id=9', { logger });

    expect(result.mimeType).toBe('application/pdf');
    expect(Buffer.isBuffer(result.textContent)).toBe(true);
  });

  it('does not promote a generic-binary body that merely CONTAINS the signature later on', async () => {
    // Offset-0 only. Sniffing ahead would mean re-classifying on arbitrary attacker-supplied content,
    // and a false positive hands a real text document to the PDF branch.
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from('not a pdf at all, but it mentions %PDF-1.4 in passing'),
      headers: { 'content-type': 'application/octet-stream' },
    });

    const result = await fetchAndParseURL('http://93.184.216.34/download?id=9', { logger });

    expect(result.mimeType).toBe('text/plain');
  });

  it('does not let the signature override a server that stated a type', async () => {
    // Deliberate boundary, not an oversight: the sniff is consulted only where the server gave no
    // format signal. Overriding an explicit Content-Type is a wider change than this fix needs.
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from('%PDF-1.4 fake'),
      headers: { 'content-type': 'text/html' },
    });

    const result = await fetchAndParseURL('http://93.184.216.34/download?id=9', { logger });

    expect(result.mimeType).toBe('text/plain');
  });

  it('does not treat a .pdf in the QUERY STRING as a PDF', async () => {
    // The old extension test split on '.' and looked at the last segment, so `?doc=report.pdf`
    // matched and an HTML page was handed to the PDF branch.
    axiosGet.mockResolvedValueOnce(ok(PAGE));

    const result = await fetchAndParseURL('http://93.184.216.34/view?doc=report.pdf', { logger });

    expect(result.mimeType).toBe('text/plain');
  });

  it('NEVER logs embedded URL credentials, on success or on failure', async () => {
    // `https://user:pass@host/doc` is a legitimate paste and this function is reached from Slack and
    // from the LLM chat path, so the raw URL must not survive into a log record that outlives the
    // message. The fetch itself still uses the credentialed URL.
    const credentialed = 'http://alice:s3cret@93.184.216.34/private';
    axiosGet.mockResolvedValueOnce(html(PAGE));

    await fetchAndParseURL(credentialed, { logger });

    const logged = (logger.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(logged).not.toContain('s3cret');
    expect(logged).toContain('93.184.216.34');

    // The fetch used the ORIGINAL url, credentials included - redaction is for the record only.
    expect(axiosGet.mock.calls[0][0]).toBe(credentialed);

    axiosGet.mockRejectedValueOnce(new Error('boom'));
    await expect(fetchAndParseURL(credentialed, { logger })).rejects.toThrow();
    const meta = (logger.updateMetadata as unknown as ReturnType<typeof vi.fn>).mock.calls.flat();
    expect(JSON.stringify(meta)).not.toContain('s3cret');
  });

  it('names an untitled page from the FINAL url, not the pasted one', async () => {
    axiosGet
      .mockResolvedValueOnce(redirectTo('http://93.184.216.35/final-document'))
      .mockResolvedValueOnce(html('<html><body><p>no title element here</p></body></html>'));

    const result = await fetchAndParseURL('http://93.184.216.34/pasted-link', { logger });

    expect(result.title).toBe('final-document');
  });
});
