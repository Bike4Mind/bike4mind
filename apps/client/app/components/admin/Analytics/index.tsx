import React, { useCallback, useRef } from 'react';
import { Sheet, Stack, LinearProgress, Box, Grid, Tabs, TabList, Tab } from '@mui/joy';
import DescriptionIcon from '@mui/icons-material/Description';
import PeopleIcon from '@mui/icons-material/People';
import AnalyticsIcon from '@mui/icons-material/Analytics';
import { UserActivityTab } from './tabs/UserActivityTab';
import { DailyReportTab } from './tabs/DailyReportTab';
import { WeeklyReportTab } from './tabs/WeeklyReportTab';
import { useAnalyticsData } from '@client/app/hooks/useAnalyticsData';
import { AnalyticsSubTab, TABS } from './types';
import { useAnalyticsStore } from './store';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

const AnalyticsTab: React.FC = () => {
  const { activeSubTab, setActiveSubTab } = useAnalyticsStore();

  const analyticsQuery = useAnalyticsData();

  const isLoading = analyticsQuery.isLoading || analyticsQuery.isFetching;

  const handleRefresh = useCallback(() => {
    analyticsQuery.refetch();
  }, [analyticsQuery]);

  const exportFunctionRef = useRef<(() => void) | null>(null);

  const getTabIcon = (tabId: AnalyticsSubTab) => {
    switch (tabId) {
      case AnalyticsSubTab.UserActivity:
        return <PeopleIcon sx={{ fontSize: '18px' }} />;
      case AnalyticsSubTab.DailyReport:
        return <DescriptionIcon sx={{ fontSize: '18px' }} />;
      case AnalyticsSubTab.WeeklyReport:
        return <AnalyticsIcon sx={{ fontSize: '18px' }} />;
      default:
        return <AnalyticsIcon sx={{ fontSize: '18px' }} />;
    }
  };

  return (
    <Sheet sx={{ overflow: 'hidden', width: '100%', px: 2 }}>
      <Grid container>
        <Grid xs={12}>
          <Stack direction="column" justifyContent={'center'} spacing={1} sx={{ width: '100%' }}>
            <Stack direction="column" spacing={1} sx={{ mb: 3, pt: 1 }}>
              {/* Analytics Tabs */}
              <Tabs
                value={activeSubTab}
                onChange={(_, value) => setActiveSubTab(value as AnalyticsSubTab)}
                sx={{ mb: 2, overflowX: { xs: 'auto', sm: 'visible' } }}
              >
                <TabList sx={{ minWidth: { xs: 'max-content', sm: 'auto' } }}>
                  {Object.values(TABS).map(tab => (
                    <Tab key={tab.id} value={tab.id}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        {getTabIcon(tab.id)}
                        <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>{tab.label}</Box>
                      </Box>
                    </Tab>
                  ))}
                  <Box sx={{ ml: '5px', display: 'flex', alignItems: 'center' }}>
                    <ContextHelpButton helpId="admin/analytics" tooltipText="Analytics Help" />
                  </Box>
                </TabList>
              </Tabs>
            </Stack>
          </Stack>
        </Grid>

        {isLoading && <LinearProgress size={'lg'} sx={{ marginX: '5px', width: '100%' }} />}

        {!isLoading && (
          <Grid xs={12} mt={0.5}>
            <Sheet sx={{ width: '100%' }}>
              {activeSubTab === AnalyticsSubTab.UserActivity && (
                <UserActivityTab
                  rawData={analyticsQuery.data?.logs || []}
                  loading={isLoading}
                  onRefresh={handleRefresh}
                  onExport={exportFunctionRef}
                />
              )}

              {activeSubTab === AnalyticsSubTab.DailyReport && (
                <DailyReportTab
                  rawData={analyticsQuery.data?.reports || []}
                  loading={isLoading}
                  onRefresh={handleRefresh}
                />
              )}

              {activeSubTab === AnalyticsSubTab.WeeklyReport && (
                <WeeklyReportTab
                  rawData={analyticsQuery.data?.reports || []}
                  loading={isLoading}
                  onRefresh={handleRefresh}
                />
              )}
            </Sheet>
          </Grid>
        )}
      </Grid>
    </Sheet>
  );
};

export default AnalyticsTab;
