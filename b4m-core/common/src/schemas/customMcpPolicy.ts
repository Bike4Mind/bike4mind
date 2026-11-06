import type { McpConnectionAuthKind } from '../types/entities/McpConnectionTypes';
import { normalizeMcpHostPattern } from './customMcpHosts';
import type { CustomMcpPolicy } from './settings';

/**
 * Policy evaluation for custom remote MCP connectors (design #4845 section 8). Pure, so the same
 * verdict is reached on create, on every call, at offer time (c6) and in the admin views (c7).
 */

export const CUSTOM_MCP_POLICY_DENY_REASONS = [
  'platform_blocked_host',
  'org_disabled',
  'org_blocked_host',
  'presets_only',
  'host_not_allowlisted',
  'unauthenticated_not_allowed',
  'api_key_over_http',
] as const;
export type CustomMcpPolicyDenyReason = (typeof CUSTOM_MCP_POLICY_DENY_REASONS)[number];

export type CustomMcpPolicyVerdict =
  { allowed: true } | { allowed: false; reason: CustomMcpPolicyDenyReason; message: string };

export interface CustomMcpPolicyInput {
  /** `McpConnection.urlHost`: lowercased hostname, no port. */
  urlHost: string;
  /**
   * Host of the catalog preset's `remoteMcp` URL when the connection came from one, resolved by the
   * caller from the catalog (never from the request). No preset carries `remoteMcp` until the preset
   * PRs, so this is undefined for every connection today.
   */
  presetRemoteHost?: string;
  authKind: McpConnectionAuthKind;
  policy: Pick<CustomMcpPolicy, 'mode' | 'allowedHostPatterns' | 'blockedHostPatterns' | 'allowUnauthenticated'>;
  /** The platform `customMcpBlockedHosts.hosts` list. */
  platformBlockedHosts: readonly string[];
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * `example.com` matches exactly that host. `*.example.com` matches any subdomain of it at any depth
 * but not `example.com` itself: list both to cover the apex too.
 */
export function matchesMcpHostPattern(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeMcpHostPattern(pattern).replace(/\.+$/, '');
  if (!normalizedHost || !normalizedPattern) return false;
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.length > suffix.length && normalizedHost.endsWith(suffix);
  }
  return normalizedHost === normalizedPattern;
}

export function matchesAnyMcpHostPattern(host: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => matchesMcpHostPattern(host, pattern));
}

function deny(reason: CustomMcpPolicyDenyReason, message: string): CustomMcpPolicyVerdict {
  return { allowed: false, reason, message };
}

/**
 * Evaluates one connection against one resolved policy, in the design order: the platform blocked
 * hosts, the org kill switch, the org blocked hosts, the mode, then unauthenticated servers.
 * The platform `EnableCustomMcpConnectors` flag is not an input: callers gate on
 * `isCustomMcpEnabled` first, so a platform-off deployment never reaches here.
 */
export function evaluateCustomMcpPolicy(input: CustomMcpPolicyInput): CustomMcpPolicyVerdict {
  const { urlHost, presetRemoteHost, authKind, policy, platformBlockedHosts } = input;

  if (matchesAnyMcpHostPattern(urlHost, platformBlockedHosts)) {
    return deny('platform_blocked_host', 'This host is blocked on this deployment');
  }
  if (policy.mode === 'off') {
    return deny('org_disabled', 'Custom connectors are turned off by your organization');
  }
  if (matchesAnyMcpHostPattern(urlHost, policy.blockedHostPatterns)) {
    return deny('org_blocked_host', 'This host is blocked by your organization');
  }
  if (policy.mode === 'presets_only') {
    const isPresetHost = presetRemoteHost !== undefined && normalizeHost(presetRemoteHost) === normalizeHost(urlHost);
    if (!isPresetHost) {
      return deny('presets_only', 'Only catalog connectors are allowed; custom server URLs are not');
    }
  }
  if (policy.mode === 'allowlist' && !matchesAnyMcpHostPattern(urlHost, policy.allowedHostPatterns)) {
    return deny('host_not_allowlisted', 'This host is not on the allowed list');
  }
  if (authKind === 'none' && !policy.allowUnauthenticated) {
    return deny('unauthenticated_not_allowed', 'Servers without sign-in are not allowed');
  }
  return { allowed: true };
}

/**
 * Folds several verdicts (one per applicable org policy) into one: the first denial wins, so any
 * org a user belongs to can close a host for them but none can reopen it.
 */
export function combineCustomMcpPolicyVerdicts(verdicts: readonly CustomMcpPolicyVerdict[]): CustomMcpPolicyVerdict {
  return verdicts.find(verdict => !verdict.allowed) ?? { allowed: true };
}

/**
 * The org admin view of a `customMcpPolicy`, served by `/api/organizations/:id/custom-mcp/policy`
 * (apps/client/server/mcpConnections/orgPolicy.ts) and rendered by the org Connectors tab.
 */
export interface OrgCustomMcpPolicyView {
  policy: CustomMcpPolicy;
  /** The org has its own override; false means it inherits the platform value. */
  overridden: boolean;
  /**
   * A stored override the schema now refuses. `resolveCustomMcpContext` keeps connectors off for
   * every member while it stands, so the admin has to save or reset it.
   */
  invalidOverride: boolean;
  /** `EnableMCPServer` AND `EnableCustomMcpConnectors`; an org can close connectors, never open them past this. */
  platformEnabled: boolean;
}
