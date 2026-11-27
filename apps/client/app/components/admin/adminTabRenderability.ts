import { AdminTab } from './adminSidebarConfig';
import { canOpenAdminTab } from './adminTabPermissions';

export interface AdminTabVisibility {
  /** The signed-in user. Required so no caller can forget a delegated admin's tab permissions. */
  user: Parameters<typeof canOpenAdminTab>[0];
  enableUserMigration?: boolean;
}

// These tabs moved into other pages; their members stay so old slugs and palette entries keep redirecting.
const RETIRED_TABS: ReadonlySet<AdminTab> = new Set([
  AdminTab.RegistrationInvites,
  AdminTab.PartnerSignupRules,
  AdminTab.HeldSignupGrants,
  AdminTab.ModelLifecycle,
  AdminTab.SecOpsTriage,
]);

/**
 * Whether the admin console can draw a panel for this tab right now, for this user. A tab that
 * cannot be drawn must not be selected, or the content pane would be blank.
 */
export function canRenderAdminTab(tab: AdminTab, visibility: AdminTabVisibility): boolean {
  // A retired tab id has no panel.
  if (AdminTab[tab] === undefined) return false;
  if (RETIRED_TABS.has(tab)) return false;
  if (!canOpenAdminTab(visibility.user, tab)) return false;
  if (tab === AdminTab.Migrate) return !!visibility.enableUserMigration;
  return true;
}
