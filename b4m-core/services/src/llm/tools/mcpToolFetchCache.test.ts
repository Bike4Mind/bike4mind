import { describe, it, expect } from 'vitest';
import { MCP_EMPTY_TOOL_FETCH_TTL_MS, shouldLiveFetchTools, buildMcpToolCacheUpdate } from './mcpToolFetchCache';

describe('shouldLiveFetchTools', () => {
  const now = Date.now();

  it('fetches when the marker is unset (never fetched)', () => {
    expect(shouldLiveFetchTools({}, now)).toBe(true);
    expect(shouldLiveFetchTools({ toolSchemasFetchedAt: null }, now)).toBe(true);
  });

  it('skips the fetch for a marker younger than the TTL', () => {
    expect(shouldLiveFetchTools({ toolSchemasFetchedAt: new Date(now - 1000) }, now)).toBe(false);
  });

  it('fetches again once the marker ages past the TTL', () => {
    expect(shouldLiveFetchTools({ toolSchemasFetchedAt: new Date(now - MCP_EMPTY_TOOL_FETCH_TTL_MS - 1) }, now)).toBe(
      true
    );
  });
});

describe('buildMcpToolCacheUpdate', () => {
  it('stamps the marker and names the tools, empty or not', () => {
    const fetchedAt = new Date('2026-01-02T03:04:05.000Z');
    expect(buildMcpToolCacheUpdate('s1', [], fetchedAt)).toEqual({
      id: 's1',
      tools: [],
      toolSchemas: [],
      toolSchemasFetchedAt: fetchedAt,
    });

    const tools = [{ name: 'notion_search', input_schema: { type: 'object' } }];
    expect(buildMcpToolCacheUpdate('s2', tools, fetchedAt)).toEqual({
      id: 's2',
      tools: ['notion_search'],
      toolSchemas: tools,
      toolSchemasFetchedAt: fetchedAt,
    });
  });
});
