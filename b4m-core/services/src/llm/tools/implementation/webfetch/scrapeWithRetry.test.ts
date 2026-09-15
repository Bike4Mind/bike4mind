import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { scrapeWithRetry } from './scrapeWithRetry';
import type FirecrawlApp from '@mendable/firecrawl-js';

const createMockApp = (scrapeUrl: Mock) => ({ scrapeUrl }) as unknown as FirecrawlApp;

const createMockLogger = () => ({
  info: vi.fn(),
});

const NO_DELAY = { getDelayMs: () => 0 };

const VALID_SCRAPE_RESULT = {
  html: '<html><body>Hello</body></html>',
  markdown: '# Hello',
  metadata: { title: 'Test Page' },
};

describe('scrapeWithRetry', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('returns scraped content on first successful attempt', async () => {
    const mockScrapeUrl = vi.fn().mockResolvedValue(VALID_SCRAPE_RESULT);
    const app = createMockApp(mockScrapeUrl);

    const result = await scrapeWithRetry(app, 'https://example.com', mockLogger);

    expect(result).toEqual({
      rawHtml: VALID_SCRAPE_RESULT.html,
      metadata: VALID_SCRAPE_RESULT.metadata,
    });
    expect(mockScrapeUrl).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors and succeeds', async () => {
    const mockScrapeUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockResolvedValueOnce(VALID_SCRAPE_RESULT);
    const app = createMockApp(mockScrapeUrl);

    const result = await scrapeWithRetry(app, 'https://example.com', mockLogger, NO_DELAY);

    expect(result.rawHtml).toBe(VALID_SCRAPE_RESULT.html);
    expect(mockScrapeUrl).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('retrying...'));
  });

  it('throws retry limit error after all retries exhausted', async () => {
    const mockScrapeUrl = vi.fn().mockRejectedValue(new Error('Server error'));
    const app = createMockApp(mockScrapeUrl);

    await expect(scrapeWithRetry(app, 'https://example.com/page', mockLogger, NO_DELAY)).rejects.toThrow(
      'Retry limit reached for URL: https://example.com/page'
    );
    expect(mockScrapeUrl).toHaveBeenCalledTimes(3);
  });

  it('fails immediately for unsupported sites without retrying', async () => {
    const mockScrapeUrl = vi
      .fn()
      .mockRejectedValue(
        new Error('Status code: 403. Error: We apologize for the inconvenience but we do not support this site.')
      );
    const app = createMockApp(mockScrapeUrl);

    await expect(scrapeWithRetry(app, 'https://www.reddit.com/r/test/', mockLogger)).rejects.toThrow(
      'The site "www.reddit.com" is not supported for web scraping. Our scraping provider does not allow access to this site.'
    );
    expect(mockScrapeUrl).toHaveBeenCalledTimes(1);
  });

  it('falls back to scraping without actions when actions are not supported', async () => {
    const mockScrapeUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('Status code: 400. Error: Actions are not supported by any available engines.'))
      .mockResolvedValueOnce(VALID_SCRAPE_RESULT);
    const app = createMockApp(mockScrapeUrl);

    const result = await scrapeWithRetry(app, 'https://www.diu.mil/work', mockLogger);

    expect(result.rawHtml).toBe(VALID_SCRAPE_RESULT.html);
    expect(mockScrapeUrl).toHaveBeenCalledTimes(2);
    // Second call should NOT have actions
    const secondCallArgs = mockScrapeUrl.mock.calls[1][1];
    expect(secondCallArgs).not.toHaveProperty('actions');
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Actions not supported'));
  });

  it('throws descriptive error when actions fallback also fails', async () => {
    const mockScrapeUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('Status code: 400. Error: Actions are not supported by any available engines.'))
      .mockRejectedValueOnce(new Error('Connection refused'));
    const app = createMockApp(mockScrapeUrl);

    await expect(scrapeWithRetry(app, 'https://www.diu.mil/work', mockLogger)).rejects.toThrow(
      'The site "www.diu.mil" cannot be scraped'
    );
    expect(mockScrapeUrl).toHaveBeenCalledTimes(2);
  });

  it('throws when scrape result has no html', async () => {
    const mockScrapeUrl = vi.fn().mockResolvedValue({ html: null, metadata: {} });
    const app = createMockApp(mockScrapeUrl);

    await expect(scrapeWithRetry(app, 'https://example.com', mockLogger)).rejects.toThrow('Failed to scrape URL');
  });

  it('throws when scrape result has error flag', async () => {
    const mockScrapeUrl = vi.fn().mockResolvedValue({
      html: '<html></html>',
      error: true,
      metadata: {},
    });
    const app = createMockApp(mockScrapeUrl);

    await expect(scrapeWithRetry(app, 'https://example.com', mockLogger)).rejects.toThrow('Failed to scrape URL');
  });
});
