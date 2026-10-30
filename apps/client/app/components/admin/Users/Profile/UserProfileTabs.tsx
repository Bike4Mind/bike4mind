import React from 'react';
import { Tab, TabList, Tabs } from '@mui/joy';
import { USER_PROFILE_TABS, USER_PROFILE_TAB_LABELS, isUserProfileTab, type UserProfileTab } from './userProfileSearch';

/** The profile's tab strip; the selected tab lives in the URL as `?tab=` (the route owns it). */
export const UserProfileTabs: React.FC<{ value: UserProfileTab; onChange: (tab: UserProfileTab) => void }> = ({
  value,
  onChange,
}) => (
  <Tabs
    value={value}
    onChange={(_event, next) => {
      if (isUserProfileTab(next)) onChange(next);
    }}
    aria-label="Profile sections"
    sx={{ bgcolor: 'transparent' }}
  >
    <TabList
      disableUnderline
      sx={{
        gap: 2.5,
        overflowX: 'auto',
        scrollbarWidth: 'none',
        borderBottom: '1px solid',
        borderColor: 'admin.border',
        '--Tab-indicatorThickness': '2px',
        '--Tab-indicatorColor': 'var(--joy-palette-admin-ink)',
      }}
    >
      {USER_PROFILE_TABS.map(tab => (
        <Tab
          key={tab}
          value={tab}
          indicatorInset
          data-testid={`user-profile-tab-${tab}`}
          sx={{
            flex: 'none',
            minHeight: 40,
            px: 0.5,
            fontSize: 14,
            fontWeight: 500,
            bgcolor: 'transparent',
            color: 'admin.inkMuted',
            '&:hover': { bgcolor: 'transparent', color: 'admin.ink' },
            '&.Mui-selected': { bgcolor: 'transparent', color: 'admin.ink' },
          }}
        >
          {USER_PROFILE_TAB_LABELS[tab]}
        </Tab>
      ))}
    </TabList>
  </Tabs>
);
