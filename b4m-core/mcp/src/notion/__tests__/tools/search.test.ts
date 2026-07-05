import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module - use vi.fn so individual tests can override
vi.mock('../../config.js', () => ({
  getConfig: vi.fn(() => ({
    accessToken: 'mock-token',
    accessMode: 'all',
    allowedPages: [],
    excludedPageIds: [],
  })),
  getEnvSignature: () => '{"accessToken":"mock-token"}',
}));

vi.mock('../../client.js', () => ({
  notionRequest: vi.fn(),
}));

import { registerSearchTools } from '../../tools/search.js';
import { notionRequest } from '../../client.js';
import { getConfig } from '../../config.js';
import { TOOL_NOTION_SEARCH } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

function makeSearchResult(id: string, title: string, parent?: Record<string, unknown>) {
  return {
    object: 'page',
    id,
    url: `https://notion.so/${id}`,
    properties: {
      title: { type: 'title', title: [{ plain_text: title }] },
    },
    parent: parent ?? { workspace: true },
  };
}

describe('Search Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue({
      accessToken: 'mock-token',
      accessMode: 'all',
      allowedPages: [],
      excludedPageIds: [],
    });
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerSearchTools(mock.server);
  });

  describe(TOOL_NOTION_SEARCH, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_NOTION_SEARCH)).toBe(true);
    });

    it('should return search results', async () => {
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [makeSearchResult('page-id-1', 'My Page')],
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect((parsed.results as Array<Record<string, unknown>>)[0].title).toBe('My Page');
    });

    it('should pass filter type when provided', async () => {
      vi.mocked(notionRequest).mockResolvedValueOnce({ results: [] });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      await tool!.handler({ query: 'test', filterType: 'database' });

      expect(notionRequest).toHaveBeenCalledWith('/search', {
        method: 'POST',
        body: JSON.stringify({
          query: 'test',
          page_size: 10,
          filter: { value: 'database', property: 'object' },
        }),
      });
    });

    it('should use custom page_size when provided', async () => {
      vi.mocked(notionRequest).mockResolvedValueOnce({ results: [] });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      await tool!.handler({ query: 'test', page_size: 25 });

      expect(notionRequest).toHaveBeenCalledWith('/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'test', page_size: 25 }),
      });
    });

    it('should handle "Untitled" for pages without title property', async () => {
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [
          {
            object: 'page',
            id: 'page-no-title',
            properties: {},
          },
        ],
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      const parsed = parseResponse(result);
      expect((parsed.results as Array<Record<string, unknown>>)[0].title).toBe('Untitled');
    });

    it('should return error response on API failure', async () => {
      vi.mocked(notionRequest).mockRejectedValueOnce(new Error('Notion API error: 401 Unauthorized'));

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('401');
    });
  });

  describe('access control — selected mode', () => {
    const ALLOWED_PAGE_ID = 'aaaa1111-bbbb-cccc-dddd-eeee22223333';
    const EXCLUDED_PAGE_ID = 'xxxx1111-yyyy-2222-zzzz-333344445555';

    it('should return empty results when selected mode has empty allowedPages (deny-by-default)', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        accessMode: 'selected',
        allowedPages: [],
        excludedPageIds: [],
      });

      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [makeSearchResult('page-1', 'Page 1'), makeSearchResult('page-2', 'Page 2')],
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.results).toEqual([]);
    });

    it('should return directly allowed pages', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [],
      });

      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [
          makeSearchResult(ALLOWED_PAGE_ID, 'Allowed Page'),
          makeSearchResult('other-page-id-00-000000000000', 'Other Page'),
        ],
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      const parsed = parseResponse(result);
      expect(parsed.count).toBe(1);
      expect((parsed.results as Array<Record<string, unknown>>)[0].id).toBe(ALLOWED_PAGE_ID);
    });

    it('should exclude directly excluded pages even if allowed', async () => {
      const pageId = 'dddd1111-eeee-ffff-0000-111122223333';
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        accessMode: 'selected',
        allowedPages: [{ id: pageId, access: 'read' }],
        excludedPageIds: [pageId],
      });

      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [makeSearchResult(pageId, 'Excluded Page')],
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      const parsed = parseResponse(result);
      expect(parsed.count).toBe(0);
    });

    it('should allow pages whose immediate parent is in the allowed list (no API call)', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [],
      });

      const childId = 'cccc1111-dddd-eeee-ffff-000011112222';
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [makeSearchResult(childId, 'Child Page', { type: 'page_id', page_id: ALLOWED_PAGE_ID })],
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      const parsed = parseResponse(result);
      expect(parsed.count).toBe(1);
      // Only the search call - parent resolved from result metadata
      expect(notionRequest).toHaveBeenCalledTimes(1);
    });

    it('should deny pages whose immediate parent is excluded', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [EXCLUDED_PAGE_ID],
      });

      const childId = 'cccc1111-dddd-eeee-ffff-000011112222';
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [makeSearchResult(childId, 'Child of Excluded', { type: 'page_id', page_id: EXCLUDED_PAGE_ID })],
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      const parsed = parseResponse(result);
      expect(parsed.count).toBe(0);
    });

    it('should walk ancestry for deep descendants and allow if ancestor is allowed', async () => {
      const grandchildId = 'ffff1111-2222-3333-4444-555566667777';
      const intermediateId = 'eeee1111-2222-3333-4444-555566667777';

      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [],
      });

      // Search returns grandchild with intermediate parent (not in allowed list)
      vi.mocked(notionRequest)
        .mockResolvedValueOnce({
          results: [makeSearchResult(grandchildId, 'Grandchild', { type: 'page_id', page_id: intermediateId })],
        })
        // Ancestry walk: grandchild's parent is intermediate
        .mockResolvedValueOnce({
          id: grandchildId,
          parent: { type: 'page_id', page_id: intermediateId },
        })
        // Ancestry walk: intermediate's parent is allowed
        .mockResolvedValueOnce({
          id: intermediateId,
          parent: { type: 'page_id', page_id: ALLOWED_PAGE_ID },
        });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      const parsed = parseResponse(result);
      expect(parsed.count).toBe(1);
    });

    it('should deny deep descendants when an excluded ancestor blocks the path', async () => {
      const grandchildId = 'ffff1111-2222-3333-4444-555566667777';

      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [EXCLUDED_PAGE_ID],
      });

      // Search returns grandchild with excluded parent
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [makeSearchResult(grandchildId, 'Grandchild', { type: 'page_id', page_id: EXCLUDED_PAGE_ID })],
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test' });

      const parsed = parseResponse(result);
      expect(parsed.count).toBe(0);
    });

    it('should trim results to requested page_size after filtering', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [],
      });

      // Return 5 allowed pages
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: Array.from({ length: 5 }, (_, i) =>
          makeSearchResult(`${ALLOWED_PAGE_ID}`, `Page ${i}`, { type: 'page_id', page_id: ALLOWED_PAGE_ID })
        ),
      });

      const tool = registeredTools.get(TOOL_NOTION_SEARCH);
      const result = await tool!.handler({ query: 'test', page_size: 2 });

      const parsed = parseResponse(result);
      expect(parsed.count).toBe(2);
    });
  });
});
