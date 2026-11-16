import type { ReactNode } from 'react';
import { Stack, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { AdminSearch } from './adminTabParams';
import {
  DEFAULT_INVITE_CENTER_SECTION,
  INVITE_CENTER_SECTION_IDS,
  INVITE_CENTER_SEARCH_PARSERS,
  INVITE_CENTER_SECTION_PARAM,
  type InviteCenterSectionId,
} from './inviteCenterSearch';
import { AdminPageHeader } from './shared/AdminPageHeader';
import InviteCenter from './InviteCenter';
import GrantPackagesTab from './InviteCenter/Packages/GrantPackagesTab';
import PartnerSignupRulesTab from './PartnerSignupRulesTab';
import { PendingSection } from './InviteCenter/Pending/PendingSection';
import { RewardsSection } from './InviteCenter/Rewards/RewardsSection';
import { ScheduleSection } from './InviteCenter/Schedule/ScheduleSection';
import { ViewTabs } from './shared/ViewTabs';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

const SECTION_LABELS: Record<InviteCenterSectionId, string> = {
  waitlist: 'Waitlist',
  invites: 'Invites',
  packages: 'Packages',
  partners: 'Partner signups',
  schedule: 'Schedule',
  pending: 'Pending',
  rewards: 'Rewards',
};

const parseSection = INVITE_CENTER_SEARCH_PARSERS[INVITE_CENTER_SECTION_PARAM];

const VIEWS = INVITE_CENTER_SECTION_IDS.map(id => ({ id, label: SECTION_LABELS[id] }));

const PackagesSection = () => (
  <Stack gap={1}>
    <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
      Add codes and partner domains inside each package.
    </Typography>
    <GrantPackagesTab embedded />
  </Stack>
);

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
        description="Waitlist, invite codes, packages, partner signups, signup credit schedule, held grants and rewards, in one place."
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
        ) : section === 'invites' ? (
          <InviteCenter />
        ) : section === 'packages' ? (
          <PackagesSection />
        ) : section === 'partners' ? (
          <PartnerSignupRulesTab />
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
