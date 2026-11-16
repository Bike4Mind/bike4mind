// Tab identity and visibility rules for the organization detail route.

import {
  canReadOrganizationAudit,
  hasOrgPermission,
  Permission,
  type OrgPermission,
  type OrgRoleSubject,
} from '@bike4mind/common';

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

type TabViewer = { id: string; isAdmin?: boolean | null } | null | undefined;
type TabOrg = OrgRoleSubject | null | undefined;

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
 * A tab gate for one org permission, failing closed while the user or org is still loading. Each tab
 * names the permission its server routes check (`verifyOrgPermission`,
 * packages/server-utils/src/utils/orgAccess.ts), so the tab is never offered to someone the API would
 * answer with a 404.
 */
const permissionGate =
  (permission: OrgPermission) =>
  (currentUser: TabViewer, organization: TabOrg): boolean =>
    !!currentUser && !!organization && hasOrgPermission(currentUser, organization, permission);

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
 * profile, plus a `managePolicies` holder, whom organizationService.update admits for
 * `sharingPolicy` alone (OrganizationSharingSettings). The single source for `canManageOrg`; the
 * page computes it once and passes it down.
 */
export const canManageOrgSettings = (
  currentUser: TabViewer,
  organization:
    | (Omit<OrgRoleSubject, 'users'> & { users?: ReadonlyArray<{ userId: string; permissions?: Permission[] }> })
    | null
    | undefined
): boolean =>
  canEditOrgProfile(currentUser, organization) || permissionGate('managePolicies')(currentUser, organization);

/** Analysis: the feedback-report routes (`manageContent`). */
export const canViewOrgAnalysis = permissionGate('manageContent');

/** Usage: the org's credit spend (`usage/index.ts`) and ledger (`admin/transactions.ts`, `admin/session-usage.ts`). */
export const canViewOrgUsage = permissionGate('viewUsage');

/**
 * The GitHub, Slack and Webhooks sections of the Integrations tab: Slack wiring (`integrations/slack/*`), the org's GitHub
 * connection, keys and PAT (`organizations/[id]/github/*`) and webhook secrets
 * (`organizations/[id]/webhooks/github*`). Connecting a GitHub source to a data lake is
 * `manageContent`, not this.
 */
export const canManageOrgIntegrations = permissionGate('manageIntegrations');

/** Groups: `assertCanManageOrgGroups` (`manageMembers`). Personal orgs have no groups. */
export const canManageOrgGroups = (
  currentUser: TabViewer,
  organization: (OrgRoleSubject & { personal?: boolean }) | null | undefined
): boolean => !!organization && !organization.personal && permissionGate('manageMembers')(currentUser, organization);

/** Connectors: the org's custom MCP connector policy and kill switch (`organizations/[id]/custom-mcp/*`). */
export const canManageOrgConnectors = permissionGate('managePolicies');

/** Audit: the team audit trail and its export (`viewAudit`, no platform-admin arm). */
export const canViewOrgAudit = canReadOrganizationAudit;

/** API keys: `organizations/[id]/api-keys/*`. */
export const canManageOrgApiKeys = permissionGate('manageKeys');

/**
 * Who may see the Billing & Subscription tab: `manageBilling` from the viewer's own role - NOT
 * `canManageOrg`, which is satisfied by any member holding `share`/`update`. The tab's actions:
 * - Subscribe        pages/api/organizations/subscriptions/subscribe.ts
 * - Change seats     pages/api/organizations/subscriptions/update-seats.ts
 * - Billing portal   pages/api/stripe/portal.ts
 * - Pay invoice      pages/api/subscriptions/pay-invoice.ts
 * Must stay in sync with those four, which all gate on `manageBilling` and so admit a platform admin.
 *
 * Nothing is lost by hiding it: the plan, its status, the renewal date and seat usage are all on
 * the Overview tab and the page header, which every member sees.
 */
export const canViewOrgBilling = permissionGate('manageBilling');

/**
 * Who may see the Domains tab: the same `manageMembers` check `loadOrgForDomainAdmin` runs for the
 * `organizations/[id]/domains/*` routes; never a personal org.
 */
export const canManageOrgDomains = (
  currentUser: TabViewer,
  organization: (OrgRoleSubject & { personal?: boolean }) | null | undefined
): boolean => !!organization && !organization.personal && permissionGate('manageMembers')(currentUser, organization);

export interface OrgTabAccess {
  canManageOrg: boolean;
  canViewUsage: boolean;
  canViewAnalysis: boolean;
  canManageIntegrations: boolean;
  canManageGroups: boolean;
  canViewBilling: boolean;
  canManageConnectors: boolean;
  canManageApiKeys: boolean;
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
  if (!access.canManageApiKeys && selected === OrganizationTabs.ApiKeys) return OrganizationTabs.Overview;
  if (!access.canManageDomains && selected === OrganizationTabs.Domains) return OrganizationTabs.Overview;
  // Billing has its own gate rather than riding canManageOrg; see canViewOrgBilling.
  if (!access.canViewBilling && selected === OrganizationTabs.Billing) return OrganizationTabs.Overview;
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
