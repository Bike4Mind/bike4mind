/**
 * GitHub MCP Server - Commit Tools
 *
 * Tools for commit history and details.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { ownerSchema, repoSchema, paginationParams } from '../helpers/schemas.js';
import { TOOL_LIST_COMMITS, TOOL_GET_COMMIT } from '../constants.js';

export function registerCommitTools(server: McpServer) {
  // LIST COMMITS - View commit history
  server.tool(
    TOOL_LIST_COMMITS,
    {
      owner: ownerSchema,
      repo: repoSchema,
      sha: z.string().optional().describe('Branch or commit SHA to start from'),
      path: z.string().optional().describe('Only commits containing this file path'),
      author: z.string().optional().describe('GitHub username to filter commits by author'),
      ...paginationParams,
    },
    async ({ owner, repo, sha, path, author, per_page, page }) => {
      try {
        const result = await octokit.repos.listCommits({
          owner,
          repo,
          sha,
          path,
          author,
          per_page: per_page || 30,
          page: page || 1,
        });

        return createSuccessResponse({
          total_count: result.data.length,
          commits: result.data.map(commit => ({
            sha: commit.sha,
            message: commit.commit.message,
            author: {
              name: commit.commit.author?.name,
              email: commit.commit.author?.email,
              date: commit.commit.author?.date,
              username: commit.author?.login,
            },
            url: commit.html_url,
            stats: commit.stats,
          })),
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET COMMIT - Get detailed information about a specific commit
  server.tool(
    TOOL_GET_COMMIT,
    {
      owner: ownerSchema,
      repo: repoSchema,
      ref: z.string().describe('Commit SHA, branch name, or tag'),
    },
    async ({ owner, repo, ref }) => {
      try {
        const result = await octokit.repos.getCommit({
          owner,
          repo,
          ref,
        });

        return createSuccessResponse({
          commit: {
            sha: result.data.sha,
            message: result.data.commit.message,
            author: {
              name: result.data.commit.author?.name || 'Unknown',
              email: result.data.commit.author?.email || '',
              date: result.data.commit.author?.date || '',
              username: result.data.author?.login,
            },
            committer: {
              name: result.data.commit.committer?.name || 'Unknown',
              email: result.data.commit.committer?.email || '',
              date: result.data.commit.committer?.date || '',
            },
            url: result.data.html_url,
            stats: {
              additions: result.data.stats?.additions,
              deletions: result.data.stats?.deletions,
              total: result.data.stats?.total,
            },
            files: result.data.files?.map(file => ({
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
              patch: file.patch,
            })),
          },
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
