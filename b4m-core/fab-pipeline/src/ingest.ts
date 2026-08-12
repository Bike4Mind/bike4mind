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
async function fetchWithoutRedirects(url: string, responseType: 'arraybuffer' | 'text', timeoutMs: number) {
  return axios.get(url, {
    responseType,
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
    let urlMimeType = 'text/plain';

    // Decided from the URL the CALLER passed, not the post-redirect one, so this heuristic behaves
    // exactly as it did before per-hop validation was introduced.
    if (url.split('.')?.pop()?.startsWith('pdf')) {
      urlMimeType = 'application/pdf';
    }

    const responseType = ['application/pdf'].includes(urlMimeType) ? ('arraybuffer' as const) : ('text' as const);

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

      response = await fetchWithoutRedirects(currentUrl, responseType, remainingMs);

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

    const cheerio = await import('cheerio');
    const htmlContent = response.data;
    const $ = cheerio.load(htmlContent);
    const title = $('title').text() || (url.split('/')?.pop() as string);
    let urlContent = null;

    switch (urlMimeType) {
      case 'application/pdf': {
        const pdfbuffer = Buffer.from(response.data);
        urlContent = pdfbuffer;
        break;
      }
      default: {
        let textContent = '';
        $('body')
          .find('p')
          .each((index, element) => {
            textContent += $(element).text() + '\n';
          });
        urlContent = textContent || htmlContent;
        break;
      }
    }

    logger.log(`Fetched ${title} with mimetype ${urlMimeType} and parsed ${url}`);
    return { title, textContent: urlContent, mimeType: urlMimeType, ext: mime.extension(urlMimeType) || null };
  } catch (error) {
    logger.updateMetadata({ failedUrl: url });
    logger.debug('Error fetching or parsing URL:', error);
    throw error;
  }
}
