/**
 * Single import surface for the Agent Client Protocol SDK.
 *
 * Centralizing the dependency here means a package rename or major-version
 * migration is a one-file change, and it gives the rest of the ACP module a
 * `schema.*` type namespace (the SDK exports its generated types flat).
 */
export {
  agent,
  methods,
  ndJsonStream,
  RequestError,
  PROTOCOL_VERSION,
  type AgentContext as AcpClientContext,
  type AgentConnection,
} from '@agentclientprotocol/sdk';

export * as schema from '@agentclientprotocol/sdk';
