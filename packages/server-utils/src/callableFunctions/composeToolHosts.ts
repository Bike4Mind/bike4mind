import { Logger } from '@bike4mind/observability';
import type { CustomMcpToolHost } from '@bike4mind/services/llm';

/**
 * One host over several: listings concatenate in argument order, which is the order the per-turn tool cap keeps
 * them in, and a call goes to the host that owns its connection id, else to the first host that names none. A host
 * whose listing fails is logged and skipped, so the others' tools are still offered.
 */
export function composeToolHosts(...hosts: CustomMcpToolHost[]): CustomMcpToolHost {
  const hostFor = (connectionId: string) =>
    hosts.find(host => host.ownsConnection?.(connectionId)) ?? hosts.find(host => !host.ownsConnection);

  return {
    listsWithoutMcpServer: hosts.some(host => host.listsWithoutMcpServer),

    async listConnections(userId, options) {
      const listing = options?.mcpServerOff ? hosts.filter(host => host.listsWithoutMcpServer) : hosts;
      const settled = await Promise.allSettled(listing.map(host => host.listConnections(userId, options)));
      return settled.flatMap((outcome, index) => {
        if (outcome.status === 'fulfilled') return outcome.value;
        Logger.warn(`[MCP] Tool host ${index} failed to list - skipping it`, {
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
        return [];
      });
    },

    async callTool(input) {
      const host = hostFor(input.connectionId);
      if (!host) throw new Error(`No tool host serves connection ${input.connectionId}`);
      return host.callTool(input);
    },
  };
}
