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

/** Singleton registry of CircuitBreaker instances, keyed by `server:opType`. */
const breakers = new Map<string, CircuitBreaker>();

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

/**
 * Get or create a CircuitBreaker instance for the given MCP server name and operation type.
 * Key is compound: `${mcpServerName}:${operationType}` (e.g., `github:read`, `atlassian:write`).
 */
export function getBreaker(mcpServerName: string, operationType: OperationType = 'read'): CircuitBreaker {
  const key = `${mcpServerName}:${operationType}`;
  let breaker = breakers.get(key);
  if (breaker) return breaker;

  const serverOverrides = CONFIG_OVERRIDES[mcpServerName] ?? {};
  const opOverrides = OP_TYPE_OVERRIDES[operationType];
  breaker = new CircuitBreaker({
    ...DEFAULT_CONFIG,
    ...opOverrides,
    ...serverOverrides,
    name: key,
    isFailure: isCircuitBreakerFailure,
    onStateChange: event => {
      console.log(`[CircuitBreaker] ${event.name}: ${event.from} -> ${event.to} (${event.reason})`);
      recordCircuitBreakerTransition(event.name, event.from, event.to, operationType).catch(err => {
        console.error(`[CircuitBreaker] Failed to record CloudWatch transition metric for ${event.name}:`, err);
      });
    },
  });

  breakers.set(key, breaker);
  return breaker;
}

/**
 * Get snapshots of all active breakers (for dashboard API).
 */
export function getAllBreakerStates(): Record<string, CircuitBreakerSnapshot> {
  const result: Record<string, CircuitBreakerSnapshot> = {};
  for (const [name, breaker] of breakers) {
    result[name] = breaker.getState();
  }
  return result;
}

/**
 * Admin reset: force a breaker back to CLOSED.
 * When called with a plain server name (e.g., 'atlassian'), resets both :read and :write variants.
 * When called with a compound key (e.g., 'atlassian:read'), resets only that variant.
 */
export function resetBreaker(name: string): void {
  if (name.includes(':')) {
    // Compound key - reset the specific breaker
    const breaker = breakers.get(name);
    if (breaker) breaker.reset();
  } else {
    // Plain server name - reset both variants
    for (const suffix of [':read', ':write'] as const) {
      const breaker = breakers.get(`${name}${suffix}`);
      if (breaker) breaker.reset();
    }
  }
}

export { CircuitBreakerError };
