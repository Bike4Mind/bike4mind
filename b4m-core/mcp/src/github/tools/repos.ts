/**
 * GitHub MCP Server - Repository Tools
 *
 * Tools for repository discovery and management.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { ownerSchema, repoSchema } from '../helpers/schemas.js';
import { TOOL_LIST_REPOSITORIES, TOOL_GET_REPOSITORY } from '../constants.js';

export function registerRepoTools(server: McpServer) {
  // LIST REPOSITORIES - Discover what repositories the user has access to
  server.tool(
    TOOL_LIST_REPOSITORIES,
    {
      visibility: z.enum(['all', 'public', 'private']).optional().describe('Filter by visibility (default: all)'),
      affiliation: z
        .string()
        .optional()
        .describe('Filter by affiliation (default: owner,collaborator,organization_member)'),
      sort: z
        .enum(['created', 'updated', 'pushed', 'full_name'])
        .optional()
        .describe('Sort by (default: updated)')
        .prefault('updated'),
      per_page: z.number().optional().describe('Results per page (max 100, default 30)').prefault(30),
      page: z.number().optional().describe('Page number for pagination'),
    },
    async ({ visibility, affiliation, sort, per_page, page }) => {
      try {
        const result = await octokit.repos.listForAuthenticatedUser({
          visibility,
          affiliation,
          sort,
          per_page,
          page: page || 1,
        });

        return createSuccessResponse({
          total_count: result.data.length,
          repositories: result.data.map(repo => ({
            full_name: repo.full_name,
            owner: repo.owner.login,
            name: repo.name,
            private: repo.private,
            fork: repo.fork,
            description: repo.description,
            url: repo.html_url,
            default_branch: repo.default_branch,
            language: repo.language,
            created_at: repo.created_at,
            updated_at: repo.updated_at,
            pushed_at: repo.pushed_at,
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            open_issues: repo.open_issues_count,
          })),
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET REPOSITORY - Get detailed information about a specific repository
  server.tool(
    TOOL_GET_REPOSITORY,
    {
      owner: ownerSchema,
      repo: repoSchema,
    },
    async ({ owner, repo }) => {
      try {
        const result = await octokit.repos.get({
          owner,
          repo,
        });

        return createSuccessResponse({
          repository: {
            full_name: result.data.full_name,
            owner: result.data.owner.login,
            name: result.data.name,
            private: result.data.private,
            fork: result.data.fork,
            description: result.data.description,
            url: result.data.html_url,
            default_branch: result.data.default_branch,
            language: result.data.language,
            topics: result.data.topics,
            created_at: result.data.created_at,
            updated_at: result.data.updated_at,
            pushed_at: result.data.pushed_at,
            stars: result.data.stargazers_count,
            forks: result.data.forks_count,
            watchers: result.data.watchers_count,
            open_issues: result.data.open_issues_count,
            has_issues: result.data.has_issues,
            has_projects: result.data.has_projects,
            has_wiki: result.data.has_wiki,
            license: result.data.license?.name,
          },
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
