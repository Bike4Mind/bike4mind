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
import { EmptyState } from './shared/EmptyState';
import GrantPackagesTab from './InviteCenter/Packages/GrantPackagesTab';
import { ViewTabs } from './shared/ViewTabs';

type StubSection = {
  title: string;
  description: string;
  links: ReadonlyArray<{ label: string; tab: AdminTab; testId: string }>;
};

const SECTION_LABELS: Record<InviteCenterSectionId, string> = {
  waitlist: 'Waitlist',
  packages: 'Packages',
  schedule: 'Schedule',
  pending: 'Pending',
  rewards: 'Rewards',
};

const parseSection = INVITE_CENTER_SEARCH_PARSERS[INVITE_CENTER_SECTION_PARAM];

const VIEWS = INVITE_CENTER_SECTION_IDS.map(id => ({ id, label: SECTION_LABELS[id] }));

const STUB_SECTIONS: Record<Exclude<InviteCenterSectionId, 'waitlist' | 'packages'>, StubSection> = {
  schedule: {
    title: 'The signup credit schedule is coming here',
    description:
      'The initial grant, daily credits, drip cap, invite bonus and the signup and trickle pools will be set in this section.',
    links: [],
  },
  pending: {
    title: 'Pending grants are coming here',
    description:
      'Held grants, remaining-to-drip and blocked signups, with bulk release and block, will live in this section. Until then, use the Held signup grants page.',
    links: [
      {
        label: 'Open Held signup grants',
        tab: AdminTab.HeldSignupGrants,
        testId: 'invite-center-open-held-grants-btn',
      },
    ],
  },
  rewards: {
    title: 'Rewards are coming here',
    description: 'Referral and gear rewards will be set in this section.',
    links: [],
  },
};

const StubSectionBody = ({ section }: { section: StubSection }) => {
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  const { title, description, links } = section;
  return (
    <EmptyState
      title={title}
      description={description}
      action={
        links.length > 0 ? (
          <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="center">
            {links.map(({ label, tab, testId }) => (
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
        ) : null
      }
    />
  );
};

const PACKAGE_LINKS: StubSection['links'] = [
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
    <Stack gap={2}>
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
        ) : (
          <StubSectionBody section={STUB_SECTIONS[section]} />
        )}
      </div>
    </Stack>
  );
}
