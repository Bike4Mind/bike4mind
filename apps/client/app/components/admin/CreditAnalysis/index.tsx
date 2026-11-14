import React from 'react';
import { Stack, Tabs, TabList, Tab, TabPanel } from '@mui/joy';
import { MarginDashboard } from './components/MarginDashboard';
import { UsageDashboard } from './components/UsageDashboard';
import { PlatformUsageDashboard } from './components/PlatformUsageDashboard';
import { CreditHolderType } from '@bike4mind/common';
import { TransactionLedger } from './components/TransactionLedger';
import { CreditAdjustmentsLog } from './components/CreditAdjustmentsLog';
import { UserCreditsManager } from './components/UserCreditsManager';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useCreditAnalysisStore, type CreditAnalysisTab } from './store';
import { AdminPageHeader } from '../shared';
import { ADMIN_REGION_GAP, adminTabStrip } from '../shared/adminStyles';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CreditEconomy } from './components/CreditEconomy';

export const CreditAnalyticsTab: React.FC = () => {
  const activeTab = useCreditAnalysisStore(state => state.activeTab);
  const setActiveTab = useCreditAnalysisStore(state => state.setActiveTab);
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const selectedTab = search.creditView === 'economy' ? 'economy' : activeTab;

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }}>
      <AdminPageHeader
        title="Credits"
        description="Balances, margins and credit usage across the platform."
        actions={<ContextHelpButton helpId="admin/credit-analytics" tooltipText="Credit analytics help" />}
      />
      <Tabs
        value={selectedTab}
        onChange={(_, value) => {
          setActiveTab(value as CreditAnalysisTab);
          void navigate({
            to: '/admin',
            replace: true,
            search: previous => ({ ...previous, creditView: value === 'economy' ? 'economy' : undefined }),
          });
        }}
        sx={{ minWidth: 0, gap: ADMIN_REGION_GAP }}
      >
        <TabList sx={adminTabStrip}>
          <Tab value="economy" data-testid="credit-analysis-economy-tab">
            Economy
          </Tab>
          <Tab value="users" data-testid="credit-analysis-users-tab">
            User credits
          </Tab>

          <Tab value="margins" data-testid="credit-analysis-margins-tab">
            Margins
          </Tab>
          <Tab value="org-usage" data-testid="credit-analysis-org-usage-tab">
            Org usage
          </Tab>
          <Tab value="api-usage" data-testid="credit-analysis-api-usage-tab">
            API usage
          </Tab>
          <Tab value="ledger" data-testid="credit-analysis-ledger-tab">
            Ledger
          </Tab>
          <Tab value="adjustments" data-testid="credit-analysis-adjustments-tab">
            Adjustments
          </Tab>
        </TabList>

        <TabPanel value="economy" sx={{ p: 0 }}>
          <CreditEconomy />
        </TabPanel>
        <TabPanel value="users" sx={{ p: 0 }}>
          <UserCreditsManager />
        </TabPanel>

        <TabPanel value="margins" sx={{ p: 0 }}>
          <MarginDashboard />
        </TabPanel>

        <TabPanel value="org-usage" sx={{ p: 0 }}>
          <UsageDashboard ownerType={CreditHolderType.Organization} />
        </TabPanel>

        <TabPanel value="api-usage" sx={{ p: 0 }}>
          <PlatformUsageDashboard />
        </TabPanel>

        <TabPanel value="ledger" sx={{ p: 0 }}>
          <TransactionLedger />
        </TabPanel>

        <TabPanel value="adjustments" sx={{ p: 0 }}>
          <CreditAdjustmentsLog />
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

export default CreditAnalyticsTab;
