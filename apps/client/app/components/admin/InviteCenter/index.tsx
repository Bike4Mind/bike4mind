import { useState } from 'react';
import { Box, Sheet, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import EmailIcon from '@mui/icons-material/Email';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import InviteCenterQuickActions from './InviteCenterQuickActions';
import BulkInviteTab from './BulkInvite/BulkInviteTab';
import InviteCodesTab from './InviteCodes/InviteCodesTab';
import { APP_NAME } from '@client/config/general'; // brand externalized

type InviteCenterTab = 'bulk' | 'codes';

const InviteCenter = () => {
  const [activeTab, setActiveTab] = useState<InviteCenterTab>('bulk');
  const [quickAction, setQuickAction] = useState<string | null>(null);

  const handleQuickInvite = () => {
    setActiveTab('bulk');
    setQuickAction('quick-invite');
    // Reset after consumption
    setTimeout(() => setQuickAction(null), 100);
  };

  const handleGenerateCodes = () => {
    setActiveTab('codes');
    setQuickAction('generate-codes');
    setTimeout(() => setQuickAction(null), 100);
  };

  const handlePasteCsv = () => {
    setActiveTab('bulk');
    setQuickAction('paste-csv');
    setTimeout(() => setQuickAction(null), 100);
  };

  return (
    <Sheet sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ px: '10px', pt: 1, pb: 0.5 }}>
        <Typography level="h3" sx={{ mb: 1 }}>
          Invite Center
        </Typography>
        <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
          Get people into{APP_NAME ? ` ${APP_NAME}` : ' the app'}. Send personalized invites or generate registration
          codes.
        </Typography>
        <InviteCenterQuickActions
          onQuickInvite={handleQuickInvite}
          onGenerateCodes={handleGenerateCodes}
          onPasteCsv={handlePasteCsv}
        />
      </Box>

      <Tabs
        value={activeTab}
        onChange={(_, value) => setActiveTab(value as InviteCenterTab)}
        sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <TabList sx={{ px: 3 }}>
          <Tab value="bulk" data-testid="invite-center-bulk-tab">
            <EmailIcon sx={{ mr: 0.5, fontSize: '1rem' }} />
            Bulk Invite
          </Tab>
          <Tab value="codes" data-testid="invite-center-codes-tab">
            <VpnKeyIcon sx={{ mr: 0.5, fontSize: '1rem' }} />
            Invite Codes
          </Tab>
        </TabList>

        <TabPanel value="bulk" sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0 }}>
          {activeTab === 'bulk' && <BulkInviteTab quickAction={quickAction} />}
        </TabPanel>

        <TabPanel value="codes" sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0 }}>
          {activeTab === 'codes' && <InviteCodesTab quickAction={quickAction} />}
        </TabPanel>
      </Tabs>
    </Sheet>
  );
};

export default InviteCenter;
