import axios from 'axios';
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent, validateUrlForFetch } from './ssrfProtection';

const DEFAULT_MAX_REDIRECTS = 5;

export type SsrfSafeDownloadOptions = {
  /** Hard ceiling on the body; larger responses are rejected rather than truncated. */
  maxBytes: number;
  /** ONE budget (ms) for the whole redirect chain, not a fresh allowance per hop. */
  timeoutMs: number;
  maxRedirects?: number;
};

export type SsrfSafeDownloadResult = {
  data: Buffer;
  contentType: string | undefined;
  /** The post-redirect address the body actually came from. */
  finalUrl: string;
};

/**
 * GET an attacker-influenced URL into a Buffer with the full SSRF guard: every hop is pre-checked by
 * `validateUrlForFetch`, every socket is pinned by the `ssrfSafeLookup` agents (closing the
 * DNS-rebinding window), redirects are followed manually so no hop escapes validation, and the body
 * is capped. Same shape as `fetchWithoutRedirects` in `ingest.ts` and `downloadImageAsBuffer` in
 * `@bike4mind/utils` - see those for the full rationale behind each option.
 *
 * Throws on a blocked URL, a non-2xx final status, a 3xx without Location, too many hops, an
 * oversized body or the deadline passing.
 */
export async function ssrfSafeDownload(url: string, options: SsrfSafeDownloadOptions): Promise<SsrfSafeDownloadResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + options.timeoutMs;
  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validation = await validateUrlForFetch(currentUrl);
    if (!validation.valid) {
      throw new Error(`URL blocked for security reasons: ${validation.error}`);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out while downloading URL');
    }

    const response = await axios.get<Buffer>(currentUrl, {
      // BOTH agents: an https URL can 302 to http, and axios picks the agent per request.
      httpAgent: ssrfSafeHttpAgent,
      httpsAgent: ssrfSafeHttpsAgent,
      // MUST accompany the agents: an env-configured proxy would otherwise replace them and drop the pin.
      proxy: false,
      responseType: 'arraybuffer',
      timeout: remainingMs,
      // axios's `timeout` stops once headers arrive; the signal keeps a trickled body inside the deadline.
      signal: AbortSignal.timeout(remainingMs),
      maxRedirects: 0,
      maxContentLength: options.maxBytes,
      maxBodyLength: options.maxBytes,
      validateStatus: status => status >= 200 && status < 400,
    });

    if (response.status < 300) {
      const contentType = response.headers?.['content-type'];
      return {
        data: Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data),
        contentType: typeof contentType === 'string' ? contentType : undefined,
        finalUrl: currentUrl,
      };
    }

    const location = response.headers?.location;
    if (typeof location !== 'string' || location.length === 0) {
      throw new Error(`URL returned status ${response.status} with no redirect target`);
    }
    if (hop === maxRedirects) {
      throw new Error(`Too many redirects (more than ${maxRedirects}) while downloading URL`);
    }

    // Relative Locations resolve against the current hop; re-validated at the top of the loop.
    currentUrl = new URL(location, currentUrl).toString();
  }

  // Unreachable: every iteration returns, throws or advances to a bounded next hop.
  throw new Error('URL download produced no response');
}
