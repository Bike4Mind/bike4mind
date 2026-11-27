import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAnthropicSpend, fetchOpenAISpend } from './providerSpendFetchers';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    expect(new URL(url).searchParams.getAll('group_by[]')).toEqual(['description']);
    expect(new URL(url).searchParams.has('group_by')).toBe(false);
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

  it('paginates by advancing start_time past last bucket end_time', async () => {
    mockFetch.mockReset();
    const julyStart = Math.floor(new Date(Date.UTC(2026, 6, 1)).getTime() / 1000);
    // Page 1: 31 buckets (hits the limit), end_time advances the cursor.
    const page1Buckets = Array.from({ length: 31 }, (_, i) => ({
      object: 'bucket',
      start_time: julyStart + i * 86400,
      end_time: julyStart + (i + 1) * 86400,
      results: [{ amount: { value: 1.0, currency: 'usd' }, line_item: 'gpt-4o' }],
    }));
    // Page 2: fewer than 31 buckets, terminates.
    const page2Buckets = [
      {
        object: 'bucket',
        start_time: julyStart + 31 * 86400,
        end_time: julyStart + 32 * 86400,
        results: [{ amount: { value: 2.0, currency: 'usd' }, line_item: 'gpt-4o' }],
      },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: page1Buckets }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: page2Buckets }) });

    const result = await fetchOpenAISpend('sk-admin-test', '2026-07');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should have advanced start_time past last bucket of page 1.
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    const lastPage1End = julyStart + 31 * 86400;
    expect(secondUrl).toContain(`start_time=${lastPage1End}`);
    // 31 * $1 + 1 * $2 = $33
    expect(result!.providerUsd).toBeCloseTo(33);
  });

  it('throws when page limit is exceeded (missing end_time guard)', async () => {
    mockFetch.mockReset();
    // 31 buckets with no end_time would loop forever without the guard.
    const stuckBuckets = Array.from({ length: 31 }, () => ({
      results: [{ amount: { value: 0.01, currency: 'usd' }, line_item: 'test' }],
    }));
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: stuckBuckets }) });

    await expect(fetchOpenAISpend('sk-admin-test', '2026-07')).rejects.toThrow('exceeded');
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
    // +1 second to include the final daily bucket (see monthToTimestampRange).
    const expectedEnd = Math.floor(new Date(Date.UTC(2026, 7, 1)).getTime() / 1000) + 1;
    expect(url).toContain(`start_time=${expectedStart}`);
    expect(url).toContain(`end_time=${expectedEnd}`);
    expect(url).toContain('limit=31');
    expect(url).toContain('bucket_width=1d');
    expect(opts.headers.Authorization).toBe('Bearer sk-admin-test');
  });
});

describe('spend request serialization', () => {
  it('uses an array query parameter for OpenAI line items and preserves fetch injection', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    await fetchOpenAISpend('test-admin-key', '2026-07', fetchFn);
    const url = new URL(fetchFn.mock.calls[0][0]);
    expect(url.searchParams.getAll('group_by[]')).toEqual(['line_item']);
    expect(url.searchParams.has('group_by')).toBe(false);
  });

  it('retries a later page without counting the earlier page again', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ results: [{ amount: '100', description: 'cost' }] }],
          has_more: true,
          next_page: 'second',
        })
      )
      .mockResolvedValueOnce(
        Response.json({ error: { type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': '1' } })
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ results: [{ amount: '200', description: 'cost' }] }], has_more: false })
      );
    const pending = fetchAnthropicSpend('test-admin-key', '2026-07', fetchFn);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ providerUsd: 3, orgUsd: 3, breakdown: { cost: 3 } });
    expect(fetchFn.mock.calls[1][0]).toBe(fetchFn.mock.calls[2][0]);
    vi.useRealTimers();
  });
});

it('rejects a failed later page rather than returning partial spend', async () => {
  const fetchFn = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: [{ results: [{ amount: '100', description: 'cost' }] }],
        has_more: true,
        next_page: 'second',
      })
    )
    .mockResolvedValueOnce(new Response('private response', { status: 400 }));
  await expect(fetchAnthropicSpend('test-admin-key', '2026-07', fetchFn)).rejects.toThrow('Anthropic API 400');
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

describe('scoped spend reports', () => {
  const anthropicRow = (amount: string, workspaceId: string | null, description = 'Input Tokens') => ({
    amount,
    description,
    workspace_id: workspaceId,
  });

  it('groups the Anthropic cost report by workspace and keeps only the scoped workspaces', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            results: [
              anthropicRow('1000', 'wrkspc_prod'),
              anthropicRow('500', null, 'Output Tokens'),
              anthropicRow('4000', 'wrkspc_other'),
            ],
          },
        ],
        has_more: false,
      })
    );

    const result = await fetchAnthropicSpend(
      'test-admin-key',
      '2026-07',
      fetchFn,
      {},
      {
        workspaceIds: ['wrkspc_prod', 'default'],
      }
    );

    const url = new URL(fetchFn.mock.calls[0][0]);
    expect(url.searchParams.getAll('group_by[]')).toEqual(['description', 'workspace_id']);
    expect(result).toEqual({
      providerUsd: 15,
      orgUsd: 55,
      breakdown: { 'Input Tokens': 10, 'Output Tokens': 5 },
    });
  });

  it('reports Anthropic API key scope as unapplied, since the cost report cannot group by key', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(Response.json({ data: [{ results: [anthropicRow('1000', null)] }], has_more: false }));

    const result = await fetchAnthropicSpend('test-admin-key', '2026-07', fetchFn, {}, { apiKeyIds: ['apikey_prod'] });

    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.getAll('group_by[]')).toEqual(['description']);
    expect(result).toEqual({
      providerUsd: 10,
      orgUsd: 10,
      breakdown: { 'Input Tokens': 10 },
      unappliedScope: ['apiKeyIds'],
    });
  });

  it('leaves an unscoped Anthropic request unchanged and reports the org total as provider spend', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(Response.json({ data: [{ results: [anthropicRow('1000', null)] }], has_more: false }));

    const result = await fetchAnthropicSpend('test-admin-key', '2026-07', fetchFn);

    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.getAll('group_by[]')).toEqual(['description']);
    expect(result).toEqual({ providerUsd: 10, orgUsd: 10, breakdown: { 'Input Tokens': 10 } });
  });

  it('groups the OpenAI cost report by project and API key and keeps rows matching both', async () => {
    const row = (value: number, projectId: string | null, apiKeyId: string | null) => ({
      line_item: 'gpt-5, input',
      project_id: projectId,
      api_key_id: apiKeyId,
      amount: { value, currency: 'usd' },
    });
    const fetchFn = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            start_time: 0,
            end_time: 1,
            results: [
              row(3, 'proj_prod', 'key_prod'),
              row(7, 'proj_prod', 'key_dev'),
              row(11, 'proj_other', 'key_prod'),
              row(13, 'proj_prod', null),
            ],
          },
        ],
      })
    );

    const result = await fetchOpenAISpend(
      'test-admin-key',
      '2026-07',
      fetchFn,
      {},
      {
        projectIds: ['proj_prod'],
        apiKeyIds: ['key_prod'],
      }
    );

    const url = new URL(fetchFn.mock.calls[0][0]);
    expect(url.searchParams.getAll('group_by[]')).toEqual(['line_item', 'project_id', 'api_key_id']);
    expect(result).toEqual({ providerUsd: 3, orgUsd: 34, breakdown: { 'gpt-5, input': 3 } });
  });

  it('groups the OpenAI cost report by project only when only projects are scoped', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({ data: [] }));

    await fetchOpenAISpend('test-admin-key', '2026-07', fetchFn, {}, { projectIds: ['proj_prod'] });

    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.getAll('group_by[]')).toEqual(['line_item', 'project_id']);
  });
});
