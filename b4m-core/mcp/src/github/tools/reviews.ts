/**
 * GitHub MCP Server - Pull Request Review Tools
 *
 * Tools for creating and managing pull request reviews.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import {
  ownerSchema,
  repoSchema,
  pullNumberSchema,
  reviewEventSchema,
  reviewCommentSchema,
  reviewBodySchema,
  confirmationParams,
} from '../helpers/schemas.js';
import { getErrorMessage, hasStatus, isRateLimitError } from '../helpers/errors.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { TOOL_CREATE_REVIEW, TOOL_APPROVE_PR, TOOL_REQUEST_CHANGES } from '../constants.js';

// Type for review comment from schema
type ReviewComment = z.infer<typeof reviewCommentSchema>;

/**
 * Core review creation logic shared by all three tools
 */
async function executeReview(params: {
  owner: string;
  repo: string;
  pull_number: number;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body?: string;
  comments?: ReviewComment[];
  commit_id?: string;
  toolName: string;
}): Promise<ReturnType<typeof createSuccessResponse> | ReturnType<typeof createErrorResponse>> {
  const { owner, repo, pull_number, event, body, comments, commit_id, toolName } = params;
  const fullRepoName = `${owner}/${repo}`;

  console.error(`[${toolName}] Attempting to create ${event} review on PR #${pull_number}: ${fullRepoName}`);

  try {
    // Fetch PR details to validate state and get current commit SHA
    let prDetails;
    try {
      prDetails = await octokit.pulls.get({
        owner,
        repo,
        pull_number,
      });
    } catch (error) {
      console.error(`[${toolName}] ERROR fetching PR: ${getErrorMessage(error)}`);
      if (hasStatus(error, 404)) {
        return createErrorResponse(error, {
          suggestion: `Pull request #${pull_number} was not found in ${fullRepoName}. Verify the PR number is correct.`,
        });
      }
      return createErrorResponse(error);
    }

    const pr = prDetails.data;

    // Validate PR is open (not merged, not closed)
    if (pr.merged) {
      return createErrorResponse(new Error(`Cannot review pull request #${pull_number} - it has already been merged`), {
        suggestion: 'Reviews cannot be submitted on merged pull requests.',
      });
    }

    if (pr.state === 'closed') {
      return createErrorResponse(new Error(`Cannot review closed pull request #${pull_number}`), {
        suggestion: 'Reopen the pull request before submitting a review.',
      });
    }

    // Use provided commit_id or default to current HEAD
    const reviewCommitId = commit_id || pr.head.sha;

    // Build review request
    const reviewRequest: {
      owner: string;
      repo: string;
      pull_number: number;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body?: string;
      commit_id?: string;
      comments?: Array<{
        path: string;
        line: number;
        side?: 'LEFT' | 'RIGHT';
        body: string;
        start_line?: number;
        start_side?: 'LEFT' | 'RIGHT';
      }>;
    } = {
      owner,
      repo,
      pull_number,
      event,
      commit_id: reviewCommitId,
    };

    if (body) {
      reviewRequest.body = body;
    }

    if (comments && comments.length > 0) {
      reviewRequest.comments = comments.map(comment => ({
        path: comment.path,
        line: comment.line,
        side: comment.side || 'RIGHT', // Default to RIGHT if not specified
        body: comment.body,
        ...(comment.start_line && { start_line: comment.start_line }),
        ...(comment.start_side && { start_side: comment.start_side }),
      }));
    }

    // Submit the review
    const result = await octokit.pulls.createReview(reviewRequest);

    // Audit logging for APPROVE and REQUEST_CHANGES events (both affect merge status)
    if (event === 'APPROVE' || event === 'REQUEST_CHANGES') {
      console.error(`[${toolName}] AUDIT: ${event} review created on PR #${pull_number} by authenticated user`);
    }

    console.error(`[${toolName}] SUCCESS: ${event} review created on PR #${pull_number}`);
    console.error(`[${toolName}] Review ID: ${result.data.id}`);
    console.error(`[${toolName}] Review URL: ${result.data.html_url}`);

    return createSuccessResponse({
      review: {
        id: result.data.id,
        node_id: result.data.node_id,
        state: result.data.state,
        url: result.data.html_url,
        commit_id: result.data.commit_id,
        submitted_at: result.data.submitted_at,
      },
      pull_request: {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
      },
    });
  } catch (error) {
    console.error(`[${toolName}] ERROR: ${getErrorMessage(error)}`);

    // Handle rate limiting
    if (isRateLimitError(error)) {
      return createErrorResponse(error, {
        suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
      });
    }

    // Handle self-review attempt (403)
    if (hasStatus(error, 403)) {
      const message = getErrorMessage(error).toLowerCase();
      if (message.includes('own pull request') || message.includes('author')) {
        return createErrorResponse(error, {
          suggestion: 'You cannot review your own pull request. Ask a collaborator to review.',
        });
      }
      // Generic permission error
      return createErrorResponse(error, {
        suggestion: "You don't have permission to review this pull request. Ensure you have collaborator access.",
      });
    }

    // Handle 401 (authentication/scope issues)
    if (hasStatus(error, 401)) {
      return createErrorResponse(error, {
        suggestion: 'Authentication failed. Ensure your token has the "repo" scope for private repos.',
      });
    }

    // Handle 422 validation errors
    if (hasStatus(error, 422)) {
      const message = getErrorMessage(error).toLowerCase();
      if (message.includes('path') || message.includes('position') || message.includes('line')) {
        return createErrorResponse(error, {
          suggestion:
            'One or more review comments reference invalid file paths or lines. Ensure paths exist in the PR diff and line numbers are within the diff context.',
        });
      }
      if (message.includes('body') || message.includes('blank')) {
        return createErrorResponse(error, {
          suggestion: 'Review body is required for REQUEST_CHANGES and COMMENT events.',
        });
      }
    }

    return createErrorResponse(error);
  }
}

export function registerReviewTools(server: McpServer) {
  // CREATE REVIEW - Full-featured review tool with inline comments support
  server.tool(
    TOOL_CREATE_REVIEW,
    'Create a review on a pull request with optional inline comments.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      pull_number: pullNumberSchema,
      event: reviewEventSchema,
      body: reviewBodySchema
        .optional()
        .describe('Review summary comment. Required for REQUEST_CHANGES and COMMENT events.'),
      comments: z
        .array(reviewCommentSchema)
        .optional()
        .describe('Inline comments on specific file lines in the PR diff'),
      commit_id: z
        .string()
        .optional()
        .describe('SHA of the commit to review. Defaults to the latest commit on the PR.'),
      ...confirmationParams,
    },
    async ({ owner, repo, pull_number, event, body, comments, commit_id, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;
      const shouldExecute = _executeFromButton === true;

      // Validate body is provided for REQUEST_CHANGES and COMMENT
      if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && !body) {
        return createErrorResponse(new Error(`Review body is required when event is ${event}`), {
          suggestion: 'Provide a body explaining the review feedback.',
        });
      }

      // PREVIEW MODE
      if (!shouldExecute) {
        // Fetch PR to get current commit SHA for preview
        let currentHeadSha: string | null = null;
        let prFetchError: string | null = null;
        try {
          const pr = await octokit.pulls.get({ owner, repo, pull_number });
          currentHeadSha = pr.data.head.sha;
        } catch (error) {
          prFetchError = getErrorMessage(error);
          console.error(`[${TOOL_CREATE_REVIEW}] Warning: Could not fetch PR for preview: ${prFetchError}`);
        }

        const previewData: Record<string, unknown> = {
          repository: fullRepoName,
          pull_number,
          event,
          body: body || '[No review body]',
          comments_count: comments?.length || 0,
        };

        if (comments && comments.length > 0) {
          previewData.comment_paths = comments.map(c => c.path);
        }

        // Warn if PR fetch failed
        if (prFetchError) {
          previewData.warning = `Could not verify PR exists: ${prFetchError}. The review may fail on execution.`;
        }
        // Warn if provided commit_id differs from current HEAD
        else if (commit_id && currentHeadSha && commit_id !== currentHeadSha) {
          previewData.warning = `Provided commit_id (${commit_id.substring(0, 7)}) differs from current HEAD (${currentHeadSha.substring(0, 7)}). Review may be marked as stale.`;
        }

        return createPreviewResponse(`📝 Preview: ${event} Review on PR #${pull_number}`, previewData, 'review', {
          tool: TOOL_CREATE_REVIEW,
          params: { owner, repo, pull_number, event, body, comments, commit_id },
        });
      }

      // EXECUTE MODE
      return executeReview({
        owner,
        repo,
        pull_number,
        event,
        body,
        comments,
        commit_id,
        toolName: TOOL_CREATE_REVIEW,
      });
    }
  );

  // APPROVE PR - Convenience wrapper for simple approvals
  server.tool(
    TOOL_APPROVE_PR,
    'Approve a pull request.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      pull_number: pullNumberSchema,
      body: reviewBodySchema.optional().describe('Optional approval message'),
      ...confirmationParams,
    },
    async ({ owner, repo, pull_number, body, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;
      const shouldExecute = _executeFromButton === true;

      // PREVIEW MODE
      if (!shouldExecute) {
        return createPreviewResponse(
          `✅ Preview: Approve PR #${pull_number}`,
          {
            repository: fullRepoName,
            pull_number,
            event: 'APPROVE',
            body: body || '[No approval message]',
          },
          'review',
          {
            tool: TOOL_APPROVE_PR,
            params: { owner, repo, pull_number, body },
          }
        );
      }

      // EXECUTE MODE - delegate to core review logic
      return executeReview({
        owner,
        repo,
        pull_number,
        event: 'APPROVE',
        body,
        toolName: TOOL_APPROVE_PR,
      });
    }
  );

  // REQUEST CHANGES - Convenience wrapper for requesting changes
  server.tool(
    TOOL_REQUEST_CHANGES,
    'Request changes on a pull request.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      pull_number: pullNumberSchema,
      body: reviewBodySchema.describe('Required explanation of changes needed'),
      comments: z.array(reviewCommentSchema).optional().describe('Optional inline comments on specific file lines'),
      ...confirmationParams,
    },
    async ({ owner, repo, pull_number, body, comments, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;
      const shouldExecute = _executeFromButton === true;

      // Body is required for request_changes (enforced by schema, but double-check)
      if (!body) {
        return createErrorResponse(new Error('Review body is required when requesting changes'), {
          suggestion: 'Provide a body explaining what changes are needed.',
        });
      }

      // PREVIEW MODE
      if (!shouldExecute) {
        const previewData: Record<string, unknown> = {
          repository: fullRepoName,
          pull_number,
          event: 'REQUEST_CHANGES',
          body,
          comments_count: comments?.length || 0,
        };

        if (comments && comments.length > 0) {
          previewData.comment_paths = comments.map(c => c.path);
        }

        return createPreviewResponse(`🔄 Preview: Request Changes on PR #${pull_number}`, previewData, 'review', {
          tool: TOOL_REQUEST_CHANGES,
          params: { owner, repo, pull_number, body, comments },
        });
      }

      // EXECUTE MODE - delegate to core review logic
      return executeReview({
        owner,
        repo,
        pull_number,
        event: 'REQUEST_CHANGES',
        body,
        comments,
        toolName: TOOL_REQUEST_CHANGES,
      });
    }
  );
}
