import { Logger } from '@bike4mind/observability';
import axios from 'axios';
import mime from 'mime-types';
import { validateUrlForFetch } from './ssrfProtection';

// Centralized URL regex - handles ports, query params, fragments
export const URL_REGEX =
  /https?:\/\/(?:[-\w.])+(?:\:[0-9]+)?(?:\/(?:[\w\/_.])*(?:\?(?:[\w&=%.])*)?(?:\#(?:[\w.])*)?)?/gi;

export function detectURLs(string: string): string[] {
  const urlsFound = string.match(URL_REGEX) || [];
  return urlsFound;
}

// Check if a string contains any URLs
export function hasURLs(string: string): boolean {
  return URL_REGEX.test(string);
}

// Check if a string contains URLs and return them
export function urlExists(stringWithPossibleUrl: string): string[] {
  const cleanString = stringWithPossibleUrl.replace(/\n/g, ' ').replace(/,/g, ' ');
  return detectURLs(cleanString);
}

interface ParsedContent {
  title: string;
  textContent: Buffer | string;
  mimeType: string;
  ext: string | null;
}

// Default timeout for URL fetching (10 seconds)
const URL_FETCH_TIMEOUT_MS = 10_000;

/**
 * Redirect hops followed before giving up. Deliberately far below axios's own default of 21: every
 * hop costs a DNS resolution plus a request, and no legitimate document needs more than a couple.
 */
const MAX_REDIRECTS = 5;

/**
 * Hard ceiling on a fetched body. A SAFETY NET against an unbounded response, not a policy limit -
 * `createFabFile` still enforces the `MaxFileSize` admin setting afterwards. Set generously (the
 * same 50MB as the Slack attachment ceiling) so it can never refuse something the app would accept;
 * without it axios defaults to `maxContentLength: -1`, i.e. buffer whatever the server sends, and
 * `@datalake add <link>` takes URLs from anyone who can type in a Slack channel.
 */
const URL_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * PDF test against the URL's PATH only. The previous form (`url.split('.').pop().startsWith('pdf')`)
 * also matched a query string, so `?doc=report.pdf` on an HTML page was fetched as a PDF.
 */
function isPdfUrl(url: string): boolean {
  // Deliberately NO try/catch. An unparseable URL cannot reach here - `fetchAndParseURL` only calls
  // this after `validateUrlForFetch(currentUrl)` accepted the address, and anything that parses for
  // the guard parses for `new URL` here. If that ever stops being true, letting the throw propagate
  // is the behaviour we want: `fetchAndParseURL`'s outer catch records `failedUrl` and rethrows, so it
  // surfaces as an ordinary fetch failure instead of being silently classified as not-a-PDF.
  //
  // The tempting fallback - split on '.' and test the last segment - is exactly the behaviour this
  // function replaced, so keeping it as an unreachable safety net would quietly reintroduce the
  // `?doc=report.pdf` mis-parse in the one branch nobody ever reads.
  return new URL(url).pathname.toLowerCase().endsWith('.pdf');
}

/**
 * Strip embedded credentials before a URL is written to a log.
 *
 * `https://user:pass@host/doc` is a legitimate paste, and this function is reached from the Slack
 * `@datalake add` path and the LLM URL-fetch path - both of which take URLs from whoever can type in
 * a channel or a chat. The FETCH still uses the original URL; only what is recorded is redacted, and a
 * log line outlives the message that produced it.
 *
 * MUST STAY IN SYNC with `sanitizeUrlForRecord` in `apps/client/server/slack/dataLakeLinkIngest.ts`,
 * which does the same job for the PERSISTED provenance record. Deliberately duplicated rather than
 * shared: exporting this would change `fab-pipeline`'s public surface, which its own `index.test.ts`
 * pins as an explicit list of names.
 */
function redactUrlCredentials(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (!parsed.username && !parsed.password) return raw;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Unparseable, so the credentials cannot be located to strip them. Log nothing rather than guess.
    return '[unparseable url]';
  }
}

/** Last path segment, used only as a display-name fallback when a page has no `<title>`. */
function lastPathSegment(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
  } catch {
    return url.split('/')?.pop() ?? url;
  }
}

/**
 * Fetch one URL without following redirects, so the caller can SSRF-validate each hop itself.
 *
 * SECURITY: this is why `maxRedirects: 0` is set rather than left at axios's default. Validating
 * only the URL the user supplied is not enough - axios would follow the redirect chain internally,
 * so any public host could answer `302 Location: http://169.254.169.254/latest/meta-data/` and the
 * guard would never see the address actually fetched.
 *
 * `timeoutMs` is the budget REMAINING for the whole operation, not a fresh per-hop allowance - see
 * the deadline in `fetchAndParseURL`.
 */
async function fetchWithoutRedirects(url: string, timeoutMs: number) {
  return axios.get(url, {
    // ALWAYS bytes. The response type cannot be chosen from the caller's URL, because a redirect can
    // land on a different content type entirely - a `.pdf` URL that 302s to an HTML gateway page, or
    // an extensionless URL that 302s to a PDF. Fetching bytes and deciding how to parse AFTERWARDS,
    // from the final response's own Content-Type, removes the guess and the mis-parse it caused.
    responseType: 'arraybuffer',
    timeout: timeoutMs, // Prevent Lambda timeout exhaustion
    maxRedirects: 0,
    maxContentLength: URL_MAX_RESPONSE_BYTES,
    maxBodyLength: URL_MAX_RESPONSE_BYTES,
    // 3xx must reach us as a value rather than a throw; anything else keeps axios's default.
    validateStatus: status => (status >= 200 && status < 300) || (status >= 300 && status < 400),
  });
}

// Fetch and parse HTML content from a URL; returns the page title and text.
export async function fetchAndParseURL(url: string, { logger }: { logger: Logger }): Promise<ParsedContent> {
  logger.updateMetadata({ failedUrl: null });
  try {
    // Follow redirects MANUALLY so the SSRF guard runs against every address we actually fetch,
    // including the first. See `fetchWithoutRedirects`.
    let currentUrl = url;
    let response = null as Awaited<ReturnType<typeof fetchWithoutRedirects>> | null;

    // ONE budget for the whole chain, not per hop. A per-hop timeout would silently multiply the
    // worst case by MAX_REDIRECTS + 1, which matters because callers wrap this: a ~60s fetch is
    // long enough to trip MongoDB's default transaction lifetime. A single-request fetch still gets
    // the full URL_FETCH_TIMEOUT_MS, so the common case is unchanged; only chains share it. Also
    // bounds the DNS resolution above, which no axios timeout covers.
    const deadline = Date.now() + URL_FETCH_TIMEOUT_MS;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // SECURITY: Validate URL to prevent SSRF attacks.
      // This blocks requests to internal networks, cloud metadata endpoints, etc.
      const ssrfValidation = await validateUrlForFetch(currentUrl);
      if (!ssrfValidation.valid) {
        throw new Error(`URL blocked for security reasons: ${ssrfValidation.error}`);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('Timed out while following redirects for URL');
      }

      response = await fetchWithoutRedirects(currentUrl, remainingMs);

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) break;

      const location = response.headers?.location;
      // A 3xx with no usable Location is not something to retry - treat the response as final and
      // let the parsing below do what it can with the body.
      if (typeof location !== 'string' || location.length === 0) break;

      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) while fetching URL`);
      }

      // Resolved against the CURRENT url so a relative Location is handled, and re-validated at the
      // top of the next iteration before anything is requested from it.
      currentUrl = new URL(location, currentUrl).toString();
    }

    if (!response) {
      // Unreachable: the loop always assigns before breaking. Guards the type, not a real case.
      throw new Error('URL fetch produced no response');
    }

    // Type decided from what we ACTUALLY received, not from the URL the caller passed: the server's
    // Content-Type when it states one, otherwise the FINAL url's extension. `currentUrl` is the
    // post-redirect address, so a chain that changes content type is classified correctly.
    const contentType = String(response.headers?.['content-type'] ?? '').toLowerCase();
    // Generic-binary content types carry no format signal, so fall back to the URL extension the
    // same way an absent Content-Type does - otherwise a .pdf served as application/octet-stream
    // is decoded as text. That is how S3 objects stored without an explicit ContentType and
    // `Content-Disposition: attachment` download links arrive, and treating them as text sent PDF
    // bytes through `toString('utf8')` into garbage that then got chunked and vectorized.
    const isGenericBinary =
      !contentType || contentType.includes('application/octet-stream') || contentType.includes('binary/octet-stream');
    const urlMimeType =
      contentType.includes('application/pdf') || (isGenericBinary && isPdfUrl(currentUrl))
        ? 'application/pdf'
        : 'text/plain';

    // `responseType: 'arraybuffer'` gives a Buffer in Node; be tolerant of a string so a caller (or
    // a test) handing back already-decoded data still works.
    const body: Buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data as never);

    let title: string;
    let urlContent: Buffer | string;

    if (urlMimeType === 'application/pdf') {
      urlContent = body;
      // No HTML to read a <title> from, so name it from the final url directly.
      title = lastPathSegment(currentUrl);
    } else {
      const cheerio = await import('cheerio');
      const htmlContent = body.toString('utf8');
      const $ = cheerio.load(htmlContent);
      // Fallback names the page from the FINAL url rather than the pasted one - after a redirect the
      // caller's last path segment describes a different document than the one actually fetched.
      title = $('title').text() || lastPathSegment(currentUrl);
      let textContent = '';
      $('body')
        .find('p')
        .each((index, element) => {
          textContent += $(element).text() + '\n';
        });
      urlContent = textContent || htmlContent;
    }

    // Both URLs when they differ: the pasted one is what the user recognises, the final one is what
    // was actually fetched and parsed. Logging only the former made a redirect invisible in the log.
    // Redacted because BOTH can carry credentials - and logging the pair widened that exposure, so the
    // redaction has to cover the chain, not just the original.
    const original = redactUrlCredentials(url);
    const final = redactUrlCredentials(currentUrl);
    const fetched = original === final ? original : `${original} -> ${final}`;
    logger.log(`Fetched ${title} with mimetype ${urlMimeType} and parsed ${fetched}`);
    return { title, textContent: urlContent, mimeType: urlMimeType, ext: mime.extension(urlMimeType) || null };
  } catch (error) {
    // Redacted for the same reason as the success log: this metadata is attached to the log record, and
    // a failure is exactly when a malformed credentialed URL is most likely to be the input.
    logger.updateMetadata({ failedUrl: redactUrlCredentials(url) });
    logger.debug('Error fetching or parsing URL:', error);
    throw error;
  }
}
