import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    search: {
      code: vi.fn(),
    },
  },
}));

import { registerSearchTools } from '../../tools/search.js';
import { octokit } from '../../client.js';
import { TOOL_SEARCH_CODE } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Search Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerSearchTools(mock.server);
  });

  describe(TOOL_SEARCH_CODE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_SEARCH_CODE)).toBe(true);
    });

    it('should return search results on success', async () => {
      const mockResults = {
        data: {
          total_count: 2,
          incomplete_results: false,
          items: [
            {
              name: 'index.ts',
              path: 'src/index.ts',
              repository: {
                full_name: 'owner/repo',
                private: false,
              },
              html_url: 'https://github.com/owner/repo/blob/main/src/index.ts',
              score: 1.5,
            },
            {
              name: 'utils.ts',
              path: 'src/utils.ts',
              repository: {
                full_name: 'owner/repo',
                private: true,
              },
              html_url: 'https://github.com/owner/repo/blob/main/src/utils.ts',
              score: 1.2,
            },
          ],
        },
      };

      vi.mocked(octokit.search.code).mockResolvedValueOnce(mockResults as never);

      const tool = registeredTools.get(TOOL_SEARCH_CODE);
      const result = await tool!.handler({ query: 'useState language:typescript' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(2);
      expect(parsed.incomplete_results).toBe(false);
      expect(parsed.items).toHaveLength(2);
      expect((parsed.items as Array<{ name: string }>)[0].name).toBe('index.ts');
      expect((parsed.items as Array<{ repository: { full_name: string } }>)[0].repository.full_name).toBe('owner/repo');
    });

    it('should use default pagination values', async () => {
      vi.mocked(octokit.search.code).mockResolvedValueOnce({
        data: { total_count: 0, incomplete_results: false, items: [] },
      } as never);

      const tool = registeredTools.get(TOOL_SEARCH_CODE);
      await tool!.handler({ query: 'test query' });

      expect(octokit.search.code).toHaveBeenCalledWith({
        q: 'test query',
        per_page: 30,
        page: 1,
      });
    });

    it('should handle rate limit error', async () => {
      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as { status?: number }).status = 403;

      vi.mocked(octokit.search.code).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_SEARCH_CODE);
      const result = await tool!.handler({ query: 'test' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('rate limit');
    });

    it('should handle generic API errors', async () => {
      vi.mocked(octokit.search.code).mockRejectedValueOnce(new Error('Search failed'));

      const tool = registeredTools.get(TOOL_SEARCH_CODE);
      const result = await tool!.handler({ query: 'test' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Search failed');
    });

    it('should handle incomplete results flag', async () => {
      vi.mocked(octokit.search.code).mockResolvedValueOnce({
        data: { total_count: 1000, incomplete_results: true, items: [] },
      } as never);

      const tool = registeredTools.get(TOOL_SEARCH_CODE);
      const result = await tool!.handler({ query: 'common term' });

      const parsed = parseResponse(result);
      expect(parsed.incomplete_results).toBe(true);
    });
  });
});
