/**
 * Tenant key for calls that carry no userId. Their snapshots are stored under it for reporting, but
 * invokeMcpHandler never throttles on it or shares a breaker through it, so unattributed callers do
 * not couple to each other. It differs from the retired platform-wide 'system' key so stale rows
 * written under that key (expired by the snapshot TTL) are never read back.
 */
export const UNATTRIBUTED_MCP_TENANT = 'unattributed';

/**
 * The tenant that owns MCP host state (rate-limit snapshots, in-process circuit breakers).
 *
 * Every MCP credential is owned by a single user - McpServer.userId for server env tokens,
 * user.atlassianConnect for Atlassian - and no MCP credential is org-owned, so the user is the
 * unit whose quota and failures belong together. Revisit this if org-level MCP credentials land.
 *
 * Dependency-free on purpose: the MCP handler Lambda imports it and has no database access.
 */
export function resolveMcpTenantKey(userId: string | null | undefined): string {
  return userId || UNATTRIBUTED_MCP_TENANT;
}
