import {
  CircuitBreaker,
  CircuitBreakerError,
  type CircuitBreakerConfig,
  type CircuitBreakerSnapshot,
} from '@bike4mind/utils';
import { isAxiosError } from 'axios';
import { recordCircuitBreakerTransition } from '@server/utils/cloudwatch';

export type OperationType = 'read' | 'write';

const WRITE_PREFIXES = [
  'create_',
  'update_',
  'delete_',
  'add_',
  'remove_',
  'bulk_',
  'assign_',
  'move_',
  'upload_',
  'merge_',
  'approve_',
  'close_',
  'reply_',
  'request_',
] as const;

/**
 * Classify an MCP action + toolName as 'read' or 'write'.
 * `getTools` is always 'read' regardless of toolName. Calls with no toolName default to 'read'.
 * Tool names matching write prefixes are 'write'; everything else is 'read'.
 */
export function classifyOperation(action: string, toolName?: string): OperationType {
  if (!toolName || action === 'getTools') return 'read';
  const lower = toolName.toLowerCase();
  return WRITE_PREFIXES.some(prefix => lower.startsWith(prefix)) ? 'write' : 'read';
}

/** Per-integration config overrides (e.g., shorter resetTimeout for Slack). */
const CONFIG_OVERRIDES: Record<string, Partial<CircuitBreakerConfig>> = {
  // Slack has shorter timeouts, recovers faster
  slack: { resetTimeout: 30_000 },
};

/** Per-operation-type config overrides (writes are stricter). */
const OP_TYPE_OVERRIDES: Record<OperationType, Partial<CircuitBreakerConfig>> = {
  write: { failureThreshold: 3, resetTimeout: 30_000 },
  read: {},
};

const DEFAULT_CONFIG: Omit<CircuitBreakerConfig, 'name'> = {
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeout: 60_000,
  rollingWindowMs: 120_000,
  halfOpenMaxConcurrent: 1,
};

type BreakerEntry = {
  serverOp: string;
  breaker: CircuitBreaker;
};

/**
 * Cap on per-tenant breakers held by one warm instance. Insertion order is recency order (a hit is
 * re-inserted), so the least recently used breaker is evicted first; an evicted breaker simply
 * starts CLOSED on that tenant's next call.
 */
export const MAX_TRACKED_BREAKERS = 1000;

/** LRU registry of CircuitBreaker instances, keyed by tenant + `server:opType`. */
const breakers = new Map<string, BreakerEntry>();

const serverOpKey = (mcpServerName: string, operationType: OperationType) => `${mcpServerName}:${operationType}`;
const registryKey = (tenantKey: string, serverOp: string) => `${tenantKey}|${serverOp}`;

/**
 * Classify whether an error represents an integration outage (counts as breaker failure)
 * vs a user-specific error (does not count).
 *
 * 4xx errors (except 429) are user-specific - the API itself is fine.
 * 429 = rate limiting = service overloaded, counts as failure.
 * 5xx, timeouts, and network errors indicate the external service is down.
 */
export function isCircuitBreakerFailure(error: Error): boolean {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status) {
      // 429 = rate limiting = service is overloaded, count as failure
      if (status === 429) return true;
      // Other 4xx = user-specific errors, the API itself is fine
      if (status >= 400 && status < 500) return false;
    }
    // 5xx or no response (network failure) = server is broken
    return true;
  }

  const msg = error.message.toLowerCase();

  // Network/connection errors indicate outage
  if (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('connection closed') ||
    msg.includes('epipe') ||
    msg.includes('service unavailable') ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout')
  ) {
    return true;
  }

  // Lambda invocation failures - use word boundary matching to avoid substring collisions
  // (e.g., "4010" matching "401")
  if (msg.includes('mcp handler invocation failed')) {
    const userErrorPattern = /\b(400|401|403|404|409|422)\b/;
    if (userErrorPattern.test(msg)) {
      return false;
    }
    return true;
  }

  // Default: count as failure (conservative - better to trip than miss an outage)
  return true;
}

function createBreaker(tenantKey: string, mcpServerName: string, operationType: OperationType): CircuitBreaker {
  const serverOverrides = CONFIG_OVERRIDES[mcpServerName] ?? {};
  const opOverrides = OP_TYPE_OVERRIDES[operationType];
  return new CircuitBreaker({
    ...DEFAULT_CONFIG,
    ...opOverrides,
    ...serverOverrides,
    // The tenant stays out of the name: it is the CloudWatch metric dimension.
    name: serverOpKey(mcpServerName, operationType),
    isFailure: isCircuitBreakerFailure,
    onStateChange: event => {
      console.log(
        `[CircuitBreaker] ${event.name} (tenant ${tenantKey}): ${event.from} -> ${event.to} (${event.reason})`
      );
      recordCircuitBreakerTransition(event.name, event.from, event.to, operationType).catch(err => {
        console.error(`[CircuitBreaker] Failed to record CloudWatch transition metric for ${event.name}:`, err);
      });
    },
  });
}

/**
 * Get or create the CircuitBreaker for one tenant's calls to an MCP server and operation type.
 * Breakers are per tenant (see resolveMcpTenantKey) so one tenant's failing server or credential
 * never trips the tools for another.
 */
export function getBreaker(
  tenantKey: string,
  mcpServerName: string,
  operationType: OperationType = 'read'
): CircuitBreaker {
  const serverOp = serverOpKey(mcpServerName, operationType);
  const key = registryKey(tenantKey, serverOp);

  const existing = breakers.get(key);
  if (existing) {
    breakers.delete(key);
    breakers.set(key, existing);
    return existing.breaker;
  }

  const breaker = createBreaker(tenantKey, mcpServerName, operationType);
  breakers.set(key, { serverOp, breaker });

  if (breakers.size > MAX_TRACKED_BREAKERS) {
    const leastRecentlyUsed = breakers.keys().next().value;
    if (leastRecentlyUsed !== undefined) breakers.delete(leastRecentlyUsed);
  }

  return breaker;
}

const STATE_SEVERITY: Record<CircuitBreakerSnapshot['state'], number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

function isWorse(candidate: CircuitBreakerSnapshot, current: CircuitBreakerSnapshot): boolean {
  const severityDelta = STATE_SEVERITY[candidate.state] - STATE_SEVERITY[current.state];
  if (severityDelta !== 0) return severityDelta > 0;
  return candidate.failureCount > current.failureCount;
}

/**
 * Breaker state per `server:opType` for the admin dashboards, which key on that pair. Each value
 * is the worst tenant's snapshot, so OPEN means "tripped for at least one tenant", not for all.
 */
export function getAllBreakerStates(): Record<string, CircuitBreakerSnapshot> {
  const result: Record<string, CircuitBreakerSnapshot> = {};
  for (const { serverOp, breaker } of breakers.values()) {
    const snapshot = breaker.getState();
    const current = result[serverOp];
    if (!current || isWorse(snapshot, current)) {
      result[serverOp] = snapshot;
    }
  }
  return result;
}

/**
 * Admin reset: force breakers back to CLOSED for every tenant.
 * A plain server name (e.g. 'atlassian') resets both :read and :write; a compound key
 * (e.g. 'atlassian:read') resets only that operation type.
 */
export function resetBreaker(name: string): void {
  const matches = name.includes(':')
    ? (serverOp: string) => serverOp === name
    : (serverOp: string) => serverOp === `${name}:read` || serverOp === `${name}:write`;

  for (const { serverOp, breaker } of breakers.values()) {
    if (matches(serverOp)) breaker.reset();
  }
}

export { CircuitBreakerError };
