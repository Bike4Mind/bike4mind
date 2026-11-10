import type { ReactNode } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AdminTab } from './adminSidebarConfig';
import type { AdminSearch } from './adminTabParams';
import {
  DEFAULT_INVITE_CENTER_SECTION,
  INVITE_CENTER_SECTION_IDS,
  INVITE_CENTER_SEARCH_PARSERS,
  INVITE_CENTER_SECTION_PARAM,
  type InviteCenterSectionId,
} from './inviteCenterSearch';
import { useAdminModal } from './useAdminModal';
import { AdminPageHeader } from './shared/AdminPageHeader';
import GrantPackagesTab from './InviteCenter/Packages/GrantPackagesTab';
import { PendingSection } from './InviteCenter/Pending/PendingSection';
import { RewardsSection } from './InviteCenter/Rewards/RewardsSection';
import { ScheduleSection } from './InviteCenter/Schedule/ScheduleSection';
import { ViewTabs } from './shared/ViewTabs';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

type SectionLink = { label: string; tab: AdminTab; testId: string };

const SECTION_LABELS: Record<InviteCenterSectionId, string> = {
  waitlist: 'Waitlist',
  packages: 'Packages',
  schedule: 'Schedule',
  pending: 'Pending',
  rewards: 'Rewards',
};

const parseSection = INVITE_CENTER_SEARCH_PARSERS[INVITE_CENTER_SECTION_PARAM];

const VIEWS = INVITE_CENTER_SECTION_IDS.map(id => ({ id, label: SECTION_LABELS[id] }));

const PACKAGE_LINKS: ReadonlyArray<SectionLink> = [
  { label: 'Open Invites', tab: AdminTab.RegistrationInvites, testId: 'invite-center-open-invites-btn' },
  { label: 'Open Partner signups', tab: AdminTab.PartnerSignupRules, testId: 'invite-center-open-partner-signups-btn' },
];

const PackagesSection = () => {
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  return (
    <Stack gap={1}>
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        <Typography level="body-sm" sx={{ color: 'text.secondary', mr: 1 }}>
          Issue codes from Invites; attach domains from Partner signups.
        </Typography>
        {PACKAGE_LINKS.map(({ label, tab, testId }) => (
          <Button
            key={tab}
            variant="outlined"
            color="neutral"
            size="sm"
            data-testid={testId}
            onClick={() => setActiveTab(tab)}
          >
            {label}
          </Button>
        ))}
      </Stack>
      <GrantPackagesTab embedded />
    </Stack>
  );
};

export function InviteCenterShell({ waitlist }: { waitlist: ReactNode }) {
  const search = useSearch({ strict: false }) as AdminSearch;
  const navigate = useNavigate();
  const section = parseSection(search[INVITE_CENTER_SECTION_PARAM]) ?? DEFAULT_INVITE_CENTER_SECTION;

  // Not the admin tab store: the URL sync would treat it as a tab switch and drop this param.
  const selectSection = (id: string) => {
    const next = parseSection(id);
    return navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({
        ...previous,
        [INVITE_CENTER_SECTION_PARAM]: next === DEFAULT_INVITE_CENTER_SECTION ? undefined : next,
      }),
      replace: true,
    });
  };

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Invite Center"
        description="Waitlist, invite packages, signup credit schedule, held grants and rewards, in one place."
      />
      <ViewTabs
        views={VIEWS}
        activeId={section}
        onSelect={selectSection}
        aria-label="Invite Center sections"
        data-testid="invite-center-sections"
      />
      <div data-testid={`invite-center-section-${section}`}>
        {section === 'waitlist' ? (
          waitlist
        ) : section === 'packages' ? (
          <PackagesSection />
        ) : section === 'pending' ? (
          <PendingSection />
        ) : section === 'schedule' ? (
          <ScheduleSection />
        ) : (
          <RewardsSection />
        )}
      </div>
    </Stack>
  );
}
