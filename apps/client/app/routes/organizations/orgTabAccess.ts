// Tab identity and visibility rules for the organization detail route.

import { isOrgOwnerOrCurrentAdmin, isOrgOwnerOrPlatformAdmin, type AdministrableOrg } from '@bike4mind/common';
import { hasOrgUpdateAccess } from '@client/app/utils/orgAccessGate';

export enum OrganizationTabs {
  Overview = 'overview',
  Members = 'members',
  Groups = 'groups',
  Usage = 'usage',
  Analysis = 'analysis',
  Billing = 'billing',
  Integrations = 'integrations',
  GitHub = 'github',
  Webhooks = 'webhooks',
  Connectors = 'connectors',
  Settings = 'settings',
}

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

/** `isOrgOwnerOrPlatformAdmin`, failing closed while the user or org is still loading. */
const ownerTierGate = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: { userId: string } | null | undefined
): boolean => !!currentUser && !!organization && isOrgOwnerOrPlatformAdmin(currentUser, organization);

/**
 * Who may see the Usage tab - the org's credit spend (`usage/index.ts`) and its ledger
 * (`admin/transactions.ts`, `admin/session-usage.ts`), all `verifyOrgOwner`. Owner or platform
 * admin; managers are refused.
 */
export const canViewOrgUsage = ownerTierGate;

/**
 * Who may see the Integrations, GitHub API and Webhooks tabs - Slack wiring
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
 * Who may see the Connectors tab - the org's custom MCP connector policy and kill switch
 * (`organizations/[id]/custom-mcp/*`, `verifyOrgAccess`). Owner, current manager or platform admin;
 * must stay in sync with that gate.
 */
export const canManageOrgConnectors = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: AdministrableOrg | null | undefined
): boolean => !!currentUser && !!organization && isOrgOwnerOrCurrentAdmin(currentUser, organization);

export interface OrgTabAccess {
  canManageOrg: boolean;
  canViewUsage: boolean;
  canViewAnalysis: boolean;
  canManageIntegrations: boolean;
  canManageGroups: boolean;
  canViewBilling: boolean;
  canManageConnectors: boolean;
}

/**
 * The tab to actually show given what the caller may see - `selected` when they may see it, and
 * Overview when they may not. A tab can be selected without ever being rendered: `?tab=` is taken
 * from the URL, so a deep link is the one path that reaches a gated tab, and it is the reason this
 * is a redirect rather than only a conditional render.
 */
export const resolveAccessibleTab = (selected: OrganizationTabs, access: OrgTabAccess): OrganizationTabs => {
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
  // Billing has its own gate rather than riding canManageOrg: every action on it is owner-only.
  if (!access.canViewBilling && selected === OrganizationTabs.Billing) return OrganizationTabs.Overview;
  return selected;
};
