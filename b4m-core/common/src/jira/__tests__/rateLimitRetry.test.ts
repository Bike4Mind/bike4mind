import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JiraApi } from '../api';
import type { JiraConfig } from '../api';

describe('JiraApi Rate Limit Retry', () => {
  let mockConfig: JiraConfig;
  let jiraApi: JiraApi;
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
      siteUrl: 'https://test.atlassian.net',
      webBaseUrl: 'https://test.atlassian.net/browse',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3',
      agileApiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/agile/1.0',
      authHeader: 'Bearer test-token',
    };
    jiraApi = new JiraApi(mockConfig);
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
        'X-RateLimit-Limit': '400',
        'X-RateLimit-Remaining': '0',
      }),
      text: async () => 'Rate limited',
    });

    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'X-RateLimit-Limit': '400',
        'X-RateLimit-Remaining': '399',
      }),
      json: async () => ({
        id: '10001',
        key: 'PROJ-123',
        fields: { summary: 'Test Issue' },
      }),
    });

    const promise = jiraApi.getIssue({ issueKey: 'PROJ-123' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toBeDefined();
    expect(result.key).toBe('PROJ-123');

    // Verify rate limit error was logged
    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const rateLimitErrorLog = logCalls.find(c => c.includes('RATE_LIMIT_ERROR'));
    expect(rateLimitErrorLog).toBeDefined();
    const retryLog = logCalls.find(c => c.includes('retrying after'));
    expect(retryLog).toBeDefined();
  });

  it('fails after single retry if second attempt also returns 429', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    // First call: 429
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '1' }),
      text: async () => 'Rate limited',
    });

    // Second call: still 429 (no more retries)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '5' }),
      text: async () => 'Still rate limited',
    });

    const promise = jiraApi.getIssue({ issueKey: 'PROJ-123' });
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const expectation = expect(promise).rejects.toThrow('Jira API error (429)');
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;

    // Should have been called exactly 2 times (original + 1 retry)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('respects Retry-After header value (capped at 10s)', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    // 429 with large Retry-After
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '60' }),
      text: async () => 'Rate limited',
    });

    // Success on retry
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: '10001', key: 'PROJ-123', fields: {} }),
    });

    const promise = jiraApi.getIssue({ issueKey: 'PROJ-123' });
    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    // Verify the retry log mentions capping at 10s, not 60s
    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const retryLog = logCalls.find(c => c.includes('retrying after'));
    expect(retryLog).toContain('10000ms');
  });

  it('defaults to 5s delay when no Retry-After header present', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    // 429 without Retry-After
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => 'Rate limited',
    });

    // Success on retry
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: '10001', key: 'PROJ-123', fields: {} }),
    });

    const promise = jiraApi.getIssue({ issueKey: 'PROJ-123' });
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const retryLog = logCalls.find(c => c.includes('retrying after'));
    expect(retryLog).toContain('5000ms');
  });

  it('logs rate limit headers on successful responses', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'X-RateLimit-Limit': '400',
        'X-RateLimit-Remaining': '350',
      }),
      json: async () => ({ id: '10001', key: 'PROJ-123', fields: {} }),
    });

    await jiraApi.getIssue({ issueKey: 'PROJ-123' });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const rateLimitLog = logCalls.find(c => c.includes('"type":"RATE_LIMIT"'));
    expect(rateLimitLog).toBeDefined();

    const parsed = JSON.parse(rateLimitLog!);
    expect(parsed.integration).toBe('jira');
    expect(parsed.limit).toBe(400);
    expect(parsed.remaining).toBe(350);
    expect(parsed.usagePercent).toBe(13);
    expect(parsed.wasThrottled).toBe(false);
  });

  it('logs warning when approaching rate limit (80%+)', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'X-RateLimit-Limit': '400',
        'X-RateLimit-Remaining': '50', // 87.5% used
      }),
      json: async () => ({ id: '10001', key: 'PROJ-123', fields: {} }),
    });

    await jiraApi.getIssue({ issueKey: 'PROJ-123' });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const warningLog = logCalls.find(c => c.includes('Rate limit warning'));
    expect(warningLog).toBeDefined();
    expect(warningLog).toContain('88%');
  });
});
