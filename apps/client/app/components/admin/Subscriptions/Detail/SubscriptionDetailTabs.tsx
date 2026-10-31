import React from 'react';
import { Tab, TabList, Tabs } from '@mui/joy';
import {
  SUBSCRIPTION_DETAIL_TABS,
  SUBSCRIPTION_DETAIL_TAB_LABELS,
  isSubscriptionDetailTab,
  type SubscriptionDetailTab,
} from './subscriptionDetailSearch';

export const subscriptionDetailTabId = (tab: SubscriptionDetailTab) => `subscription-detail-tab-${tab}`;
export const subscriptionDetailPanelId = (tab: SubscriptionDetailTab) => `subscription-detail-panel-${tab}`;

/** The detail page's tab strip; the selected tab lives in the URL as `?tab=` (the route owns it). */
export const SubscriptionDetailTabs: React.FC<{
  value: SubscriptionDetailTab;
  onChange: (tab: SubscriptionDetailTab) => void;
}> = ({ value, onChange }) => (
  <Tabs
    value={value}
    onChange={(_event, next) => {
      if (isSubscriptionDetailTab(next)) onChange(next);
    }}
    aria-label="Subscription sections"
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
      {SUBSCRIPTION_DETAIL_TABS.map(tab => (
        <Tab
          key={tab}
          value={tab}
          id={subscriptionDetailTabId(tab)}
          // Only the selected tab's panel is rendered, so only it has a panel to point at.
          aria-controls={tab === value ? subscriptionDetailPanelId(tab) : undefined}
          indicatorInset
          data-testid={`subscription-detail-tab-${tab}`}
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
          {SUBSCRIPTION_DETAIL_TAB_LABELS[tab]}
        </Tab>
      ))}
    </TabList>
  </Tabs>
);
