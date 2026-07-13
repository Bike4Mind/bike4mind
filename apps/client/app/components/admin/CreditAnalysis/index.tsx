import React, { useState } from 'react';
import { Box, Tabs, TabList, Tab, TabPanel } from '@mui/joy';
import PeopleIcon from '@mui/icons-material/People';
import InsightsIcon from '@mui/icons-material/Insights';
import PriceChangeIcon from '@mui/icons-material/PriceChange';
import { MarginDashboard } from './components/MarginDashboard';
import { ModelPricingCatalog } from './components/ModelPricingCatalog';
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
      </Tabs>

      <AdminProfileModal />
    </Box>
  );
};

export default CreditAnalyticsTab;
