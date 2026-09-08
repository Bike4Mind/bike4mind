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
    // `proxy: false` is part of the same defence, not a separate nicety: axios honours
    // HTTPS_PROXY/HTTP_PROXY from the environment by default and installs its own agent, which
    // displaces ours - so the pin above would silently stop applying wherever a proxy env var is set.
    expect(axiosGet.mock.calls[0][1]).toMatchObject({ proxy: false });
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

/**
 * Extraction used to collect ONLY `<p>` elements and fall back to the raw HTML string when that
 * found nothing - so a page whose content sits outside `<p>` (RFC-style `<pre>` pages, or a page
 * with headings/lists/tables alongside its `<p>`s) either stored markup verbatim or silently
 * dropped everything but its paragraphs.
 */
describe('fetchAndParseURL whole-body text extraction', () => {
  const html = (body: string) => ({ status: 200, data: body, headers: { 'content-type': 'text/html' } });

  it('extracts readable text from a <pre>-only page instead of falling back to raw markup', async () => {
    // Shaped after an RFC page: no <p> anywhere, all content inside <pre> with inline markup.
    const page =
      '<html><head><title>RFC 7168</title></head><body>' +
      '<pre><span class="h1">Internet Engineering Task Force</span>\n' +
      'A silly example: <a href="./rfc2324">RFC 2324</a></pre>' +
      '</body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/rfc7168.html', { logger });

    expect(result.textContent).toContain('Internet Engineering Task Force');
    expect(result.textContent).toContain('RFC 2324');
    // The old fallback stored the raw HTML string, so these tag fragments would be visible bytes.
    expect(result.textContent).not.toMatch(/<pre|<span|<a\s/i);
  });

  it('preserves <pre> indentation instead of collapsing it like ordinary prose whitespace', async () => {
    // A code block's leading-space indentation is meaningful; the per-line whitespace collapse
    // that normalizes ordinary prose must not touch it.
    const page =
      '<html><body>' + '<pre>def foo():\n    return 1</pre>' + '<p>Some   text   here</p>' + '</body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/snippet', { logger });

    expect(result.textContent).toContain('def foo():\n    return 1');
    // Ordinary prose whitespace still collapses to a single space, unaffected by the <pre> fix.
    expect(result.textContent).toContain('Some text here');
  });

  it('separates adjacent <div>-only content instead of jamming it into one word', async () => {
    // Many React/SPA-rendered pages use <div> per line rather than <p> - without a break after
    // each div, "Hello" and "World" concatenate into the unreadable "HelloWorld".
    const page = '<html><body><div>Hello</div><div>World</div></body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/spa-page', { logger });

    expect(result.textContent).toContain('Hello');
    expect(result.textContent).toContain('World');
    expect(result.textContent).not.toContain('HelloWorld');
  });

  it('captures headings, list items and table cells that live outside <p>', async () => {
    // Shaped after a Wikipedia-style article: substance in headings/lists/tables, not just <p>.
    const page =
      '<html><body>' +
      '<h2>HTTP 404</h2>' +
      '<ul><li>Not Found</li><li>Client error response code</li></ul>' +
      '<table><tr><td>Status code</td><td>404</td></tr></table>' +
      '</body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/wiki/HTTP_404', { logger });

    expect(result.textContent).toContain('HTTP 404');
    expect(result.textContent).toContain('Not Found');
    expect(result.textContent).toContain('Client error response code');
    expect(result.textContent).toContain('Status code');
    expect(result.textContent).toContain('404');
    // Pins the space-separator behavior itself, not just that both strings appear somewhere -
    // without this, deleting the td/th separator would still pass (the run-on "Status code404"
    // still contains both substrings).
    expect(result.textContent).not.toContain('Status code404');
  });

  it('separates adjacent HTML5 semantic containers instead of jamming them together', async () => {
    // article/section/header/footer/main/dt/dd/figcaption/caption all had the same word-jamming
    // gap as bare <div> did before that fix - common on modern blog/doc sites that structure
    // content with these instead of <p> or <div>.
    const page =
      '<html><body>' +
      '<article><section>First section</section><section>Second section</section></article>' +
      '<dl><dt>Term</dt><dd>Definition</dd></dl>' +
      '</body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/blog-post', { logger });

    expect(result.textContent).toContain('First section');
    expect(result.textContent).toContain('Second section');
    expect(result.textContent).not.toContain('First sectionSecond section');
    expect(result.textContent).toContain('Term');
    expect(result.textContent).toContain('Definition');
    expect(result.textContent).not.toContain('TermDefinition');
  });

  it('never lets script, style, or noscript content reach the stored text', async () => {
    const page =
      '<html><head><style>.hidden { display: none }</style></head><body>' +
      '<script>trackPageView("secret-analytics-id");</script>' +
      '<noscript>enable-javascript-notice</noscript>' +
      '<p>Visible paragraph</p>' +
      '</body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/article', { logger });

    expect(result.textContent).toContain('Visible paragraph');
    expect(result.textContent).not.toContain('trackPageView');
    expect(result.textContent).not.toContain('hidden');
    expect(result.textContent).not.toContain('enable-javascript-notice');
  });

  it('stores nothing rather than falling back to raw HTML when there is no extractable text', async () => {
    const page = '<html><head><style>body { color: red }</style></head><body><script>doStuff();</script></body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/empty', { logger });

    expect(result.textContent).toBe('');
    // An empty extraction still returns successfully - the log line has to say so explicitly, or
    // it reads identically to a normal fetch that parsed into real content.
    const logged = (logger.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(logged).toContain('no extractable text was found');
  });
});
