import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the config module so no real token is needed
vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => ({
    accessToken: 'mock-token',
    writeEnabled: true,
    rootPageId: null,
    accessMode: 'all',
    allowedPages: [],
    excludedPageIds: [],
  })),
  getEnvSignature: () => '{"accessToken":"mock-token"}',
}));

import { notionRequest } from '../client.js';

/** Stand-in for a fetch Response carrying only the fields notionRequest reads. */
function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const mockFetch = vi.fn();

describe('notionRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not retry a 5xx on a write', async () => {
    mockFetch.mockResolvedValue(mockResponse(502, { code: 'internal_server_error', message: 'bad gateway' }));

    const promise = notionRequest('/pages', { method: 'POST', body: '{}' });
    const rejection = expect(promise).rejects.toThrow('bad gateway');
    // Long enough to cover every backoff the retry path would have scheduled
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    // Replaying a POST that may have landed would double-create the page
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx on a read and returns the eventual success body', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(502, { message: 'bad gateway' }))
      .mockResolvedValueOnce(mockResponse(200, { id: 'page-1' }));

    const promise = notionRequest<{ id: string }>('/pages/page-1');
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual({ id: 'page-1' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 even on a write', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(429, { message: 'rate limited' }))
      .mockResolvedValueOnce(mockResponse(200, { id: 'new-page' }));

    const promise = notionRequest<{ id: string }>('/pages', { method: 'POST', body: '{}' });
    await vi.advanceTimersByTimeAsync(1_000);

    // A 429 never reached the handler, so replaying it cannot double-create
    await expect(promise).resolves.toEqual({ id: 'new-page' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('clamps an oversized Retry-After to the retry ceiling', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(429, { message: 'rate limited' }, { 'retry-after': '120' }))
      .mockResolvedValueOnce(mockResponse(200, { id: 'page-1' }));

    const promise = notionRequest<{ id: string }>('/pages/page-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Not the 1s exponential fallback an out-of-range header used to trigger
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // ...and not the full 120s Notion asked for either
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toEqual({ id: 'page-1' });
  });
});
