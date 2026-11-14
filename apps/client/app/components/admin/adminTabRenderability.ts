import { AdminTab } from './adminSidebarConfig';
import { canOpenAdminTab } from './adminTabPermissions';

export interface AdminTabVisibility {
  /** The signed-in user. Required so no caller can forget a delegated admin's tab permissions. */
  user: Parameters<typeof canOpenAdminTab>[0];
  enableUserMigration?: boolean;
  /** Undefined until the visibility query answers. */
  liveOpsTriage?: boolean;
}

/**
 * Whether the admin console can draw a panel for this tab right now, for this user. A tab that
 * cannot be drawn must not be selected, or the content pane would be blank.
 */
export function canRenderAdminTab(tab: AdminTab, visibility: AdminTabVisibility): boolean {
  // A retired tab id has no panel.
  if (AdminTab[tab] === undefined) return false;
  // Model lifecycle moved into the Models tab; its member stays only so its slug and palette entry keep resolving.
  if (tab === AdminTab.ModelLifecycle) return false;
  if (!canOpenAdminTab(visibility.user, tab)) return false;
  if (tab === AdminTab.Migrate) return !!visibility.enableUserMigration;
  // Keep a deep link that arrived before the visibility query answered.
  if (tab === AdminTab.LiveOpsTriage) return visibility.liveOpsTriage ?? true;
  return true;
}
