import { Logger } from '@bike4mind/observability';
import { ToolDefinition, ToolContext } from '../../base/types';
import { GetEffectiveApiKeyAdapters } from '../../../../apiKeyService';
import { CitableSource } from '@bike4mind/common';
import { FirecrawlError } from '@mendable/firecrawl-js';
import { FirecrawlApp } from './firecrawlApp';

// Re-exported so external construction sites (e.g. apps/client researchEngineQueue)
// can use the interop-safe constructor instead of the raw default import.
export { FirecrawlApp, resolveFirecrawlApp } from './firecrawlApp';

interface WebFetchParams {
  url: string;
}

interface WebFetchResult {
  /** Extracted content, capped at WEB_FETCH_CONTENT_CAP characters. */
  markdown: string;
  title?: string;
  /** Length of the returned (capped) markdown. */
  extractedChars: number;
  /** Length Firecrawl actually extracted, before the cap was applied. */
  originalChars: number;
  /** True when originalChars exceeded the cap and content was dropped. */
  truncated: boolean;
  /** The cap that was applied (WEB_FETCH_CONTENT_CAP). */
  cap: number;
  /** Wall-clock duration of the Firecrawl scrape, in ms. */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PDF_TIMEOUT_MS = 90_000;

// Max extracted characters kept from a fetched page. Anything past this is dropped
// (see the silent-truncation incident in issue #452); truncation is now surfaced
// via the in-band marker and citable/telemetry fields rather than dropped silently.
const WEB_FETCH_CONTENT_CAP = 50_000;

/**
 * ASCII-only in-band marker appended to a truncated tool result so the model can
 * reason about incompleteness instead of hallucinating a full read.
 */
export function truncationMarker(originalChars: number, cap: number): string {
  return `\n\n[TRUNCATED at ${cap} of ~${originalChars} chars - content continues]`;
}

function isPdfUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

type FirecrawlFetchOptions = {
  /** Maximum timeout in ms - callers with shorter Lambda lifetimes should cap this.
   *  Defaults to PDF_TIMEOUT_MS (90s) for PDFs, DEFAULT_TIMEOUT_MS (60s) otherwise. */
  maxTimeoutMs?: number;
};

/**
 * Fetch URL content using Firecrawl (shared function, no ToolContext)
 * Pattern follows serpApiSearch from websearch tool
 *
 * @param adapters - Database adapters for fetching Firecrawl API key
 * @param url - URL to fetch
 * @param options - Optional configuration (e.g. maxTimeoutMs for Lambda-constrained callers)
 * @returns Markdown content and title
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

  const apiKeySetting = await adapters.db.adminSettings.findBySettingName('FirecrawlApiKey');
  if (!apiKeySetting?.settingValue) {
    Logger.globalInstance.error('❌ WebFetch Tool: Firecrawl API key not configured');
    throw new Error('Firecrawl API key not configured');
  }

  const app = new FirecrawlApp({ apiKey: apiKeySetting.settingValue });

  // Use longer timeout for PDF URLs - large PDFs need more server-side processing time.
  // Callers with shorter Lambda lifetimes can cap via maxTimeoutMs.
  const isPdf = isPdfUrl(url);
  const desiredTimeout = isPdf ? PDF_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const timeoutMs = options?.maxTimeoutMs ? Math.min(desiredTimeout, options.maxTimeoutMs) : desiredTimeout;

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

  // Cap content size to bound memory. Capture the pre-cap length so callers can
  // surface truncation instead of silently dropping the tail (issue #452).
  const originalChars = result.markdown.length;
  const markdown = result.markdown.slice(0, WEB_FETCH_CONTENT_CAP);
  const truncated = originalChars > WEB_FETCH_CONTENT_CAP;
  Logger.globalInstance.log(
    `📄 WebFetch Tool: Extracted ${markdown.length} of ${originalChars} characters` +
      (truncated ? ` (truncated at cap ${WEB_FETCH_CONTENT_CAP})` : '')
  );

  return {
    markdown,
    title: result.metadata?.title,
    extractedChars: markdown.length,
    originalChars,
    truncated,
    cap: WEB_FETCH_CONTENT_CAP,
    durationMs,
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

        const result = await firecrawlFetch({ db: context.db }, params.url);

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

        // Surface truncation in-band so the model reasons about incompleteness
        // rather than assuming it received the whole page.
        return result.truncated
          ? result.markdown + truncationMarker(result.originalChars, result.cap)
          : result.markdown;
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

        // Network-level errors - no response received, connection refused, etc.
        // Return user-friendly message so the agent can continue
        const networkPatterns = [
          'no response received',
          'econnrefused',
          'econnreset',
          'network error',
          'socket hang up',
          'abort',
        ];
        if (networkPatterns.some(p => errorMessage.toLowerCase().includes(p))) {
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
        'Fetches and reads the FULL CONTENT of a specific URL that the user provides. Use this when the user gives you a direct URL link (e.g., "fetch https://example.com", "read this article https://...", "summarize the content at https://..."). This tool downloads the entire page content and converts it to markdown for you to read. You can then answer questions, summarize, or extract information from the content yourself. DO NOT use web_search when the user provides a specific URL - always use web_fetch instead.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'The URL to fetch content from (must be http or https)',
          },
        },
        required: ['url'],
      },
    },
  }),
};
