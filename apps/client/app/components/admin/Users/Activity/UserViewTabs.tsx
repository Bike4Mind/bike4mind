import React, { lazy, Suspense } from 'react';
import { Box, CircularProgress, Tab, TabList, Tabs } from '@mui/joy';
import {
  USER_PROFILE_TAB_LABELS,
  isUserProfileTab,
  type UserProfileTab,
} from '@client/app/components/admin/Users/Profile/userProfileSearch';

// Lazy so the chart library and the activity queries load only when an admin opens the tab.
const UserActivityPanel = lazy(() => import('./UserActivityPanel'));

/**
 * The tab strip of the admin user view. The Overview panel stays mounted (hidden) while another tab
 * is shown, so staged but unsaved edits on it survive a tab switch.
 */
export const UserViewTabs: React.FC<{
  tabs: readonly UserProfileTab[];
  value: UserProfileTab;
  onChange(value: UserProfileTab): void;
}> = ({ tabs, value, onChange }) => (
  <Tabs
    value={value}
    onChange={(_event, next) => {
      if (isUserProfileTab(next)) onChange(next);
    }}
    sx={{ bgcolor: 'transparent' }}
  >
    <TabList size="sm" sx={{ px: { xs: 1, sm: 2 }, overflowX: 'auto' }}>
      {tabs.map(tab => (
        <Tab key={tab} value={tab} data-testid={`user-profile-tab-${tab}`}>
          {USER_PROFILE_TAB_LABELS[tab]}
        </Tab>
      ))}
    </TabList>
  </Tabs>
);

export const UserActivityTabPanel: React.FC<{ userId: string }> = ({ userId }) => (
  <Suspense
    fallback={
      <Box sx={{ p: 2 }}>
        <CircularProgress size="sm" />
      </Box>
    }
  >
    <UserActivityPanel userId={userId} />
  </Suspense>
);
