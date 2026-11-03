import {
  CreditHolderType,
  CustomMcpPolicySchema,
  SettingScopeLevel,
  evaluateCustomMcpPolicy,
  orgAclRowConfersMembership,
  toMcpConnectionPublic,
  type IMcpConnectionPublic,
  type OrgCustomMcpPolicyView,
  type SettingScope,
} from '@bike4mind/common';
import { adminSettingsRepository, mcpConnectionRepository, scopedSettingsRepository } from '@bike4mind/database';
import { scopedSettingsService } from '@bike4mind/services';
import { isFeatureEnabled } from '@server/middlewares/featureFlag';

/**
 * The org admin side of custom MCP connectors (design #4845 section 8): an org owner or manager
 * reads and sets the org's `customMcpPolicy` override and sees which current members hold
 * connections. Authorization is the caller's (`verifyOrgAccess`); members pick the policy up through
 * `resolveCustomMcpContext`; other instances observe changes after their settings cache expires.
 */

/** Same scope `resolveCustomMcpContext` resolves for a member of this org. */
function orgScope(organizationId: string): SettingScope {
  return { organizationId, owner: { id: organizationId, type: CreditHolderType.Organization } };
}

const settingsDb = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };

/** The stored override at the org rung, or null when the org inherits the platform value. */
export async function readOrgCustomMcpPolicyOverride(organizationId: string): Promise<string | null> {
  const [existing] = await scopedSettingsRepository.findOverrides(
    [{ scopeLevel: SettingScopeLevel.Organization, scopeId: organizationId }],
    ['customMcpPolicy']
  );
  return existing?.settingValue ?? null;
}

export async function getOrgCustomMcpPolicy(organizationId: string): Promise<OrgCustomMcpPolicyView> {
  const [mcpEnabled, customEnabled, entries, override] = await Promise.all([
    isFeatureEnabled('EnableMCPServer'),
    isFeatureEnabled('EnableCustomMcpConnectors'),
    scopedSettingsService.resolveScopedSettingEntries(['customMcpPolicy'], orgScope(organizationId), settingsDb, {
      readFailureMode: 'throw',
    }),
    readOrgCustomMcpPolicyOverride(organizationId),
  ]);
  const entry = entries.customMcpPolicy;
  return {
    policy: entry.value,
    overridden: override !== null,
    invalidOverride: (entry.ignoredOverrides?.length ?? 0) > 0,
    platformEnabled: mcpEnabled && customEnabled,
  };
}

/**
 * Writes the whole policy as the org override. The body is parsed with the setting's own schema
 * first, so defaults are filled in and the stored row is exactly what the resolver will read back.
 */
export async function setOrgCustomMcpPolicy(organizationId: string, policy: unknown): Promise<string> {
  const settingValue = JSON.stringify(CustomMcpPolicySchema.parse(policy));
  await scopedSettingsService.writeScopedOverride(
    'customMcpPolicy',
    { scopeLevel: SettingScopeLevel.Organization, scopeId: organizationId },
    settingValue,
    { scopedSettings: scopedSettingsRepository }
  );
  return settingValue;
}

/** Drops the org override so the org inherits the platform value again. */
export async function resetOrgCustomMcpPolicy(organizationId: string): Promise<void> {
  await scopedSettingsService.clearScopedOverride(
    'customMcpPolicy',
    { scopeLevel: SettingScopeLevel.Organization, scopeId: organizationId },
    { scopedSettings: scopedSettingsRepository }
  );
}

/**
 * The org's current members: the billing owner plus every `users[]` row that confers membership.
 * Same rule as `isOrgMember` (b4m-core/common/src/constants/organization.ts), minus the platform
 * admin tier, which is not a roster.
 */
export function currentOrgMemberIds(org: {
  userId: string;
  users?: ReadonlyArray<{ userId: string; permissions?: readonly string[] | null }> | null;
}): string[] {
  const ids = new Set<string>([org.userId]);
  for (const row of org.users ?? []) {
    if (orgAclRowConfersMembership(row)) ids.add(row.userId);
  }
  return [...ids];
}

/**
 * Current members' own connections stamped with this org, each with the status the org's policy
 * implies (`blocked_by_policy` when it denies). A member who left the org is not listed, though
 * their connection still carries the org id.
 */
export async function listOrgMemberConnections(
  org: {
    id: string;
    userId: string;
    users?: ReadonlyArray<{ userId: string; permissions?: readonly string[] | null }> | null;
  },
  view: OrgCustomMcpPolicyView
): Promise<IMcpConnectionPublic[]> {
  const [connections, platform] = await Promise.all([
    mcpConnectionRepository.listMemberConnections(org.id, currentOrgMemberIds(org)),
    scopedSettingsService.resolveScopedSettingEntries(['customMcpBlockedHosts'], orgScope(org.id), settingsDb, {
      readFailureMode: 'throw',
    }),
  ]);
  const blocklist = platform.customMcpBlockedHosts;
  const disabled = !view.platformEnabled || view.invalidOverride || blocklist.platformRejected === true;
  const platformBlockedHosts = blocklist.value.hosts;
  return connections.map(connection =>
    toMcpConnectionPublic(
      connection,
      disabled
        ? { allowed: false }
        : evaluateCustomMcpPolicy({
            urlHost: connection.urlHost,
            authKind: connection.auth?.kind ?? 'none',
            policy: view.policy,
            platformBlockedHosts,
          })
    )
  );
}
