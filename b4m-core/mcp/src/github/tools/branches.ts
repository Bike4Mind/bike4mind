/**
 * GitHub MCP Server - Branch Tools
 *
 * Tools for branch-related operations.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { ownerSchema, repoSchema, paginationParams, confirmationParams } from '../helpers/schemas.js';
import { getErrorMessage, hasStatus, isRateLimitError } from '../helpers/errors.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { TOOL_LIST_BRANCHES, TOOL_CREATE_BRANCH } from '../constants.js';

export function registerBranchTools(server: McpServer) {
  // LIST BRANCHES - View all branches in a repository
  server.tool(
    TOOL_LIST_BRANCHES,
    {
      owner: ownerSchema,
      repo: repoSchema,
      ...paginationParams,
    },
    async ({ owner, repo, per_page, page }) => {
      try {
        const result = await octokit.repos.listBranches({
          owner,
          repo,
          per_page: per_page || 30,
          page: page || 1,
        });

        return createSuccessResponse({
          total_count: result.data.length,
          branches: result.data.map(branch => ({
            name: branch.name,
            protected: branch.protected,
            commit: {
              sha: branch.commit.sha,
              url: branch.commit.url,
            },
          })),
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // CREATE BRANCH - Create a new branch in a repository
  server.tool(
    TOOL_CREATE_BRANCH,
    'Create a new branch in a GitHub repository.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      branch_name: z
        .string()
        .min(1, 'Branch name is required')
        .max(255, 'Branch name must be 255 characters or less')
        .refine(val => !val.startsWith('/') && !val.startsWith('-'), 'Branch name cannot start with "/" or "-"')
        .refine(val => !val.endsWith('/') && !val.endsWith('.lock'), 'Branch name cannot end with "/" or ".lock"')
        .refine(
          val => !/[\s~^:?*\[\]\\]|\.\./.test(val),
          'Branch name cannot contain spaces, "..", "~", "^", ":", "?", "*", "[", "]", or "\\"'
        )
        .describe('Name for the new branch (e.g., "feature/my-feature" or "fix/bug-123")'),
      from_branch: z.string().optional().describe('Source branch to create from (default: main)'),
      ...confirmationParams,
    },
    async ({ owner, repo, branch_name, from_branch: fromBranchInput, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;
      const shouldExecute = _executeFromButton === true;
      const fromBranch = fromBranchInput ?? 'main';

      // PREVIEW MODE
      if (!shouldExecute) {
        // Check if branch already exists (idempotency)
        try {
          await octokit.repos.getBranch({
            owner,
            repo,
            branch: branch_name,
          });

          // Branch exists
          return createSuccessResponse({
            action: 'branch_already_exists',
            message: 'Branch already exists',
            branch: {
              name: branch_name,
              repo: fullRepoName,
            },
            suggestion: 'Use a different branch name or delete the existing branch first',
          });
        } catch (error) {
          // 404 means branch doesn't exist - that's good, we can create it
          if (!hasStatus(error, 404)) {
            console.error(
              `[${TOOL_CREATE_BRANCH}] Warning: Could not check if branch exists: ${getErrorMessage(error)}`
            );
          }
        }

        return createPreviewResponse(
          '🌿 Preview: Branch to be Created',
          {
            repository: fullRepoName,
            new_branch: branch_name,
            source_branch: fromBranch,
          },
          'branch',
          {
            tool: TOOL_CREATE_BRANCH,
            params: { owner, repo, branch_name, from_branch: fromBranch },
          }
        );
      }

      // EXECUTE MODE
      console.error(
        `[${TOOL_CREATE_BRANCH}] Attempting to create branch: ${fullRepoName}/${branch_name} from ${fromBranch}`
      );

      try {
        // Step 1: Resolve the source branch to a commit SHA
        let baseSha: string;
        try {
          const branchInfo = await octokit.repos.getBranch({
            owner,
            repo,
            branch: fromBranch,
          });
          baseSha = branchInfo.data.commit.sha;
        } catch (error) {
          if (hasStatus(error, 404)) {
            return createErrorResponse(error, {
              suggestion: `Branch "${fromBranch}" not found. Use list_branches to find available branches.`,
            });
          }
          throw error;
        }

        // Step 2: Create the new branch ref
        const result = await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch_name}`,
          sha: baseSha,
        });

        console.error(`[${TOOL_CREATE_BRANCH}] SUCCESS: Branch "${branch_name}" created from "${fromBranch}"`);

        return createSuccessResponse({
          branch: {
            name: branch_name,
            sha: result.data.object.sha,
            url: result.data.url,
            repo: fullRepoName,
            source: fromBranch,
          },
        });
      } catch (error) {
        console.error(`[${TOOL_CREATE_BRANCH}] ERROR: ${getErrorMessage(error)}`);

        // Handle rate limiting
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }

        // Handle 422 (branch already exists or invalid ref)
        if (hasStatus(error, 422)) {
          const message = getErrorMessage(error);
          if (message.toLowerCase().includes('already exists') || message.toLowerCase().includes('reference')) {
            return createErrorResponse(error, {
              suggestion: 'Branch may already exist. Use list_branches to see existing branches.',
            });
          }
        }

        return createErrorResponse(error);
      }
    }
  );
}
