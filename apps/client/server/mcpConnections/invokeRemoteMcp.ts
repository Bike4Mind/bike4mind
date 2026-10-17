import { createHash, randomUUID } from 'crypto';
import {
  BadGatewayError,
  ConflictError,
  ForbiddenError,
  MCP_CONNECTION_LIMITS,
  NotFoundError,
  TooManyRequestsError,
  mcpApiKeyHeaderNameProblem,
  type IMcpConnectionDocument,
  type McpConnectionTransport,
} from '@bike4mind/common';
import { cacheRepository, mcpConnectionRepository, type CustomMcpAuditMetadata } from '@bike4mind/database';
import {
  RemoteMcpAuthFailedError,
  RemoteMcpAuthRequiredError,
  RemoteMcpClient,
  RemoteMcpError,
  RemoteMcpUpstreamError,
  type RemoteMcpCallToolResult,
  type RemoteMcpClientConfig,
  type RemoteMcpErrorCode,
  type RemoteMcpLimits,
  type RemoteMcpListToolsResult,
} from '@bike4mind/mcp/remote';
import { Resource } from 'sst';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { decryptToken } from '@server/security/tokenEncryption';
import { CircuitBreakerError, getBreaker, type OperationType } from '@server/services/mcpCircuitBreakers';
import { recordCircuitBreakerRejection } from '@server/utils/cloudwatch';
import { resolveMcpTenantKey } from '@server/utils/mcpTenantKey';
import {
  evaluateConnectionPolicy,
  resolveCustomMcpContext,
  type CustomMcpContext,
  type RemoteMcpNetworkOptions,
} from './customMcpAccess';

/**
 * The one way the app talks to a custom remote MCP server (design #4845 sections 5, 8, 11, 12).
 *
 * Lives in apps/client/server rather than packages/server-utils because everything it composes
 * (the per-tenant breakers, the audit logger, token decryption bound to the app Config, CloudWatch)
 * still lives here; apps/workers reaches it through the `@server/*` alias like invokeMcpHandler.
 */

export type RemoteMcpAction = 'listTools' | 'callTool';

/**
 * Everything one remote operation needs, already decrypted. Serializable on purpose: it is the
 * payload the hosted `remoteMcpHandler` Lambda will receive, so it carries no ids or DB handles.
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

const runInProcess = createInProcessRemoteMcpRunner();

function remoteMcpHandlerName(): string | undefined {
  try {
    // Not in the generated Resource type until the Lambda is linked (infra/remoteMcp.ts).
    return (Resource as unknown as Record<string, { name?: string } | undefined>).remoteMcpHandler?.name;
  } catch {
    return undefined;
  }
}

/**
 * Where a remote operation runs. Only in-process exists so far, which is what self-host keeps.
 * SEAM: the hosted `remoteMcpHandler` Lambda (outside the VPC, no links) is selected here when its
 * Resource is linked, mirroring invokeMcpHandler, and like it must never fall back to in-process
 * after a failed invoke. Until that branch exists, a linked Lambda fails closed rather than calling
 * user-supplied hosts from inside the VPC.
 */
export function resolveRemoteMcpRunner(): RemoteMcpRunner {
  if (remoteMcpHandlerName()) {
    throw new Error('remoteMcpHandler is linked but its dispatcher branch is not implemented');
  }
  return runInProcess;
}

export const REMOTE_MCP_CALLS_PER_MINUTE = 60;
const CALL_WINDOW_MS = 60_000;

/** Failures that say the server is down or broken, as opposed to this request or credential. */
const OUTAGE_CODES: ReadonlySet<RemoteMcpErrorCode> = new Set(['timeout', 'upstream_5xx', 'protocol']);

/** A policy or kill switch refused the call. */
export class CustomMcpPolicyBlockedError extends ForbiddenError {
  constructor(message: string, reason: string) {
    super(message, { code: 'policy_blocked', reason });
    this.name = 'CustomMcpPolicyBlockedError';
  }
}

/** The per-(user, connection) breaker is open after repeated outages. */
export class CustomMcpUnavailableError extends BadGatewayError {
  constructor(displayName: string) {
    super(`${displayName} is temporarily unavailable after repeated failures; it will be retried shortly`, {
      code: 'circuit_open',
    });
    this.name = 'CustomMcpUnavailableError';
  }
}

interface InvokeRemoteMcpBase {
  connectionId: string;
  /** The connection owner; the connection is loaded owner-scoped, so another user's id is a 404. */
  userId: string;
  limits?: Partial<RemoteMcpLimits>;
}

export interface InvokeRemoteMcpListTools extends InvokeRemoteMcpBase {
  action: 'listTools';
}

export interface InvokeRemoteMcpCallTool extends InvokeRemoteMcpBase {
  action: 'callTool';
  toolName: string;
  args?: Record<string, unknown>;
}

export type InvokeRemoteMcpRequest = InvokeRemoteMcpListTools | InvokeRemoteMcpCallTool;

export interface InvokeRemoteMcpOptions {
  runner?: RemoteMcpRunner;
  /** Reuse a context the caller already resolved for this request. */
  context?: CustomMcpContext;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Short, fixed text per failure: the server's own error text is never reflected back. */
export function describeRemoteMcpError(
  error: RemoteMcpError,
  authKind: IMcpConnectionDocument['auth']['kind']
): string {
  switch (error.code) {
    case 'invalid_url':
      return error.message;
    case 'ssrf_blocked':
      return 'The server address resolves to a private or blocked network';
    case 'timeout':
      return 'The server did not answer in time';
    case 'auth_required':
      return authKind === 'api_key' ? 'The server rejected the API key' : 'The server requires sign-in';
    case 'auth_failed':
      return 'The server refused the credentials';
    case 'protocol':
      return 'The server did not respond as an MCP server';
    case 'size_cap':
      return 'The server response was too large';
    case 'upstream_5xx':
      return error instanceof RemoteMcpUpstreamError
        ? `The server returned an error (HTTP ${error.status})`
        : 'The server returned an error';
  }
}

function truncateScope(scope: string | undefined): string | undefined {
  return scope?.slice(0, MCP_CONNECTION_LIMITS.requiredScopeLength);
}

/**
 * Stores what a failure means for the connection. Auth failures always move the status (they need
 * the user). Anything else moves it on a listTools (probe, discovery, refresh) or when it is about
 * the address itself; a transient call failure leaves a connected connection connected and is the
 * breaker's business, so one timeout does not pull the connector out of chat.
 */
async function recordFailure(
  connection: IMcpConnectionDocument,
  action: RemoteMcpAction,
  error: RemoteMcpError
): Promise<void> {
  const message = describeRemoteMcpError(error, connection.auth.kind);
  if (error instanceof RemoteMcpAuthRequiredError) {
    if (connection.auth.kind === 'none') {
      await mcpConnectionRepository.setPendingAuth(connection.id, {
        resourceMetadataUrl: error.resourceMetadataUrl,
        scope: error.scope,
        message,
      });
      return;
    }
    await mcpConnectionRepository.setStatus(connection.id, 'needs_reconnect', {
      code: 'auth_required',
      message,
      requiredScope: truncateScope(error.scope),
    });
    return;
  }
  if (error instanceof RemoteMcpAuthFailedError) {
    if (error.scope) {
      await mcpConnectionRepository.setStatus(connection.id, 'needs_reconnect', {
        code: 'insufficient_scope',
        message: 'The server needs more access than was granted',
        requiredScope: truncateScope(error.scope),
      });
      return;
    }
    await mcpConnectionRepository.setStatus(
      connection.id,
      connection.auth.kind === 'none' ? 'error' : 'needs_reconnect',
      {
        code: 'auth_failed',
        message,
      }
    );
    return;
  }
  if (action === 'listTools' || error.code === 'ssrf_blocked' || error.code === 'invalid_url') {
    await mcpConnectionRepository.setStatus(connection.id, 'error', { code: error.code, message });
  }
}

/**
 * The credential headers for a connection, decrypted here in the app tier. Header-name policy is
 * re-checked on every call so a row written before a rule tightened cannot smuggle a header.
 */
function buildAuthHeaders(connection: IMcpConnectionDocument): Record<string, string> {
  const { auth } = connection;
  if (auth.kind === 'none') return {};
  if (auth.kind === 'api_key') {
    const apiKey = auth.apiKey;
    const value = decryptToken(apiKey?.valueEnc);
    if (!apiKey || !value || mcpApiKeyHeaderNameProblem(apiKey.headerName)) {
      throw new RemoteMcpAuthRequiredError({});
    }
    return { [apiKey.headerName]: apiKey.scheme === 'raw' ? value : `Bearer ${value}` };
  }
  // SEAM (OAuth): RemoteMcpTokenManager.getAccessToken(connection) with the leased refresh, then
  // `Authorization: Bearer <token>`, one forced refresh and retry on a 401. Until then an OAuth
  // connection reads as needing sign-in.
  throw new RemoteMcpAuthRequiredError({});
}

function operationTypeFor(connection: IMcpConnectionDocument, request: InvokeRemoteMcpRequest): OperationType {
  if (request.action === 'listTools') return 'read';
  const annotations = connection.tools.find(tool => tool.name === request.toolName)?.annotations;
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true ? 'read' : 'write';
}

function transportFor(connection: IMcpConnectionDocument, action: RemoteMcpAction): McpConnectionTransport {
  // A call reuses the transport discovery detected; a listTools re-detects, so a server that moved
  // from legacy SSE to Streamable HTTP is picked up on the next refresh.
  if (action === 'callTool' && connection.transport === 'auto' && connection.detectedTransport) {
    return connection.detectedTransport;
  }
  return connection.transport;
}

/** Best effort: a failed bookkeeping write must not turn a tool call that ran into a failure. */
async function recordCallBookkeeping(
  connection: IMcpConnectionDocument,
  detectedTransport: RemoteMcpCallToolResult['detectedTransport']
): Promise<void> {
  try {
    await mcpConnectionRepository.markUsed(connection.id);
    if (detectedTransport !== connection.detectedTransport) {
      await mcpConnectionRepository.update({ id: connection.id, detectedTransport });
    }
  } catch (error) {
    console.warn(`[invokeRemoteMcp] Could not record use of connection ${connection.id}:`, error);
  }
}

export function invokeRemoteMcp(
  request: InvokeRemoteMcpListTools,
  options?: InvokeRemoteMcpOptions
): Promise<RemoteMcpListToolsResult>;
export function invokeRemoteMcp(
  request: InvokeRemoteMcpCallTool,
  options?: InvokeRemoteMcpOptions
): Promise<RemoteMcpCallToolResult>;
/**
 * Runs one listTools or callTool against a user's connection: owner-scoped load with credentials,
 * the gate and policy re-checked, the per-connection rate limit, the per-(user, connection) breaker,
 * and an audit entry carrying sizes and hashes only. Persists what a failure means for the
 * connection; persists `lastUsedAt` and a newly detected transport after a call.
 */
export async function invokeRemoteMcp(
  request: InvokeRemoteMcpRequest,
  options: InvokeRemoteMcpOptions = {}
): Promise<RemoteMcpListToolsResult | RemoteMcpCallToolResult> {
  const owner = { ownerType: 'user' as const, ownerKey: request.userId };
  const connection = await mcpConnectionRepository.findByIdWithCredentials(request.connectionId, owner);
  if (!connection) throw new NotFoundError('Connection not found');

  const args = request.action === 'callTool' ? (request.args ?? {}) : undefined;
  const serializedArgs = args ? JSON.stringify(args) : undefined;
  const metadata: CustomMcpAuditMetadata = {
    connectionId: connection.id,
    host: connection.urlHost,
    slug: connection.slug,
    ...(request.action === 'callTool' ? { toolName: request.toolName } : {}),
    ...(serializedArgs !== undefined
      ? { argsSha256: sha256(serializedArgs), argsBytes: Buffer.byteLength(serializedArgs, 'utf8') }
      : {}),
  };
  const audit = IntegrationAuditLogger.create({
    entityType: 'mcp_connection',
    integrationName: 'custom_mcp',
    action: request.action === 'callTool' ? 'tool_called' : 'tools_listed',
    requestId: randomUUID().split('-')[0]!,
    userId: request.userId,
    metadata: { ...metadata },
  });

  const context = options.context ?? (await resolveCustomMcpContext(request.userId));
  if (!context.enabled) {
    audit.failure('policy_blocked', { policyVerdict: 'disabled' });
    throw new CustomMcpPolicyBlockedError('Custom MCP connectors are disabled', 'disabled');
  }
  const verdict = evaluateConnectionPolicy(context, { urlHost: connection.urlHost, authKind: connection.auth.kind });
  if (!verdict.allowed) {
    audit.failure('policy_blocked', { policyVerdict: verdict.reason });
    throw new CustomMcpPolicyBlockedError(verdict.message, verdict.reason);
  }
  if (request.action === 'callTool' && (!connection.enabled || connection.status !== 'connected')) {
    audit.failure('connection_not_ready');
    throw new ConflictError('This connection is not ready to call tools', {
      code: 'connection_not_ready',
      status: connection.status,
      enabled: connection.enabled,
    });
  }

  const { success } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
    `custom-mcp-calls:${request.userId}:${connection.id}`,
    REMOTE_MCP_CALLS_PER_MINUTE,
    CALL_WINDOW_MS
  );
  if (!success) {
    audit.rateLimited();
    throw new TooManyRequestsError(`At most ${REMOTE_MCP_CALLS_PER_MINUTE} calls per minute per connection`);
  }

  const breaker = getBreaker(
    resolveMcpTenantKey(request.userId),
    `custom:${connection.id}`,
    operationTypeFor(connection, request)
  );
  try {
    const payload: RemoteMcpRunPayload = {
      url: decryptToken(connection.urlEnc) ?? '',
      transport: transportFor(connection, request.action),
      headers: buildAuthHeaders(connection),
      action: request.action,
      ...(request.action === 'callTool' ? { toolName: request.toolName, args } : {}),
      limits: request.limits,
      network: context.network,
    };
    const runner = options.runner ?? resolveRemoteMcpRunner();
    // Only outages count against the breaker: a refused key or a blocked address says nothing
    // about whether the server is up, so those come back as values and are rethrown below.
    const outcome = await breaker.execute(async () => {
      try {
        return { ok: true as const, run: await runner(payload) };
      } catch (error) {
        if (error instanceof RemoteMcpError && !OUTAGE_CODES.has(error.code)) return { ok: false as const, error };
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;

    const { run } = outcome;
    if (run.action === 'callTool') {
      await recordCallBookkeeping(connection, run.result.detectedTransport);
      audit.success({ resultBytes: Buffer.byteLength(JSON.stringify(run.result.result), 'utf8') });
    } else {
      audit.success({ toolCount: run.result.tools.length, droppedCount: run.result.dropped.length });
    }
    return run.result;
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      audit.failure('circuit_open');
      recordCircuitBreakerRejection('custom_mcp').catch(metricError => {
        console.error('[invokeRemoteMcp] Failed to record the breaker rejection metric:', metricError);
      });
      throw new CustomMcpUnavailableError(connection.displayName);
    }
    if (error instanceof RemoteMcpError) {
      audit.failure(error.code);
      await recordFailure(connection, request.action, error);
      throw error;
    }
    audit.failure('internal_error');
    throw error;
  }
}
