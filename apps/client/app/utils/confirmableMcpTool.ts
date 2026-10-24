import { ATLASSIAN_CONFIRMABLE_TOOLS } from '@bike4mind/mcp/atlassian/constants';
import { GITHUB_CONFIRMABLE_TOOLS } from '@bike4mind/mcp/github/constants';

/**
 * Whether a pending action is one the confirm route will execute, so the Confirm card renders only
 * for those. Mirrors the server's routing allowlist (server/utils/pendingActionTarget.ts).
 */
export function isConfirmableMcpTool(tool: string): boolean {
  return GITHUB_CONFIRMABLE_TOOLS.has(tool) || ATLASSIAN_CONFIRMABLE_TOOLS.has(tool);
}

/** A custom-connector action: the confirm route executes it against the stored connection. */
export function isCustomConnectorAction(action: { customConnector?: unknown }): boolean {
  return action.customConnector != null;
}
