// Tab identity and visibility rules for the organization detail route.

import {
  canAdministerOrganization,
  isOrgOwnerOrCurrentAdmin,
  isOrgOwnerOrPlatformAdmin,
  Permission,
  type AdministrableOrg,
} from '@bike4mind/common';
import { hasOrgUpdateAccess } from '@client/app/utils/orgAccessGate';
import { orgAclRowConfersMembership } from '@bike4mind/common';

export enum OrganizationTabs {
  Overview = 'overview',
  Library = 'library',
  Members = 'members',
  Groups = 'groups',
  Usage = 'usage',
  Analysis = 'analysis',
  Integrations = 'integrations',
  Billing = 'billing',
  Domains = 'domains',
  ApiKeys = 'api-keys',
  Settings = 'settings',
  Audit = 'audit',
}

/**
 * The sub-sections of the Integrations tab, carried in `?section=`. Order is display order, and the
 * first visible one is the default: Slack leads because a bare `?tab=integrations` meant the Slack
 * panel before the merge, and the Slack OAuth callback (pages/api/slack/oauth/org-connect) still
 * returns there.
 */
export enum IntegrationSections {
  Slack = 'slack',
  GitHub = 'github',
  Webhooks = 'webhooks',
  Connectors = 'connectors',
}

/**
 * `?tab=` values that named their own tab before GitHub API, Webhooks and Connectors moved under
 * Integrations. The page rewrites them to `?tab=integrations&section=<section>` so old bookmarks
 * and links keep landing on the same settings.
 */
export const LEGACY_INTEGRATION_TABS: Readonly<Record<string, IntegrationSections>> = {
  github: IntegrationSections.GitHub,
  webhooks: IntegrationSections.Webhooks,
  connectors: IntegrationSections.Connectors,
};

/**
 * Who may edit the team profile (the system prompt). Mirrors organizationService.update, whose
 * finder admits the owner and a `users[]` row holding `update` (updateAccessArms in
 * SharableDocumentModel.ts), plus a platform admin. `share` alone is not enough: the save would
 * 404. Group-granted `update` is not visible here, so such a member fails closed.
 */
export const canEditOrgProfile = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization:
    { userId: string; users?: ReadonlyArray<{ userId: string; permissions?: Permission[] }> } | null | undefined
): boolean => {
  if (!currentUser || !organization) return false;
  if (currentUser.isAdmin === true || currentUser.id === organization.userId) return true;
  const row = organization.users?.find(u => u.userId === currentUser.id);
  return row?.permissions?.includes(Permission.update) ?? false;
};

/**
 * Who may open the Settings tab (and the header's Settings button): anyone who can edit the
 * profile, plus a current manager, whom organizationService.update admits for `sharingPolicy`
 * alone (OrganizationSharingSettings). The single source for `canManageOrg`; the page computes it
 * once and passes it down.
 */
export const canManageOrgSettings = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization:
    | (Omit<AdministrableOrg, 'users'> & { users?: ReadonlyArray<{ userId: string; permissions?: Permission[] }> })
    | null
    | undefined
): boolean =>
  canEditOrgProfile(currentUser, organization) ||
  (!!currentUser && !!organization && isOrgOwnerOrCurrentAdmin(currentUser, organization));

/**
 * Who may see the org's feedback analysis. Mirrors the server gate the feedback-report routes run
 * (packages/server-utils/src/utils/orgAccess.ts, verifyOrgAccess): a platform admin, the org owner, or a
 * manager - NOT every member holding manage permissions, so the tab is never offered to someone the
 * API would answer with a 404. Must stay in sync with that function.
 *
 * Exported rather than left inline in $id.tsx so the spec can exercise the predicate the page
 * actually runs; a copy of the logic declared in the test passes whatever the page does.
 */
export const canViewOrgAnalysis = hasOrgUpdateAccess;

export const canViewOrgAudit = (
  user: { id: string } | null | undefined,
  org:
    | (Omit<AdministrableOrg, 'users'> & { users?: { userId: string; permissions?: readonly string[] | null }[] })
    | null
    | undefined
): boolean =>
  !!user &&
  !!org &&
  (org.userId === user.id ||
    ((org.adminUserIds ?? []).includes(user.id) &&
      (org.users ?? []).some(row => row.userId === user.id && orgAclRowConfersMembership(row))));

/** `isOrgOwnerOrPlatformAdmin`, failing closed while the user or org is still loading. */
const ownerTierGate = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: { userId: string } | null | undefined
): boolean => !!currentUser && !!organization && isOrgOwnerOrPlatformAdmin(currentUser, organization);

/**
 * Usage and ledger reads use verifyOrgAccess: owner, current manager or platform admin.
 * Billing actions retain their separate owner-only gate.
 */
export const canViewOrgUsage = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: AdministrableOrg | null | undefined
): boolean => !!currentUser && !!organization && isOrgOwnerOrCurrentAdmin(currentUser, organization);

/**
 * Who may see the GitHub, Slack and Webhooks sections of the Integrations tab - Slack wiring
 * (`integrations/slack/*`), the org's GitHub connection, keys and PAT (`organizations/[id]/github/*`)
 * and webhook secrets (`organizations/[id]/webhooks/github*`), all `verifyOrgOwner`. Owner or
 * platform admin. Connecting a GitHub source to a data lake does not go through these routes, so a
 * manager can still do that.
 */
export const canManageOrgIntegrations = ownerTierGate;

/**
 * Who may see the Billing & Subscription tab. Owner only - NOT `canManageOrg`, which is satisfied
 * by any member holding `share`/`update`. All three of the tab's actions are owner-gated, so a
 * member reaching it saw an enabled control for every one of them and an error back from each:
 * - Subscribe        pages/api/organizations/subscriptions/subscribe.ts (verifyOrgOwner)
 * - Change seats     pages/api/organizations/subscriptions/update-seats.ts
 * - Billing portal   pages/api/stripe/portal.ts
 * Must stay in sync with those three.
 *
 * A platform admin who is not the owner is deliberately excluded, though the first two routes would
 * admit them: portal.ts has no admin bypass, so an admin would still get a Billing Portal button
 * that rejects them. Admins act on an org's billing through the Admin -> Organizations panel, which
 * is the same split the page already makes for member management.
 *
 * Nothing is lost by hiding it: the plan, its status, the renewal date and seat usage are all on
 * the Overview tab and the page header, which every member sees.
 */
export const canViewOrgBilling = (
  currentUser: { id: string } | null | undefined,
  organization: { userId: string } | null | undefined
): boolean => {
  if (!currentUser || !organization) return false;
  return currentUser.id === organization.userId;
};

/**
 * Who may see the Connectors section of the Integrations tab - the org's custom MCP connector policy
 * and kill switch (`organizations/[id]/custom-mcp/*`, `verifyOrgAccess`). Owner, current manager or
 * platform admin; must stay in sync with that gate.
 */
export const canManageOrgConnectors = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: AdministrableOrg | null | undefined
): boolean => !!currentUser && !!organization && isOrgOwnerOrCurrentAdmin(currentUser, organization);

/**
 * Who may see the Domains tab: the same checks `loadOrgForDomainAdmin` runs for the
 * `organizations/[id]/domains/*` routes (owner, current manager or platform admin; never a personal org).
 */
export const canManageOrgDomains = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: (AdministrableOrg & { personal?: boolean }) | null | undefined
): boolean =>
  !!currentUser && !!organization && !organization.personal && canAdministerOrganization(currentUser, organization);

export interface OrgTabAccess {
  canManageOrg: boolean;
  canViewUsage: boolean;
  canViewAnalysis: boolean;
  canManageIntegrations: boolean;
  canManageGroups: boolean;
  canViewBilling: boolean;
  canManageConnectors: boolean;
  canManageDomains: boolean;
  canViewAudit?: boolean;
}

/** The Integrations sub-sections this caller may see, in display order. */
export const visibleIntegrationSections = (
  access: Pick<OrgTabAccess, 'canManageIntegrations' | 'canManageConnectors'>
): IntegrationSections[] =>
  Object.values(IntegrationSections).filter(section =>
    section === IntegrationSections.Connectors ? access.canManageConnectors : access.canManageIntegrations
  );

/**
 * The tab to actually show given what the caller may see - `selected` when they may see it, and
 * Overview when they may not. A tab can be selected without ever being rendered: `?tab=` is taken
 * from the URL, so a deep link is the one path that reaches a gated tab, and it is the reason this
 * is a redirect rather than only a conditional render.
 */
export const resolveAccessibleTab = (selected: OrganizationTabs, access: OrgTabAccess): OrganizationTabs => {
  if (!access.canViewAudit && selected === OrganizationTabs.Audit) return OrganizationTabs.Overview;
  if (!access.canManageOrg && selected === OrganizationTabs.Settings) return OrganizationTabs.Overview;
  if (selected === OrganizationTabs.Integrations && visibleIntegrationSections(access).length === 0) {
    return OrganizationTabs.Overview;
  }
  if (!access.canViewUsage && selected === OrganizationTabs.Usage) return OrganizationTabs.Overview;
  if (!access.canViewAnalysis && selected === OrganizationTabs.Analysis) return OrganizationTabs.Overview;
  if (!access.canManageGroups && selected === OrganizationTabs.Groups) return OrganizationTabs.Overview;
  if (!access.canManageDomains && selected === OrganizationTabs.Domains) return OrganizationTabs.Overview;
  // Billing has its own gate rather than riding canManageOrg: every action on it is owner-only.
  if (!access.canViewBilling && selected === OrganizationTabs.Billing) return OrganizationTabs.Overview;
  // Same verifyOrgAccess gate as Connectors (pages/api/organizations/[id]/api-keys/*).
  if (!access.canManageConnectors && selected === OrganizationTabs.ApiKeys) return OrganizationTabs.Overview;
  return selected;
};

/** The Integrations sub-section to show: the requested one when visible, else the first visible. */
export const resolveIntegrationSection = (
  requested: string | undefined,
  access: Pick<OrgTabAccess, 'canManageIntegrations' | 'canManageConnectors'>
): IntegrationSections | undefined => {
  const visible = visibleIntegrationSections(access);
  return visible.find(section => section === requested) ?? visible[0];
};
