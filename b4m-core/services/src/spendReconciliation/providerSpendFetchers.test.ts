import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAnthropicSpend, fetchOpenAISpend } from './providerSpendFetchers';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -- Anthropic ----------------------------------------------------------
// Response shape captured from the Anthropic cost_report endpoint docs.
// amount is cents as a decimal string; currency is always USD.

const ANTHROPIC_COST_RESPONSE = {
  data: [
    {
      starting_at: '2026-07-01T00:00:00Z',
      ending_at: '2026-07-02T00:00:00Z',
      results: [
        {
          amount: '12345.67',
          cost_type: 'tokens',
          currency: 'USD',
          description: 'Claude Sonnet 4 Usage - Input Tokens',
          model: 'claude-sonnet-4-20250514',
          service_tier: 'standard',
          token_type: 'uncached_input_tokens',
          context_window: '0-200k',
          inference_geo: 'global',
          workspace_id: null,
        },
        {
          amount: '5000.00',
          cost_type: 'tokens',
          currency: 'USD',
          description: 'Claude Sonnet 4 Usage - Output Tokens',
          model: 'claude-sonnet-4-20250514',
          service_tier: 'standard',
          token_type: 'output_tokens',
          context_window: '0-200k',
          inference_geo: 'global',
          workspace_id: null,
        },
      ],
    },
    {
      starting_at: '2026-07-02T00:00:00Z',
      ending_at: '2026-07-03T00:00:00Z',
      results: [
        {
          amount: '800.00',
          cost_type: 'tokens',
          currency: 'USD',
          description: 'Claude Haiku 4.5 Usage - Input Tokens',
          model: 'claude-haiku-4-5-20251001',
          service_tier: 'standard',
          token_type: 'uncached_input_tokens',
          context_window: '0-200k',
          inference_geo: 'global',
          workspace_id: null,
        },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

describe('fetchAnthropicSpend', () => {
  it('returns null when key is not configured', async () => {
    expect(await fetchAnthropicSpend('not-configured', '2026-07')).toBeNull();
    expect(await fetchAnthropicSpend('', '2026-07')).toBeNull();
  });

  it('sums cost amounts from real response shape (cents string to USD)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ANTHROPIC_COST_RESPONSE,
    });

    const result = await fetchAnthropicSpend('sk-ant-admin01-test', '2026-07');

    expect(result).not.toBeNull();
    // 12345.67 + 5000.00 + 800.00 = 18145.67 cents = $181.4567
    expect(result!.providerUsd).toBeCloseTo(181.4567, 2);
    expect(result!.breakdown['Claude Sonnet 4 Usage - Input Tokens']).toBeCloseTo(123.4567, 2);
    expect(result!.breakdown['Claude Sonnet 4 Usage - Output Tokens']).toBeCloseTo(50, 2);
    expect(result!.breakdown['Claude Haiku 4.5 Usage - Input Tokens']).toBeCloseTo(8, 2);
  });

  it('throws on non-ok response instead of returning $0', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(fetchAnthropicSpend('bad-key', '2026-07')).rejects.toThrow('Anthropic API 401');
  });

  it('passes correct endpoint, RFC 3339 date range, and headers', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], has_more: false }),
    });

    await fetchAnthropicSpend('sk-ant-admin01-test', '2026-07');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/v1/organizations/cost_report');
    expect(url).toContain('starting_at=');
    expect(url).toContain('ending_at=');
    expect(url).toContain('bucket_width=1d');
    expect(url).toContain('limit=31');
    expect(opts.headers['x-api-key']).toBe('sk-ant-admin01-test');
  });

  it('paginates when has_more is true', async () => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ results: [{ amount: '100.00', description: 'page1' }] }],
          has_more: true,
          next_page: 'page_abc',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ results: [{ amount: '200.00', description: 'page2' }] }],
          has_more: false,
        }),
      });

    const result = await fetchAnthropicSpend('sk-ant-admin01-test', '2026-07');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain('page=page_abc');
    // (100 + 200) cents = $3.00
    expect(result!.providerUsd).toBeCloseTo(3, 2);
  });
});

// -- OpenAI -------------------------------------------------------------
// Response shape from OpenAI /v1/organization/costs docs.
// amount.value is in USD as a decimal number (not cents).

const OPENAI_COSTS_RESPONSE = {
  data: [
    {
      object: 'bucket',
      start_time: 1751328000,
      end_time: 1751414400,
      results: [
        {
          object: 'organization.costs.result',
          amount: { value: 42.5, currency: 'usd' },
          line_item: 'GPT-4o',
          project_id: null,
          organization_id: 'org-test',
        },
        {
          object: 'organization.costs.result',
          amount: { value: 8.25, currency: 'usd' },
          line_item: 'GPT-4o mini',
          project_id: null,
          organization_id: 'org-test',
        },
      ],
    },
    {
      object: 'bucket',
      start_time: 1751414400,
      end_time: 1751500800,
      results: [
        {
          object: 'organization.costs.result',
          amount: { value: 30.0, currency: 'usd' },
          line_item: 'GPT-4o',
          project_id: null,
          organization_id: 'org-test',
        },
      ],
    },
  ],
};

describe('fetchOpenAISpend', () => {
  it('returns null when key is not configured', async () => {
    expect(await fetchOpenAISpend('not-configured', '2026-07')).toBeNull();
    expect(await fetchOpenAISpend('', '2026-07')).toBeNull();
  });

  it('sums costs from real response shape (amounts in USD)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => OPENAI_COSTS_RESPONSE,
    });

    const result = await fetchOpenAISpend('sk-admin-test', '2026-07');

    expect(result).not.toBeNull();
    // 42.5 + 8.25 + 30.0 = 80.75
    expect(result!.providerUsd).toBeCloseTo(80.75);
    expect(result!.breakdown['GPT-4o']).toBeCloseTo(72.5);
    expect(result!.breakdown['GPT-4o mini']).toBeCloseTo(8.25);
  });

  it('throws on non-ok response instead of returning $0', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    await expect(fetchOpenAISpend('bad-key', '2026-07')).rejects.toThrow('OpenAI API 403');
  });

  it('passes correct params including limit and bucket_width', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await fetchOpenAISpend('sk-admin-test', '2026-07');

    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const [url, opts] = lastCall;
    const expectedStart = Math.floor(new Date(Date.UTC(2026, 6, 1)).getTime() / 1000);
    const expectedEnd = Math.floor(new Date(Date.UTC(2026, 7, 1)).getTime() / 1000);
    expect(url).toContain(`start_time=${expectedStart}`);
    expect(url).toContain(`end_time=${expectedEnd}`);
    expect(url).toContain('limit=31');
    expect(url).toContain('bucket_width=1d');
    expect(opts.headers.Authorization).toBe('Bearer sk-admin-test');
  });
});
