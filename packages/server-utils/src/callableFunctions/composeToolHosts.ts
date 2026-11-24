import type { CustomMcpToolHost } from '@bike4mind/services/llm';

/**
 * One host over several: listings concatenate in argument order, which is the order the per-turn tool cap keeps
 * them in, and a call goes to the host that owns its connection id, else to the first host that names none.
 */
export function composeToolHosts(...hosts: CustomMcpToolHost[]): CustomMcpToolHost {
  const hostFor = (connectionId: string) =>
    hosts.find(host => host.ownsConnection?.(connectionId)) ?? hosts.find(host => !host.ownsConnection);

  return {
    async listConnections(userId, options) {
      const listings = await Promise.all(hosts.map(host => host.listConnections(userId, options)));
      return listings.flat();
    },

    async callTool(input) {
      const host = hostFor(input.connectionId);
      if (!host) throw new Error(`No tool host serves connection ${input.connectionId}`);
      return host.callTool(input);
    },
  };
}
