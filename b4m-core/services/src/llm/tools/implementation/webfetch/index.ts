import { Logger } from '@bike4mind/observability';
import { ToolDefinition, ToolContext } from '../../base/types';
import { GetEffectiveApiKeyAdapters, getFirecrawlConfig } from '../../../../apiKeyService';
import { CitableSource } from '@bike4mind/common';
import { FirecrawlError } from '@mendable/firecrawl-js';
import { createFirecrawlApp } from './firecrawlApp';
import { plainFetchScrape } from './plainFetch';
import { unsafeFetchUrlReason } from './ssrfGuard';

// Re-exported so external construction sites (e.g. apps/client researchEngineQueue)
// can use the interop-safe constructor instead of the raw default import.
export { FirecrawlApp, createFirecrawlApp, resolveFirecrawlApp } from './firecrawlApp';

interface WebFetchParams {
  url: string;
  /** Character offset into the extracted content to start reading from (continuation). */
  offset?: number;
}

interface WebFetchResult {
  /** One chunk of the extracted content: markdown.slice(offset, offset + WEB_FETCH_CONTENT_CAP). */
  markdown: string;
  title?: string;
  /** Length of the returned chunk. */
  extractedChars: number;
  /** Total length Firecrawl extracted, before any offset/cap window was applied. */
  originalChars: number;
  /** Char offset this chunk started at (0 for the first read). */
  offset: number;
  /** True when content remains AFTER this chunk (offset + extractedChars < originalChars). */
  truncated: boolean;
  /** The per-chunk size cap that was applied (WEB_FETCH_CONTENT_CAP). */
  cap: number;
  /** Wall-clock duration of the Firecrawl scrape, in ms. */
  durationMs: number;
  /** When set, the origin advertises an llms.txt/llms-full.txt worth suggesting for long-form content. */
  llmsTxtUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PDF_TIMEOUT_MS = 90_000;

// Max characters returned per fetch. Content past this is no longer dropped (the
// silent-truncation incident, issue #452): the tail is surfaced via the in-band marker and
// citable/telemetry fields, and the model can page through it with offset (issue #497).
const WEB_FETCH_CONTENT_CAP = 50_000;

/**
 * ASCII-only in-band marker appended to a truncated tool result. Tells the model exactly how
 * to continue (the next offset to pass) instead of hallucinating a full read, and suggests an
 * llms.txt long-form source when the origin advertises one. Must stay in sync with the offset
 * parameter the web_fetch schema exposes.
 */
export function truncationMarker(args: {
  offset: number;
  extractedChars: number;
  originalChars: number;
  llmsTxtUrl?: string;
}): string {
  const { offset, extractedChars, originalChars, llmsTxtUrl } = args;
  const nextOffset = offset + extractedChars;
  const hint = llmsTxtUrl
    ? ` A curated long-form version may be available at ${llmsTxtUrl} - fetching it can be more efficient than paging.`
    : '';
  return (
    `\n\n[web_fetch: showing chars ${offset}-${nextOffset} of ~${originalChars}. ` +
    `More content remains - call web_fetch again with the same url and offset=${nextOffset} to continue.${hint}]`
  );
}

/**
 * Single source of truth for the model-facing string of a web_fetch result, shared by all three
 * callers (tool, HTTP endpoint, CLI) so their truncation/continuation semantics cannot drift.
 * Returns the chunk plus a continuation marker when more remains, a short note when the requested
 * offset is at/past the end, or the plain chunk otherwise.
 */
export function webFetchBody(result: WebFetchResult): string {
  if (result.extractedChars === 0 && result.offset > 0) {
    return `[web_fetch: offset ${result.offset} is at or beyond the end of the content (~${result.originalChars} chars); nothing further to read.]`;
  }
  return result.truncated ? result.markdown + truncationMarker(result) : result.markdown;
}

function isPdfUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/** How long a single llms.txt HEAD/GET probe may take before we give up on it (ms). */
const LLMS_TXT_PROBE_TIMEOUT_MS = 2_500;

/**
 * Best-effort probe for an advertised llms.txt on the page's origin, so a long-form fetch can
 * suggest a curated source (issue #497). Prefers /llms-full.txt over /llms.txt. Never throws:
 * any failure/timeout resolves to undefined so it can never break the primary fetch. A single
 * byte is requested (Range) and the body is never read; a non-HTML content-type guards against
 * SPA catch-all routes that answer 200 with index.html.
 */
async function probeLlmsTxt(pageUrl: string): Promise<string | undefined> {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return undefined;
  }

  const probe = async (candidate: string): Promise<string | undefined> => {
    // SSRF guard: this is a direct server-side fetch against a user/model-supplied origin, so
    // reject private/loopback/metadata targets and use redirect:'error' so a public origin cannot
    // 302-pivot to an internal address after the check. See ssrfGuard.ts.
    if (await unsafeFetchUrlReason(new URL(candidate))) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLMS_TXT_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(candidate, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
        redirect: 'error',
      });
      const contentType = res.headers.get('content-type') ?? '';
      const found = res.ok && !contentType.includes('text/html');
      // Only headers are needed; cancel the body so undici releases the connection now
      // rather than at GC (fire-and-forget - must not affect the probe result).
      void res.body?.cancel().catch(() => {});
      return found ? candidate : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const [full, index] = await Promise.all([probe(`${origin}/llms-full.txt`), probe(`${origin}/llms.txt`)]);
  return full ?? index;
}

type FirecrawlFetchOptions = {
  /** Maximum timeout in ms - callers with shorter Lambda lifetimes should cap this.
   *  Defaults to PDF_TIMEOUT_MS (90s) for PDFs, DEFAULT_TIMEOUT_MS (60s) otherwise. */
  maxTimeoutMs?: number;
  /** Char offset into the extracted content to start the returned chunk at (continuation).
   *  Firecrawl has no native paging, so the full page is re-scraped and re-sliced here. */
  offset?: number;
};

/**
 * Fetch URL content using Firecrawl (shared function, no ToolContext)
 * Pattern follows serpApiSearch from websearch tool
 *
 * @param adapters - Database adapters for fetching Firecrawl API key
 * @param url - URL to fetch
 * @param options - Optional configuration (maxTimeoutMs for Lambda-constrained callers; offset to
 *                  window into a long page for continuation)
 * @returns One [offset, offset+cap) chunk of markdown, title, and size/truncation metrics (see WebFetchResult)
 */
export async function firecrawlFetch(
  adapters: GetEffectiveApiKeyAdapters,
  url: string,
  options?: FirecrawlFetchOptions
): Promise<WebFetchResult> {
  const urlPattern = /^https?:\/\/.+/i;
  if (!urlPattern.test(url)) {
    throw new Error(`Invalid URL format: ${url}. URL must start with http:// or https://`);
  }

  // Use longer timeout for PDF URLs - large PDFs need more server-side processing time.
  // Callers with shorter Lambda lifetimes can cap via maxTimeoutMs.
  const isPdf = isPdfUrl(url);
  const desiredTimeout = isPdf ? PDF_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const timeoutMs = options?.maxTimeoutMs ? Math.min(desiredTimeout, options.maxTimeoutMs) : desiredTimeout;

  const app = createFirecrawlApp(await getFirecrawlConfig(adapters));

  // No Firecrawl configured (self-host): fall back to a direct fetch + HTML->markdown. The same
  // windowing/telemetry as the Firecrawl path is applied below so WebFetchResult semantics are
  // identical; only the extraction source differs (no headless browser / PDF parsing - see
  // plainFetchScrape).
  if (!app) {
    const startedAt = Date.now();
    const { markdown, title } = await plainFetchScrape(url, { timeoutMs });
    return buildWebFetchResult(markdown, title, url, options?.offset, Date.now() - startedAt);
  }

  Logger.globalInstance.log(
    `📥 WebFetch Tool: Scraping URL with Firecrawl${isPdf ? ' (PDF mode, extended timeout)' : ''}...`
  );

  // PDF URLs skip the JS wait action - Firecrawl parses them directly
  const baseParams = { formats: ['markdown' as const], timeout: timeoutMs };

  const startedAt = Date.now();
  let result;
  if (isPdf) {
    result = await app.scrapeUrl(url, baseParams);
  } else {
    try {
      result = await app.scrapeUrl(url, {
        ...baseParams,
        actions: [
          {
            type: 'wait' as const,
            milliseconds: 1000,
          },
        ],
      });
    } catch (scrapeError) {
      const msg = scrapeError instanceof Error ? scrapeError.message : '';
      if (msg.includes('Actions are not supported')) {
        Logger.globalInstance.log('📥 WebFetch Tool: Actions not supported, retrying without actions...');
        result = await app.scrapeUrl(url, baseParams);
      } else {
        throw scrapeError;
      }
    }
  }
  const durationMs = Date.now() - startedAt;

  if (!result || result.error) {
    const errorMessage = result?.error || 'Unknown error';
    Logger.globalInstance.error('❌ WebFetch Tool: Firecrawl error:', errorMessage);
    throw new Error(`Failed to fetch content from URL: ${errorMessage}`);
  }

  if (!('markdown' in result) || !result.markdown) {
    Logger.globalInstance.error('❌ WebFetch Tool: No markdown content returned');
    throw new Error('No content could be extracted from the URL');
  }

  return buildWebFetchResult(result.markdown, result.metadata?.title, url, options?.offset, durationMs);
}

/**
 * Window the full extracted markdown into one [offset, offset + cap) chunk and attach size/
 * truncation metrics. Shared by the Firecrawl and plain-fetch paths so their WebFetchResult
 * semantics (paging, telemetry, llms.txt hint) are identical - only the extraction source differs.
 *
 * Firecrawl (and plain fetch) return the whole document with no native paging, so continuation is
 * client-side: the model pages via the offset it reads from the truncation marker. Capturing
 * originalChars lets callers surface that more remains instead of silently dropping the tail (issue
 * #452, continuation in #497). The offsets are only valid against a STABLE page - each call
 * re-fetches, so if the source changes between calls the windows may not line up.
 */
async function buildWebFetchResult(
  fullMarkdown: string,
  title: string | undefined,
  url: string,
  rawOffset: number | undefined,
  durationMs: number
): Promise<WebFetchResult> {
  // Coerce a non-finite offset (e.g. a model passing offset:"abc" on the unvalidated tool/CLI
  // paths) to 0 rather than letting slice(NaN, NaN) return a silent empty string.
  const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const originalChars = fullMarkdown.length;
  // Avoid splitting a surrogate pair at the window's end - a lone high surrogate is rejected by
  // some LLM APIs. Shrink the window by one so the split code unit starts the next chunk instead.
  let end = offset + WEB_FETCH_CONTENT_CAP;
  if (end < originalChars) {
    const lastCode = fullMarkdown.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  }
  const markdown = fullMarkdown.slice(offset, end);
  const extractedChars = markdown.length;
  const truncated = offset + extractedChars < originalChars;
  Logger.globalInstance.log(
    `📄 WebFetch Tool: Extracted ${extractedChars} chars from offset ${offset} of ${originalChars} total in ${durationMs}ms` +
      (truncated ? ` (more remains past ${offset + extractedChars})` : '')
  );

  // Probe for an llms.txt hint only on the FIRST truncated read (offset 0): that is the
  // long-form case where a curated source helps, and gating on offset avoids re-probing the
  // same origin on every continuation call once the model is already paging.
  const llmsTxtUrl = truncated && offset === 0 ? await probeLlmsTxt(url) : undefined;

  return {
    markdown,
    title,
    extractedChars,
    originalChars,
    offset,
    truncated,
    cap: WEB_FETCH_CONTENT_CAP,
    durationMs,
    llmsTxtUrl,
  };
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  implementation: (context: ToolContext) => ({
    toolFn: async value => {
      const params = value as WebFetchParams;
      Logger.globalInstance.log('🌐 WebFetch Tool: Starting fetch for URL:', params.url);

      try {
        await context.statusUpdate({}, `Fetching content from ${params.url}...`);

        const result = await firecrawlFetch({ db: context.db }, params.url, { offset: params.offset });

        // Create citable source for UI display
        const citable: CitableSource = {
          id: params.url,
          type: 'web_url' as const,
          title: result.title || params.url,
          url: params.url,
          description: result.markdown.slice(0, 200) + (result.markdown.length > 200 ? '...' : ''),
          timestamp: new Date().toISOString(),
          status: 'complete' as const,
          metadata: {
            sourceSystem: 'web_fetch',
            contentLength: result.extractedChars,
            truncated: result.truncated,
            originalContentLength: result.originalChars,
            cap: result.cap,
          },
        };

        await context.statusUpdate(
          {
            promptMeta: {
              citables: [citable],
            },
          },
          'WebFetch completed successfully'
        );

        Logger.globalInstance.log(`📚 WebFetch Tool: Stored citable source for ${params.url}`);

        // Surface truncation in-band (with the next offset to continue) so the model reasons
        // about incompleteness rather than assuming it received the whole page.
        return webFetchBody(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // 400/403/408 + 502/503/504 are expected external failures - return user-friendly message
        // so the agent can continue rather than treating this as a hard failure
        if (error instanceof FirecrawlError && [400, 403, 408, 502, 503, 504].includes(error.statusCode)) {
          const statusMessages: Record<number, { userMessage: string; statusLabel: string }> = {
            400: {
              userMessage: `This site requires advanced browser features that are not available. Try using web_search to find the information instead.`,
              statusLabel: 'actions not supported',
            },
            403: {
              userMessage: `This site cannot be accessed by the web scraper — it blocks automated access or is not supported. Try using web_search to find the information instead.`,
              statusLabel: 'site not supported',
            },
            408: {
              userMessage: `The page timed out before loading completely — the site may be slow or require heavy JavaScript rendering. Try using web_search to find the information instead.`,
              statusLabel: 'scrape timed out',
            },
            502: {
              userMessage: `The website returned a Bad Gateway error — it may be temporarily unavailable. Try again later or use web_search to find the information instead.`,
              statusLabel: 'bad gateway',
            },
            503: {
              userMessage: `The website is temporarily unavailable (Service Unavailable). Try again later or use web_search to find the information instead.`,
              statusLabel: 'service unavailable',
            },
            504: {
              userMessage: `The website took too long to respond (Gateway Timeout). Try again later or use web_search to find the information instead.`,
              statusLabel: 'gateway timeout',
            },
          };
          const { userMessage, statusLabel } = statusMessages[error.statusCode];
          context.logger.warn('WebFetch expected Firecrawl failure', {
            url: params.url,
            statusCode: error.statusCode,
            error: errorMessage,
          });
          await context.statusUpdate({}, `WebFetch: ${statusLabel}`);
          return userMessage;
        }

        // Firecrawl 500 with PDF page-count timeout hint - the PDF is too large to process
        if (error instanceof FirecrawlError && error.statusCode === 500 && errorMessage.includes('PDF')) {
          context.logger.warn('WebFetch PDF too large for Firecrawl', {
            url: params.url,
            error: errorMessage,
          });
          await context.statusUpdate({}, 'WebFetch: PDF too large');
          return `This PDF is too large to process via URL. Please download the file and upload it directly instead.`;
        }

        // Network-level errors (no response, connection reset, blocked redirect, ...) - return a
        // user-friendly message so the agent can continue. The keyless plain-fetch path uses native
        // fetch, which puts the real reason on error.cause and only 'fetch failed' on error.message,
        // so match against both. Hosted Firecrawl throws FirecrawlError with no Error cause, making
        // the cause match a no-op there. 'redirect' covers plainFetchScrape's redirect:'error' policy,
        // which hard-fails the apex->www / http->https 301s that Firecrawl follows server-side.
        const causeMessage = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
        const networkErrorText = `${errorMessage} ${causeMessage}`.toLowerCase();
        const networkPatterns = [
          'no response received',
          'econnrefused',
          'econnreset',
          'network error',
          'socket hang up',
          'abort',
          'redirect',
        ];
        if (networkPatterns.some(p => networkErrorText.includes(p))) {
          context.logger.warn('WebFetch network error', {
            url: params.url,
            error: errorMessage,
          });
          await context.statusUpdate({}, 'WebFetch: network error');
          return `The page could not be reached — the server may be down, unreachable, or blocking automated access. Try using web_search to find the information instead.`;
        }

        // Unexpected errors - log as error and rethrow
        context.logger.error('WebFetch error:', error);
        await context.statusUpdate({}, `WebFetch failed: ${errorMessage}`);
        throw error;
      }
    },
    toolSchema: {
      name: 'web_fetch',
      description:
        'Fetches and reads the content of a specific URL that the user provides. Use this when the user gives you a direct URL link (e.g., "fetch https://example.com", "read this article https://...", "summarize the content at https://..."). This tool downloads the page content and converts it to markdown for you to read. Long pages are returned in chunks: if the result ends with a "[web_fetch: ... offset=N ...]" marker, more content remains - call web_fetch again with the same url and that offset to read the next chunk (repeat until there is no marker to read the whole page). You can then answer questions, summarize, or extract information from the content yourself. DO NOT use web_search when the user provides a specific URL - always use web_fetch instead.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'The URL to fetch content from (must be http or https)',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description:
              "Character offset to start reading from. Omit (or 0) for the start of the page; to continue a long page, pass the offset value from the previous result's [web_fetch: ... offset=N ...] continuation marker.",
          },
        },
        required: ['url'],
      },
    },
  }),
};
