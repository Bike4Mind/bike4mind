import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { registerSurfaceChatContextProvider, type SurfaceChatContext } from '@client/app/utils/surfaceChatContext';
import { AdminTab, SIDEBAR_SECTIONS } from './adminSidebarConfig';
import { adminTabToSlug } from './adminTabSlugs';
import { ADMIN_TAB_PARAMS, parseAdminSearch } from './adminTabParams';

function describeTab(tab: AdminTab): string | null {
  const slug = adminTabToSlug(tab);
  if (!slug) return null;
  for (const section of SIDEBAR_SECTIONS) {
    const item = section.items.find(candidate => candidate.tab === tab);
    if (item) return `Admin > ${section.label} > ${item.label} (tab: ${slug})`;
  }
  return null;
}

/** The tab's own search params that are set (a selected user id, a filter), as `key=value` lines. */
function describeTabSelection(tab: AdminTab, rawSearch: Record<string, unknown>): string | null {
  const slug = adminTabToSlug(tab);
  const owned: readonly string[] = (slug && (ADMIN_TAB_PARAMS as Record<string, readonly string[]>)[slug]) || [];
  const parsed: Record<string, unknown> = parseAdminSearch(rawSearch);
  const pairs = owned.flatMap(key => {
    const value = parsed[key];
    return value === undefined || value === null || value === '' ? [] : [`${key}=${String(value)}`];
  });
  return pairs.length > 0 ? `Selection on the open admin tab: ${pairs.join(', ')}` : null;
}

/**
 * Tells the chat which admin tab is open while the admin page is mounted. Search is read from the
 * router when a message is sent, so it reflects the URL at that moment, not at registration.
 * An active tab that is not an AdminTab (null, a stale id) contributes nothing.
 */
export function useAdminAssistantChatContext(activeTab: AdminTab | string | null): void {
  const router = useRouter();

  useEffect(() => {
    if (typeof activeTab !== 'number') return;
    return registerSurfaceChatContextProvider((): SurfaceChatContext => {
      const rawSearch = router.state.location.search as Record<string, unknown>;
      return {
        viewDescription: describeTab(activeTab),
        briefContext: describeTabSelection(activeTab, rawSearch),
      };
    });
  }, [activeTab, router]);
}
