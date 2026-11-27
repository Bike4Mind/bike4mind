import type { AdminActionCountKey } from '@bike4mind/server-utils/app/components/admin/adminActionCounts';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import { SIDEBAR_SECTIONS, type AdminTab, type SidebarItem, type SidebarSection } from '../adminSidebarConfig';
import { adminTabFromSlug } from '../adminTabSlugs';

const SIDEBAR_ITEMS: readonly SidebarItem[] = SIDEBAR_SECTIONS.flatMap(section => section.items);

/** The sidebar item for a tab, so the dashboard reuses its label and icon. */
export const sidebarItemForTab = (tab: AdminTab): SidebarItem | undefined =>
  SIDEBAR_ITEMS.find(item => item.tab === tab);

/**
 * The tab that works each action-count queue. Derived from the sidebar badges (`badge` and
 * `delegateBadge`) so it cannot drift from where the sidebar shows the same count.
 */
export const ACTION_COUNT_TABS: ReadonlyMap<AdminActionCountKey, AdminTab> = new Map(
  SIDEBAR_ITEMS.flatMap(item => {
    const keys: AdminActionCountKey[] = [];
    if (item.badge && item.badge !== 'newSubscriptions') keys.push(item.badge);
    if (item.delegateBadge) keys.push(item.delegateBadge);
    return keys.map(key => [key, item.tab] as const);
  })
);

/**
 * The sidebar's Pinned group: copies of the pinned tabs' items, listed above Overview. Each copy gets
 * its own testid so it never collides with the item in its home section.
 */
export function pinnedSidebarSection(
  pins: readonly string[],
  canOpenTab: (tab: AdminTab) => boolean
): SidebarSection | null {
  const items = pins.flatMap(slug => {
    const tab = adminTabFromSlug(slug);
    const item = tab === undefined ? undefined : sidebarItemForTab(tab);
    return item && canOpenTab(item.tab) ? [{ ...item, testid: `admin-sidebar-pinned-${slug}`, pinned: true }] : [];
  });
  return items.length > 0 ? { key: 'pinned', Icon: PushPinOutlinedIcon, label: 'Pinned', items } : null;
}
