import { Box, Stack, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import { useState } from 'react';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import EmailTemplatesPanel from './email/EmailTemplatesPanel';
import EmailJobsPanel from './email/EmailJobsPanel';

export default function EmailMarketingTab() {
  const [activeTab, setActiveTab] = useState(0);

  return (
    <Box sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography level="h3">Email Marketing</Typography>
        <ContextHelpButton helpId="admin/email-marketing" tooltipText="Email Marketing Help" />
      </Stack>

      <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value as number)} sx={{ borderRadius: 'lg' }}>
        <TabList>
          <Tab>Templates</Tab>
          <Tab>Campaigns</Tab>
        </TabList>

        <TabPanel value={0} sx={{ p: 0 }}>
          <EmailTemplatesPanel />
        </TabPanel>

        <TabPanel value={1} sx={{ p: 0 }}>
          <EmailJobsPanel />
        </TabPanel>
      </Tabs>
    </Box>
  );
}
