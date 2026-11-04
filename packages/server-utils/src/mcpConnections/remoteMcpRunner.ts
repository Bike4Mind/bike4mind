import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { McpConnectionTransport } from '@bike4mind/common';
import {
  RemoteMcpAuthFailedError,
  RemoteMcpAuthRequiredError,
  RemoteMcpClient,
  RemoteMcpError,
  RemoteMcpInvalidUrlError,
  RemoteMcpProtocolError,
  RemoteMcpSizeCapError,
  RemoteMcpSsrfBlockedError,
  RemoteMcpTimeoutError,
  RemoteMcpUpstreamError,
  type RemoteMcpCallToolResult,
  type RemoteMcpClientConfig,
  type RemoteMcpErrorCode,
  type RemoteMcpLimits,
  type RemoteMcpListToolsResult,
  type RemoteMcpUrlRejection,
} from '@bike4mind/mcp/remote';

/**
 * The pure half of the custom remote MCP path: one operation against a user-supplied server, with
 * no DB, Config or secrets. Shared by the app tier (which dispatches) and the `remoteMcpHandler`
 * Lambda (which runs it outside the VPC), so neither imports the other.
 */

/** Network options handed to `validateRemoteMcpUrl` and `RemoteMcpClient` (`@bike4mind/mcp/remote`). */
export interface RemoteMcpNetworkOptions {
  ownHosts: string[];
  /** Self-host only, from `customMcpAllowPrivateNetworks`. */
  allowPrivateCidrs?: string[];
  allowHttp?: boolean;
}

export type RemoteMcpAction = 'listTools' | 'callTool';

/**
 * Everything one remote operation needs, already decrypted. Serializable on purpose: it is the
 * payload the hosted `remoteMcpHandler` Lambda receives, so it carries no ids or DB handles.
 */
export interface RemoteMcpRunPayload {
  url: string;
  transport: McpConnectionTransport;
  headers: Record<string, string>;
  action: RemoteMcpAction;
  toolName?: string;
  args?: Record<string, unknown>;
  limits?: Partial<RemoteMcpLimits>;
  network: RemoteMcpNetworkOptions;
}

export type RemoteMcpRunResult =
  { action: 'listTools'; result: RemoteMcpListToolsResult } | { action: 'callTool'; result: RemoteMcpCallToolResult };

export type RemoteMcpRunner = (payload: RemoteMcpRunPayload) => Promise<RemoteMcpRunResult>;

/** Builds the runner over a client factory; tests pass one that reaches the loopback fixture. */
export function createInProcessRemoteMcpRunner(
  createClient: (config: RemoteMcpClientConfig) => RemoteMcpClient = config => new RemoteMcpClient(config)
): RemoteMcpRunner {
  return async payload => {
    const client = createClient({
      url: payload.url,
      transport: payload.transport,
      headers: payload.headers,
      limits: payload.limits,
      ...payload.network,
    });
    if (payload.action === 'listTools') return { action: 'listTools', result: await client.listTools() };
    if (!payload.toolName) throw new Error('callTool needs a toolName');
    return { action: 'callTool', result: await client.callTool(payload.toolName, payload.args ?? {}) };
  };
}

/** A `RemoteMcpError` as plain data: its class is rebuilt from `code`, never from a name sent over the wire. */
export interface SerializedRemoteMcpError {
  code: RemoteMcpErrorCode;
  message: string;
  status?: number;
  reason?: RemoteMcpUrlRejection;
  scope?: string;
  resourceMetadataUrl?: string;
  wwwAuthenticate?: string;
}

const REMOTE_MCP_ERROR_CODES: ReadonlySet<string> = new Set<RemoteMcpErrorCode>([
  'invalid_url',
  'ssrf_blocked',
  'timeout',
  'auth_required',
  'auth_failed',
  'protocol',
  'size_cap',
  'upstream_5xx',
]);

export function serializeRemoteMcpError(error: RemoteMcpError): SerializedRemoteMcpError {
  const serialized: SerializedRemoteMcpError = { code: error.code, message: error.message };
  if (error instanceof RemoteMcpUpstreamError) serialized.status = error.status;
  if (error instanceof RemoteMcpInvalidUrlError) serialized.reason = error.reason;
  if (error instanceof RemoteMcpAuthFailedError) serialized.scope = error.scope;
  if (error instanceof RemoteMcpAuthRequiredError) {
    serialized.scope = error.scope;
    serialized.resourceMetadataUrl = error.resourceMetadataUrl;
    serialized.wwwAuthenticate = error.wwwAuthenticate;
  }
  return serialized;
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Rebuilds the same subclass `serializeRemoteMcpError` was given; throws on anything it does not recognise. */
export function deserializeRemoteMcpError(raw: unknown): RemoteMcpError {
  if (typeof raw !== 'object' || raw === null) throw new Error('Not a serialized RemoteMcpError');
  const s = raw as Record<string, unknown>;
  const code = s.code;
  const message = typeof s.message === 'string' ? s.message : '';
  if (typeof code !== 'string' || !REMOTE_MCP_ERROR_CODES.has(code)) throw new Error('Unknown RemoteMcpError code');
  switch (code as RemoteMcpErrorCode) {
    case 'invalid_url':
      return new RemoteMcpInvalidUrlError((optionalString(s.reason) ?? 'malformed') as RemoteMcpUrlRejection, message);
    case 'ssrf_blocked':
      return new RemoteMcpSsrfBlockedError(message);
    case 'timeout':
      return new RemoteMcpTimeoutError(message);
    case 'auth_required':
      return new RemoteMcpAuthRequiredError({
        resourceMetadataUrl: optionalString(s.resourceMetadataUrl),
        scope: optionalString(s.scope),
        wwwAuthenticate: optionalString(s.wwwAuthenticate),
      });
    case 'auth_failed':
      return new RemoteMcpAuthFailedError(message, optionalString(s.scope));
    case 'protocol':
      return new RemoteMcpProtocolError(message);
    case 'size_cap':
      return new RemoteMcpSizeCapError(message);
    case 'upstream_5xx':
      return new RemoteMcpUpstreamError(typeof s.status === 'number' ? s.status : 502);
  }
}

/** What the `remoteMcpHandler` Lambda returns: a typed failure is a value, so its class survives the hop. */
export type RemoteMcpLambdaResponse =
  { ok: true; run: RemoteMcpRunResult } | { ok: false; error: SerializedRemoteMcpError };

/**
 * The Lambda side: a typed failure is returned as a value so the caller rebuilds its class; any
 * other error propagates and surfaces as a FunctionError.
 */
export async function runForLambda(
  runner: RemoteMcpRunner,
  payload: RemoteMcpRunPayload
): Promise<RemoteMcpLambdaResponse> {
  try {
    return { ok: true, run: await runner(payload) };
  } catch (error) {
    if (error instanceof RemoteMcpError) return { ok: false, error: serializeRemoteMcpError(error) };
    throw error;
  }
}

const FAILED_MESSAGE = 'Remote MCP handler invocation failed';

/**
 * Runs the operation in the `remoteMcpHandler` Lambda (RequestResponse). Any failure other than a
 * typed `ok:false` body is a plain Error with fixed text: the Lambda's error payload can carry
 * server-influenced text, so it is neither reflected nor used to pick a code path.
 */
export function createLambdaRemoteMcpRunner(
  functionName: string,
  send: (command: InvokeCommand) => Promise<{ FunctionError?: string; Payload?: Uint8Array }> = command =>
    new LambdaClient({}).send(command)
): RemoteMcpRunner {
  // The cause is kept for operators (error name only, never payload or body); the message stays fixed.
  const failed = (cause?: unknown) => new Error(FAILED_MESSAGE, { cause });
  return async payload => {
    let reply: { FunctionError?: string; Payload?: Uint8Array };
    try {
      reply = await send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(payload)),
        })
      );
    } catch (error) {
      throw failed(error instanceof Error ? error.name : 'unknown');
    }
    if (reply.FunctionError) throw failed(`FunctionError: ${reply.FunctionError}`);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(reply.Payload as Uint8Array).toString('utf8'));
    } catch (error) {
      // A missing Payload lands here too (Buffer.from throws a TypeError).
      throw failed(error instanceof Error ? error.name : 'unknown');
    }
    const response = body as Partial<RemoteMcpLambdaResponse> | null;
    if (response?.ok === false) {
      let error: RemoteMcpError;
      try {
        error = deserializeRemoteMcpError(response.error);
      } catch {
        throw failed();
      }
      throw error;
    }
    if (response?.ok !== true || response.run?.action !== payload.action) throw failed();
    return response.run;
  };
}
