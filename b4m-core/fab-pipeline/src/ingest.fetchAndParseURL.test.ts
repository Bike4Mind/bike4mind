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
    // without these, deleting the td/th separator would still pass (the run-on "Status code404"
    // still contains both substrings), and so would carving td/th back out of the block selector,
    // which puts the next cell on its own line instead of keeping the row together.
    expect(result.textContent).not.toContain('Status code404');
    expect(result.textContent).toContain('Status code 404');
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

  it('separates non-inline elements outside the common block set', async () => {
    // Every OTHER extraction test here uses a tag the old enumerated allowlist already covered, so
    // this case is the only thing stopping the deliberate inline-denylist inversion from being
    // 'simplified' back into an allowlist with CI still green. The tags below are the ones that
    // allowlist missed; on a real Node.js API page the <details><summary> pattern alone jams its
    // heading into the following text roughly a hundred times.
    const page =
      '<html><body>' +
      '<details><summary>History</summary><p>Changed in v2</p></details>' +
      '<nav>Home</nav><nav>About</nav>' +
      // Deliberately NOT <button>/<select>, which are the obvious members of this tag family:
      // those are stripped as page chrome now, so they cannot double as separator fixtures here.
      '<hgroup>Submit</hgroup><hgroup>Cancel</hgroup>' +
      '<aside>Sidebar</aside><address>Contact us</address>' +
      '<fieldset>Alpha</fieldset><output>Beta</output>' +
      '</body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/docs', { logger });

    expect(result.textContent).toContain('History');
    expect(result.textContent).toContain('Changed in v2');
    expect(result.textContent).toContain('Home');
    expect(result.textContent).toContain('About');
    expect(result.textContent).toContain('Submit');
    expect(result.textContent).toContain('Cancel');
    expect(result.textContent).toContain('Sidebar');
    expect(result.textContent).toContain('Contact us');
    expect(result.textContent).toContain('Alpha');
    expect(result.textContent).toContain('Beta');
    // One jam per tag family - the positives above alone would still pass if a break were dropped.
    expect(result.textContent).not.toContain('HistoryChanged');
    expect(result.textContent).not.toContain('HomeAbout');
    expect(result.textContent).not.toContain('SubmitCancel');
    expect(result.textContent).not.toContain('SidebarContact');
    expect(result.textContent).not.toContain('AlphaBeta');
  });

  it('keeps inline elements inline instead of breaking a sentence at every tag', async () => {
    // The other half of the same selector. Collapsing it to a bare '*' passes every block-separation
    // case above while shredding ordinary prose - a linked, emphasized sentence comes back as
    // 'See the docs\nfor more\ndetail.' - so the inline carve-out needs its own pin.
    const page =
      '<html><body>' +
      '<p>See the <a href="/x">docs</a> for <strong>more</strong> detail.</p>' +
      '<p>Press <code>npm i</code> then <em>wait</em>.</p>' +
      '</body></html>';
    axiosGet.mockResolvedValueOnce(html(page));

    const result = await fetchAndParseURL('http://93.184.216.34/guide', { logger });

    expect(result.textContent).toContain('See the docs for more detail.');
    expect(result.textContent).toContain('Press npm i then wait.');
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

describe('fetchAndParseURL page-chrome stripping', () => {
  const html = (body: string) => ({ status: 200, data: body, headers: { 'content-type': 'text/html' } });
  const fetchText = async (page: string) => {
    axiosGet.mockResolvedValueOnce(html(page));
    const result = await fetchAndParseURL('http://93.184.216.34/docs', { logger });
    return String(result.textContent);
  };

  // Each of the four below is modeled on the markup one of the pages that motivated this actually
  // ships, because the tell differs per site and no single rule covers them: GitHub's docs chrome is
  // aria-hidden tooltip spans and a survey outside <main>, Tailwind's top nav is unmarked <div>s of
  // links with no landmark anywhere, and react.dev's sandbox toolbar mixes <button>s with an <a>.

  it('drops aria-hidden tooltip labels rendered beside icon buttons', async () => {
    const page =
      '<html><body><main>' +
      '<div><span aria-hidden="true">Collapse sidebar</span><span aria-hidden="true">Expand sidebar</span></div>' +
      '<p>Real prose about workflows.</p>' +
      '</main></body></html>';

    const text = await fetchText(page);

    expect(text).not.toContain('Collapse sidebar');
    expect(text).not.toContain('Expand sidebar');
    expect(text).toContain('Real prose about workflows.');
  });

  it('extracts from <main> and leaves site header and footer chrome outside it alone', async () => {
    const page =
      '<html><body>' +
      '<header role="banner"><span aria-hidden="true">Search or ask Copilot</span></header>' +
      '<main><p>Quickstart for GitHub Actions.</p></main>' +
      '<footer><h3>Help us make these docs great!</h3>' +
      '<form><div role="radiogroup"><label>Yes</label><label>No</label></div></form>' +
      '<a href="/privacy">Privacy policy</a></footer>' +
      '</body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Quickstart for GitHub Actions.');
    expect(text).not.toContain('Search or ask Copilot');
    expect(text).not.toContain('Help us make these docs great');
    expect(text).not.toContain('Privacy policy');
    expect(text).not.toMatch(/\bYes\b/);
    expect(text).not.toMatch(/\bNo\b/);
  });

  it('drops an unmarked nav bar of links on a page with no landmark at all', async () => {
    const page =
      '<html><body><div><div>' +
      '<div><a href="/docs">Docs</a><a href="/blog">Blog</a><a href="/showcase">Showcase</a></div>' +
      '<div><button>Search</button><kbd>Ctrl K</kbd></div>' +
      '</div>' +
      '<h1>Installing Tailwind CSS as a Vite plugin</h1>' +
      '<p>It is fast, flexible, and reliable.</p>' +
      '</body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Installing Tailwind CSS as a Vite plugin');
    expect(text).toContain('It is fast, flexible, and reliable.');
    expect(text).not.toContain('Docs');
    expect(text).not.toContain('Showcase');
    expect(text).not.toContain('Search');
  });

  it('drops a link sharing a toolbar with buttons, which a tag-based rule cannot see', async () => {
    // The `Fork` link is chrome only because of the company it keeps: on its own an <a> is content.
    const page =
      '<html><body><main><article>' +
      '<div><button>Reload</button><button>Clear</button><a href="https://codesandbox.io/x">Fork</a></div>' +
      '<p>useState is a React Hook that lets you add a state variable.</p>' +
      '</article></main></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('useState is a React Hook that lets you add a state variable.');
    expect(text).not.toContain('Reload');
    expect(text).not.toContain('Clear');
    expect(text).not.toContain('Fork');
  });

  it('KEEPS real content in <aside> and <footer>, the failure mode the naive fix causes', async () => {
    // Dropping these tags outright is the obvious way to strip chrome and it is wrong: a pull quote
    // in an <aside> and an author note in a <footer> are the article. Nothing here declares a
    // <main>, so the whole document is the scope and both have to survive on their own merits.
    const page =
      '<html><body>' +
      '<article><p>The main argument of the piece.</p>' +
      '<aside><h2>Background</h2><p>A pull quote with real substance that belongs in the index.</p></aside>' +
      '<footer><p>Written by a staff reporter covering monetary policy since 2011.</p></footer>' +
      '</article></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('The main argument of the piece.');
    expect(text).toContain('Background');
    expect(text).toContain('A pull quote with real substance that belongs in the index.');
    expect(text).toContain('Written by a staff reporter covering monetary policy since 2011.');
  });

  it('KEEPS an <aside> and <footer> that live INSIDE the declared <main>', async () => {
    const page =
      '<html><body>' +
      '<header role="banner"><a href="/">Home</a><a href="/about">About</a></header>' +
      '<main><p>The body of the article.</p>' +
      '<aside><p>A sidebar note that expands on the argument.</p></aside>' +
      '<footer><p>Corrections: an earlier version misstated the date.</p></footer>' +
      '</main></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('The body of the article.');
    expect(text).toContain('A sidebar note that expands on the argument.');
    expect(text).toContain('Corrections: an earlier version misstated the date.');
  });

  it('keeps a single short link, so an ordinary content list is not mistaken for a nav', async () => {
    // Two controls is the threshold; one is how a real list item or a linked card reads. The <ul>
    // holding both WOULD qualify, which is the rule doing its job on a nav - what saves this page
    // is the rollback below, since pruning it leaves nothing at all.
    const page =
      '<html><body><ul>' +
      '<li><a href="/a">Understanding GitHub Actions</a></li>' +
      '<li><a href="/b">Using workflow templates</a></li>' +
      '</ul></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Understanding GitHub Actions');
    expect(text).toContain('Using workflow templates');
  });

  it('keeps a link list whose entries are prose rather than labels', async () => {
    const page =
      '<html><body><div>' +
      '<a href="/a">Committing the workflow file to a branch triggers the push event and runs it.</a>' +
      '<a href="/b">If you chose to start a pull request, you can continue and create it.</a>' +
      '</div></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('triggers the push event');
    expect(text).toContain('you can continue and create it');
  });

  it('rolls the pruning back rather than storing nothing for a page that IS a list of links', async () => {
    const entries = Array.from({ length: 40 }, (_unused, index) => `<a href="/p${index}">Chapter ${index}</a>`).join(
      ''
    );
    const page = `<html><body><div>${entries}</div></body></html>`;

    const text = await fetchText(page);

    expect(text).toContain('Chapter 0');
    expect(text).toContain('Chapter 39');
  });

  it('prunes a nav on a page that has prose, and does NOT roll back because prose survives', async () => {
    // The other side of the rollback: identical nav markup to the case above, one paragraph added.
    const entries = Array.from({ length: 40 }, (_unused, index) => `<a href="/p${index}">Chapter ${index}</a>`).join(
      ''
    );
    const page = `<html><body><div>${entries}</div><p>The chapter itself, in prose.</p></body></html>`;

    const text = await fetchText(page);

    expect(text).toBe('The chapter itself, in prose.');
  });

  it('ignores an empty <main> shell instead of extracting nothing from it', async () => {
    // A client-rendered app can ship <main></main> with the real content elsewhere in the document.
    const page =
      '<html><body><main></main><div><p>Server-rendered prose that is the whole page.</p></div></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Server-rendered prose that is the whole page.');
  });

  it('does not let an aria-hidden wrapper take a whole real article down with it', async () => {
    // The strip rule and the non-content removal used to be gated by one rollback each - here the
    // article's ONLY container is a non-content wrapper, so nothing was left to trigger a rollback
    // and the page extracted to "".
    const page =
      '<html><body><div aria-hidden="true"><article><h1>Title</h1>' +
      '<p>The entire article body.</p></article></div></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('The entire article body.');
  });

  it('does not let a <dialog> wrapper take a whole real article down with it', async () => {
    const page = '<html><body><dialog open><p>The whole article lives in a dialog.</p></dialog></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('The whole article lives in a dialog.');
  });

  it('rolls back both the strip AND the non-content removal together when together they empty the page', async () => {
    // The label is what keeps the page non-empty right up until NON_CONTENT_SELECTOR removes it -
    // after the strip is pruned first, this is a page whose only remaining text lives in a <label>.
    const entries = Array.from({ length: 40 }, (_unused, index) => `<a href="/p${index}">Chapter ${index}</a>`).join(
      ''
    );
    const page = `<html><body><div>${entries}</div><form><label>Sign in to continue reading.</label></form></body></html>`;

    const text = await fetchText(page);

    expect(text).toContain('Chapter 0');
    expect(text).toContain('Sign in to continue reading.');
  });

  it('rolls back a link directory even though its footer copyright line survives on its own', async () => {
    // A bare rollback gate ("is ANY text left") is defeated by this - the copyright line alone is
    // enough to look like the pruning "worked", even though the page is still overwhelmingly links.
    const entries = Array.from({ length: 40 }, (_unused, index) => `<a href="/p${index}">Chapter ${index}</a>`).join(
      ''
    );
    const page = `<html><body><div>${entries}</div><footer>(c) 2024 Acme Inc</footer></body></html>`;

    const text = await fetchText(page);

    expect(text).toContain('Chapter 0');
    expect(text).toContain('Chapter 39');
  });

  it('rolls back a linked list even though a short "Further reading" label survives on its own', async () => {
    const page =
      '<html><body><p>Further reading.</p><ul>' +
      '<li><a href="/a">Article A</a></li><li><a href="/b">Article B</a></li>' +
      '</ul></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Article A');
    expect(text).toContain('Article B');
  });

  it('does not lose real content outside <main> when <main> is truthy only because of a loading placeholder', async () => {
    const page =
      '<html><body><main>Loading...</main>' +
      '<article><p>The server-rendered article prose that matters.</p></article></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('The server-rendered article prose that matters.');
  });

  it('falls back to the whole document when <main> holds nothing but a nav bar', async () => {
    const page =
      '<html><body><main><nav><a href="/">Home</a><a href="/blog">Blog</a></nav></main>' +
      '<div><p>Real article body that must not be lost.</p></div></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Real article body that must not be lost.');
    expect(text).not.toContain('Home');
    expect(text).not.toContain('Blog');
  });

  it('keeps a reference table of linked cells, which a table row can never be a nav bar for', async () => {
    const page =
      '<html><body><p>API reference.</p><table>' +
      '<tr><td><a href="/useState">useState</a></td><td><a href="/hook">Hook</a></td></tr>' +
      '<tr><td><a href="/useEffect">useEffect</a></td><td><a href="/hook2">Hook</a></td></tr>' +
      '</table></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('API reference.');
    expect(text).toContain('useState');
    expect(text).toContain('useEffect');
  });

  it('drops a nav bar carrying one extra bare word alongside its links', async () => {
    // A wordmark or a lone "Menu" span used to be enough non-control text to defeat the whole strip.
    const page =
      '<html><body><nav><a href="/">Home</a><a href="/docs">Docs</a><span>Menu</span></nav>' +
      '<p>Real prose paragraph describing the article content in detail.</p></body></html>';

    const text = await fetchText(page);

    expect(text).not.toContain('Home');
    expect(text).not.toContain('Docs');
    expect(text).not.toContain('Menu');
    expect(text).toContain('Real prose paragraph describing the article content in detail.');
  });

  it('treats a 40-character control label as still strippable, and a 41-character one as not', async () => {
    const label40 = 'A'.repeat(40);
    const label41 = 'A'.repeat(41);
    const pageWith = (label: string) =>
      `<html><body><nav><a href="/a">${label}</a><a href="/b">${label}</a></nav>` +
      '<p>Real distinguishing prose that must survive regardless.</p></body></html>';

    const textAt40 = await fetchText(pageWith(label40));
    expect(textAt40).not.toContain(label40);
    expect(textAt40).toContain('Real distinguishing prose that must survive regardless.');

    const textAt41 = await fetchText(pageWith(label41));
    expect(textAt41).toContain(label41);
    expect(textAt41).toContain('Real distinguishing prose that must survive regardless.');
  });

  it('keeps a short link list whose labels are sentences rather than nav-style words', async () => {
    // Both labels are well under the 40-character length cap, so only the sentence-punctuation
    // clause is what disqualifies this as a strip.
    const page =
      '<html><body><nav><a href="/a">Yes. Go.</a><a href="/b">No. Stop.</a></nav>' +
      '<p>Real prose that also must survive.</p></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Yes. Go.');
    expect(text).toContain('No. Stop.');
    expect(text).toContain('Real prose that also must survive.');
  });

  it('treats 15 characters of non-control text in a strip as still strippable, and 16 as not', async () => {
    const pageWith = (extra: string) =>
      `<html><body><nav><a href="/a">Home</a><a href="/b">Docs</a><span>${extra}</span></nav>` +
      '<p>Real prose paragraph describing the article content in enough detail.</p></body></html>';

    const nonControlText15 = 'A'.repeat(15);
    const textAt15 = await fetchText(pageWith(nonControlText15));
    expect(textAt15).not.toContain('Home');
    expect(textAt15).not.toContain(nonControlText15);
    expect(textAt15).toContain('Real prose paragraph describing the article content in enough detail.');

    const nonControlText16 = 'A'.repeat(16);
    const textAt16 = await fetchText(pageWith(nonControlText16));
    expect(textAt16).toContain(nonControlText16);
    expect(textAt16).toContain('Real prose paragraph describing the article content in enough detail.');
  });

  it('treats a control strip within the depth cap as still strippable, and one past it as not', async () => {
    // MAX_STRIP_CONTAINER_DEPTH is 32, measured from the document root: a <nav> wrapped in N
    // levels sits at depth N + 2 (html -> body -> N wrappers -> nav), so 30 wrappers land the nav
    // exactly at the cap and 31 land it one past it. Wrapped in <article>, not <div> - a <div>
    // wrapper with no text of its own and the nav's two links as its only descendants would
    // itself qualify as a (shallow, well-within-cap) control strip and get removed as a whole,
    // never exercising the nav's own depth at all. <article> is not a STRIP_CONTAINER_SELECTOR
    // tag, so it only adds depth without being a candidate itself.
    const wrap = (depth: number, inner: string) => '<article>'.repeat(depth) + inner + '</article>'.repeat(depth);
    const nav = '<nav><a href="/a">Home</a><a href="/b">Docs</a></nav>';
    const prose = '<p>Real prose paragraph describing the article content in detail.</p>';

    const atCap = `<html><body>${wrap(30, nav)}${prose}</body></html>`;
    const textAtCap = await fetchText(atCap);
    expect(textAtCap).not.toContain('Home');
    expect(textAtCap).not.toContain('Docs');
    expect(textAtCap).toContain('Real prose paragraph describing the article content in detail.');

    // Deliberate, documented gap (see MAX_STRIP_CONTAINER_DEPTH): a genuine nav bar nested past the
    // cap is never evaluated as a strip candidate at all, so it survives untouched.
    const pastCap = `<html><body>${wrap(31, nav)}${prose}</body></html>`;
    const textPastCap = await fetchText(pastCap);
    expect(textPastCap).toContain('Home');
    expect(textPastCap).toContain('Docs');
    expect(textPastCap).toContain('Real prose paragraph describing the article content in detail.');
  });

  it('extracts a deeply nested document without throwing or hanging', async () => {
    // Regression guard only: pins that a 500-level document still completes within a generous
    // budget, so a future change that reintroduces unbounded recursion or a pathological loop
    // fails loudly. It is NOT a measurement of the depth cap's benefit - the bound is loose enough
    // that the uncapped implementation also clears it; `MAX_STRIP_CONTAINER_DEPTH`'s own cost
    // tradeoff is pinned by the depth-cap boundary test above instead.
    const depth = 500;
    const page =
      '<html><body>' +
      '<div>'.repeat(depth) +
      '<p>Deeply nested real content.</p>' +
      '</div>'.repeat(depth) +
      '</body></html>';

    const start = Date.now();
    const text = await fetchText(page);
    const elapsed = Date.now() - start;

    expect(text).toContain('Deeply nested real content.');
    expect(elapsed).toBeLessThan(3000);
  });

  it('does not drop inline links, and the words between them, out of a sentence', async () => {
    // A <span> wrapping two short links in the middle of a paragraph is structurally identical to a
    // toolbar (two controls, little non-control text) - only its prose ancestry tells them apart.
    const page =
      '<html><body><main><p>This behaviour is specified in ' +
      '<span><a href="/rfc">RFC 9110</a> and <a href="/errata">its errata</a></span>' +
      ', which every conforming client must implement.</p></main></body></html>';

    const text = await fetchText(page);

    expect(text).toBe(
      'This behaviour is specified in RFC 9110 and its errata, which every conforming client must implement.'
    );
  });

  it('does not drop inline links out of a sentence wrapped in a non-prose tag', async () => {
    // Same shape as the <p>-wrapped case above, but the sentence's own container is a <div>,
    // <section> or <td> - none of which is in PROSE_ANCESTOR_SELECTOR. Only the tag-agnostic
    // adjacent-text-node check (hasAdjacentProseText) protects these; the ancestor-tag check alone
    // does not see them.
    const sentence = (open: string, close: string) =>
      `${open}This behaviour is specified in ` +
      '<span><a href="/rfc">RFC 9110</a> and <a href="/errata">its errata</a></span>' +
      `, which every conforming client must implement.${close}`;
    const expected =
      'This behaviour is specified in RFC 9110 and its errata, which every conforming client must implement.';

    const divPage = `<html><body><main>${sentence('<div>', '</div>')}</main></body></html>`;
    expect(await fetchText(divPage)).toBe(expected);

    const sectionPage = `<html><body><main>${sentence('<section>', '</section>')}</main></body></html>`;
    expect(await fetchText(sectionPage)).toBe(expected);

    const tablePage =
      '<html><body><main><table><tr><td>' + sentence('', '') + '</td></tr></table></main></body></html>';
    expect(await fetchText(tablePage)).toContain(expected);
  });

  it('keeps a self-contained callout block that is not nested inside a longer sentence', async () => {
    // A "Related:"/"See also:" callout sitting in its own <div> is the whole short block, not a
    // fragment nested inside a longer one - hasAdjacentProseText/hasProseAncestor only look outside
    // the candidate, so neither one saves it. Only the strip-budget itself being landmark-only
    // (see LANDMARK_CHROME_SELECTOR) stops "Related: " from clearing isControlStrip.
    const page =
      '<html><body><main>' +
      '<p>The API supports pagination via the cursor parameter, which should be treated as an opaque token by clients.</p>' +
      '<div>Related: <a href="/pagination">Pagination guide</a> and <a href="/cursors">Cursor tokens</a>.</div>' +
      '<p>Rate limits are enforced per API key and reset on a rolling one-minute window.</p>' +
      '</main></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Related: Pagination guide and Cursor tokens.');
    expect(text).toContain('The API supports pagination via the cursor parameter');
    expect(text).toContain('Rate limits are enforced per API key');
  });

  it('still strips a nav bar with a bare wordmark alongside its links (landmark tags keep the budget)', async () => {
    const page =
      '<html><body><nav>' +
      '<a href="/a">Home</a><a href="/b">Docs</a><span>Acme</span>' +
      '</nav>' +
      '<p>Real prose paragraph describing the article content in detail.</p></body></html>';

    const text = await fetchText(page);

    expect(text).not.toContain('Home');
    expect(text).not.toContain('Docs');
    expect(text).not.toContain('Acme');
    expect(text).toContain('Real prose paragraph describing the article content in detail.');
  });

  it('does not strip a link pair sitting inside a list item, heading, or blockquote', async () => {
    const page =
      '<html><body><main>' +
      '<h2>See also <a href="/a">Alpha</a> and <a href="/b">Beta</a></h2>' +
      '<li><span><a href="/c">Gamma</a> or <a href="/d">Delta</a></span></li>' +
      '<blockquote><span><a href="/e">Epsilon</a>, <a href="/f">Zeta</a></span> said so.</blockquote>' +
      '<p>Enough surrounding prose to keep this page well past the survival floor regardless.</p>' +
      '</main></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).toContain('Gamma');
    expect(text).toContain('Delta');
    expect(text).toContain('Epsilon');
    expect(text).toContain('Zeta');
  });

  it('still strips a toolbar even though it sits next to a <p> rather than inside one', async () => {
    // The prose-ancestor exclusion only declines a candidate NESTED inside prose - a sibling
    // toolbar block must still be caught, or the exclusion would swallow genuine chrome too.
    const page =
      '<html><body><main>' +
      '<div><a href="/reload">Reload</a><a href="/clear">Clear</a><a href="/fork">Fork</a></div>' +
      '<p>Real article prose that has nothing to do with the sandbox toolbar above it.</p>' +
      '</main></body></html>';

    const text = await fetchText(page);

    expect(text).not.toContain('Reload');
    expect(text).not.toContain('Clear');
    expect(text).not.toContain('Fork');
    expect(text).toContain('Real article prose that has nothing to do with the sandbox toolbar above it.');
  });

  it('keeps a two-item content list of links when real prose survives elsewhere on the page', async () => {
    // Same shape as the earlier "keeps a single short link" rollback case, but with enough OTHER
    // prose on the page that the rollback never fires - so this is the one place the <ul>/<ol>
    // control threshold, not the rollback, has to be what protects the list.
    const page =
      '<html><body><main>' +
      '<p>Long enough paragraph of real prose to clear the survival floor easily on its own.</p>' +
      '<ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul>' +
      '</main></body></html>';

    const text = await fetchText(page);

    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).toContain('Long enough paragraph of real prose to clear the survival floor easily on its own.');
  });

  it('still strips a three-item nav list even with prose surviving elsewhere', async () => {
    const page =
      '<html><body><main>' +
      '<ul><li><a href="/a">Home</a></li><li><a href="/b">Docs</a></li><li><a href="/c">Blog</a></li></ul>' +
      '<p>Real article prose that must survive the nav-list strip above it.</p>' +
      '</main></body></html>';

    const text = await fetchText(page);

    expect(text).not.toContain('Home');
    expect(text).not.toContain('Docs');
    expect(text).not.toContain('Blog');
    expect(text).toContain('Real article prose that must survive the nav-list strip above it.');
  });

  it('treats one control as too few to strip a div, and two as enough', async () => {
    const pageWith = (links: string) =>
      `<html><body><main><div>${links}</div>` +
      '<p>Real prose paragraph describing the article content in detail.</p></main></body></html>';

    const oneLink = await fetchText(pageWith('<a href="/a">Home</a>'));
    expect(oneLink).toContain('Home');
    expect(oneLink).toContain('Real prose paragraph describing the article content in detail.');

    const twoLinks = await fetchText(pageWith('<a href="/a">Home</a><a href="/b">Docs</a>'));
    expect(twoLinks).not.toContain('Home');
    expect(twoLinks).not.toContain('Docs');
    expect(twoLinks).toContain('Real prose paragraph describing the article content in detail.');
  });

  it('treats 20 surviving characters as enough to trust a prune, and 19 as not', async () => {
    const pageWith = (remnant: string) =>
      `<html><body><nav><a href="/a">Home</a><a href="/b">Docs</a></nav><p>${remnant}</p></body></html>`;

    const remnant19 = 'A'.repeat(19);
    const textAt19 = await fetchText(pageWith(remnant19));
    expect(textAt19).toContain('Home');
    expect(textAt19).toContain('Docs');
    expect(textAt19).toContain(remnant19);

    const remnant20 = 'A'.repeat(20);
    const textAt20 = await fetchText(pageWith(remnant20));
    expect(textAt20).not.toContain('Home');
    expect(textAt20).not.toContain('Docs');
    expect(textAt20).toContain(remnant20);
  });
});
