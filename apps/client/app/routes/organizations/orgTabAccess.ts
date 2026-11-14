// Tab identity and visibility rules for the organization detail route.

import {
  canReadOrganizationAudit,
  hasOrgPermission,
  orgMemberHasPermission,
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
  Billing = 'billing',
  Integrations = 'integrations',
  GitHub = 'github',
  Webhooks = 'webhooks',
  Connectors = 'connectors',
  Domains = 'domains',
  ApiKeys = 'api-keys',
  Settings = 'settings',
  Audit = 'audit',
}

type TabViewer = { id: string; isAdmin?: boolean | null } | null | undefined;
type TabOrg = OrgRoleSubject | null | undefined;

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

/** Analysis: the feedback-report routes (`manageContent`). */
export const canViewOrgAnalysis = permissionGate('manageContent');

/** Usage: the org's credit spend (`usage/index.ts`) and ledger (`admin/transactions.ts`, `admin/session-usage.ts`). */
export const canViewOrgUsage = permissionGate('viewUsage');

/**
 * Integrations, GitHub API and Webhooks: Slack wiring (`integrations/slack/*`), the org's GitHub
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
 * Must stay in sync with those four.
 *
 * A platform admin who holds no role is deliberately excluded, though the first two routes would
 * admit them: portal.ts has no admin bypass, so an admin would still get a Billing Portal button
 * that rejects them. Admins act on an org's billing through the Admin -> Organizations panel, which
 * is the same split the page already makes for member management.
 *
 * Nothing is lost by hiding it: the plan, its status, the renewal date and seat usage are all on
 * the Overview tab and the page header, which every member sees.
 */
export const canViewOrgBilling = (currentUser: TabViewer, organization: TabOrg): boolean =>
  !!currentUser && !!organization && orgMemberHasPermission(organization, currentUser.id, 'manageBilling');

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

/**
 * The tab to actually show given what the caller may see - `selected` when they may see it, and
 * Overview when they may not. A tab can be selected without ever being rendered: `?tab=` is taken
 * from the URL, so a deep link is the one path that reaches a gated tab, and it is the reason this
 * is a redirect rather than only a conditional render.
 */
export const resolveAccessibleTab = (selected: OrganizationTabs, access: OrgTabAccess): OrganizationTabs => {
  if (!access.canViewAudit && selected === OrganizationTabs.Audit) return OrganizationTabs.Overview;
  if (!access.canManageOrg && selected === OrganizationTabs.Settings) return OrganizationTabs.Overview;
  const integrationPinned =
    selected === OrganizationTabs.Integrations ||
    selected === OrganizationTabs.GitHub ||
    selected === OrganizationTabs.Webhooks;
  if (!access.canManageIntegrations && integrationPinned) return OrganizationTabs.Overview;
  if (!access.canViewUsage && selected === OrganizationTabs.Usage) return OrganizationTabs.Overview;
  if (!access.canViewAnalysis && selected === OrganizationTabs.Analysis) return OrganizationTabs.Overview;
  if (!access.canManageGroups && selected === OrganizationTabs.Groups) return OrganizationTabs.Overview;
  if (!access.canManageConnectors && selected === OrganizationTabs.Connectors) return OrganizationTabs.Overview;
  if (!access.canManageApiKeys && selected === OrganizationTabs.ApiKeys) return OrganizationTabs.Overview;
  if (!access.canManageDomains && selected === OrganizationTabs.Domains) return OrganizationTabs.Overview;
  // Billing has its own gate rather than riding canManageOrg; see canViewOrgBilling.
  if (!access.canViewBilling && selected === OrganizationTabs.Billing) return OrganizationTabs.Overview;
  return selected;
};
