import React, { useState } from 'react';
import { Box, Button, Sheet, Stack, Tab, TabList, TabPanel, Tabs, Typography, useTheme } from '@mui/joy';
import {
  HomeRounded,
  PersonSearch as PersonSearchIcon,
  Lock,
  Key,
  MailOutlined,
  History as HistoryIcon,
  Block as BlockIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { useQueryClient } from '@tanstack/react-query';
import SecurityOverviewTab from './overview/SecurityOverviewTab';
import SuspiciousLoginsTab from './tabs/SuspiciousLoginsTab';
import FailedLoginsTab from './tabs/FailedLoginsTab';
import ApiKeyStatusTab from './tabs/ApiKeyStatusTab';
import PhishingTestTab from './tabs/PhishingTestTab';
import RecentActivityTab from './tabs/RecentActivityTab';
import BlockedIPsTab from './tabs/BlockedIPsTab';

type SecurityTabId =
  | 'overview'
  | 'suspicious-logins'
  | 'failed-logins'
  | 'api-keys'
  | 'phishing'
  | 'activity'
  | 'blocked-ips';

const SECURITY_QUERY_KEYS = [
  ['security', 'user', 'summary'],
  ['security', 'user', 'recent', '24h'],
  ['security', 'user', 'recent', '7d'],
  ['security', 'blocked-ips'],
  ['admin', 'security', 'api-usage'],
  ['admin', 'security', 'behavioral-summary'],
] as const;

const SecurityTabLayout: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SecurityTabId>('overview');
  const queryClient = useQueryClient();
  const theme = useTheme();

  const handleRefresh = async () => {
    await Promise.all(SECURITY_QUERY_KEYS.map(key => queryClient.invalidateQueries({ queryKey: key })));
  };

  return (
    <Box data-testid="security-tab-layout" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Page header */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'flex-start' }}
        flexWrap="wrap"
        gap={1.5}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography level="h3">Security Dashboard</Typography>
          <Typography level="body-sm" sx={{ color: theme.palette.text.secondary }}>
            Monitor your account security, login events, API key activity, and AI-powered behavioral risk assessment.
          </Typography>
        </Box>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<RefreshIcon fontSize="small" />}
          onClick={handleRefresh}
          data-testid="security-summary-refresh-btn"
          sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'auto' } }}
        >
          Refresh
        </Button>
      </Stack>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={(_, val) => {
          if (typeof val === 'string' && val !== '') {
            setActiveTab(val as SecurityTabId);
          }
        }}
        sx={{ backgroundColor: 'transparent' }}
      >
        <Sheet variant="outlined" sx={{ borderRadius: 'md', mb: 2, overflow: 'hidden' }}>
          <TabList
            sx={{
              overflowX: 'auto',
              flexWrap: 'nowrap',
              '&::-webkit-scrollbar': { height: 4 },
            }}
          >
            <Tab value="overview" data-testid="security-tab-overview" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
              <Stack direction="row" gap={0.75} alignItems="center">
                <HomeRounded fontSize="small" />
                <span>Overview</span>
              </Stack>
            </Tab>
            <Tab
              value="suspicious-logins"
              data-testid="security-tab-suspicious-logins"
              sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <Stack direction="row" gap={0.75} alignItems="center">
                <PersonSearchIcon fontSize="small" />
                <span>Suspicious Logins</span>
              </Stack>
            </Tab>
            <Tab
              value="failed-logins"
              data-testid="security-tab-failed-logins"
              sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <Stack direction="row" gap={0.75} alignItems="center">
                <Lock fontSize="small" />
                <span>Failed Login Attempts</span>
              </Stack>
            </Tab>
            <Tab value="api-keys" data-testid="security-tab-api-keys" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
              <Stack direction="row" gap={0.75} alignItems="center">
                <Key fontSize="small" />
                <span>API Key Status</span>
              </Stack>
            </Tab>
            <Tab value="phishing" data-testid="security-tab-phishing" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
              <Stack direction="row" gap={0.75} alignItems="center">
                <MailOutlined fontSize="small" />
                <span>Last Phishing Test</span>
              </Stack>
            </Tab>
            <Tab value="activity" data-testid="security-tab-activity" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
              <Stack direction="row" gap={0.75} alignItems="center">
                <HistoryIcon fontSize="small" />
                <span>Recent Activity</span>
              </Stack>
            </Tab>
            <Tab
              value="blocked-ips"
              data-testid="security-tab-blocked-ips"
              sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <Stack direction="row" gap={0.75} alignItems="center">
                <BlockIcon fontSize="small" />
                <span>Blocked IPs</span>
              </Stack>
            </Tab>
          </TabList>
        </Sheet>

        {/* Lazy panels - only active panel renders */}
        <TabPanel value="overview" sx={{ p: 0 }}>
          {activeTab === 'overview' && (
            <SecurityOverviewTab onTabSelect={tab => setActiveTab(tab as SecurityTabId)} onRefresh={handleRefresh} />
          )}
        </TabPanel>
        <TabPanel value="suspicious-logins" sx={{ p: 0 }}>
          {activeTab === 'suspicious-logins' && <SuspiciousLoginsTab />}
        </TabPanel>
        <TabPanel value="failed-logins" sx={{ p: 0 }}>
          {activeTab === 'failed-logins' && <FailedLoginsTab />}
        </TabPanel>
        <TabPanel value="api-keys" sx={{ p: 0 }}>
          {activeTab === 'api-keys' && <ApiKeyStatusTab />}
        </TabPanel>
        <TabPanel value="phishing" sx={{ p: 0 }}>
          {activeTab === 'phishing' && <PhishingTestTab />}
        </TabPanel>
        <TabPanel value="activity" sx={{ p: 0 }}>
          {activeTab === 'activity' && <RecentActivityTab />}
        </TabPanel>
        <TabPanel value="blocked-ips" sx={{ p: 0 }}>
          {activeTab === 'blocked-ips' && <BlockedIPsTab />}
        </TabPanel>
      </Tabs>
    </Box>
  );
};

export default SecurityTabLayout;
