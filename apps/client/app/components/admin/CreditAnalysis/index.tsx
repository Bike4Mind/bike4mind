import React, { useState } from 'react';
import { Box, Tabs, TabList, Tab, TabPanel } from '@mui/joy';
import PeopleIcon from '@mui/icons-material/People';
import InsightsIcon from '@mui/icons-material/Insights';
import PriceChangeIcon from '@mui/icons-material/PriceChange';
import BusinessIcon from '@mui/icons-material/Business';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import HistoryIcon from '@mui/icons-material/History';
import { MarginDashboard } from './components/MarginDashboard';
import { ModelPricingCatalog } from './components/ModelPricingCatalog';
import { OrgUsageDashboard } from './components/OrgUsageDashboard';
import { TransactionLedger } from './components/TransactionLedger';
import { CreditAdjustmentsLog } from './components/CreditAdjustmentsLog';
import { UserCreditsManager } from './components/UserCreditsManager';
import AdminProfileModal from '../AdminProfileModal';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

export const CreditAnalyticsTab: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('users');

  return (
    <Box sx={{ height: '100%', overflow: 'auto', px: 2, py: 1 }}>
      <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value as string)} sx={{ mb: 2 }}>
        <TabList sx={{ overflowX: { xs: 'auto', sm: 'visible' }, minWidth: { xs: 'max-content', sm: 'auto' } }}>
          <Tab value="users">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <PeopleIcon sx={{ fontSize: '18px' }} />
              <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>User Credits</Box>
            </Box>
          </Tab>
          <Tab value="pricing" data-testid="credit-analysis-pricing-tab">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <PriceChangeIcon sx={{ fontSize: '18px' }} />
              <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>Model Pricing</Box>
            </Box>
          </Tab>
          <Tab value="margins" data-testid="credit-analysis-margins-tab">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <InsightsIcon sx={{ fontSize: '18px' }} />
              <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>Margins</Box>
            </Box>
          </Tab>
          <Tab value="org-usage" data-testid="credit-analysis-org-usage-tab">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <BusinessIcon sx={{ fontSize: '18px' }} />
              <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>Org Usage</Box>
            </Box>
          </Tab>
          <Tab value="ledger" data-testid="credit-analysis-ledger-tab">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <ReceiptLongIcon sx={{ fontSize: '18px' }} />
              <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>Ledger</Box>
            </Box>
          </Tab>
          <Tab value="adjustments" data-testid="credit-analysis-adjustments-tab">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <HistoryIcon sx={{ fontSize: '18px' }} />
              <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>Adjustments</Box>
            </Box>
          </Tab>
          <ContextHelpButton helpId="admin/credit-analytics" tooltipText="Credit Analytics Help" />
        </TabList>

        <TabPanel value="users" sx={{ p: 0 }}>
          <UserCreditsManager />
        </TabPanel>

        <TabPanel value="pricing" sx={{ p: 0 }}>
          <ModelPricingCatalog />
        </TabPanel>

        <TabPanel value="margins" sx={{ p: 0 }}>
          <MarginDashboard />
        </TabPanel>

        <TabPanel value="org-usage" sx={{ p: 0 }}>
          <OrgUsageDashboard />
        </TabPanel>

        <TabPanel value="ledger" sx={{ p: 0 }}>
          <TransactionLedger />
        </TabPanel>

        <TabPanel value="adjustments" sx={{ p: 0 }}>
          <CreditAdjustmentsLog />
        </TabPanel>
      </Tabs>

      <AdminProfileModal />
    </Box>
  );
};

export default CreditAnalyticsTab;
