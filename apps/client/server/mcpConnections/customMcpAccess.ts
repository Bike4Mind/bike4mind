import {
  CreditHolderType,
  ForbiddenError,
  combineCustomMcpPolicyVerdicts,
  evaluateCustomMcpPolicy,
  isCustomMcpEnabled,
  type CustomMcpPolicy,
  type CustomMcpPolicyVerdict,
  type McpConnectionAuthKind,
  type SettingScope,
} from '@bike4mind/common';
import { adminSettingsRepository, organizationRepository, scopedSettingsRepository } from '@bike4mind/database';
import { scopedSettingsService } from '@bike4mind/services';
import { isFeatureEnabled } from '@server/middlewares/featureFlag';

/**
 * Who may use custom remote MCP connectors, and where they may point them (design #4845 section 8).
 * Every route and the dispatcher read this on every request or call, so turning a switch off takes
 * effect on the next one without a sweep.
 */

/** Network options handed to `validateRemoteMcpUrl` and `RemoteMcpClient` (`@bike4mind/mcp/remote`). */
export interface RemoteMcpNetworkOptions {
  ownHosts: string[];
  /** Self-host only, from `customMcpAllowPrivateNetworks`. */
  allowPrivateCidrs?: string[];
  allowHttp?: boolean;
}

export interface CustomMcpContext {
  /** `EnableMCPServer` AND `EnableCustomMcpConnectors` AND no applicable org policy set to `off`. */
  enabled: boolean;
  /**
   * The resolved `customMcpPolicy` for each org the user is a member of, or the platform value
   * alone for a user in no org. Every one is applied: any org can close a host, none can reopen it.
   */
  policies: CustomMcpPolicy[];
  platformBlockedHosts: string[];
  /** The orgs the user is a member of (owner or users[] ACL). */
  organizationIds: string[];
  network: RemoteMcpNetworkOptions;
  /** The lowest `maxConnectionsPerUser` across the policies. */
  maxConnectionsPerUser: number;
}

function isSelfHost(): boolean {
  return process.env.B4M_SELF_HOST === 'true';
}

/**
 * This deployment's own hosts, refused as connector targets: the app URL and an absolute CDN URL.
 * A relative CDN URL (the self-host app-file proxy) is the app host already.
 */
export function resolveOwnHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = new Set<string>();
  for (const raw of [env.APP_URL, env.NEXT_PUBLIC_CDN_URL]) {
    const value = raw?.trim();
    if (!value || !/^https?:\/\//i.test(value)) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // A malformed URL names no host to protect.
    }
  }
  return [...hosts];
}

function policyScope(userId: string, organizationId?: string): SettingScope {
  return organizationId
    ? { organizationId, owner: { id: organizationId, type: CreditHolderType.Organization } }
    : { owner: { id: userId, type: CreditHolderType.User } };
}

const CUSTOM_MCP_HOST_SETTING_KEYS = ['customMcpBlockedHosts', 'customMcpAllowPrivateNetworks'] as const;

/**
 * A stored value the setting's schema now refuses (e.g. a private range saved before the shared
 * unreachable-network list) resolves to the default, so say so; otherwise the operator's list vanishes silently.
 */
function warnOnDroppedOverrides(
  entries: Record<
    (typeof CUSTOM_MCP_HOST_SETTING_KEYS)[number],
    { platformRejected?: true; ignoredOverrides?: { scopeLevel: string; scopeId: string }[] }
  >
): void {
  for (const key of CUSTOM_MCP_HOST_SETTING_KEYS) {
    const entry = entries[key];
    if (entry.platformRejected) {
      console.warn(
        `[customMcpAccess] Stored '${key}' at platform scope failed validation; using the default (no override applied)`
      );
    }
    for (const ignored of entry.ignoredOverrides ?? []) {
      console.warn(
        `[customMcpAccess] Stored '${key}' at ${ignored.scopeLevel} scope ${ignored.scopeId} failed validation; using the default (no override applied)`
      );
    }
  }
}

/**
 * Resolves the switches, the policies and the network options for one user. Org policies come from
 * the user's actual memberships (`findMembershipOrgIds`), never from the selected-org pointer, so a
 * member cannot pick a laxer org to escape a stricter one.
 */
export async function resolveCustomMcpContext(userId: string): Promise<CustomMcpContext> {
  const db = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
  const [mcpEnabled, customEnabled, orgIds, platform] = await Promise.all([
    isFeatureEnabled('EnableMCPServer'),
    isFeatureEnabled('EnableCustomMcpConnectors'),
    organizationRepository.findMembershipOrgIds(userId),
    scopedSettingsService.resolveScopedSettingEntries(CUSTOM_MCP_HOST_SETTING_KEYS, policyScope(userId), db),
  ]);
  const scopes = orgIds.length > 0 ? orgIds.map(orgId => policyScope(userId, orgId)) : [policyScope(userId)];
  const policies = await Promise.all(
    scopes.map(async scope => (await scopedSettingsService.resolveScopedSetting('customMcpPolicy', scope, db)).value)
  );

  const platformFlag = mcpEnabled && customEnabled;
  warnOnDroppedOverrides(platform);
  const privateNetworks = platform.customMcpAllowPrivateNetworks.value;
  const selfHostPrivate = isSelfHost() ? privateNetworks : undefined;
  return {
    enabled: policies.every(policy => isCustomMcpEnabled(platformFlag, policy)),
    policies,
    platformBlockedHosts: platform.customMcpBlockedHosts.value.hosts,
    organizationIds: orgIds,
    network: {
      ownHosts: resolveOwnHosts(),
      ...(selfHostPrivate && selfHostPrivate.cidrs.length > 0 ? { allowPrivateCidrs: selfHostPrivate.cidrs } : {}),
      ...(selfHostPrivate?.allowHttp ? { allowHttp: true } : {}),
    },
    maxConnectionsPerUser: Math.min(...policies.map(policy => policy.maxConnectionsPerUser)),
  };
}

/**
 * Throws 403 unless custom connectors are on for this user (the `assertMcpServerEnabled`
 * convention). Create, edit, refresh and calls go through it; listing reports nothing and delete
 * stays open, so a user can always clean up.
 */
export async function assertCustomMcpEnabled(user: { id: string }): Promise<CustomMcpContext> {
  const context = await resolveCustomMcpContext(user.id);
  if (!context.enabled) throw new ForbiddenError('Custom MCP connectors are disabled');
  return context;
}

/** The policy verdict for a connection across every applicable policy. */
export function evaluateConnectionPolicy(
  context: Pick<CustomMcpContext, 'policies' | 'platformBlockedHosts'>,
  connection: { urlHost: string; authKind: McpConnectionAuthKind; presetRemoteHost?: string }
): CustomMcpPolicyVerdict {
  return combineCustomMcpPolicyVerdicts(
    context.policies.map(policy =>
      evaluateCustomMcpPolicy({
        urlHost: connection.urlHost,
        authKind: connection.authKind,
        presetRemoteHost: connection.presetRemoteHost,
        policy,
        platformBlockedHosts: context.platformBlockedHosts,
      })
    )
  );
}
