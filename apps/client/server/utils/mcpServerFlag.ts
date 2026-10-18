import { isFeatureEnabled } from '@server/middlewares/featureFlag';
import { ForbiddenError } from '@server/utils/errors';

/**
 * Throws unless the EnableMCPServer admin flag is on. The web routes that write or contact a user's
 * MCP server, or execute a pending MCP action, call this; the Slack handlers check the same flag
 * through isFeatureEnabled. Checked beyond tool loading so turning the flag off also stops an action
 * already pending. Deleting or disconnecting a server stays open so users can clean up.
 */
export async function assertMcpServerEnabled(): Promise<void> {
  if (!(await isFeatureEnabled('EnableMCPServer'))) {
    throw new ForbiddenError('MCP servers are disabled');
  }
}
