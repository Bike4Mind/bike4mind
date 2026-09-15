/**
 * Wires the ACP agent-side request/notification handlers to an AcpServer.
 *
 * Extracted from the command entry point so the same handler graph can be
 * driven in-process by tests (via the SDK's client/agent direct connect) as
 * well as over stdio in production.
 */

import { agent, methods } from './acpSdk.js';
import { AGENT_INFO } from './protocol.js';
import type { AcpServer } from './AcpServer.js';

/**
 * Build the ACP AgentApp. `getServer` is a late-bound accessor because the
 * server needs the connection's abort signal, which only exists after
 * `connect()` - the accessor lets handlers resolve the server on first use.
 */
export function buildAcpApp(getServer: () => AcpServer) {
  return agent({ name: AGENT_INFO.name })
    .onRequest(methods.agent.initialize, ({ params }) => getServer().initialize(params))
    .onRequest(methods.agent.session.new, ({ params }) => getServer().newSession(params))
    .onRequest(methods.agent.session.load, ({ params, client }) => getServer().loadSession(params, client))
    .onRequest(methods.agent.session.prompt, ({ params, client, signal }) => getServer().prompt(params, client, signal))
    .onRequest(methods.agent.session.setMode, ({ params, client }) => getServer().setSessionMode(params, client))
    .onNotification(methods.agent.session.cancel, ({ params }) => getServer().cancel(params));
}
