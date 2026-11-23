import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAnthropicHourlyUsage, fetchOpenAIHourlyUsage } from './providerUsageFetchers';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

const json = (body: unknown) => ({ ok: true, json: async () => body });
const requestedUrl = (call: number) => new URL(String(mockFetch.mock.calls[call][0]));

const START_ISO = '2026-10-31T10:00:00.000Z';
const END_ISO = '2026-10-31T11:00:00.000Z';
const START_UNIX = Date.parse(START_ISO) / 1000;
const END_UNIX = Date.parse(END_ISO) / 1000;

describe('fetchAnthropicHourlyUsage', () => {
  const page1 = {
    data: [
      {
        starting_at: START_ISO,
        ending_at: END_ISO,
        results: [
          {
            model: 'claude-opus-4-5-20251101',
            uncached_input_tokens: 1000,
            cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 50 },
            cache_read_input_tokens: 3000,
            output_tokens: 400,
            server_tool_use: { web_search_requests: 2 },
          },
        ],
      },
    ],
    has_more: true,
    next_page: 'cursor-2',
  };
  const page2 = {
    data: [
      {
        starting_at: START_ISO,
        ending_at: END_ISO,
        results: [{ model: 'claude-haiku-4-5-20251001', uncached_input_tokens: 10, output_tokens: 5 }],
      },
    ],
    has_more: false,
    next_page: null,
  };

  it('maps fields, sums both cache-write windows, and follows next_page', async () => {
    mockFetch.mockResolvedValueOnce(json(page1)).mockResolvedValueOnce(json(page2));

    const rows = await fetchAnthropicHourlyUsage('sk-admin', START_ISO, END_ISO);

    expect(rows).toEqual([
      {
        bucketStart: new Date(START_ISO),
        model: 'claude-opus-4-5-20251101',
        inputTokens: 1000,
        outputTokens: 400,
        cacheReadTokens: 3000,
        cacheWriteTokens: 250,
        inScope: true,
      },
      {
        bucketStart: new Date(START_ISO),
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inScope: true,
      },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const first = requestedUrl(0);
    expect(first.origin + first.pathname).toBe('https://api.anthropic.com/v1/organizations/usage_report/messages');
    expect(first.searchParams.get('starting_at')).toBe(START_ISO);
    expect(first.searchParams.get('ending_at')).toBe(END_ISO);
    expect(first.searchParams.get('bucket_width')).toBe('1h');
    expect(first.searchParams.getAll('group_by[]')).toEqual(['model']);
    expect(first.searchParams.get('page')).toBeNull();
    expect(requestedUrl(1).searchParams.get('page')).toBe('cursor-2');
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ 'x-api-key': 'sk-admin', 'anthropic-version': '2023-06-01' });
  });

  it('returns no rows for an idle hour', async () => {
    mockFetch.mockResolvedValueOnce(json({ data: [{ starting_at: START_ISO, results: [] }], has_more: false }));
    expect(await fetchAnthropicHourlyUsage('sk-admin', START_ISO, END_ISO)).toEqual([]);
  });

  it('throws on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'invalid x-api-key' });
    await expect(fetchAnthropicHourlyUsage('sk-admin', START_ISO, END_ISO)).rejects.toThrow(
      'Anthropic API 401: invalid x-api-key'
    );
  });

  it('stops on a cursor that never ends', async () => {
    mockFetch.mockImplementation(async () => json({ data: [], has_more: true, next_page: 'same' }));
    await expect(fetchAnthropicHourlyUsage('sk-admin', START_ISO, END_ISO)).rejects.toThrow(/page limit/);
  });
});

describe('fetchOpenAIHourlyUsage', () => {
  it('splits cached reads out of input_tokens and follows next_page', async () => {
    mockFetch
      .mockResolvedValueOnce(
        json({
          data: [
            {
              start_time: START_UNIX,
              end_time: END_UNIX,
              results: [
                { model: 'gpt-4o-2024-08-06', input_tokens: 5000, input_cached_tokens: 2000, output_tokens: 700 },
              ],
            },
          ],
          has_more: true,
          next_page: 'page_2',
        })
      )
      .mockResolvedValueOnce(
        json({
          data: [{ start_time: START_UNIX, results: [{ model: 'gpt-5.5', input_tokens: 10, output_tokens: 20 }] }],
          has_more: false,
          next_page: null,
        })
      );

    const rows = await fetchOpenAIHourlyUsage('sk-admin', START_UNIX, END_UNIX);

    expect(rows).toEqual([
      {
        bucketStart: new Date(START_ISO),
        model: 'gpt-4o-2024-08-06',
        inputTokens: 3000,
        outputTokens: 700,
        cacheReadTokens: 2000,
        cacheWriteTokens: 0,
        inScope: true,
      },
      {
        bucketStart: new Date(START_ISO),
        model: 'gpt-5.5',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inScope: true,
      },
    ]);

    const first = requestedUrl(0);
    expect(first.origin + first.pathname).toBe('https://api.openai.com/v1/organization/usage/completions');
    expect(first.searchParams.get('start_time')).toBe(String(START_UNIX));
    expect(first.searchParams.get('end_time')).toBe(String(END_UNIX));
    expect(first.searchParams.get('bucket_width')).toBe('1h');
    expect(first.searchParams.getAll('group_by[]')).toEqual(['model']);
    expect(requestedUrl(1).searchParams.get('page')).toBe('page_2');
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer sk-admin' });
  });

  it('returns no rows for an empty response', async () => {
    mockFetch.mockResolvedValueOnce(json({ data: [], has_more: false }));
    expect(await fetchOpenAIHourlyUsage('sk-admin', START_UNIX, END_UNIX)).toEqual([]);
  });

  it('throws on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' });
    await expect(fetchOpenAIHourlyUsage('sk-admin', START_UNIX, END_UNIX)).rejects.toThrow(
      'OpenAI API 429: rate limited'
    );
  });
});

describe('scoped usage reports', () => {
  it('groups the Anthropic usage report by workspace and API key and tags rows in scope', async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        data: [
          {
            starting_at: START_ISO,
            results: [
              { model: 'claude-sonnet-4-5', workspace_id: 'wrkspc_prod', api_key_id: 'apikey_prod', output_tokens: 1 },
              { model: 'claude-sonnet-4-5', workspace_id: 'wrkspc_prod', api_key_id: 'apikey_dev', output_tokens: 2 },
              { model: 'claude-sonnet-4-5', workspace_id: null, api_key_id: 'apikey_prod', output_tokens: 3 },
              { model: 'claude-sonnet-4-5', workspace_id: 'wrkspc_prod', api_key_id: null, output_tokens: 4 },
            ],
          },
        ],
        has_more: false,
      })
    );

    const rows = await fetchAnthropicHourlyUsage('sk-admin', START_ISO, END_ISO, {
      workspaceIds: ['wrkspc_prod'],
      apiKeyIds: ['apikey_prod'],
    });

    expect(requestedUrl(0).searchParams.getAll('group_by[]')).toEqual(['model', 'workspace_id', 'api_key_id']);
    expect(rows.map(row => [row.outputTokens, row.inScope])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]);
  });

  it('matches the Anthropic default workspace, reported as null, by the "default" id', async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        data: [{ starting_at: START_ISO, results: [{ model: 'm', workspace_id: null, output_tokens: 1 }] }],
        has_more: false,
      })
    );

    const rows = await fetchAnthropicHourlyUsage('sk-admin', START_ISO, END_ISO, { workspaceIds: ['default'] });

    expect(requestedUrl(0).searchParams.getAll('group_by[]')).toEqual(['model', 'workspace_id']);
    expect(rows[0].inScope).toBe(true);
  });

  it('groups the OpenAI usage report by project and API key and tags rows in scope', async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        data: [
          {
            start_time: START_UNIX,
            results: [
              { model: 'gpt-5', project_id: 'proj_prod', api_key_id: 'key_prod', output_tokens: 1 },
              { model: 'gpt-5', project_id: 'proj_other', api_key_id: 'key_prod', output_tokens: 2 },
              { model: 'gpt-5', project_id: 'proj_prod', api_key_id: 'key_dev', output_tokens: 3 },
            ],
          },
        ],
        has_more: false,
      })
    );

    const rows = await fetchOpenAIHourlyUsage('sk-admin', START_UNIX, END_UNIX, {
      projectIds: ['proj_prod'],
      apiKeyIds: ['key_prod'],
    });

    expect(requestedUrl(0).searchParams.getAll('group_by[]')).toEqual(['model', 'project_id', 'api_key_id']);
    expect(rows.map(row => [row.outputTokens, row.inScope])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });
});
