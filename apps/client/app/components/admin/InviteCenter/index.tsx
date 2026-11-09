import { useState } from 'react';
import { Stack } from '@mui/joy';
import { AdminPageHeader } from '../shared/AdminPageHeader';
import { ViewTabs } from '../shared/ViewTabs';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import InviteCenterQuickActions from './InviteCenterQuickActions';
import BulkInviteTab from './BulkInvite/BulkInviteTab';
import InviteCodesTab from './InviteCodes/InviteCodesTab';
import { APP_NAME } from '@client/config/general'; // brand externalized

type InviteCenterTab = 'bulk' | 'codes';

// The e2e page object clicks these two test ids.
const VIEWS = [
  { id: 'bulk', label: 'Bulk invite', testId: 'invite-center-bulk-tab' },
  { id: 'codes', label: 'Invite codes', testId: 'invite-center-codes-tab' },
];

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
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Invites"
        description={`Get people into${APP_NAME ? ` ${APP_NAME}` : ' the app'}. Send personalized invites or generate registration codes.`}
        actions={
          <InviteCenterQuickActions
            onQuickInvite={handleQuickInvite}
            onGenerateCodes={handleGenerateCodes}
            onPasteCsv={handlePasteCsv}
          />
        }
      />
      <ViewTabs
        views={VIEWS}
        activeId={activeTab}
        onSelect={id => setActiveTab(id as InviteCenterTab)}
        aria-label="Invite views"
        data-testid="invite-center-views"
      />
      {activeTab === 'bulk' ? (
        <BulkInviteTab quickAction={quickAction} />
      ) : (
        <InviteCodesTab quickAction={quickAction} />
      )}
    </Stack>
  );
};

export default InviteCenter;
