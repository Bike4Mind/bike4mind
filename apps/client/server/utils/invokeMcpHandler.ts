import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Buffer } from 'node:buffer';
import { handler as localMcpHandler } from '@server/utils/mcpCall';
import { isMcpServerAvailable } from '@server/services/integrationCircuitBreaker';
import { getBreaker, classifyOperation, CircuitBreakerError } from '@server/services/mcpCircuitBreakers';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import type { IntegrationAuditIntegrationName } from '@bike4mind/database';
import {
  rateLimitSnapshotRepository,
  type IntegrationType,
  INTEGRATION_AUDIT_INTEGRATION_NAMES,
} from '@bike4mind/database';
import { recordRateLimitEvent, recordCircuitBreakerRejection } from '@server/utils/cloudwatch';
import {
  normalizeEndpoint,
  isNearLimit,
  RATE_LIMIT_INTEGRATIONS,
  type RateLimitIntegrationType,
} from '@bike4mind/common';
import { randomUUID } from 'crypto';
import { Resource } from 'sst';

// Shared const so the auditable set can never drift from the model's enum.
const AUDITABLE_INTEGRATIONS = new Set<string>(INTEGRATION_AUDIT_INTEGRATION_NAMES);

const shouldRunLocally = () => process.env.IS_LOCAL === 'true' || process.env.NODE_ENV === 'development';

const needsLocalFallback = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('missing credentials') ||
    message.includes('could not load credentials') ||
    message.includes('credentials provider error') ||
    message.includes('missing region') ||
    message.includes('socket hang up') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('network error')
  );
};

function decodePayload(payload: Uint8Array | undefined): string {
  if (!payload) {
    return '';
  }

  return Buffer.from(payload).toString('utf8');
}

/** Map MCP server names to integration types for rate limit lookups */
const SERVER_TO_INTEGRATIONS: Record<string, IntegrationType[]> = {
  github: ['github'],
  atlassian: ['jira', 'confluence'],
};

/**
 * Pre-call rate limit check: delays requests when an integration is near its rate limit.
 * Queries the latest snapshot and sleeps until resetAt if usage >= 90%.
 */
async function maybeThrottle(serverName: string, action: string): Promise<void> {
  if (action !== 'callTool') return;

  const integrations = SERVER_TO_INTEGRATIONS[serverName];
  if (!integrations) return;

  try {
    for (const integration of integrations) {
      const latest = await rateLimitSnapshotRepository.getLatestByIntegration(integration, 'system');
      if (!latest || latest.usagePercent === null) continue;

      if (latest.usagePercent >= 90 && latest.resetAt && latest.resetAt > new Date()) {
        const delayMs = Math.min(latest.resetAt.getTime() - Date.now(), 10000); // Cap at 10s
        if (delayMs > 0) {
          console.warn(
            `[RateLimit] Throttling ${integration} for ${delayMs}ms (${latest.usagePercent}% usage, resets at ${latest.resetAt.toISOString()})`
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  } catch (err) {
    // Never block calls on rate limit check failures
    console.error('[RateLimit] Pre-call throttle check failed', err);
  }
}

/** Validated shape of a rate limit event extracted from MCP handler responses. */
interface RateLimitEvent {
  integration: RateLimitIntegrationType;
  endpoint: string;
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
  usagePercent: number | null;
  retryAfterMs: number | null;
  wasThrottled: boolean;
}

const VALID_RATE_LIMIT_INTEGRATIONS = new Set<string>(RATE_LIMIT_INTEGRATIONS);

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse and validate a raw event object into a typed RateLimitEvent. Returns null if invalid. */
function parseRateLimitEvent(raw: unknown): RateLimitEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const event = raw as Record<string, unknown>;
  const integration = event.integration;

  if (typeof integration !== 'string' || !VALID_RATE_LIMIT_INTEGRATIONS.has(integration)) {
    console.warn(`[RateLimit] Skipping event with invalid integration: ${String(integration)}`);
    return null;
  }

  return {
    integration: integration as RateLimitIntegrationType,
    endpoint: String(event.endpoint || ''),
    limit: safeNumber(event.limit),
    remaining: safeNumber(event.remaining),
    resetAt: typeof event.resetAt === 'string' ? new Date(event.resetAt) : null,
    usagePercent: safeNumber(event.usagePercent),
    retryAfterMs: safeNumber(event.retryAfterMs),
    wasThrottled: event.type === 'RATE_LIMIT_ERROR',
  };
}

async function extractAndPersistRateLimitEvents(result: Record<string, unknown> | undefined | null): Promise<void> {
  if (!result || !result._rateLimitEvents) {
    return;
  }

  const events = result._rateLimitEvents;
  delete result._rateLimitEvents;

  if (!Array.isArray(events)) return;

  for (const raw of events) {
    const event = parseRateLimitEvent(raw);
    if (!event) continue;

    const { integration, endpoint, limit, remaining, resetAt, usagePercent, retryAfterMs, wasThrottled } = event;

    try {
      await rateLimitSnapshotRepository.create({
        integration,
        userId: 'system',
        endpoint,
        limit,
        remaining,
        resetAt,
        usagePercent,
        wasThrottled,
        retryAfterMs,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('[RateLimit] Failed to persist snapshot to MongoDB', err);
    }

    if (isNearLimit({ limit, remaining, resetAt, retryAfterMs, usagePercent })) {
      console.warn(`[RateLimit] WARNING: ${integration} at ${usagePercent}% usage (${remaining}/${limit} remaining)`);
    }

    // Separate try-catch so a metric failure doesn't affect the DB write above
    try {
      const normalizedEndpoint = normalizeEndpoint(endpoint);
      await recordRateLimitEvent(integration, usagePercent, wasThrottled, normalizedEndpoint || undefined);
    } catch (err) {
      console.error('[RateLimit] Failed to emit CloudWatch metric', err);
    }
  }
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

  // Adaptive throttling: delay if integration is near rate limit
  await maybeThrottle(name, action);

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
  const breaker = getBreaker(name, opType);

  try {
    const result = await breaker.execute(async () => {
      const mcpName = (() => {
        try {
          return Resource.mcpHandler?.name;
        } catch {
          return undefined;
        }
      })();
      return shouldRunLocally() || !mcpName ? ((await localMcpHandler(payload)) as T) : await invokeLambda<T>(payload);
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

// Safe: only called when mcpName is truthy (line 213-214 guard ensures Resource.mcpHandler is accessible)
async function invokeLambda<T>(payload: Parameters<typeof localMcpHandler>[0]): Promise<T> {
  try {
    const client = new LambdaClient({});
    const command = new InvokeCommand({
      FunctionName: Resource.mcpHandler.name,
      Payload: Buffer.from(JSON.stringify(payload)),
      InvocationType: 'RequestResponse',
    });

    const response = await client.send(command);
    const raw = decodePayload(response.Payload);

    if (response.FunctionError) {
      let details = response.FunctionError;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          details = parsed?.errorMessage || parsed?.message || parsed || details;
        } catch {
          details = `${details}: ${raw}`;
        }
      }

      throw new Error(`MCP handler invocation failed: ${details}`);
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

    await extractAndPersistRateLimitEvents(parsed);
    return parsed as T;
  } catch (error) {
    if (!shouldRunLocally() && needsLocalFallback(error)) {
      console.error(
        `[invokeMcpHandler] Lambda invocation failed, falling back to local handler.`,
        `Server: ${payload.name}, Action: ${payload.action},`,
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      const result = await localMcpHandler(payload);
      try {
        await extractAndPersistRateLimitEvents(result as Record<string, unknown>);
      } catch (rateLimitErr) {
        console.error('[invokeMcpHandler] Failed to extract rate limit events in fallback path:', rateLimitErr);
      }
      return result as T;
    }

    throw error;
  }
}
