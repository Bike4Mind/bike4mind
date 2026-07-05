import FirecrawlApp, { ScrapeResponse } from '@mendable/firecrawl-js';

const DEFAULT_MAX_RETRIES = 3;

const NON_RETRYABLE_PATTERNS = ['do not support this site'] as const;

const ACTIONS_NOT_SUPPORTED_PATTERN = 'Actions are not supported';

type ScrapeResult = {
  rawHtml: string;
  metadata: ScrapeResponse['metadata'];
};

type ScrapeOptions = {
  maxRetries?: number;
  getDelayMs?: (attempt: number, maxRetries: number) => number;
  formats?: ('markdown' | 'html')[];
  actions?: ScrapeResponse['actions'];
};

type MinimalLogger = {
  info(...args: unknown[]): void;
};

const defaultGetDelayMs = (attempt: number, maxRetries: number): number => Math.pow(2, maxRetries - attempt) * 1000;

const isNonRetryableError = (message: string): boolean =>
  NON_RETRYABLE_PATTERNS.some(pattern => message.includes(pattern));

const isActionsNotSupportedError = (message: string): boolean => message.includes(ACTIONS_NOT_SUPPORTED_PATTERN);

const buildScrapeParams = (options?: ScrapeOptions) => ({
  formats: options?.formats ?? (['markdown', 'html'] as const),
  actions: options?.actions ?? [
    { type: 'wait' as const, milliseconds: 1000 },
    { type: 'scroll' as const, direction: 'down' as const, pixels: Math.floor(Math.random() * 200 + 11) },
    { type: 'wait' as const, milliseconds: 2000 },
  ],
});

export const scrapeWithRetry = async (
  app: FirecrawlApp,
  url: string,
  logger: MinimalLogger,
  options?: ScrapeOptions
): Promise<ScrapeResult> => {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const getDelayMs = options?.getDelayMs ?? defaultGetDelayMs;
  let remainingRetries = maxRetries;
  let result: ScrapeResponse | null = null;

  while (remainingRetries > 0) {
    try {
      result = (await app.scrapeUrl(url, buildScrapeParams(options))) as ScrapeResponse;
      break;
    } catch (e) {
      const errorMessage = (e as Error).message ?? '';

      if (isActionsNotSupportedError(errorMessage)) {
        logger.info(`Actions not supported for URL: ${url}, retrying without actions...`);
        try {
          result = (await app.scrapeUrl(url, {
            formats: options?.formats ?? ['markdown', 'html'],
          })) as ScrapeResponse;
          break;
        } catch (fallbackError) {
          const domain = new URL(url).hostname;
          throw new Error(
            `The site "${domain}" cannot be scraped. It requires browser actions that are not available, and basic scraping also failed.`
          );
        }
      }

      if (isNonRetryableError(errorMessage)) {
        const domain = new URL(url).hostname;
        throw new Error(
          `The site "${domain}" is not supported for web scraping. Our scraping provider does not allow access to this site.`
        );
      }

      logger.info(`Failed to scrape URL: ${url} - ${errorMessage}, retrying...`);
      remainingRetries--;

      if (remainingRetries > 0) {
        const delayMs = getDelayMs(remainingRetries, maxRetries);
        logger.info(`Waiting ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    if (remainingRetries === 0) {
      throw new Error(`Retry limit reached for URL: ${url}`);
    }
  }

  if (!result || result.error || !result.html) {
    throw new Error('Failed to scrape URL');
  }

  return {
    rawHtml: result.html,
    metadata: result.metadata,
  };
};
