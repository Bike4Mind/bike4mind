import { useEffect } from 'react';
import { Box, Tab, TabList, TabPanel, Tabs } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import HudDashboard from '@client/app/components/hud/HudDashboard';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const TABS = ['keep'] as const;
type TabValue = (typeof TABS)[number];

function isValidTab(value: unknown): value is TabValue {
  return typeof value === 'string' && TABS.includes(value as TabValue);
}

export default function HudPage() {
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();

  // Legacy deep-link: /hud?tab=tavern redirects to the promoted /tavern route.
  // Must run before the hasInvalidTab normalization below so the redirect fires
  // instead of being swallowed by the ?tab=keep rewrite.
  useEffect(() => {
    if (search.tab === 'tavern') {
      void navigate({ to: '/tavern', replace: true } as never);
    }
  }, [search.tab, navigate]);

  const requestedTab: TabValue = isValidTab(search.tab) ? search.tab : 'keep';

  // Normalize an invalid ?tab= so the URL matches the rendered tab.
  const hasInvalidTab = search.tab !== undefined && !isValidTab(search.tab) && search.tab !== 'tavern';
  useEffect(() => {
    if (hasInvalidTab) {
      void navigate({ to: '/hud', search: { tab: requestedTab }, replace: true } as never);
    }
  }, [hasInvalidTab, requestedTab, navigate]);

  useDocumentTitle('The Keep - HUD');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Tabs
        value={requestedTab}
        onChange={(_e, value) => {
          const tab = value as TabValue;
          void navigate({ to: '/hud', search: { tab } } as never);
        }}
        sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        <TabList>
          <Tab value="keep">The Keep</Tab>
        </TabList>

        <TabPanel value="keep" sx={{ p: 0, flex: 1, minHeight: 0, overflow: 'auto' }}>
          <HudDashboard />
        </TabPanel>
      </Tabs>
    </Box>
  );
}
