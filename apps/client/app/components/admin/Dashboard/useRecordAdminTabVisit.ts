import { useEffect } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { AdminTab } from '../adminSidebarConfig';
import { adminTabToSlug } from '../adminTabSlugs';
import { useAdminPageVisits } from './adminPageVisits';

/** A tab counts once it has stayed open this long, so a stale tab shown before URL sync, or a click-through, does not. */
export const VISIT_DWELL_MS = 1500;

/**
 * Counts each tab the admin opens, for the dashboard's "Jump back in" row. Neither the dashboard
 * itself nor a non-tab string (a detail route) is counted.
 */
export function useRecordAdminTabVisit(activeTab: AdminTab | string | null | undefined) {
  const userId = useUser(state => state.currentUser?.id);
  const recordVisit = useAdminPageVisits(state => state.recordVisit);
  useEffect(() => {
    if (!userId || typeof activeTab !== 'number' || activeTab === AdminTab.Dashboard) return;
    const slug = adminTabToSlug(activeTab);
    if (!slug) return;
    const timer = setTimeout(() => recordVisit(userId, slug), VISIT_DWELL_MS);
    return () => clearTimeout(timer);
  }, [userId, activeTab, recordVisit]);
}
