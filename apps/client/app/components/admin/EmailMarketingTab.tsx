import { Stack } from '@mui/joy';
import { useState } from 'react';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { AdminPageHeader, ViewTabs, type ViewTab } from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import EmailTemplatesPanel from './email/EmailTemplatesPanel';
import EmailJobsPanel from './email/EmailJobsPanel';

const VIEWS: readonly ViewTab[] = [
  { id: 'templates', label: 'Templates' },
  { id: 'campaigns', label: 'Campaigns' },
];

export default function EmailMarketingTab() {
  const [activeView, setActiveView] = useState('templates');

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-email-marketing-tab">
      <AdminPageHeader
        title="Email marketing"
        description="Reusable email templates and the campaigns that send them to users and the waitlist."
        actions={<ContextHelpButton helpId="admin/email-marketing" tooltipText="Email marketing help" />}
      />
      <ViewTabs
        views={VIEWS}
        activeId={activeView}
        onSelect={setActiveView}
        aria-label="Email marketing views"
        data-testid="email-marketing-views"
      />
      {activeView === 'templates' ? <EmailTemplatesPanel /> : <EmailJobsPanel />}
    </Stack>
  );
}
