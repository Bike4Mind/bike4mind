import { Box, Tab, TabList, TabPanel, Tabs } from '@mui/joy';
import React, { useState } from 'react';
import SecurityDashboard from './SecurityDashboard';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

const SecurityDashboardMock: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'react'>('react');

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        minHeight: '600px',
        border: 'none',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Tabs
        value={activeTab}
        onChange={(_, value) => setActiveTab(value as 'react')}
        sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <TabList sx={{ flex: 1 }}>
            <Tab
              value="react"
              data-testid="security-dashboard-react-inner-tab-btn"
              sx={{ fontWeight: 'md', textTransform: 'none' }}
            >
              Security Dashboard (Mock)
            </Tab>
          </TabList>
          <ContextHelpButton helpId="admin/security-dashboard" tooltipText="Security Dashboard Help" />
        </Box>

        <TabPanel
          value="react"
          sx={{
            p: 0,
            flex: 1,
            overflow: 'auto',
          }}
        >
          <Box
            sx={{
              width: '100%',
              height: '100%',
              minHeight: '600px',
              border: 'none',
            }}
          >
            <SecurityDashboard />
          </Box>
        </TabPanel>
      </Tabs>
    </Box>
  );
};

export default SecurityDashboardMock;
