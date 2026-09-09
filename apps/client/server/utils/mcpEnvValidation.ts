import { findForbiddenMcpEnvKeys, type McpEnvVariable } from '@bike4mind/mcp';
import { BadRequestError } from '@server/utils/errors';

/**
 * Reject an inbound MCP server write whose `envVariables` name a runtime-controlling key.
 *
 * The shape of the body is gated upstream by `mcpServerValidators.ts`; this is the semantic
 * half. These variables are stored and later become the environment of a spawned Node child,
 * so a key such as NODE_OPTIONS is not configuration - the runtime applies it before any server
 * code loads. `buildMcpChildEnv` is the boundary that actually enforces this and it withholds
 * such keys whatever is stored; rejecting here as well is what turns a silently withheld
 * variable into an error the user can see and correct.
 *
 * @throws BadRequestError naming the offending keys, never their values.
 */
export function assertNoForbiddenMcpEnvKeys(envVariables: readonly McpEnvVariable[]): void {
  const forbidden = findForbiddenMcpEnvKeys(envVariables);
  if (forbidden.length === 0) {
    return;
  }

  throw new BadRequestError('Rejected MCP environment variable', {
    reason: `These keys configure the server runtime rather than the integration and cannot be set: ${forbidden.join(', ')}`,
  });
}
