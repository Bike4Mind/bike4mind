import React, { lazy, Suspense } from 'react';
import { Box, CircularProgress, Tab, TabList, Tabs } from '@mui/joy';

export type UserViewTab = 'overview' | 'activity';

// Lazy so the chart library and the activity queries load only when an admin opens the tab.
const UserActivityPanel = lazy(() => import('./UserActivityPanel'));

/**
 * The tab strip of the admin user view. The Overview panel stays mounted (hidden) while Activity is
 * shown, so staged but unsaved edits on it survive a tab switch.
 */
export const UserViewTabs: React.FC<{ value: UserViewTab; onChange(value: UserViewTab): void }> = ({
  value,
  onChange,
}) => (
  <Tabs
    value={value}
    onChange={(_event, next) => {
      if (next === 'overview' || next === 'activity') onChange(next);
    }}
    sx={{ bgcolor: 'transparent' }}
  >
    <TabList size="sm" sx={{ px: { xs: 1, sm: 2 } }}>
      <Tab value="overview" data-testid="user-view-overview-tab">
        Overview
      </Tab>
      <Tab value="activity" data-testid="user-view-activity-tab">
        Activity
      </Tab>
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
