// Tab identity and visibility rules for the organization detail route.

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
  Settings = 'settings',
}

/**
 * Who may see the org's usage/spend dashboards and its feedback analysis. Mirrors the server gate
 * (apps/client/server/utils/orgAccess.ts, verifyOrgAccess): a platform admin, the org owner, or the
 * team manager - NOT every member holding manage permissions, so neither tab is offered to someone
 * the API would answer with a 404. Must stay in sync with that function.
 *
 * Exported rather than left inline in $id.tsx so the spec can exercise the predicate the page
 * actually runs; a copy of the logic declared in the test passes whatever the page does.
 */
export const canViewOrgUsage = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: { userId: string; managerId?: string | null } | null | undefined
): boolean => {
  if (!currentUser || !organization) return false;
  if (currentUser.isAdmin) return true;
  if (currentUser.id === organization.userId) return true;
  return organization.managerId === currentUser.id;
};

export interface OrgTabAccess {
  canManageOrg: boolean;
  canViewUsage: boolean;
  canManageGroups: boolean;
}

/**
 * The tab to actually show given what the caller may see - `selected` when they may see it, and
 * Overview when they may not. A tab can be selected without ever being rendered: `?tab=` is taken
 * from the URL, so a deep link is the one path that reaches a gated tab, and it is the reason this
 * is a redirect rather than only a conditional render.
 */
export const resolveAccessibleTab = (selected: OrganizationTabs, access: OrgTabAccess): OrganizationTabs => {
  const managePinned =
    selected === OrganizationTabs.Billing ||
    selected === OrganizationTabs.Integrations ||
    selected === OrganizationTabs.GitHub ||
    selected === OrganizationTabs.Webhooks ||
    selected === OrganizationTabs.Settings;
  if (!access.canManageOrg && managePinned) return OrganizationTabs.Overview;
  // Usage and Analysis share one gate: both are owner/manager surfaces the API would 404 otherwise.
  if (!access.canViewUsage && (selected === OrganizationTabs.Usage || selected === OrganizationTabs.Analysis)) {
    return OrganizationTabs.Overview;
  }
  if (!access.canManageGroups && selected === OrganizationTabs.Groups) return OrganizationTabs.Overview;
  return selected;
};
