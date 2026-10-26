import { hasAdminPermission, type AdminPermissionId, type IUserDocument } from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';

// Legacy AdminTab values with neither a panel nor a sidebar entry.
const PANEL_LESS_TABS: ReadonlySet<AdminTab> = new Set([AdminTab.Accounts, AdminTab.Analysts, AdminTab.BulkImport]);

export interface AdminTabVisibility {
  enableUserMigration?: boolean;
  /** Undefined until the visibility query answers. */
  liveOpsTriage?: boolean;
}

/**
 * Whether the admin console can draw a panel for this tab right now. A tab that cannot be drawn
 * must not be selected, or the content pane would be blank.
 */
export function canRenderAdminTab(tab: AdminTab, visibility: AdminTabVisibility = {}): boolean {
  if (tab === AdminTab.Migrate) return !!visibility.enableUserMigration;
  // Keep a deep link that arrived before the visibility query answered.
  if (tab === AdminTab.LiveOpsTriage) return visibility.liveOpsTriage ?? true;
  return !PANEL_LESS_TABS.has(tab);
}

export const permissionForAdminTab = (tab: AdminTab): AdminPermissionId => {
  if (tab === AdminTab.Users) return 'support:read';
  if (tab === AdminTab.EmbedKeys) return 'keys:revoke';
  return 'settings:manage';
};

export const canAccessAdminTab = (user: IUserDocument | null, tab: AdminTab): boolean =>
  hasAdminPermission(user, permissionForAdminTab(tab)) ||
  (tab === AdminTab.EmbedKeys && hasAdminPermission(user, 'settings:manage')) ||
  ((tab === AdminTab.CreditAnalytics || tab === AdminTab.Organizations) &&
    hasAdminPermission(user, 'credits:adjust')) ||
  (tab === AdminTab.PublishedPages && hasAdminPermission(user, 'users:moderate'));
