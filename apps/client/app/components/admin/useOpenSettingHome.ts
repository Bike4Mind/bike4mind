import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AdminTab } from './adminSidebarConfig';
import { ADMIN_WAITLIST_TAB_SLUG, adminSearchForTab, type AdminSearch } from './adminTabParams';
import { INVITE_CENTER_SECTION_PARAM } from './inviteCenterSearch';
import type { SettingHome } from './settingHomes';
import { useAdminModal } from './useAdminModal';

/** Opens a setting's home page. Kept apart from settingHomes.ts so the Growth tab can use it without an import cycle. */
export function useOpenSettingHome() {
  const navigate = useNavigate();
  const setActiveTab = useAdminModal(state => state.setActiveTab);

  return useCallback(
    (home: Pick<SettingHome, 'inviteSection'>) => {
      const section = home.inviteSection;
      if (!section) {
        setActiveTab(AdminTab.GrowthPricing);
        return;
      }
      // Navigate with the tab slug instead of setting the store: the store-to-URL mirror would
      // rebuild the search and drop the section (see InviteCenterShell).
      void navigate({
        to: '/admin',
        search: (previous: AdminSearch) => ({
          ...adminSearchForTab(previous, ADMIN_WAITLIST_TAB_SLUG),
          [INVITE_CENTER_SECTION_PARAM]: section,
        }),
        replace: true,
      });
    },
    [navigate, setActiveTab]
  );
}
