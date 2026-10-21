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
