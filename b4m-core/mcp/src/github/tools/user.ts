/**
 * GitHub MCP Server - User Tools
 *
 * Tools for user-related operations.
 */

import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { createStderrLogger } from '../../shared/stderrLog.js';
import { errorLogFields } from '../helpers/errors.js';
import { TOOL_CURRENT_USER } from '../constants.js';

const log = createStderrLogger('github');

export function registerUserTools(server: McpServer) {
  // CURRENT USER - Get authenticated user details
  server.tool(TOOL_CURRENT_USER, {}, async () => {
    try {
      const result = await octokit.users.getAuthenticated();

      return createSuccessResponse({
        user: {
          login: result.data.login,
          id: result.data.id,
          name: result.data.name,
          email: result.data.email,
          bio: result.data.bio,
          company: result.data.company,
          location: result.data.location,
          url: result.data.html_url,
          avatar_url: result.data.avatar_url,
          type: result.data.type,
          created_at: result.data.created_at,
          updated_at: result.data.updated_at,
          public_repos: result.data.public_repos,
          public_gists: result.data.public_gists,
          followers: result.data.followers,
          following: result.data.following,
        },
      });
    } catch (error) {
      log.error('failed', { toolName: TOOL_CURRENT_USER, ...errorLogFields(error) });
      return createErrorResponse(error);
    }
  });
}
