import {
  createInProcessRemoteMcpRunner,
  runForLambda,
  type RemoteMcpLambdaResponse,
  type RemoteMcpRunPayload,
  type RemoteMcpRunner,
} from '@bike4mind/server-utils/mcpConnections/remoteMcpRunner';

// Lambda entry for remoteMcpHandler (infra/remoteMcp.ts). Runs outside the VPC with no secrets
// linked: the caller sends the already-decrypted request, so this file must stay free of the DB,
// Config and `sst`, and must never log headers or args.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertPayload(event: unknown): asserts event is RemoteMcpRunPayload {
  if (
    !isObject(event) ||
    (event.action !== 'listTools' && event.action !== 'callTool') ||
    typeof event.url !== 'string' ||
    !isObject(event.headers) ||
    !isObject(event.network)
  ) {
    throw new Error('Invalid remote MCP payload');
  }
}

export function createHandler(runner: RemoteMcpRunner = createInProcessRemoteMcpRunner()) {
  return async (event: unknown): Promise<RemoteMcpLambdaResponse> => {
    assertPayload(event);
    return runForLambda(runner, event);
  };
}

export const handler = createHandler();
