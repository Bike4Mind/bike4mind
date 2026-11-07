import { mcpConnectionRepository } from '@bike4mind/database';
import { isCustomToolOffered, type CustomMcpToolHost } from '@bike4mind/services/llm';
import { evaluateConnectionPolicy, resolveCustomMcpContext } from './customMcpAccess';
import { invokeRemoteMcp } from './invokeRemoteMcp';

/**
 * Supplies custom-connector tools to tool building. Listing reports nothing unless custom
 * connectors are enabled for the user, and drops any connection a policy now blocks; `callTool`
 * goes through `invokeRemoteMcp`, which re-checks policy, approval, rate limit and breaker.
 */
export const customMcpToolHost: CustomMcpToolHost = {
  async listConnections(userId) {
    const context = await resolveCustomMcpContext(userId);
    if (!context.enabled) return [];
    const connections = await mcpConnectionRepository.listForUser(userId);
    return connections
      .filter(
        connection =>
          evaluateConnectionPolicy(context, {
            urlHost: connection.urlHost,
            authKind: connection.auth.kind,
            url: connection.displayUrl,
          }).allowed
      )
      .map(connection => ({
        connectionId: connection.id,
        slug: connection.slug,
        displayName: connection.displayName,
        urlHost: connection.urlHost,
        allowWriteTools: context.policies.every(policy => policy.allowWriteTools),
        requireApprovalForAll: context.policies.some(policy => policy.requireApprovalForAll),
        tools: connection.tools,
      }));
  },

  callTool: ({ connectionId, userId, toolName, args, approved }) =>
    invokeRemoteMcp({ action: 'callTool', connectionId, userId, toolName, args, approved }),
};

/**
 * Whether the user's connection still offers this tool (enabled, connected, reviewed, policy allows
 * it). The confirm route asks before it claims an approved action, so a deterministic refusal leaves
 * the card in place instead of consuming it.
 */
export async function isCustomToolStillOffered(
  userId: string,
  connectionId: string,
  toolName: string
): Promise<boolean> {
  const connection = (await customMcpToolHost.listConnections(userId)).find(c => c.connectionId === connectionId);
  const tool = connection?.tools.find(candidate => candidate.name === toolName);
  return Boolean(connection && tool && isCustomToolOffered(tool, connection));
}
