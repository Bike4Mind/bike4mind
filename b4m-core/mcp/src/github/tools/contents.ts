/**
 * GitHub MCP Server - File Contents Tools
 *
 * Tools for creating and updating file contents in repositories.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { ownerSchema, repoSchema, confirmationParams } from '../helpers/schemas.js';
import { getErrorMessage, hasStatus, isRateLimitError } from '../helpers/errors.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { TOOL_CREATE_OR_UPDATE_FILE } from '../constants.js';

export function registerContentsTools(server: McpServer) {
  // CREATE OR UPDATE FILE - Create a new file or update an existing file in a repository
  server.tool(
    TOOL_CREATE_OR_UPDATE_FILE,
    'Create a new file or update an existing file in a GitHub repository. Content is automatically base64 encoded.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      path: z
        .string()
        .min(1, 'File path is required')
        .max(1024, 'File path must be 1024 characters or less')
        .refine(val => !val.startsWith('/'), 'Path should not start with /')
        .describe('File path in the repository (e.g., "src/index.ts" or "README.md")'),
      content: z.string().min(1, 'Content is required').describe('File content (will be automatically base64 encoded)'),
      message: z
        .string()
        .min(1, 'Commit message is required')
        .max(72, 'Commit message should be 72 characters or less for best practices')
        .describe('Commit message for this change'),
      branch: z.string().optional().describe('Branch to commit to (default: repository default branch)'),
      sha: z
        .string()
        .optional()
        .describe(
          'SHA of the file being replaced. Required when updating an existing file. Omit when creating a new file.'
        ),
      committer: z
        .object({
          name: z.string().describe('Committer name'),
          email: z.email().describe('Committer email'),
        })
        .optional()
        .describe('Override committer information (defaults to authenticated user)'),
      author: z
        .object({
          name: z.string().describe('Author name'),
          email: z.email().describe('Author email'),
        })
        .optional()
        .describe('Override author information (defaults to committer)'),
      ...confirmationParams,
    },
    async ({
      owner,
      repo,
      path,
      content,
      message,
      branch: branchInput,
      sha: shaInput,
      committer,
      author,
      _executeFromButton,
    }) => {
      const fullRepoName = `${owner}/${repo}`;
      const shouldExecute = _executeFromButton === true;

      // Determine if file exists and get SHA if updating
      let existingSha: string | undefined = shaInput;
      let fileExists = false;

      if (!shaInput) {
        try {
          const existingFile = await octokit.repos.getContent({
            owner,
            repo,
            path,
            ...(branchInput && { ref: branchInput }),
          });

          // getContent can return file or directory - we only handle files
          if (!Array.isArray(existingFile.data) && existingFile.data.type === 'file') {
            existingSha = existingFile.data.sha;
            fileExists = true;
            console.error(`[${TOOL_CREATE_OR_UPDATE_FILE}] File exists at ${path}, will update (sha: ${existingSha})`);
          }
        } catch (error) {
          // 404 means file doesn't exist - that's fine for creating new files
          if (!hasStatus(error, 404)) {
            console.error(`[${TOOL_CREATE_OR_UPDATE_FILE}] Error checking file existence: ${getErrorMessage(error)}`);
            return createErrorResponse(error);
          }
          console.error(`[${TOOL_CREATE_OR_UPDATE_FILE}] File does not exist at ${path}, will create`);
        }
      } else {
        // If SHA was provided, assume file exists
        fileExists = true;
      }

      // PREVIEW MODE
      if (!shouldExecute) {
        const action = fileExists ? 'update' : 'create';
        const contentPreview =
          content.length > 500 ? content.substring(0, 500) + `\n\n... (${content.length} total characters)` : content;

        return createPreviewResponse(
          `📄 Preview: File to be ${action === 'create' ? 'Created' : 'Updated'}`,
          {
            repository: fullRepoName,
            path,
            action,
            message,
            branch: branchInput || '(default branch)',
            content_preview: contentPreview,
            content_length: content.length,
            ...(fileExists && { existing_sha: existingSha }),
          },
          'file',
          {
            tool: TOOL_CREATE_OR_UPDATE_FILE,
            params: {
              owner,
              repo,
              path,
              content,
              message,
              branch: branchInput,
              sha: existingSha,
              committer,
              author,
            },
          }
        );
      }

      // EXECUTE MODE
      const action = fileExists ? 'update' : 'create';
      console.error(`[${TOOL_CREATE_OR_UPDATE_FILE}] Attempting to ${action} file: ${fullRepoName}/${path}`);

      try {
        // Base64 encode the content
        const encodedContent = Buffer.from(content).toString('base64');

        const result = await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: encodedContent,
          ...(branchInput && { branch: branchInput }),
          ...(existingSha && { sha: existingSha }),
          ...(committer && { committer }),
          ...(author && { author }),
        });

        console.error(`[${TOOL_CREATE_OR_UPDATE_FILE}] SUCCESS: File ${action}d at ${path}`);
        console.error(`[${TOOL_CREATE_OR_UPDATE_FILE}] Commit SHA: ${result.data.commit.sha}`);

        return createSuccessResponse({
          action,
          path,
          commit: {
            sha: result.data.commit.sha,
            url: result.data.commit.html_url,
            message: result.data.commit.message,
          },
          content: {
            sha: result.data.content?.sha,
            url: result.data.content?.html_url,
            download_url: result.data.content?.download_url,
          },
        });
      } catch (error) {
        console.error(`[${TOOL_CREATE_OR_UPDATE_FILE}] ERROR: ${getErrorMessage(error)}`);

        // Handle rate limiting
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }

        // Handle specific 409 conflict errors (SHA mismatch)
        if (hasStatus(error, 409)) {
          return createErrorResponse(error, {
            suggestion: 'The file was modified since you last fetched it. Fetch the latest SHA and try again.',
          });
        }

        // Handle 422 errors
        if (hasStatus(error, 422)) {
          const errorMessage = getErrorMessage(error);
          if (errorMessage.toLowerCase().includes('sha')) {
            return createErrorResponse(error, {
              suggestion:
                'SHA mismatch - the file may have been modified. Omit the sha parameter to auto-detect, or provide the current SHA.',
            });
          }
        }

        return createErrorResponse(error);
      }
    }
  );
}
