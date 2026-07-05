import { describe, it, expect, vi } from 'vitest';
import { safeHostname, serpApiSearch, performWebSearch } from './index';

vi.mock('../../../../apiKeyService', () => ({
  getSerperKey: vi.fn(),
}));

import { getSerperKey } from '../../../../apiKeyService';

const mockGetSerperKey = vi.mocked(getSerperKey);
const mockAdapters = {} as Parameters<typeof serpApiSearch>[0];

describe('serpApiSearch — missing key', () => {
  it('returns an object with empty organic_results when no API key is configured', async () => {
    mockGetSerperKey.mockResolvedValue(null);

    const result = await serpApiSearch(mockAdapters, 'test query');

    expect(result).toEqual({ organic_results: [] });
  });
});

describe('performWebSearch — missing key', () => {
  it('returns no-results message and empty citables when no API key is configured', async () => {
    mockGetSerperKey.mockResolvedValue(null);

    const result = await performWebSearch(mockAdapters, { query: 'test query' });

    expect(result.formattedResults).toBe('No results found from web search.');
    expect(result.citables).toEqual([]);
  });
});

describe('safeHostname', () => {
  it('extracts the hostname from a valid absolute URL', () => {
    expect(safeHostname('https://example.com/path?q=1')).toBe('example.com');
  });

  it('returns the raw input when the URL is invalid (e.g. SerpAPI redirect path)', () => {
    const relative = '/goto?url=https%3A%2F%2Fexample.com%2F';
    expect(safeHostname(relative)).toBe(relative);
  });
});
