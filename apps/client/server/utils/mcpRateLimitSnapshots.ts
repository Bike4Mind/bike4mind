import { rateLimitSnapshotRepository, type IntegrationType } from '@bike4mind/database';
import { recordRateLimitEvent } from '@server/utils/cloudwatch';
import {
  normalizeEndpoint,
  isNearLimit,
  RATE_LIMIT_INTEGRATIONS,
  type RateLimitIntegrationType,
} from '@bike4mind/common';

/**
 * Per-tenant MCP rate-limit snapshots. Both writers - invokeMcpHandler (events returned in the
 * handler payload) and the /api/admin/rate-limits/ingest route (events posted by the MCP handler
 * Lambda) - go through persistRateLimitEvents, so a snapshot is always stored under the tenant
 * that spent the quota. See resolveMcpTenantKey for what a tenant is.
 */

/** Map MCP server names to integration types for rate limit lookups */
const SERVER_TO_INTEGRATIONS: Record<string, IntegrationType[]> = {
  github: ['github'],
  atlassian: ['jira', 'confluence'],
};

const THROTTLE_USAGE_PERCENT = 90;
const MAX_THROTTLE_DELAY_MS = 10_000;

/**
 * Pre-call rate limit check: delays a tenant's request when that tenant's latest snapshot for the
 * integration is near its limit, sleeping until resetAt (capped). Never blocks on lookup failures.
 */
export async function throttleIfNearRateLimit(tenantKey: string, serverName: string, action: string): Promise<void> {
  if (action !== 'callTool') return;

  const integrations = SERVER_TO_INTEGRATIONS[serverName];
  if (!integrations) return;

  try {
    for (const integration of integrations) {
      const latest = await rateLimitSnapshotRepository.getLatestByIntegration(integration, tenantKey);
      if (!latest || latest.usagePercent === null) continue;

      if (latest.usagePercent >= THROTTLE_USAGE_PERCENT && latest.resetAt && latest.resetAt > new Date()) {
        const delayMs = Math.min(latest.resetAt.getTime() - Date.now(), MAX_THROTTLE_DELAY_MS);
        if (delayMs > 0) {
          console.warn(
            `[RateLimit] Throttling ${integration} for tenant ${tenantKey} for ${delayMs}ms (${latest.usagePercent}% usage, resets at ${latest.resetAt.toISOString()})`
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  } catch (err) {
    console.error('[RateLimit] Pre-call throttle check failed', err);
  }
}

/** Validated shape of a rate limit event emitted by an MCP server. */
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

function isRateLimitIntegration(value: unknown): value is RateLimitIntegrationType {
  return typeof value === 'string' && VALID_RATE_LIMIT_INTEGRATIONS.has(value);
}

/** Parse and validate a raw event object into a typed RateLimitEvent. Returns null if invalid. */
function parseRateLimitEvent(raw: unknown): RateLimitEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const event = raw as Record<string, unknown>;
  if (!isRateLimitIntegration(event.integration)) {
    console.warn(`[RateLimit] Skipping event with invalid integration: ${String(event.integration)}`);
    return null;
  }

  return {
    integration: event.integration,
    endpoint: String(event.endpoint || ''),
    limit: safeNumber(event.limit),
    remaining: safeNumber(event.remaining),
    resetAt: typeof event.resetAt === 'string' ? new Date(event.resetAt) : null,
    usagePercent: safeNumber(event.usagePercent),
    retryAfterMs: safeNumber(event.retryAfterMs),
    wasThrottled: event.type === 'RATE_LIMIT_ERROR',
  };
}

/**
 * Persist raw rate limit events under the given tenant and emit their CloudWatch metrics.
 * Invalid events are skipped. Returns the number of snapshots stored.
 */
export async function persistRateLimitEvents(rawEvents: readonly unknown[], tenantKey: string): Promise<number> {
  let persisted = 0;

  for (const raw of rawEvents) {
    const event = parseRateLimitEvent(raw);
    if (!event) continue;

    const { integration, endpoint, limit, remaining, resetAt, usagePercent, retryAfterMs, wasThrottled } = event;

    try {
      await rateLimitSnapshotRepository.create({
        integration,
        userId: tenantKey,
        endpoint,
        limit,
        remaining,
        resetAt,
        usagePercent,
        wasThrottled,
        retryAfterMs,
        timestamp: new Date(),
      });
      persisted++;
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

  return persisted;
}
