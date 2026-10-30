import { createHash, randomUUID } from 'crypto';
import {
  BadGatewayError,
  ConflictError,
  ForbiddenError,
  MCP_CONNECTION_LIMITS,
  NotFoundError,
  TooManyRequestsError,
  mcpApiKeyHeaderNameProblem,
  isReadOnlyMcpConnectionTool,
  requiresMcpConnectionToolApproval,
  type IMcpConnectionDocument,
  type McpConnectionLastErrorInput,
  type McpConnectionTransport,
} from '@bike4mind/common';
import { cacheRepository, mcpConnectionRepository, type CustomMcpAuditMetadata } from '@bike4mind/database';
import {
  DEFAULT_REMOTE_MCP_LIMITS,
  RemoteMcpAuthFailedError,
  RemoteMcpAuthRequiredError,
  RemoteMcpClient,
  RemoteMcpError,
  RemoteMcpProtocolError,
  validateRemoteMcpUrl,
  type RemoteMcpCallToolResult,
  type RemoteMcpClientConfig,
  type RemoteMcpErrorCode,
  type RemoteMcpLimits,
  type RemoteMcpListToolsResult,
} from '@bike4mind/mcp/remote';
import { describeRemoteMcpError } from './describeRemoteMcpError';

export { describeRemoteMcpError };
import { cleanMcpToolText } from '@bike4mind/server-utils/mcpConnections/toolDiscovery';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { Resource } from 'sst';
import { IntegrationAuditLogger } from '@bike4mind/server-utils/integrations/integrationAuditLogger';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import {
  CircuitBreakerError,
  flushBreakerMetrics,
  getBreaker,
  type OperationType,
} from '@bike4mind/server-utils/services/mcpCircuitBreakers';
import { recordCircuitBreakerRejection } from '@bike4mind/server-utils/utils/cloudwatch';
import { resolveMcpTenantKey } from '@bike4mind/server-utils/utils/mcpTenantKey';
import {
  evaluateConnectionPolicy,
  isSelfHost,
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

/** Policy or the tool settings require approval, and this call was not approved. */
export class CustomMcpApprovalRequiredError extends ForbiddenError {
  constructor() {
    super('This tool call requires approval', { code: 'approval_required' });
    this.name = 'CustomMcpApprovalRequiredError';
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
  /** The user or agent gate approved this call; required by policy and the saved tool approval mode. */
  approved?: boolean;
}

export type InvokeRemoteMcpRequest = InvokeRemoteMcpListTools | InvokeRemoteMcpCallTool;

export interface InvokeRemoteMcpOptions {
  runner?: RemoteMcpRunner;
  /** Reuse a context the caller already resolved for this request. */
  context?: CustomMcpContext;
  /** Called with the stored API key the run will use, so a caller can guard its own write against rotation. */
  onApiKeyLoaded?: (valueEnc: string | null) => void;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * On a hosted deployment a blocked address reads exactly like a server that is not answering, so
 * the error cannot be used to map which internal names resolve. The audit keeps the real code.
 * Self-host keeps the distinct reason: its admin chose the networks and needs to see why.
 */
function userFacingRemoteMcpError(error: RemoteMcpError): RemoteMcpError {
  if (error.code !== 'ssrf_blocked' || isSelfHost()) return error;
  return new RemoteMcpProtocolError('The server did not respond as an MCP server');
}

/**
 * The RFC 9728 metadata URL from a 401, kept only when it passes the connector URL rules over https
 * on the connection's own host or registrable domain; anything else is dropped rather than stored
 * for the OAuth flow to fetch.
 */
function trustedResourceMetadataUrl(
  raw: string | undefined,
  connection: IMcpConnectionDocument,
  network: RemoteMcpNetworkOptions
): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = validateRemoteMcpUrl(raw, network);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.hostname === connection.urlHost) return url.toString();
  const domain = registrableDomain(url.hostname, { allowPrivateDomains: true });
  return domain && domain === registrableDomain(connection.urlHost, { allowPrivateDomains: true })
    ? url.toString()
    : undefined;
}

/** Each requested limit may only tighten the default, never loosen it. */
function clampLimits(requested: Partial<RemoteMcpLimits> | undefined): Partial<RemoteMcpLimits> | undefined {
  if (!requested) return undefined;
  const clamped: Partial<RemoteMcpLimits> = {};
  for (const key of Object.keys(DEFAULT_REMOTE_MCP_LIMITS) as (keyof RemoteMcpLimits)[]) {
    const value = requested[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      clamped[key] = Math.min(value, DEFAULT_REMOTE_MCP_LIMITS[key]);
    }
  }
  return clamped;
}

/** A server-supplied scope is shown to the user and later sent to the authorization server. */
function cleanScope(scope: string | undefined): string | undefined {
  return typeof scope === 'string'
    ? cleanMcpToolText(scope, MCP_CONNECTION_LIMITS.requiredScopeLength) || undefined
    : undefined;
}

/**
 * Stores what a failure means for the connection. Auth failures always move the status (they need
 * the user). Anything else moves it on a listTools (probe, discovery, refresh) or when it is about
 * the address itself; a transient call failure leaves a connected connection connected and is the
 * breaker's business, so one timeout does not pull the connector out of chat. What is stored is
 * the user-facing form of the error (`shown`); the decision is made on the real one.
 */
async function recordFailure(
  connection: IMcpConnectionDocument,
  action: RemoteMcpAction,
  error: RemoteMcpError,
  shown: RemoteMcpError,
  network: RemoteMcpNetworkOptions
): Promise<void> {
  const message = describeRemoteMcpError(shown, connection.auth.kind);
  const setFailureStatus = (status: 'error' | 'needs_reconnect', failure: McpConnectionLastErrorInput) => {
    if (connection.auth.kind !== 'api_key') {
      return mcpConnectionRepository.setStatus(connection.id, status, failure);
    }
    return mcpConnectionRepository.setStatus(connection.id, status, failure, connection.auth.apiKey?.valueEnc ?? null);
  };
  if (error instanceof RemoteMcpAuthRequiredError) {
    if (connection.auth.kind === 'none') {
      await mcpConnectionRepository.setPendingAuth(connection.id, {
        resourceMetadataUrl: trustedResourceMetadataUrl(error.resourceMetadataUrl, connection, network),
        scope: cleanScope(error.scope),
        message,
      });
      return;
    }
    await setFailureStatus('needs_reconnect', {
      code: 'auth_required',
      message,
      requiredScope: cleanScope(error.scope),
    });
    return;
  }
  if (error instanceof RemoteMcpAuthFailedError) {
    if (error.scope) {
      await setFailureStatus('needs_reconnect', {
        code: 'insufficient_scope',
        message: 'The server needs more access than was granted',
        requiredScope: cleanScope(error.scope),
      });
      return;
    }
    await setFailureStatus(connection.auth.kind === 'none' ? 'error' : 'needs_reconnect', {
      code: 'auth_failed',
      message,
    });
    return;
  }
  if (action === 'listTools' || error.code === 'ssrf_blocked' || error.code === 'invalid_url') {
    await setFailureStatus('error', { code: shown.code, message });
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
  const tool = connection.tools.find(tool => tool.name === request.toolName);
  return tool && isReadOnlyMcpConnectionTool(tool) ? 'read' : 'write';
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
  if (connection.auth.kind === 'api_key') options.onApiKeyLoaded?.(connection.auth.apiKey?.valueEnc ?? null);

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
    const reason = context.disabledReason ?? 'disabled';
    audit.failure('policy_blocked', { policyVerdict: reason });
    throw new CustomMcpPolicyBlockedError('Custom MCP connectors are disabled', reason);
  }
  const verdict = evaluateConnectionPolicy(context, {
    urlHost: connection.urlHost,
    authKind: connection.auth.kind,
    url: connection.displayUrl,
  });
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
  if (request.action === 'callTool') {
    const tool = connection.tools.find(candidate => candidate.name === request.toolName);
    if (!tool || !tool.enabled || tool.state !== 'active') {
      audit.failure('tool_not_approved');
      throw new ConflictError('This tool has not been reviewed and enabled', { code: 'tool_not_approved' });
    }
    if (!isReadOnlyMcpConnectionTool(tool) && context.policies.some(policy => !policy.allowWriteTools)) {
      audit.failure('policy_blocked', { policyVerdict: 'write_tools_not_allowed' });
      throw new CustomMcpPolicyBlockedError(
        'Your organization allows only read-only tools from custom connectors',
        'write_tools_not_allowed'
      );
    }
    if (
      request.approved !== true &&
      requiresMcpConnectionToolApproval(
        tool,
        context.policies.some(policy => policy.requireApprovalForAll)
      )
    ) {
      audit.failure('approval_required');
      throw new CustomMcpApprovalRequiredError();
    }
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
      limits: clampLimits(request.limits),
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
      // Awaited: the throw ends the invocation, and a frozen Lambda loses a pending emit.
      await recordCircuitBreakerRejection('custom_mcp');
      throw new CustomMcpUnavailableError(connection.displayName);
    }
    if (error instanceof RemoteMcpError) {
      audit.failure(error.code);
      const shown = userFacingRemoteMcpError(error);
      await recordFailure(connection, request.action, error, shown, context.network);
      throw shown;
    }
    audit.failure('internal_error');
    throw error;
  } finally {
    await flushBreakerMetrics();
  }
}
