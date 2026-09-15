import { McpServerName } from '@bike4mind/common';
import {
  integrationHealthCheckRepository,
  integrationCircuitOverrideRepository,
  INTEGRATION_HEALTH_THRESHOLDS,
} from '@bike4mind/database';
import type { IntegrationName, CircuitBreakerMode } from '@bike4mind/database';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches probe interval

interface CacheEntry {
  available: boolean;
  reason: string | null;
  /** The effective mode: 'auto', 'force_block', or 'force_open' */
  mode: CircuitBreakerMode;
  /** Whether the automatic logic detected a failure streak (only meaningful when mode is 'auto') */
  autoTripped: boolean;
  /** True when there aren't enough real API checks to evaluate (below threshold) */
  noData?: boolean;
  /** True when all recorded checks are configMissing (no integration connection exists) */
  allConfigMissing?: boolean;
  cachedAt: number;
}

const cache = new Map<IntegrationName, CacheEntry>();

/**
 * Maps an MCP server name to the integration name(s) it depends on.
 * Returns undefined for MCP servers that have no health probes.
 */
const MCP_TO_INTEGRATIONS: Partial<Record<McpServerName, IntegrationName[]>> = {
  [McpServerName.Github]: ['github'],
  [McpServerName.Atlassian]: ['jira', 'confluence'],
};

/**
 * Check whether an integration is available.
 *
 * Priority order:
 *  1. Manual override (`force_block` / `force_open`) - takes precedence
 *  2. Automatic probe-based detection (3 consecutive API failures)
 *  3. Default: available
 *
 * Results are cached in memory for CACHE_TTL_MS to avoid repeated DB queries.
 */
async function checkAvailability(integration: IntegrationName): Promise<CacheEntry> {
  const now = Date.now();
  const cached = cache.get(integration);

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  // --- 1. Check manual override ---
  const override = await integrationCircuitOverrideRepository.getOverride(integration);
  const mode = override?.mode ?? 'auto';

  if (mode === 'force_block') {
    const entry: CacheEntry = {
      available: false,
      reason: `${integration} integration is manually blocked by admin${override?.reason ? `: ${override.reason}` : ''}. Contact your administrator.`,
      mode: 'force_block',
      autoTripped: false,
      cachedAt: now,
    };
    cache.set(integration, entry);
    return entry;
  }

  if (mode === 'force_open') {
    const entry: CacheEntry = {
      available: true,
      reason: null,
      mode: 'force_open',
      autoTripped: false,
      cachedAt: now,
    };
    cache.set(integration, entry);
    return entry;
  }

  // --- 2. Automatic probe-based detection ---
  const threshold = INTEGRATION_HEALTH_THRESHOLDS.FAILURE_ALERT_THRESHOLD;
  const checks = await integrationHealthCheckRepository.getLastNChecks(integration, threshold);

  // Ignore config-missing records - they indicate the integration isn't set up,
  // not that the API is actually down. Let those calls through so the user gets
  // the normal "please connect this integration" flow instead of a circuit breaker error.
  const apiChecks = checks.filter(c => !c.configMissing);
  const allConfigMissing = checks.length > 0 && checks.every(c => c.configMissing);

  // Not enough real API data yet - don't block
  if (apiChecks.length < threshold) {
    const entry: CacheEntry = {
      available: true,
      reason: null,
      mode: 'auto',
      autoTripped: false,
      noData: true,
      allConfigMissing,
      cachedAt: now,
    };
    cache.set(integration, entry);
    return entry;
  }

  const allFailed = apiChecks.every(c => c.status === 'unhealthy');

  if (allFailed) {
    const lastError = apiChecks[0]?.error ?? 'consecutive health check failures';
    const entry: CacheEntry = {
      available: false,
      reason: `${integration} integration is currently unavailable (${threshold} consecutive failures: ${lastError}). Retry later.`,
      mode: 'auto',
      autoTripped: true,
      cachedAt: now,
    };
    cache.set(integration, entry);
    return entry;
  }

  const entry: CacheEntry = { available: true, reason: null, mode: 'auto', autoTripped: false, cachedAt: now };
  cache.set(integration, entry);
  return entry;
}

/**
 * Check if a single integration is available.
 */
export async function isAvailable(integration: IntegrationName): Promise<boolean> {
  const result = await checkAvailability(integration);
  return result.available;
}

/**
 * Get a human-readable reason why an integration is unavailable, or null if it is available.
 */
export async function getUnavailableReason(integration: IntegrationName): Promise<string | null> {
  const result = await checkAvailability(integration);
  return result.reason;
}

/**
 * Get the full circuit breaker status for an integration (used by the dashboard API).
 */
export async function getStatus(integration: IntegrationName): Promise<{
  available: boolean;
  reason: string | null;
  mode: CircuitBreakerMode;
  autoTripped: boolean;
  noData?: boolean;
  allConfigMissing?: boolean;
}> {
  const result = await checkAvailability(integration);
  return {
    available: result.available,
    reason: result.reason,
    mode: result.mode,
    autoTripped: result.autoTripped,
    noData: result.noData,
    allConfigMissing: result.allConfigMissing,
  };
}

/**
 * Check if an MCP server is available based on the health of its backing integrations.
 *
 * For `atlassian`, the circuit trips only when BOTH Jira and Confluence are unhealthy
 * (the Atlassian MCP server can still serve one product if the other is down).
 *
 * Returns `{ available: true }` for MCP servers that have no health probes (e.g. LinkedIn).
 */
export async function isMcpServerAvailable(
  mcpServerName: string
): Promise<{ available: boolean; reason: string | null }> {
  const integrations = MCP_TO_INTEGRATIONS[mcpServerName as McpServerName];

  if (!integrations) {
    // No health probes for this MCP server - always allow
    return { available: true, reason: null };
  }

  if (integrations.length === 1) {
    const result = await checkAvailability(integrations[0]);
    return { available: result.available, reason: result.reason };
  }

  // For Atlassian: trip only if ALL backing integrations are down
  const results = await Promise.all(integrations.map(i => checkAvailability(i)));
  const allDown = results.every(r => !r.available);

  if (allDown) {
    const reasons = results
      .map(r => r.reason)
      .filter(Boolean)
      .join('; ');
    return {
      available: false,
      reason: `Atlassian integrations are currently unavailable (${reasons}). Retry later.`,
    };
  }

  return { available: true, reason: null };
}

/**
 * Clear the in-memory cache for a specific integration or all integrations.
 * Call this after setting a manual override so it takes effect immediately.
 */
export function clearCache(integration?: IntegrationName): void {
  if (integration) {
    cache.delete(integration);
  } else {
    cache.clear();
  }
}
