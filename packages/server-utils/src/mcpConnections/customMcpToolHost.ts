import { mcpConnectionRepository } from '@bike4mind/database';
import { isCustomToolOffered, type CustomMcpToolHost } from '@bike4mind/services/llm';
import { evaluateConnectionPolicy, resolveCustomMcpContext } from './customMcpAccess';
import { invokeRemoteMcp } from './invokeRemoteMcp';
import { policyPresetHost } from './policyPresetHost';

/**
 * Supplies custom-connector tools to tool building. Listing reports nothing unless custom
 * connectors are enabled for the user, lists a platform connector only when the caller names it as
 * switched on, and drops any connection a policy now blocks; `callTool` goes through
 * `invokeRemoteMcp`, which re-checks policy, approval, rate limit and breaker.
 */
export const customMcpToolHost: CustomMcpToolHost = {
  async listConnections(userId, options = {}) {
    const context = await resolveCustomMcpContext(userId);
    if (!context.enabled) return [];
    const connections = await mcpConnectionRepository.listForUser(userId, {
      platformIds: options.platformConnectionIds ?? [],
    });
    return connections
      .filter(
        connection =>
          evaluateConnectionPolicy(context, {
            urlHost: connection.urlHost,
            authKind: connection.auth.kind,
            url: connection.displayUrl,
            presetRemoteHost: policyPresetHost(connection),
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

  callTool: ({ connectionId, userId, toolName, args, approved, platformConnectionIds }) =>
    invokeRemoteMcp({ action: 'callTool', connectionId, userId, toolName, args, approved, platformConnectionIds }),
};

/**
 * Whether the user's connection still offers this tool (enabled, connected, reviewed, policy allows
 * it). The confirm route asks before it claims an approved action, so a deterministic refusal leaves
 * the card in place instead of consuming it. The card was recorded from a tool the user was offered,
 * so a platform connector it names counts as switched on.
 */
export async function isCustomToolStillOffered(
  userId: string,
  connectionId: string,
  toolName: string
): Promise<boolean> {
  const connection = (await customMcpToolHost.listConnections(userId, { platformConnectionIds: [connectionId] })).find(
    c => c.connectionId === connectionId
  );
  const tool = connection?.tools.find(candidate => candidate.name === toolName);
  return Boolean(connection && tool && isCustomToolOffered(tool, connection));
}
