// Tab identity and visibility rules for the organization detail route.

import { canReadOrganizationAudit, hasOrgPermission, type OrgPermission, type OrgRoleSubject } from '@bike4mind/common';

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
 * Who may open and edit the Settings tab (and the header's Settings button). Mirrors
 * organizationService.update: every field there is org-wide, so the gate is the team role
 * (`managePolicies`), never a sharing-ACL row. The page computes it once and passes it down.
 */
export const canManageOrgSettings = permissionGate('managePolicies');

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
 * Everyone else who manages the team (`isOrgOwnerOrCurrentAdmin`: managers) gets a locked entry
 * with a read-only summary instead, see `isOrgTabLocked`.
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
  /**
   * Owner, current manager or platform admin. Such a caller gets an owner-only tab they cannot open
   * as a locked rail entry instead of having it vanish; a plain member is not shown admin tabs at all.
   */
  seesLockedTabs?: boolean;
}

/**
 * Who may open each gated tab, for the notice a caller sees when a deep link names one they cannot.
 * Tabs open to every member are absent. Billing is owner-only (canViewOrgBilling); every other gated
 * tab admits the owner and current managers.
 */
export const ORG_TAB_AUDIENCE: Readonly<Partial<Record<OrganizationTabs, 'owner' | 'managers'>>> = {
  [OrganizationTabs.Groups]: 'managers',
  [OrganizationTabs.Usage]: 'managers',
  [OrganizationTabs.Analysis]: 'managers',
  [OrganizationTabs.Integrations]: 'managers',
  [OrganizationTabs.Billing]: 'owner',
  [OrganizationTabs.Domains]: 'managers',
  [OrganizationTabs.ApiKeys]: 'managers',
  [OrganizationTabs.Audit]: 'managers',
  [OrganizationTabs.Settings]: 'managers',
};

/** Owner-only tabs shown to a manager as a locked entry with a read-only summary. */
export const isOrgTabLocked = (tab: OrganizationTabs, access: OrgTabAccess): boolean =>
  tab === OrganizationTabs.Billing && !!access.seesLockedTabs && !access.canViewBilling;

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

export interface OrgTabView {
  /** The tab to select. */
  tab: OrganizationTabs;
  /** The tab is owner-only and shows its locked panel rather than its content. */
  locked: boolean;
  /** The requested tab, when the caller may not open it and was sent to Overview instead. */
  denied?: OrganizationTabs;
}

/**
 * resolveAccessibleTab, except that a locked tab stays selected (it renders its locked panel) and a
 * refused one is reported, so the page can say why the link landed on Overview.
 */
export const resolveOrgTabView = (requested: OrganizationTabs, access: OrgTabAccess): OrgTabView => {
  if (isOrgTabLocked(requested, access)) return { tab: requested, locked: true };
  const tab = resolveAccessibleTab(requested, access);
  return tab === requested ? { tab, locked: false } : { tab, locked: false, denied: requested };
};

/** The Integrations sub-section to show: the requested one when visible, else the first visible. */
export const resolveIntegrationSection = (
  requested: string | undefined,
  access: Pick<OrgTabAccess, 'canManageIntegrations' | 'canManageConnectors'>
): IntegrationSections | undefined => {
  const visible = visibleIntegrationSections(access);
  return visible.find(section => section === requested) ?? visible[0];
};
