/**
 * GitHub MCP Server - Search Tools
 *
 * Tools for code search operations.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse, createCustomErrorResponse } from '../helpers/responses.js';
import { paginationParams } from '../helpers/schemas.js';
import { isRateLimitError } from '../helpers/errors.js';
import { TOOL_SEARCH_CODE } from '../constants.js';
import { filterToScope, type RepoScope } from '../repoScope.js';

export function registerSearchTools(server: McpServer, scope: RepoScope) {
  // SEARCH CODE - Find implementations and patterns
  server.tool(
    TOOL_SEARCH_CODE,
    {
      query: z
        .string()
        .describe('GitHub code search query (e.g., "useState in:file language:typescript repo:facebook/react")'),
      ...paginationParams,
    },
    async ({ query, per_page, page }) => {
      try {
        const result = await octokit.search.code({
          q: query,
          per_page: per_page || 30,
          page: page || 1,
        });

        const items = filterToScope(scope, result.data.items, item => item.repository.full_name);

        return createSuccessResponse({
          // GitHub's total counts matches in every repository, so it is only reported unrestricted.
          ...(scope.mode === 'all' && { total_count: result.data.total_count }),
          incomplete_results: result.data.incomplete_results,
          ...(items.length < result.data.items.length && {
            excluded_outside_selected_repositories: result.data.items.length - items.length,
          }),
          items: items.map(item => ({
            name: item.name,
            path: item.path,
            repository: {
              full_name: item.repository.full_name,
              private: item.repository.private,
            },
            html_url: item.html_url,
            score: item.score,
          })),
        });
      } catch (error) {
        // Handle rate limiting specifically
        if (isRateLimitError(error)) {
          return createCustomErrorResponse('GitHub API rate limit exceeded. Please wait a moment and try again.', {
            status: 403,
          });
        }

        return createErrorResponse(error);
      }
    }
  );
}
