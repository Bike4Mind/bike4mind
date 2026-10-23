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
import { buildPrivateAddressAdmission } from '@bike4mind/fab-pipeline/ssrf';
import { isIP } from 'net';
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
  /**
   * `EnableMCPServer` AND `EnableCustomMcpConnectors` AND no applicable org policy set to `off`
   * AND a usable platform blocklist.
   */
  enabled: boolean;
  /** Set when `enabled` is false for a reason other than a switch being off. */
  disabledReason?: 'platform_blocklist_invalid' | 'org_policy_invalid';
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

export function isSelfHost(): boolean {
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

interface DroppedOverrideInfo {
  platformRejected?: true;
  ignoredOverrides?: { scopeLevel: string; scopeId: string }[];
}

// Every request resolves these settings, so each dropped value is reported once per process.
const warnedDroppedOverrides = new Set<string>();

function warnOnce(id: string, message: string): void {
  if (warnedDroppedOverrides.has(id)) return;
  warnedDroppedOverrides.add(id);
  console.warn(message);
}

/**
 * A stored value the setting's schema now refuses (e.g. a private range saved before the shared
 * unreachable-network list) is skipped, so say so; otherwise the operator's choice vanishes silently.
 * A rejected platform row resolves to the coded default; a skipped narrower override falls back to
 * the next wider scope.
 */
function warnOnDroppedOverrides(key: string, entry: DroppedOverrideInfo): void {
  if (entry.platformRejected) {
    warnOnce(
      `${key}:platform`,
      `[customMcpAccess] Stored '${key}' at platform scope failed validation; using the coded default`
    );
  }
  for (const ignored of entry.ignoredOverrides ?? []) {
    warnOnce(
      `${key}:${ignored.scopeLevel}:${ignored.scopeId}`,
      `[customMcpAccess] Stored '${key}' at ${ignored.scopeLevel} scope ${ignored.scopeId} failed validation; ` +
        'falling back to the next wider scope'
    );
  }
}

/** Test seam: forget which dropped values were already reported. */
export function resetDroppedOverrideWarnings(): void {
  warnedDroppedOverrides.clear();
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
    scopedSettingsService.resolveScopedSettingEntries(CUSTOM_MCP_HOST_SETTING_KEYS, policyScope(userId), db, {
      readFailureMode: 'throw',
    }),
  ]);
  const scopes = orgIds.length > 0 ? orgIds.map(orgId => policyScope(userId, orgId)) : [policyScope(userId)];
  const policyEntries = await Promise.all(
    scopes.map(
      async scope =>
        (
          await scopedSettingsService.resolveScopedSettingEntries(['customMcpPolicy'], scope, db, {
            readFailureMode: 'throw',
          })
        ).customMcpPolicy
    )
  );
  const policies = policyEntries.map(entry => entry.value);

  const platformFlag = mcpEnabled && customEnabled;
  for (const key of CUSTOM_MCP_HOST_SETTING_KEYS) warnOnDroppedOverrides(key, platform[key]);
  for (const entry of policyEntries) warnOnDroppedOverrides('customMcpPolicy', entry);
  // An empty blocklist would quietly reopen every host the operator closed, so fail closed instead.
  const blocklistInvalid = platform.customMcpBlockedHosts.platformRejected === true;
  // A skipped org override falls back to the platform value, which may be laxer than what the org set.
  const orgPolicyInvalid = policyEntries.some(entry => (entry.ignoredOverrides?.length ?? 0) > 0);
  const privateNetworks = platform.customMcpAllowPrivateNetworks.value;
  const selfHostPrivate = isSelfHost() ? privateNetworks : undefined;
  return {
    enabled:
      !blocklistInvalid && !orgPolicyInvalid && policies.every(policy => isCustomMcpEnabled(platformFlag, policy)),
    ...(blocklistInvalid
      ? { disabledReason: 'platform_blocklist_invalid' as const }
      : orgPolicyInvalid
        ? { disabledReason: 'org_policy_invalid' as const }
        : {}),
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
  if (!context.enabled) {
    throw new ForbiddenError(
      'Custom MCP connectors are disabled',
      context.disabledReason ? { code: 'policy_blocked', reason: context.disabledReason } : undefined
    );
  }
  return context;
}

/**
 * Self-host can allow plain http; an API key sent that way is readable on every hop, so it is
 * allowed only to an IP literal inside the admin's private CIDRs. A hostname is refused even when
 * it resolves inside them: the address is not known at this layer, and DNS can change.
 */
function apiKeyOverHttpVerdict(
  network: RemoteMcpNetworkOptions | undefined,
  url: string | undefined,
  authKind: McpConnectionAuthKind
): CustomMcpPolicyVerdict {
  if (!network?.allowHttp || authKind !== 'api_key' || !url) return { allowed: true };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: true };
  }
  if (parsed.protocol !== 'http:') return { allowed: true };
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const admitted =
    family !== 0 && buildPrivateAddressAdmission({ allowPrivateCidrs: network.allowPrivateCidrs ?? [] })(host, family);
  return admitted
    ? { allowed: true }
    : {
        allowed: false,
        reason: 'api_key_over_http',
        message: 'An API key can be sent over plain http only to an address inside the allowed private networks',
      };
}

/**
 * The policy verdict for a connection across every applicable policy. Pass `url` (the stored
 * `displayUrl` or the prepared URL) and the context's `network` to apply the plain-http API key rule.
 */
export function evaluateConnectionPolicy(
  context: Pick<CustomMcpContext, 'policies' | 'platformBlockedHosts'> & { network?: RemoteMcpNetworkOptions },
  connection: { urlHost: string; authKind: McpConnectionAuthKind; presetRemoteHost?: string; url?: string }
): CustomMcpPolicyVerdict {
  return combineCustomMcpPolicyVerdicts([
    ...context.policies.map(policy =>
      evaluateCustomMcpPolicy({
        urlHost: connection.urlHost,
        authKind: connection.authKind,
        presetRemoteHost: connection.presetRemoteHost,
        policy,
        platformBlockedHosts: context.platformBlockedHosts,
      })
    ),
    apiKeyOverHttpVerdict(context.network, connection.url, connection.authKind),
  ]);
}
