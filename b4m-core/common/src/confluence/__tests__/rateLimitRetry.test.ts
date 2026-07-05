import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfluenceApi } from '../api';
import type { ConfluenceConfig } from '../api';

describe('ConfluenceApi Rate Limit Retry', () => {
  let mockConfig: ConfluenceConfig;
  let confluenceApi: ConfluenceApi;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let mathRandomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic jitter for predictable delay assertions
    mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    mockConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net/wiki',
      webBaseUrl: 'https://test.atlassian.net/wiki',
      apiBaseUrlV1: 'https://test.atlassian.net/wiki/rest/api',
      apiBaseUrlV2: 'https://api.atlassian.com/ex/confluence/test-cloud-id/wiki/api/v2',
      authHeader: 'Bearer test-token',
    };
    confluenceApi = new ConfluenceApi(mockConfig);
    global.fetch = vi.fn();
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
    mathRandomSpy.mockRestore();
  });

  it('retries once on 429 and succeeds on second attempt', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    // First call: 429 with Retry-After header
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({
        'Retry-After': '1',
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '0',
      }),
      text: async () => 'Rate limited',
    });

    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/json',
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '99',
      }),
      text: async () =>
        JSON.stringify({
          id: '123',
          title: 'Test Page',
          status: 'current',
          body: { storage: { value: '<p>Hello</p>' } },
          version: { number: 1 },
          _links: { webui: '/wiki/spaces/TEST/pages/123' },
        }),
    });

    const promise = confluenceApi.getPage({ pageId: '123' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toBeDefined();

    // Verify rate limit error was logged
    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const rateLimitErrorLog = logCalls.find(c => c.includes('RATE_LIMIT_ERROR'));
    expect(rateLimitErrorLog).toBeDefined();
  });

  it('fails after single retry if second attempt also returns 429', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    // First call: 429
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'Retry-After': '1' }),
      text: async () => 'Rate limited',
    });

    // Second call: still 429 (exhausted retry)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'Retry-After': '5' }),
      text: async () => JSON.stringify({ message: 'Still rate limited' }),
    });

    const promise = confluenceApi.getPage({ pageId: '123' });
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const expectation = expect(promise).rejects.toThrow('Confluence API Error 429');
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('caps Retry-After at 10 seconds for Lambda budget', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    // 429 with very large Retry-After
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '120' }),
      text: async () => 'Rate limited',
    });

    // Success on retry
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({
          id: '123',
          title: 'Test Page',
          status: 'current',
          body: {},
          version: { number: 1 },
          _links: { webui: '/wiki/spaces/TEST/pages/123' },
        }),
    });

    const promise = confluenceApi.getPage({ pageId: '123' });
    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    // Verify the delay was capped at 10s
    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const retryLog = logCalls.find(c => c.includes('retrying after'));
    expect(retryLog).toContain('10000ms');
  });

  it('logs rate limit headers on successful responses', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/json',
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '75',
      }),
      text: async () =>
        JSON.stringify({
          id: '123',
          title: 'Test Page',
          status: 'current',
          body: {},
          version: { number: 1 },
          _links: { webui: '/wiki/spaces/TEST/pages/123' },
        }),
    });

    await confluenceApi.getPage({ pageId: '123' });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const rateLimitLog = logCalls.find(c => c.includes('"type":"RATE_LIMIT"'));
    expect(rateLimitLog).toBeDefined();

    const parsed = JSON.parse(rateLimitLog!);
    expect(parsed.integration).toBe('confluence');
    expect(parsed.limit).toBe(100);
    expect(parsed.remaining).toBe(75);
    expect(parsed.usagePercent).toBe(25);
  });
});
