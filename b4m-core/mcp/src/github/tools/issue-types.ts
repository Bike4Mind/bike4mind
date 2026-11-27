/**
 * GitHub MCP Server - Issue Type Tools
 *
 * Tools for organization issue type operations.
 */

import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { orgSchema } from '../helpers/schemas.js';
import { createStderrLogger } from '../../shared/stderrLog.js';
import { errorLogFields, getErrorInfo } from '../helpers/errors.js';
import { TOOL_LIST_ORG_ISSUE_TYPES } from '../constants.js';

const log = createStderrLogger('github');

export function registerIssueTypeTools(server: McpServer) {
  // LIST ORGANIZATION ISSUE TYPES - List available issue types for an organization
  server.tool(
    TOOL_LIST_ORG_ISSUE_TYPES,
    'List all available issue types for a GitHub organization. Returns native issue types like Bug, Feature, Task that can be set on issues.',
    {
      org: orgSchema,
    },
    async ({ org }) => {
      try {
        const result = await octokit.orgs.listIssueTypes({
          org,
        });

        return createSuccessResponse({
          issue_types: result.data,
        });
      } catch (error) {
        const errorInfo = getErrorInfo(error);
        log.error('failed', { toolName: TOOL_LIST_ORG_ISSUE_TYPES, ...errorLogFields(error) });

        return createErrorResponse(error, {
          organization: org,
          hint:
            errorInfo.status === 404
              ? 'Issue types may not be enabled for this organization, or the organization does not exist.'
              : 'Check that you have permission to access this organization.',
        });
      }
    }
  );
}
