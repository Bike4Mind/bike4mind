import ProfileDetailTabContent from '@client/app/components/ProfileModal/ProfileDetailTabContent';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetFriendRequests } from '@client/app/hooks/data/user';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import SettingsIcon from '@mui/icons-material/Settings';
import InsightsIcon from '@mui/icons-material/Insights';
import SecurityIcon from '@mui/icons-material/Security';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import CloseIcon from '@mui/icons-material/Close';
import { Badge, Box, LinearProgress, TabList, TabPanel, Tabs, Tooltip, Typography, IconButton } from '@mui/joy';
import { styled } from '@mui/system';
import PeopleIcon from '@mui/icons-material/People';
import LinkIcon from '@mui/icons-material/Link';
import ShareIcon from '@mui/icons-material/Share';
import dynamic from 'next/dynamic';
import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useSessions } from '@client/app/contexts/SessionsContext';
import CommunityTabContent from '@client/app/components/ProfileModal/CommunityTabContent';
import { ContextHelpButton } from '@client/app/components/help';
import { profileTabListSx } from '@client/app/components/common/profileTabListSx';
import { PageTab } from '@client/app/components/common/pageTabs';
import { useQuery } from '@tanstack/react-query';
import { listMyPublishedArtifacts } from '@client/app/utils/publishApi';

const SettingsTabContent = dynamic(() => import('@client/app/components/ProfileModal/SettingsTabContent'), {
  ssr: false,
  loading: () => <LinearProgress data-testid="settings-tab-loading" />,
});
const CreditAnalyticsTabContent = dynamic(
  () => import('@client/app/components/ProfileModal/CreditAnalyticsTabContent'),
  {
    ssr: false,
    loading: () => <LinearProgress />,
  }
);
const IntegrationsTabContent = dynamic(() => import('@client/app/components/ProfileModal/IntegrationsTabContent'), {
  ssr: false,
  loading: () => <LinearProgress />,
});
const ApiTabContent = dynamic(() => import('@client/app/components/ProfileModal/ApiTabContent'), {
  ssr: false,
  loading: () => <LinearProgress />,
});
const SecurityTabContent = dynamic(() => import('@client/app/components/ProfileModal/SecurityTab'), {
  ssr: false,
  loading: () => <LinearProgress />,
});
const PublishedArtifactsTabContent = dynamic(
  () => import('@client/app/components/ProfileModal/PublishedArtifactsTabContent'),
  {
    ssr: false,
    loading: () => <LinearProgress />,
  }
);

export enum ProfileTab {
  Profile = '',
  Community = 'community',
  Settings = 'settings',
  ApiKeys = 'api-keys',
  Usage = 'usage',
  Integrations = 'integrations',
  Security = 'security',
  Published = 'published',
}

/**
 * Legacy `?tab=` values consolidated into other surfaces. Admin moved to the
 * standalone `/admin` route; System Prompts / Email Inbox / Mementos became
 * sub-tabs under Settings. Redirect old deep links/bookmarks so they keep working
 * instead of silently falling back to the Profile tab. Credit Usage was later
 * promoted to its own top-level `usage` tab and is handled separately below.
 */
const LEGACY_SETTINGS_REDIRECTS: Record<string, string> = {
  'system-prompts': 'custom-instructions',
  'email-inbox': 'email-inbox',
  mementos: 'mementos',
};

/**
 * Tab text label: hidden on phones unless the tab is active, so the current section is named
 * while the other tabs stay icon-only. The phone cap fits the longest label (Live Artifacts,
 * ~100px at 16px Libre Franklin) and only truncates a future, longer one.
 */
const TabLabel = ({ active, children }: { active: boolean; children: React.ReactNode }) => (
  <Typography
    data-testid="profile-tab-label"
    data-active={active}
    sx={{
      display: { xs: active ? 'block' : 'none', sm: 'block' },
      color: 'text.primary',
      maxWidth: { xs: '112px', sm: 'none' },
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </Typography>
);

const ProfilePage = () => {
  const { currentUser } = useUser();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const rawTab = (search as { tab?: string })?.tab;
  const rawSubtab = (search as { subtab?: string })?.subtab;
  const activeTab = rawTab || ProfileTab.Profile;
  const tabListRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const { data: friendRequests } = useGetFriendRequests(currentUser?.id);
  const { currentSession } = useSessions();
  const isAdmin = currentUser?.isAdmin ?? false;
  const {
    data: publishedArtifacts,
    isPending: publishedPending,
    isError: publishedError,
  } = useQuery({
    // This screen only needs "does the caller have any", so it asks for a single row and reads
    // the total rather than pulling the whole library. Distinct key from the tab's paged query,
    // but under the same prefix so the tab's invalidation still refreshes it.
    queryKey: ['published-artifacts', 'mine', 'any'],
    queryFn: () => listMyPublishedArtifacts({ limit: 1 }),
    enabled: !!currentUser,
  });
  const hasPublishedArtifacts = (publishedArtifacts?.total ?? 0) > 0;

  // Redirect legacy tab values to their new homes (see LEGACY_SETTINGS_REDIRECTS).
  useEffect(() => {
    if (!rawTab) return;
    if (rawTab === 'admin-settings') {
      navigate({ to: '/admin', replace: true });
      return;
    }
    // Credit Usage was promoted to its own top-level tab: redirect the legacy
    // top-level alias (`?tab=credit-analysis`) and the old Settings->Billing sub-tab
    // (`?tab=settings&subtab=billing`) to it.
    if (rawTab === 'credit-analysis' || (rawTab === ProfileTab.Settings && rawSubtab === 'billing')) {
      navigate({ to: '/profile', search: { tab: ProfileTab.Usage }, replace: true });
      return;
    }
    const subtab = LEGACY_SETTINGS_REDIRECTS[rawTab];
    if (subtab) {
      navigate({ to: '/profile', search: { tab: ProfileTab.Settings, subtab }, replace: true });
      return;
    }
    // Redirect to Profile if user navigates to a hidden tab.
    // Wait for currentUser to hydrate before checking admin status, and for
    // the published query to settle, to avoid bouncing users who are still loading.
    if (!currentUser) return;
    if (rawTab === ProfileTab.Security && !isAdmin) {
      navigate({ to: '/profile', search: { tab: ProfileTab.Profile }, replace: true });
      return;
    }
    if (rawTab === ProfileTab.Published && !publishedPending && !publishedError && !hasPublishedArtifacts) {
      navigate({ to: '/profile', search: { tab: ProfileTab.Profile }, replace: true });
      return;
    }
  }, [rawTab, rawSubtab, navigate, currentUser, isAdmin, publishedPending, publishedError, hasPublishedArtifacts]);

  const profileName = currentUser?.name || currentUser?.username;
  useDocumentTitle(profileName ? `${profileName}'s Profile` : 'Profile');

  // On a phone the strip overflows and scrolls, so a deep-linked tab near the end would sit
  // off-screen with its label. Optional call: jsdom has no scrollIntoView.
  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTab, isAdmin, hasPublishedArtifacts]);

  const handleClose = () => {
    if (currentSession?.id) {
      navigate({ to: `/notebooks/${currentSession.id}` });
    } else {
      navigate({ to: '/new' });
    }
  };

  return (
    <Box sx={{ padding: '30px', height: '100%', overflow: 'auto', position: 'relative' }}>
      {/* Close button and help button in the top right corner */}
      <Box
        sx={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          zIndex: 1000,
          display: 'flex',
          gap: 1,
          alignItems: 'center',
        }}
      >
        <ContextHelpButton helpId="features/profile-settings" tooltipText="Learn about Profile & Settings" />
        <IconButton
          aria-label="Close"
          data-testid="profile-close-btn"
          onClick={handleClose}
          sx={{
            backgroundColor: theme => theme.palette.background.surface,
            border: theme => `1px solid ${theme.palette.divider}`,
            '&:hover': {
              backgroundColor: theme => theme.palette.background.level1,
            },
          }}
          size="sm"
          variant="outlined"
        >
          <CloseIcon />
        </IconButton>
      </Box>

      <Tabs
        aria-label="Profile sections"
        value={activeTab}
        defaultValue={ProfileTab.Profile}
        onChange={(_, tab) => {
          navigate({
            to: '/profile',
            search: { tab: String(tab ?? '') },
            replace: true,
          });
        }}
      >
        <TabList ref={tabListRef} data-testid="profile-tablist" sx={profileTabListSx}>
          <PageTab
            data-testid="profile-tab"
            sx={{ borderBottomLeftRadius: '0' }}
            value={ProfileTab.Profile}
            aria-label={t('profile.title')}
          >
            <Tooltip title={t('profile.tooltip')}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <AccountCircleIcon sx={{ flexShrink: 0, color: 'text.primary', fontSize: '16px' }} />
                <TabLabel active={activeTab === ProfileTab.Profile}>{t('profile.title')}</TabLabel>
              </Box>
            </Tooltip>
          </PageTab>

          <PageTab
            data-testid="community-tab"
            sx={{ borderBottomLeftRadius: '0' }}
            value={ProfileTab.Community}
            aria-label={t('community.title')}
          >
            <Tooltip title={t('community.tooltip')}>
              <Badge size="sm" color="danger" invisible={friendRequests?.length === 0}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <PeopleIcon sx={{ color: 'text.primary', fontSize: '16px' }} />
                  <TabLabel active={activeTab === ProfileTab.Community}>{t('community.title')}</TabLabel>
                </Box>
              </Badge>
            </Tooltip>
          </PageTab>

          <PageTab data-testid="settings-tab" value={ProfileTab.Settings} aria-label={t('settings.title')}>
            <Tooltip title={t('settings.tooltip')}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <SettingsIcon sx={{ color: 'text.primary', fontSize: '16px' }} />
                <TabLabel active={activeTab === ProfileTab.Settings}>{t('settings.title')}</TabLabel>
              </Box>
            </Tooltip>
          </PageTab>

          <PageTab data-testid="api-keys-tab" value={ProfileTab.ApiKeys} aria-label="API Keys">
            <Tooltip title="Manage your API keys">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <KeyOutlinedIcon sx={{ color: 'text.primary', fontSize: '16px' }} />
                <TabLabel active={activeTab === ProfileTab.ApiKeys}>API Keys</TabLabel>
              </Box>
            </Tooltip>
          </PageTab>

          <PageTab data-testid="usage-tab" value={ProfileTab.Usage} aria-label="Usage">
            <Tooltip title="View your credit usage and model pricing">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <InsightsIcon sx={{ color: 'text.primary', fontSize: '16px' }} />
                <TabLabel active={activeTab === ProfileTab.Usage}>Usage</TabLabel>
              </Box>
            </Tooltip>
          </PageTab>

          <PageTab data-testid="integrations-tab" value={ProfileTab.Integrations} aria-label="Integrations">
            <Tooltip title="Manage external integrations">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <LinkIcon sx={{ color: 'text.primary', fontSize: '16px' }} />
                <TabLabel active={activeTab === ProfileTab.Integrations}>Integrations</TabLabel>
              </Box>
            </Tooltip>
          </PageTab>

          {isAdmin && (
            <PageTab data-testid="security-tab" value={ProfileTab.Security} aria-label="Security">
              <Tooltip title="View security events and alerts">
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <SecurityIcon sx={{ color: 'text.primary', fontSize: '16px' }} />
                  <TabLabel active={activeTab === ProfileTab.Security}>Security</TabLabel>
                </Box>
              </Tooltip>
            </PageTab>
          )}

          {hasPublishedArtifacts && (
            <PageTab data-testid="published-tab" value={ProfileTab.Published} aria-label="Live Artifacts">
              <Tooltip title="Manage your Live Artifacts (published & shared)">
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <ShareIcon sx={{ color: 'text.primary', fontSize: '16px' }} />
                  <TabLabel active={activeTab === ProfileTab.Published}>Live Artifacts</TabLabel>
                </Box>
              </Tooltip>
            </PageTab>
          )}
        </TabList>

        {/* Tab Panels */}

        <StyledTabPanel value={ProfileTab.Profile}>
          {activeTab === ProfileTab.Profile && <ProfileDetailTabContent />}
        </StyledTabPanel>

        <StyledTabPanel value={ProfileTab.Community}>
          {activeTab === ProfileTab.Community && <CommunityTabContent />}
        </StyledTabPanel>

        <StyledTabPanel value={ProfileTab.Settings}>
          {activeTab === ProfileTab.Settings && <SettingsTabContent />}
        </StyledTabPanel>

        <StyledTabPanel value={ProfileTab.ApiKeys}>
          {activeTab === ProfileTab.ApiKeys && <ApiTabContent />}
        </StyledTabPanel>

        <StyledTabPanel value={ProfileTab.Usage}>
          {activeTab === ProfileTab.Usage && <CreditAnalyticsTabContent />}
        </StyledTabPanel>

        <StyledTabPanel value={ProfileTab.Integrations}>
          {activeTab === ProfileTab.Integrations && <IntegrationsTabContent />}
        </StyledTabPanel>

        {isAdmin && (
          <StyledTabPanel value={ProfileTab.Security}>
            {activeTab === ProfileTab.Security && <SecurityTabContent />}
          </StyledTabPanel>
        )}

        {hasPublishedArtifacts && (
          <StyledTabPanel value={ProfileTab.Published}>
            {activeTab === ProfileTab.Published && <PublishedArtifactsTabContent />}
          </StyledTabPanel>
        )}
      </Tabs>
    </Box>
  );
};

const StyledTabPanel = styled(TabPanel)({
  padding: '15px 0 0',
});

export default ProfilePage;
