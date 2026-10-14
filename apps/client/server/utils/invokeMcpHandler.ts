import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Buffer } from 'node:buffer';
import { handler as localMcpHandler } from '@server/utils/mcpCall';
import { isMcpServerAvailable } from '@server/services/integrationCircuitBreaker';
import { getBreaker, classifyOperation, CircuitBreakerError } from '@server/services/mcpCircuitBreakers';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import type { IntegrationAuditIntegrationName } from '@bike4mind/database';
import { INTEGRATION_AUDIT_INTEGRATION_NAMES } from '@bike4mind/database';
import { recordCircuitBreakerRejection } from '@server/utils/cloudwatch';
import { persistRateLimitEvents, throttleIfNearRateLimit } from '@server/utils/mcpRateLimitSnapshots';
import { resolveMcpTenantKey } from '@server/utils/mcpTenantKey';
import { randomUUID } from 'crypto';
import { Resource } from 'sst';

// Shared const so the auditable set can never drift from the model's enum.
const AUDITABLE_INTEGRATIONS = new Set<string>(INTEGRATION_AUDIT_INTEGRATION_NAMES);

/**
 * The local MCP handler spawns the MCP server as a child of whatever runtime calls it, so
 * "run locally" has to mean a developer machine or a deployment with no mcpHandler Lambda at
 * all - never a hosted runtime that holds platform credentials.
 *
 * There is deliberately no fallback from a failed Lambda invoke to the local handler. The old
 * one selected itself by substring-matching the error text for things like 'etimedout', and in
 * the deployed case that text came back in the Lambda's own error payload - which an MCP server
 * writes. A remote error message could therefore choose to have the MCP child spawned next to
 * the credentials. A broken invoke now surfaces as an error instead.
 */
const shouldRunLocally = () => process.env.IS_LOCAL === 'true' || process.env.NODE_ENV === 'development';

function decodePayload(payload: Uint8Array | undefined): string {
  if (!payload) {
    return '';
  }

  return Buffer.from(payload).toString('utf8');
}

async function extractAndPersistRateLimitEvents(
  result: Record<string, unknown> | undefined | null,
  tenantKey: string
): Promise<void> {
  if (!result || !result._rateLimitEvents) {
    return;
  }

  const events = result._rateLimitEvents;
  delete result._rateLimitEvents;

  if (!Array.isArray(events)) return;

  await persistRateLimitEvents(events, tenantKey);
}

export async function invokeMcpHandler<T = unknown>(payload: Parameters<typeof localMcpHandler>[0]): Promise<T> {
  // Circuit breaker: short-circuit if the integration is known to be unhealthy
  if (payload?.name) {
    const { available, reason } = await isMcpServerAvailable(payload.name);
    if (!available) {
      throw new Error(reason ?? `${payload.name} integration is currently unavailable. Retry later.`);
    }
  }

  const { action, name, toolName, id: mcpServerId, userId } = payload;
  const tenantKey = resolveMcpTenantKey(userId);

  // Adaptive throttling: delay if this tenant is near its rate limit
  await throttleIfNearRateLimit(tenantKey, name, action);

  let auditLogger: IntegrationAuditLogger | null = null;
  try {
    if (action === 'callTool' && AUDITABLE_INTEGRATIONS.has(name)) {
      auditLogger = IntegrationAuditLogger.create({
        entityType: 'mcp_tool',
        integrationName: name as IntegrationAuditIntegrationName,
        action: `mcp_callTool_${toolName || 'unknown'}`,
        requestId: randomUUID().split('-')[0],
        userId,
        metadata: { mcpServerId, toolName },
      });
    }
  } catch (auditCreateError) {
    console.error('[invokeMcpHandler] Failed to create audit logger:', auditCreateError);
  }

  // In-memory circuit breaker: fail-fast when repeated failures detected
  const opType = classifyOperation(action, toolName);
  const breaker = getBreaker(tenantKey, name, opType);

  try {
    const result = await breaker.execute(async () => {
      const mcpName = (() => {
        try {
          return Resource.mcpHandler?.name;
        } catch {
          return undefined;
        }
      })();
      return shouldRunLocally() || !mcpName
        ? ((await localMcpHandler(payload)) as T)
        : await invokeLambda<T>(payload, tenantKey);
    });

    try {
      auditLogger?.success({ toolName, mcpServerName: name });
    } catch (auditError) {
      console.error('[invokeMcpHandler] Audit log failed on success path:', auditError);
    }

    return result;
  } catch (error) {
    // Convert CircuitBreakerError to a user-friendly message
    if (error instanceof CircuitBreakerError) {
      console.warn(`[CircuitBreaker] Rejected call to ${name} (${opType}) — breaker is ${error.state}`);
      recordCircuitBreakerRejection(name).catch(err => {
        console.error(`[CircuitBreaker] Failed to record rejection metric for ${name}:`, err);
      });
      const userError = new Error(
        `${name} integration is temporarily unavailable due to repeated failures. The system will automatically retry shortly.`
      );
      userError.cause = error;
      throw userError;
    }

    try {
      const errorMsg = error instanceof Error ? error.message : '';
      const isConnectionError =
        errorMsg.includes('Connection closed') ||
        errorMsg.includes('-32000') ||
        errorMsg.includes('EPIPE') ||
        errorMsg.includes('ECONNRESET');

      auditLogger?.failure(isConnectionError ? 'connection_error' : 'tool_execution_error', {
        toolName,
        mcpServerName: name,
      });
    } catch (auditError) {
      console.error('[invokeMcpHandler] Audit log failed on error path:', auditError);
    }

    throw error;
  }
}

/**
 * Render a Lambda FunctionError as display text. The payload is authored by the MCP handler and,
 * through it, by the MCP server itself - it is a string to show a user, never a signal that
 * steers control flow here.
 */
function describeFunctionError(functionError: string, raw: string): string {
  if (!raw) {
    return functionError;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const { errorMessage, message } = parsed as Record<string, unknown>;
      if (typeof errorMessage === 'string' && errorMessage) return errorMessage;
      if (typeof message === 'string' && message) return message;
    }
  } catch {
    // Not JSON - fall through and show the raw body alongside the error type.
  }

  return `${functionError}: ${raw}`;
}

// Safe: only called when mcpName is truthy (the Resource.mcpHandler lookup above ensures it is accessible)
async function invokeLambda<T>(payload: Parameters<typeof localMcpHandler>[0], tenantKey: string): Promise<T> {
  const client = new LambdaClient({});
  const command = new InvokeCommand({
    FunctionName: Resource.mcpHandler.name,
    Payload: Buffer.from(JSON.stringify(payload)),
    InvocationType: 'RequestResponse',
  });

  const response = await client.send(command);
  const raw = decodePayload(response.Payload);

  if (response.FunctionError) {
    throw new Error(`MCP handler invocation failed: ${describeFunctionError(response.FunctionError, raw)}`);
  }

  if (!raw) {
    return undefined as T;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse MCP handler response: ${raw}`);
  }

  await extractAndPersistRateLimitEvents(parsed, tenantKey);
  return parsed as T;
}
