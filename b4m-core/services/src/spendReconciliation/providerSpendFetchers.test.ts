import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAnthropicSpend, fetchOpenAISpend } from './providerSpendFetchers';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchAnthropicSpend', () => {
  it('returns null when key is not configured', async () => {
    expect(await fetchAnthropicSpend('not-configured', '2026-07')).toBeNull();
    expect(await fetchAnthropicSpend('', '2026-07')).toBeNull();
  });

  it('sums cost_usd from usage buckets grouped by api_key_name', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { api_key_name: 'prod-key', cost_usd: 100.5 },
          { api_key_name: 'prod-key', cost_usd: 50.25 },
          { api_key_name: 'dev-key', cost_usd: 10 },
        ],
      }),
    });

    const result = await fetchAnthropicSpend('sk-admin-test', '2026-07');

    expect(result).not.toBeNull();
    expect(result!.providerUsd).toBeCloseTo(160.75);
    expect(result!.breakdown['prod-key']).toBeCloseTo(150.75);
    expect(result!.breakdown['dev-key']).toBeCloseTo(10);
  });

  it('returns error note on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await fetchAnthropicSpend('bad-key', '2026-07');

    expect(result).not.toBeNull();
    expect(result!.providerUsd).toBe(0);
    expect(result!.note).toContain('401');
  });

  it('passes correct date range and headers', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await fetchAnthropicSpend('sk-admin-test', '2026-07');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('start_date=2026-07-01');
    expect(url).toContain('end_date=2026-08-01');
    expect(opts.headers['x-api-key']).toBe('sk-admin-test');
  });
});

describe('fetchOpenAISpend', () => {
  it('returns null when key is not configured', async () => {
    expect(await fetchOpenAISpend('not-configured', '2026-07')).toBeNull();
    expect(await fetchOpenAISpend('', '2026-07')).toBeNull();
  });

  it('sums costs from line items (converting cents to USD)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            results: [
              { line_item: 'gpt-4o', amount: { value: 50.0, currency: 'usd' } },
              { line_item: 'gpt-4o-mini', amount: { value: 12.0, currency: 'usd' } },
            ],
          },
          {
            results: [{ line_item: 'gpt-4o', amount: { value: 30.0, currency: 'usd' } }],
          },
        ],
      }),
    });

    const result = await fetchOpenAISpend('sk-admin-test', '2026-07');

    expect(result).not.toBeNull();
    expect(result!.providerUsd).toBeCloseTo(92); // 50 + 12 + 30
    expect(result!.breakdown['gpt-4o']).toBeCloseTo(80); // 50 + 30
    expect(result!.breakdown['gpt-4o-mini']).toBeCloseTo(12);
  });

  it('returns error note on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    const result = await fetchOpenAISpend('bad-key', '2026-07');

    expect(result).not.toBeNull();
    expect(result!.providerUsd).toBe(0);
    expect(result!.note).toContain('403');
  });

  it('passes correct timestamp range and auth header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await fetchOpenAISpend('sk-admin-test', '2026-07');

    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const [url, opts] = lastCall;
    // July 2026 start timestamp
    const expectedStart = Math.floor(new Date(Date.UTC(2026, 6, 1)).getTime() / 1000);
    const expectedEnd = Math.floor(new Date(Date.UTC(2026, 7, 1)).getTime() / 1000);
    expect(url).toContain(`start_time=${expectedStart}`);
    expect(url).toContain(`end_time=${expectedEnd}`);
    expect(opts.headers.Authorization).toBe('Bearer sk-admin-test');
  });
});
