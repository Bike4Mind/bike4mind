/**
 * GitHub MCP Server - Pull Request Tools
 *
 * Tools for pull request operations.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import {
  ownerSchema,
  repoSchema,
  paginationParams,
  prStateSchema,
  confirmationParams,
  pullNumberSchema,
} from '../helpers/schemas.js';
import { getErrorMessage, hasStatus, isRateLimitError } from '../helpers/errors.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import {
  TOOL_LIST_PULL_REQUESTS,
  TOOL_GET_PULL_REQUEST,
  TOOL_GET_PULL_REQUEST_FILES,
  TOOL_GET_PULL_REQUEST_DIFF,
  TOOL_CREATE_PULL_REQUEST,
  TOOL_UPDATE_PULL_REQUEST,
  TOOL_MERGE_PULL_REQUEST,
  TOOL_SEARCH_PULL_REQUESTS,
} from '../constants.js';
import { MARK_PR_READY_FOR_REVIEW_MUTATION, CONVERT_PR_TO_DRAFT_MUTATION } from '../helpers/queries.js';

export function registerPullTools(server: McpServer) {
  // LIST PULL REQUESTS - View PRs for a repository
  server.tool(
    TOOL_LIST_PULL_REQUESTS,
    {
      owner: ownerSchema,
      repo: repoSchema,
      state: prStateSchema,
      author: z
        .string()
        .max(39, 'GitHub username too long')
        .optional()
        .describe('Filter PRs by author username (e.g., "octocat")'),
      labels: z
        .array(
          z
            .string()
            .max(50, 'Label name too long')
            .refine(s => !/["\\]/.test(s), 'Labels cannot contain quotes or backslashes')
        )
        .optional()
        .describe('Filter PRs by labels (e.g., ["awaiting review", "bug"])'),
      ...paginationParams,
    },
    async ({ owner, repo, state, author, labels, per_page, page }) => {
      try {
        // When labels or author are specified, use Search API (pulls.list doesn't support these filters)
        if ((labels && labels.length > 0) || author) {
          console.error('Using github search');
          const stateFilter = state === 'all' ? '' : `is:${state || 'open'}`;
          const labelFilters = labels ? labels.map(label => `label:"${label}"`).join(' ') : '';
          const authorFilter = author ? `author:${author}` : '';
          const query = [`type:pr`, `repo:${owner}/${repo}`, stateFilter, labelFilters, authorFilter]
            .filter(Boolean)
            .join(' ');

          const searchResult = await octokit.request('GET /search/issues', {
            q: query,
            per_page: per_page || 30,
            page: page || 1,
          });

          return createSuccessResponse({
            total_count: searchResult.data.total_count,
            // Search API returns fewer fields than Pulls API;
            // head/base/mergeable/merged require individual PR fetches
            pull_requests: searchResult.data.items.map(pr => ({
              number: pr.number,
              title: pr.title,
              state: pr.state,
              draft: pr.draft,
              url: pr.html_url,
              user: pr.user?.login,
              labels: pr.labels?.map(l => l.name) || [],
              created_at: pr.created_at,
              updated_at: pr.updated_at,
              // These fields are not available from Search API
              head: null,
              base: null,
              mergeable: null,
              merged: null,
            })),
          });
        }

        // Standard list without label/author filtering
        const result = await octokit.pulls.list({
          owner,
          repo,
          state: state || 'open',
          per_page: per_page || 30,
          page: page || 1,
        });

        return createSuccessResponse({
          page_count: result.data.length, // Items in current page (use Link header for total)
          pull_requests: result.data.map(pr => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft,
            url: pr.html_url,
            user: pr.user?.login,
            labels: pr.labels?.map(l => l.name) || [],
            head: pr.head?.ref,
            base: pr.base?.ref,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            // mergeable/merged only available from individual PR fetch, not list
            mergeable: (pr as { mergeable?: boolean }).mergeable,
            merged: (pr as { merged?: boolean }).merged,
          })),
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET PULL REQUEST - Get detailed information about a specific PR
  server.tool(
    TOOL_GET_PULL_REQUEST,
    {
      owner: ownerSchema,
      repo: repoSchema,
      pull_number: z.number().describe('Pull request number'),
    },
    async ({ owner, repo, pull_number }) => {
      try {
        const result = await octokit.pulls.get({
          owner,
          repo,
          pull_number,
        });

        return createSuccessResponse({
          pull_request: {
            number: result.data.number,
            title: result.data.title,
            body: result.data.body,
            state: result.data.state,
            draft: result.data.draft,
            url: result.data.html_url,
            user: result.data.user.login,
            head: {
              ref: result.data.head.ref,
              sha: result.data.head.sha,
            },
            base: {
              ref: result.data.base.ref,
              sha: result.data.base.sha,
            },
            created_at: result.data.created_at,
            updated_at: result.data.updated_at,
            merged: result.data.merged,
            mergeable: result.data.mergeable,
            mergeable_state: result.data.mergeable_state,
            additions: result.data.additions,
            deletions: result.data.deletions,
            changed_files: result.data.changed_files,
            comments: result.data.comments,
            review_comments: result.data.review_comments,
            commits: result.data.commits,
          },
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET PULL REQUEST FILES - Get the list of files changed in a PR
  server.tool(
    TOOL_GET_PULL_REQUEST_FILES,
    {
      owner: ownerSchema,
      repo: repoSchema,
      pull_number: pullNumberSchema,
      ...paginationParams,
    },
    async ({ owner, repo, pull_number, per_page, page }) => {
      const fullRepoName = `${owner}/${repo}`;

      try {
        const result = await octokit.pulls.listFiles({
          owner,
          repo,
          pull_number,
          per_page: per_page || 100,
          page: page || 1,
        });

        // GitHub API has a hard limit of 3000 files
        const MAX_FILES = 3000;
        const warning =
          result.data.length >= MAX_FILES
            ? `This PR has ${MAX_FILES}+ files. Results may be incomplete. Consider reviewing in smaller batches.`
            : undefined;

        return createSuccessResponse({
          total_count: result.data.length,
          files: result.data.map(file => ({
            sha: file.sha,
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch || null,
            previous_filename: file.previous_filename || null,
            is_binary: !file.patch && file.status !== 'removed',
            blob_url: file.blob_url,
            raw_url: file.raw_url,
          })),
          pagination: {
            page: page || 1,
            per_page: per_page || 100,
            has_more: result.data.length === (per_page || 100),
          },
          ...(warning && { warning }),
        });
      } catch (error) {
        // Handle rate limiting
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }

        // Handle not found
        if (hasStatus(error, 404)) {
          return createErrorResponse(error, {
            suggestion: `Pull request #${pull_number} was not found in ${fullRepoName}. Verify the PR number is correct.`,
          });
        }

        return createErrorResponse(error);
      }
    }
  );

  // GET PULL REQUEST DIFF - Get the raw unified diff for a PR
  server.tool(
    TOOL_GET_PULL_REQUEST_DIFF,
    {
      owner: ownerSchema,
      repo: repoSchema,
      pull_number: pullNumberSchema,
    },
    async ({ owner, repo, pull_number }) => {
      const fullRepoName = `${owner}/${repo}`;

      try {
        // Use octokit.request with custom Accept header for raw diff
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner,
          repo,
          pull_number,
          headers: {
            accept: 'application/vnd.github.diff',
          },
        });

        // Response is raw text when using diff media type
        const diffContent = response.data as unknown as string;
        const diffLines = diffContent ? diffContent.split('\n').length : 0;

        return createSuccessResponse({
          pull_number,
          diff: diffContent,
          diff_lines: diffLines,
        });
      } catch (error) {
        // Handle rate limiting
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }

        // Handle not found
        if (hasStatus(error, 404)) {
          return createErrorResponse(error, {
            suggestion: `Pull request #${pull_number} was not found in ${fullRepoName}. Verify the PR number is correct.`,
          });
        }

        // Handle diff too large (406 Not Acceptable)
        if (hasStatus(error, 406)) {
          return createErrorResponse(error, {
            suggestion:
              'Diff exceeds GitHub size limits (20,000 lines, 300 files, or 1MB). Use get_pull_request_files for structured file-by-file access instead.',
          });
        }

        return createErrorResponse(error);
      }
    }
  );

  // CREATE PULL REQUEST - Create a new pull request
  server.tool(
    TOOL_CREATE_PULL_REQUEST,
    'Create a pull request in a GitHub repository.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      title: z
        .string()
        .min(1, 'Title is required')
        .max(256, 'Title must be 256 characters or less')
        .transform(val => val.trim())
        .refine(val => val.length > 0, 'Title cannot be only whitespace')
        .describe('Pull request title'),
      body: z
        .string()
        .max(65536, 'Body must be 65536 characters or less')
        .optional()
        .describe('Pull request body (supports Markdown)'),
      head: z
        .string()
        .min(1, 'Head branch is required')
        .describe('Branch containing changes. For cross-repo PRs, use "username:branch" format'),
      base: z.string().optional().describe('Target branch to merge into (default: main)'),
      draft: z.boolean().optional().describe('Create as draft PR (default: true)'),
      maintainer_can_modify: z
        .boolean()
        .optional()
        .describe('Allow maintainers to modify this PR branch (default: true)'),
      ...confirmationParams,
    },
    async ({
      owner,
      repo,
      title,
      body,
      head,
      base: baseInput,
      draft: draftInput,
      maintainer_can_modify: maintainerCanModifyInput,
      _executeFromButton,
    }) => {
      const fullRepoName = `${owner}/${repo}`;
      const shouldExecute = _executeFromButton === true;

      // Apply defaults
      const base = baseInput ?? 'main';
      const draft = draftInput ?? true;
      const maintainer_can_modify = maintainerCanModifyInput ?? true;

      // PREVIEW MODE
      if (!shouldExecute) {
        // Check for existing PR (idempotency)
        try {
          const existingPRs = await octokit.pulls.list({
            owner,
            repo,
            head: head.includes(':') ? head : `${owner}:${head}`,
            base,
            state: 'open',
          });

          if (existingPRs.data.length > 0) {
            const existing = existingPRs.data[0];
            return createSuccessResponse({
              action: 'existing_pr_found',
              message: 'A pull request already exists for this branch combination',
              pull_request: {
                number: existing.number,
                title: existing.title,
                url: existing.html_url,
                state: existing.state,
              },
              suggestion: 'Update the existing PR or close it before creating a new one',
            });
          }
        } catch (error) {
          // Silently continue to preview if check fails
          console.error(
            `[${TOOL_CREATE_PULL_REQUEST}] Warning: Could not check for existing PRs: ${getErrorMessage(error)}`
          );
        }

        return createPreviewResponse(
          '🔀 Preview: Pull Request to be Created',
          {
            repository: fullRepoName,
            title,
            body: body || '[No description]',
            head,
            base,
            draft,
            maintainer_can_modify,
          },
          'pull_request',
          {
            tool: TOOL_CREATE_PULL_REQUEST,
            params: { owner, repo, title, body, head, base, draft, maintainer_can_modify },
          }
        );
      }

      // EXECUTE MODE
      console.error(`[${TOOL_CREATE_PULL_REQUEST}] Attempting to create PR: ${fullRepoName} - "${title}"`);

      try {
        const result = await octokit.pulls.create({
          owner,
          repo,
          title,
          body,
          head,
          base,
          draft,
          maintainer_can_modify,
        });

        console.error(`[${TOOL_CREATE_PULL_REQUEST}] SUCCESS: PR #${result.data.number} created`);
        console.error(`[${TOOL_CREATE_PULL_REQUEST}] URL: ${result.data.html_url}`);

        return createSuccessResponse({
          pull_request: {
            number: result.data.number,
            title: result.data.title,
            url: result.data.html_url,
            state: result.data.state,
            draft: result.data.draft,
            head: result.data.head.ref,
            base: result.data.base.ref,
            created_at: result.data.created_at,
            user: result.data.user?.login,
          },
        });
      } catch (error) {
        console.error(`[${TOOL_CREATE_PULL_REQUEST}] ERROR: ${getErrorMessage(error)}`);

        // Handle rate limiting
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }

        // Handle specific 422 errors
        if (hasStatus(error, 422)) {
          const message = getErrorMessage(error);
          if (message.toLowerCase().includes('already exists')) {
            return createErrorResponse(error, {
              suggestion: 'A PR already exists for this head/base. Use list_pull_requests to find it.',
            });
          }
          if (message.toLowerCase().includes('no commits between')) {
            return createErrorResponse(error, {
              suggestion: 'Ensure your head branch has commits that differ from the base branch.',
            });
          }
        }

        return createErrorResponse(error);
      }
    }
  );

  // UPDATE PULL REQUEST - Update an existing pull request
  server.tool(
    TOOL_UPDATE_PULL_REQUEST,
    'Update a pull request in a GitHub repository.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      pull_number: z.number().min(1, 'Pull request number is required').describe('Pull request number to update'),
      title: z
        .string()
        .min(1, 'Title cannot be empty')
        .max(256, 'Title must be 256 characters or less')
        .transform(val => val.trim())
        .refine(val => val.length > 0, 'Title cannot be only whitespace')
        .optional()
        .describe('New pull request title'),
      body: z
        .string()
        .max(65536, 'Body must be 65536 characters or less')
        .optional()
        .describe('New pull request body (supports Markdown)'),
      state: z
        .enum(['open', 'closed'])
        .optional()
        .describe('PR state: "open" to reopen, "closed" to close without merging'),
      base: z.string().optional().describe('Target branch to merge into'),
      draft: z.boolean().optional().describe('Draft status: true to convert to draft, false to mark ready for review'),
      maintainer_can_modify: z.boolean().optional().describe('Allow maintainers to modify this PR branch'),
      ...confirmationParams,
    },
    async ({
      owner,
      repo,
      pull_number,
      title,
      body,
      state,
      base,
      draft,
      maintainer_can_modify,
      _executeFromButton,
    }) => {
      const fullRepoName = `${owner}/${repo}`;
      const shouldExecute = _executeFromButton === true;

      // Check if at least one update field is provided
      const hasUpdates =
        title !== undefined ||
        body !== undefined ||
        state !== undefined ||
        base !== undefined ||
        draft !== undefined ||
        maintainer_can_modify !== undefined;

      if (!hasUpdates) {
        return createErrorResponse(new Error('No update fields provided'), {
          suggestion:
            'Provide at least one field to update: title, body, state, base, draft, or maintainer_can_modify.',
        });
      }

      // Fetch current PR details
      let prDetails;
      try {
        prDetails = await octokit.pulls.get({
          owner,
          repo,
          pull_number,
        });
      } catch (error) {
        console.error(`[${TOOL_UPDATE_PULL_REQUEST}] ERROR fetching PR: ${getErrorMessage(error)}`);
        if (hasStatus(error, 404)) {
          return createErrorResponse(error, {
            suggestion: `Pull request #${pull_number} was not found in ${fullRepoName}.`,
          });
        }
        return createErrorResponse(error);
      }

      const pr = prDetails.data;

      // Validate draft status change constraints
      if (draft !== undefined) {
        // Can't change draft status on merged PRs
        if (pr.merged) {
          return createErrorResponse(new Error(`Cannot change draft status of merged pull request #${pull_number}`), {
            suggestion: 'Merged pull requests cannot be modified.',
          });
        }
        // Can't change draft status on closed PRs
        if (pr.state === 'closed') {
          return createErrorResponse(new Error(`Cannot change draft status of closed pull request #${pull_number}`), {
            suggestion: 'Reopen the pull request first before changing draft status.',
          });
        }
      }

      // Build the changes preview
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (title !== undefined && title !== pr.title) {
        changes.title = { from: pr.title, to: title };
      }
      if (body !== undefined && body !== pr.body) {
        changes.body = { from: pr.body ? '[existing body]' : '[no body]', to: body ? '[new body]' : '[clear body]' };
      }
      if (state !== undefined && state !== pr.state) {
        changes.state = { from: pr.state, to: state };
      }
      if (base !== undefined && base !== pr.base.ref) {
        changes.base = { from: pr.base.ref, to: base };
      }
      if (draft !== undefined && draft !== pr.draft) {
        changes.draft = { from: pr.draft, to: draft };
      }
      if (maintainer_can_modify !== undefined && maintainer_can_modify !== pr.maintainer_can_modify) {
        changes.maintainer_can_modify = { from: pr.maintainer_can_modify, to: maintainer_can_modify };
      }

      // Check if there are actual changes
      if (Object.keys(changes).length === 0) {
        return createSuccessResponse({
          action: 'no_changes',
          message: 'No changes needed - PR already matches the requested values',
          pull_request: {
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            state: pr.state,
            draft: pr.draft,
          },
        });
      }

      // PREVIEW MODE
      if (!shouldExecute) {
        return createPreviewResponse(
          '✏️ Preview: Pull Request to be Updated',
          {
            repository: fullRepoName,
            pull_request: {
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              current_state: pr.state,
              current_draft: pr.draft,
            },
            changes,
          },
          'pull_request_update',
          {
            tool: TOOL_UPDATE_PULL_REQUEST,
            params: { owner, repo, pull_number, title, body, state, base, draft, maintainer_can_modify },
          }
        );
      }

      // EXECUTE MODE
      console.error(`[${TOOL_UPDATE_PULL_REQUEST}] Attempting to update PR #${pull_number}: ${fullRepoName}`);

      try {
        // Step 1: Update REST API fields (title, body, state, base, maintainer_can_modify)
        const restFields: {
          title?: string;
          body?: string;
          state?: 'open' | 'closed';
          base?: string;
          maintainer_can_modify?: boolean;
        } = {};

        if (title !== undefined) restFields.title = title;
        if (body !== undefined) restFields.body = body;
        if (state !== undefined) restFields.state = state;
        if (base !== undefined) restFields.base = base;
        if (maintainer_can_modify !== undefined) restFields.maintainer_can_modify = maintainer_can_modify;

        let updatedPr = pr;

        // Only call REST API if there are REST fields to update
        if (Object.keys(restFields).length > 0) {
          const restResult = await octokit.pulls.update({
            owner,
            repo,
            pull_number,
            ...restFields,
          });
          updatedPr = restResult.data;
          console.error(`[${TOOL_UPDATE_PULL_REQUEST}] REST update successful`);
        }

        // Step 2: Handle draft status change via GraphQL (if requested)
        if (draft !== undefined && draft !== pr.draft) {
          const nodeId = updatedPr.node_id;

          if (draft === false) {
            // Mark as ready for review
            console.error(`[${TOOL_UPDATE_PULL_REQUEST}] Marking PR as ready for review via GraphQL`);
            const graphqlResult = await octokit.graphql<{
              markPullRequestReadyForReview: {
                pullRequest: { id: string; isDraft: boolean; number: number; title: string };
              };
            }>(MARK_PR_READY_FOR_REVIEW_MUTATION, {
              pullRequestId: nodeId,
            });
            updatedPr.draft = graphqlResult.markPullRequestReadyForReview.pullRequest.isDraft;
            console.error(`[${TOOL_UPDATE_PULL_REQUEST}] PR marked ready for review`);
          } else {
            // Convert to draft
            console.error(`[${TOOL_UPDATE_PULL_REQUEST}] Converting PR to draft via GraphQL`);
            const graphqlResult = await octokit.graphql<{
              convertPullRequestToDraft: {
                pullRequest: { id: string; isDraft: boolean; number: number; title: string };
              };
            }>(CONVERT_PR_TO_DRAFT_MUTATION, {
              pullRequestId: nodeId,
            });
            updatedPr.draft = graphqlResult.convertPullRequestToDraft.pullRequest.isDraft;
            console.error(`[${TOOL_UPDATE_PULL_REQUEST}] PR converted to draft`);
          }
        }

        console.error(`[${TOOL_UPDATE_PULL_REQUEST}] SUCCESS: PR #${pull_number} updated`);

        return createSuccessResponse({
          pull_request: {
            number: updatedPr.number,
            title: updatedPr.title,
            url: updatedPr.html_url,
            state: updatedPr.state,
            draft: updatedPr.draft,
            head: updatedPr.head.ref,
            base: updatedPr.base.ref,
            updated_at: updatedPr.updated_at,
          },
          changes_applied: changes,
        });
      } catch (error) {
        console.error(`[${TOOL_UPDATE_PULL_REQUEST}] ERROR: ${getErrorMessage(error)}`);

        // Handle rate limiting
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }

        // Handle specific 422 errors
        if (hasStatus(error, 422)) {
          const message = getErrorMessage(error);
          if (message.toLowerCase().includes('draft')) {
            return createErrorResponse(error, {
              suggestion: 'Draft status change failed. Ensure the PR is open and you have permissions.',
            });
          }
          if (message.toLowerCase().includes('base')) {
            return createErrorResponse(error, {
              suggestion: 'Invalid base branch. Use list_branches to see available branches.',
            });
          }
        }

        // Handle GraphQL errors
        if (error instanceof Error && error.message.includes('GraphQL')) {
          return createErrorResponse(error, {
            suggestion: 'GraphQL mutation failed. This may be due to permissions or PR state.',
          });
        }

        return createErrorResponse(error);
      }
    }
  );

  // MERGE PULL REQUEST - Merge an open pull request
  server.tool(
    TOOL_MERGE_PULL_REQUEST,
    'Merge a pull request in a GitHub repository.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      pull_number: z.number().min(1, 'Pull request number is required').describe('Pull request number to merge'),
      merge_method: z
        .enum(['merge', 'squash', 'rebase'])
        .optional()
        .describe('Merge method (default: merge). "squash" combines commits, "rebase" applies commits individually'),
      commit_title: z
        .string()
        .max(256, 'Commit title must be 256 characters or less')
        .optional()
        .describe('Custom merge commit title (only for merge and squash methods)'),
      commit_message: z
        .string()
        .max(65536, 'Commit message must be 65536 characters or less')
        .optional()
        .describe('Custom merge commit message (only for merge and squash methods)'),
      sha: z
        .string()
        .optional()
        .describe('SHA that head must match to merge. If omitted, any SHA is accepted (use with caution)'),
      ...confirmationParams,
    },
    async ({
      owner,
      repo,
      pull_number,
      merge_method: mergeMethodInput,
      commit_title,
      commit_message,
      sha,
      _executeFromButton,
    }) => {
      const fullRepoName = `${owner}/${repo}`;
      const shouldExecute = _executeFromButton === true;

      // Apply defaults
      const merge_method = mergeMethodInput ?? 'merge';

      // Fetch PR details for both preview and execute modes
      let prDetails;
      try {
        prDetails = await octokit.pulls.get({
          owner,
          repo,
          pull_number,
        });
      } catch (error) {
        console.error(`[${TOOL_MERGE_PULL_REQUEST}] ERROR fetching PR: ${getErrorMessage(error)}`);
        if (hasStatus(error, 404)) {
          return createErrorResponse(error, {
            suggestion: `Pull request #${pull_number} was not found in ${fullRepoName}.`,
          });
        }
        return createErrorResponse(error);
      }

      const pr = prDetails.data;

      // Check if PR is already merged
      if (pr.merged) {
        return createSuccessResponse({
          action: 'already_merged',
          message: `Pull request #${pull_number} has already been merged`,
          pull_request: {
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            merged: true,
            merged_at: pr.merged_at,
          },
        });
      }

      // Check if PR is closed (not mergeable)
      if (pr.state === 'closed') {
        return createErrorResponse(new Error(`Pull request #${pull_number} is closed and cannot be merged`), {
          suggestion: 'Reopen the pull request before attempting to merge.',
        });
      }

      // PREVIEW MODE
      if (!shouldExecute) {
        return createPreviewResponse(
          '🔀 Preview: Pull Request to be Merged',
          {
            repository: fullRepoName,
            pull_request: {
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              head: pr.head.ref,
              base: pr.base.ref,
              additions: pr.additions,
              deletions: pr.deletions,
              changed_files: pr.changed_files,
              commits: pr.commits,
            },
            merge_method,
            mergeable: pr.mergeable,
            mergeable_state: pr.mergeable_state,
            ...(commit_title && { commit_title }),
            ...(commit_message && { commit_message }),
          },
          'merge',
          {
            tool: TOOL_MERGE_PULL_REQUEST,
            params: { owner, repo, pull_number, merge_method, commit_title, commit_message, sha },
          }
        );
      }

      // EXECUTE MODE
      console.error(
        `[${TOOL_MERGE_PULL_REQUEST}] Attempting to merge PR #${pull_number}: ${fullRepoName} (${merge_method})`
      );

      // Check mergeability before attempting merge
      if (pr.mergeable === false) {
        console.error(`[${TOOL_MERGE_PULL_REQUEST}] PR is not mergeable. State: ${pr.mergeable_state}`);
        return createErrorResponse(new Error('Pull request cannot be merged'), {
          suggestion: `PR is not mergeable (state: ${pr.mergeable_state}). Check for conflicts or required status checks.`,
        });
      }

      try {
        const result = await octokit.pulls.merge({
          owner,
          repo,
          pull_number,
          merge_method,
          ...(commit_title && { commit_title }),
          ...(commit_message && { commit_message }),
          ...(sha && { sha }),
        });

        console.error(`[${TOOL_MERGE_PULL_REQUEST}] SUCCESS: PR #${pull_number} merged`);
        console.error(`[${TOOL_MERGE_PULL_REQUEST}] Merge SHA: ${result.data.sha}`);

        return createSuccessResponse({
          merged: result.data.merged,
          message: result.data.message,
          sha: result.data.sha,
          pull_request: {
            number: pull_number,
            title: pr.title,
            url: pr.html_url,
            head: pr.head.ref,
            base: pr.base.ref,
          },
        });
      } catch (error) {
        console.error(`[${TOOL_MERGE_PULL_REQUEST}] ERROR: ${getErrorMessage(error)}`);

        // Handle rate limiting
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }

        // Handle specific 405 errors (not mergeable)
        if (hasStatus(error, 405)) {
          return createErrorResponse(error, {
            suggestion:
              'Pull request is not mergeable. Check for merge conflicts, failing status checks, or required reviews.',
          });
        }

        // Handle specific 409 errors (head SHA mismatch)
        if (hasStatus(error, 409)) {
          return createErrorResponse(error, {
            suggestion: 'Head SHA does not match. The PR may have been updated. Fetch latest PR details and retry.',
          });
        }

        // Handle specific 422 errors
        if (hasStatus(error, 422)) {
          const message = getErrorMessage(error);
          if (message.toLowerCase().includes('merge conflict')) {
            return createErrorResponse(error, {
              suggestion: 'The PR has merge conflicts that must be resolved before merging.',
            });
          }
        }

        return createErrorResponse(error);
      }
    }
  );

  // SEARCH PULL REQUESTS - Search PRs with date range, author, and other filters
  server.tool(
    TOOL_SEARCH_PULL_REQUESTS,
    'Search pull requests using GitHub Search API with date-range filtering. Much faster than paginating list_pull_requests for date-filtered queries.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      state: z
        .enum(['open', 'closed', 'merged', 'all'])
        .optional()
        .describe('PR state filter (default: all). "merged" filters for merged PRs specifically'),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')
        .optional()
        .describe('ISO date string (YYYY-MM-DD) — only return PRs closed after this date'),
      author: z
        .string()
        .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/, 'Invalid GitHub username format')
        .max(39, 'GitHub username too long')
        .optional()
        .describe('Filter by PR author username'),
      labels: z
        .array(
          z
            .string()
            .max(50, 'Label name too long')
            .refine(s => !/["\\]/.test(s), 'Labels cannot contain quotes or backslashes')
        )
        .optional()
        .describe('Filter PRs by labels'),
      sort: z.enum(['created', 'updated', 'comments']).optional().describe('Sort field (default: updated)'),
      order: z.enum(['asc', 'desc']).optional().describe('Sort order (default: desc)'),
      ...paginationParams,
    },
    async ({ owner, repo, state, since, author, labels, sort, order, per_page, page }) => {
      try {
        // Build GitHub search query
        const parts: string[] = [`type:pr`, `repo:${owner}/${repo}`];
        if (state && state !== 'all') {
          parts.push(state === 'merged' ? 'is:merged' : `is:${state}`);
        }
        if (since) parts.push(`closed:>${since}`);
        if (author) parts.push(`author:${author}`);
        if (labels) labels.forEach(l => parts.push(`label:"${l}"`));

        const result = await octokit.search.issuesAndPullRequests({
          q: parts.join(' '),
          sort: sort || 'updated',
          order: order || 'desc',
          per_page: per_page || 100,
          page: page || 1,
        });

        return createSuccessResponse({
          total_count: result.data.total_count,
          pull_requests: result.data.items.map(pr => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft,
            url: pr.html_url,
            user: pr.user?.login,
            labels: pr.labels?.map(l => l.name) || [],
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            closed_at: pr.closed_at,
          })),
        });
      } catch (error) {
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }
        return createErrorResponse(error);
      }
    }
  );
}
