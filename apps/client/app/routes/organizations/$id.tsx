import {
  IOrganizationDocument,
  Permission,
  WithId,
  isOrgOwnerOrCurrentAdmin,
  isOrgOwnerOrPlatformAdmin,
} from '@bike4mind/common';
import Breadcrumbs from '@client/app/components/common/Breadcrumbs';
import OrganizationMembers from '@client/app/components/organizations/Member';
import OrganizationGroups from '@client/app/components/organizations/OrganizationGroups';
import OrganizationBillingSection from '@client/app/components/organizations/OrganizationBillingSection';
import OrganizationSettingsSection from '@client/app/components/organizations/OrganizationSettingsSection';
import OrganizationUsageSection from '@client/app/components/organizations/OrganizationUsageSection';
import OrganizationAnalysisSection from '@client/app/components/organizations/OrganizationAnalysisSection';
import OrgSlackIntegration from '@client/app/components/organizations/OrgSlackIntegration';
import OrgWebhookConfig from '@client/app/components/organizations/OrgWebhookConfig';
import OrgGitHubConnectionTab from '@client/app/components/organizations/OrgGitHubConnectionTab';
import OrgCustomMcpPolicySection from '@client/app/components/organizations/OrgCustomMcpPolicySection';
import OrgApiKeysSection from '@client/app/components/organizations/OrgApiKeysSection';
import OrgMemberApiKeysSection from '@client/app/components/organizations/OrgMemberApiKeysSection';
import CreditIcon from '@client/app/components/svgs/icons/CreditIcon';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOrganization, useOrganizationSeats } from '@client/app/hooks/data/organizations';
import { useGetSubscriptionsByOwner } from '@client/app/hooks/data/subscriptions';
import {
  SubscriptionOwnerType,
  isDelinquentSubscriptionStatus,
  pickDisplayedSubscription,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { creditBalanceParams, formatCreditAmount } from '@client/app/utils/formatCredits';
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  LinearProgress,
  Option,
  Select,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Typography,
} from '@mui/joy';
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import CreditCardOutlinedIcon from '@mui/icons-material/CreditCardOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import GroupWorkOutlinedIcon from '@mui/icons-material/GroupWorkOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import GitHubIcon from '@mui/icons-material/GitHub';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import {
  canManageOrgConnectors,
  canManageOrgIntegrations,
  canViewOrgAnalysis,
  canViewOrgBilling,
  canViewOrgUsage,
  OrganizationTabs,
  resolveAccessibleTab,
} from '@client/app/routes/organizations/orgTabAccess';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { FC, ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const OrganizationPage: FC = () => {
  const { t } = useTranslation();
  const { id } = useParams({ strict: false });
  const { data: organization, isLoading } = useGetOrganization(id as string);
  const { maxSeats, currentSeats } = useOrganizationSeats(id as string);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const { currentUser } = useUser();
  const isMobile = useIsMobile();

  // The URL is the only place the requested tab lives; the page keeps no copy, so Back and a
  // pasted link move it like a click does. An unknown value names no tab, which would leave Tabs
  // with nothing selected, so it reads as Overview.
  const requestedTab =
    search.tab && Object.values(OrganizationTabs).includes(search.tab as OrganizationTabs)
      ? (search.tab as OrganizationTabs)
      : OrganizationTabs.Overview;

  // Replace rather than push: a tab click is a view change, not a destination, and pushing would
  // put one back-stack entry per click between the caller and the page they arrived from.
  const requestTab = (tab: OrganizationTabs) => {
    navigate({ to: '/organizations/$id', params: { id: id as string }, search: { tab }, replace: true });
  };

  // The viewer's org permission set, which drives tab visibility (canManageOrg). The Members tab
  // does not use it: each roster control there asks the server predicate behind its own endpoint.
  const userPermissions = useMemo(() => {
    if (!currentUser || !organization) return [];
    if (currentUser.id === organization.userId) return [Permission.read, Permission.update, Permission.share];
    const memberDetails = organization.users.find(u => u.userId === currentUser.id);
    return memberDetails?.permissions || [];
  }, [currentUser, organization]);

  const canManageOrg = useMemo(() => {
    return userPermissions.includes(Permission.share) || userPermissions.includes(Permission.update);
  }, [userPermissions]);

  // Usage (credit spend) and the Integrations / GitHub API / Webhooks tabs are owner-only;
  // Analysis is open to managers. None of them follows the permission set - see orgTabAccess.ts.
  const canViewUsage = useMemo(() => canViewOrgUsage(currentUser, organization), [currentUser, organization]);
  const canViewAnalysis = useMemo(() => canViewOrgAnalysis(currentUser, organization), [currentUser, organization]);
  const canManageIntegrations = useMemo(
    () => canManageOrgIntegrations(currentUser, organization),
    [currentUser, organization]
  );

  // Who may manage group instances + membership: the same isOrgOwnerOrCurrentAdmin rule
  // assertCanManageOrgGroups enforces, so a stale adminUserIds entry is never shown a surface whose
  // every write would 403. Personal orgs never have groups.
  const canManageGroups = useMemo(() => {
    if (!currentUser || !organization || organization.personal) return false;
    return isOrgOwnerOrCurrentAdmin(currentUser, organization);
  }, [currentUser, organization]);

  // Billing is owner-only, narrower than canManageOrg - see canViewOrgBilling for why, and for
  // why a platform admin is not admitted here either.
  const canViewBilling = useMemo(() => canViewOrgBilling(currentUser, organization), [currentUser, organization]);
  const canManageConnectors = useMemo(
    () => canManageOrgConnectors(currentUser, organization),
    [currentUser, organization]
  );

  // Only the billing owner or a platform admin may add or remove managers (admins route authz).
  const canSetAdmins = useMemo(() => {
    if (!currentUser || !organization) return false;
    return isOrgOwnerOrPlatformAdmin(currentUser, organization);
  }, [currentUser, organization]);

  // A ?tab= deep link can ask for a tab this caller never gets rendered, so the request is sent
  // back through the same visibility rules the TabList applies. Resolved during render rather than
  // in an effect on purpose: the gates read the org document, which lands a render after mount, and
  // until it does they deny everyone; deriving re-answers the question the moment it arrives.
  // The answer is deliberately not written back to the URL - rewriting ?tab=usage to ?tab=overview
  // would break the link for this caller the day they are granted access, and make one shared URL
  // mean different things to different people.
  const selectedTab = resolveAccessibleTab(requestedTab, {
    canManageOrg,
    canViewUsage,
    canViewAnalysis,
    canManageIntegrations,
    canManageGroups,
    canViewBilling,
    canManageConnectors,
  });

  // One list feeds both the desktop rail and the phone select, so the two can never offer
  // different tabs. Order and gates must match the TabPanels below.
  const visibleTabs: { value: OrganizationTabs; label: string; icon: ReactNode }[] = [
    { value: OrganizationTabs.Overview, label: t('organization.tabs.overview'), icon: <BusinessOutlinedIcon sx={{ fontSize: 16 }} /> },
    { value: OrganizationTabs.Members, label: t('organization.tabs.members'), icon: <GroupOutlinedIcon sx={{ fontSize: 16 }} /> },
    ...(canManageGroups
      ? [{ value: OrganizationTabs.Groups, label: t('organization.tabs.groups'), icon: <GroupWorkOutlinedIcon sx={{ fontSize: 16 }} /> }]
      : []),
    ...(canViewUsage
      ? [{ value: OrganizationTabs.Usage, label: t('organization.tabs.usage'), icon: <InsightsOutlinedIcon sx={{ fontSize: 16 }} /> }]
      : []),
    ...(canViewAnalysis
      ? [
          {
            value: OrganizationTabs.Analysis,
            label: t('organization.tabs.analysis'),
            icon: <RateReviewOutlinedIcon sx={{ fontSize: 16 }} />,
          },
        ]
      : []),
    ...(canViewBilling
      ? [{ value: OrganizationTabs.Billing, label: t('organization.tabs.billing'), icon: <CreditCardOutlinedIcon sx={{ fontSize: 16 }} /> }]
      : []),
    ...(canManageIntegrations
      ? [
          {
            value: OrganizationTabs.Integrations,
            label: t('organization.tabs.integrations'),
            icon: <ExtensionOutlinedIcon sx={{ fontSize: 16 }} />,
          },
          { value: OrganizationTabs.GitHub, label: t('organization.tabs.github_api'), icon: <VpnKeyOutlinedIcon sx={{ fontSize: 16 }} /> },
          { value: OrganizationTabs.Webhooks, label: t('organization.tabs.webhooks'), icon: <GitHubIcon sx={{ fontSize: 16 }} /> },
        ]
      : []),
    ...(canManageConnectors
      ? [{ value: OrganizationTabs.Connectors, label: t('organization.tabs.connectors'), icon: <HubOutlinedIcon sx={{ fontSize: 16 }} /> }]
      : []),
    ...(canManageConnectors
      ? [{ value: OrganizationTabs.ApiKeys, label: 'API Keys', icon: <KeyOutlinedIcon sx={{ fontSize: 16 }} /> }]
      : []),
    ...(canManageOrg
      ? [{ value: OrganizationTabs.Settings, label: t('organization.tabs.settings'), icon: <SettingsOutlinedIcon sx={{ fontSize: 16 }} /> }]
      : []),
  ];

  useDocumentTitle(organization?.name, t('organization.document_title_suffix'));

  return isLoading || !organization ? (
    <Box display="flex" justifyContent="center" alignItems="center" height="100%" width="100%">
      <CircularProgress />
    </Box>
  ) : (
    <Stack
      gap={{ xs: '16px', sm: '24px' }}
      sx={theme => ({
        // dvh keeps a phone's collapsing browser bar from pushing the page past the fold.
        height: '100vh',
        '@supports (height: 100dvh)': { height: '100dvh' },
        backgroundColor: theme.palette.background.level1,
        pt: { xs: '16px', sm: '24px' },
        '& ::-webkit-scrollbar-thumb': {
          backgroundColor: theme.palette.background.scrollbar,
          border: `2px solid ${theme.palette.background.scrollbarTrack}`,
          borderRadius: '20px',
        },
        '& ::-webkit-scrollbar': {
          width: '8px',
        },
        '& ::-webkit-scrollbar-track': {
          backgroundColor: theme.palette.background.scrollbarTrack,
        },
      })}
    >
      <Box sx={{ mx: { xs: 2, sm: 3 } }}>
        <Breadcrumbs
          items={[{ name: t('organization.organizations'), href: '/organizations' }, { name: organization.name }]}
        />
      </Box>

      <OrganizationHeader
        organization={organization}
        onSettingsClick={() => canManageOrg && requestTab(OrganizationTabs.Settings)}
      />

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Tabs
          orientation={isMobile ? 'horizontal' : 'vertical'}
          sx={{
            borderRadius: 'sm',
            flex: 1,
            overflow: 'hidden',
            minHeight: 0,
          }}
          value={selectedTab}
          onChange={(_, value) => requestTab(value as OrganizationTabs)}
        >
          {isMobile ? (
            <Box sx={{ px: 2, pb: 1 }}>
              <Select
                value={selectedTab}
                onChange={(_, value) => value && requestTab(value as OrganizationTabs)}
                startDecorator={visibleTabs.find(tab => tab.value === selectedTab)?.icon}
                slotProps={{
                  button: { 'aria-label': 'Team section', 'data-testid': 'organization-tabs-select' },
                  listbox: { 'aria-label': 'Team sections' },
                }}
              >
                {visibleTabs.map(tab => (
                  <Option key={tab.value} value={tab.value} data-testid={`organization-tabs-option-${tab.value}`}>
                    {tab.label}
                  </Option>
                ))}
              </Select>
            </Box>
          ) : (
            <TabList
              data-testid="organization-tabs"
              aria-label="Team sections"
              sx={{
                width: '240px',
                flexShrink: 0,
                borderRight: '1px solid',
                borderColor: 'divider',
                p: 2,
                '& .MuiTab-root': {
                  justifyContent: 'flex-start',
                  px: 2,
                  py: 1.5,
                  '&.Mui-selected': {
                    backgroundColor: 'background.level2',
                    fontWeight: 'bold',
                  },
                },
              }}
            >
              {visibleTabs.map(tab => (
                <Tab key={tab.value} value={tab.value} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {tab.icon}
                  {tab.label}
                </Tab>
              ))}
            </TabList>
          )}

          <Box sx={{ p: { xs: 1, sm: 3 }, flex: 1, overflow: 'auto', minWidth: 0 }}>
            <TabPanel value={OrganizationTabs.Overview}>
              <OrganizationOverviewSection organization={organization} />
            </TabPanel>
            <TabPanel value={OrganizationTabs.Members}>
              <Typography level="title-lg" startDecorator={<GroupOutlinedIcon />} sx={{ mb: 3 }}>
                {t('organization.headings.members_seats', { current: currentSeats, max: maxSeats })}
              </Typography>
              {currentUser && <OrganizationMembers organization={organization} />}
            </TabPanel>
            {canManageGroups && (
              <TabPanel value={OrganizationTabs.Groups}>
                <Typography level="title-lg" startDecorator={<GroupWorkOutlinedIcon />} sx={{ mb: 3 }}>
                  {t('organization.headings.groups')}
                </Typography>
                <OrganizationGroups organization={organization} canSetAdmins={canSetAdmins} />
              </TabPanel>
            )}
            {canViewUsage && (
              <TabPanel value={OrganizationTabs.Usage}>
                <Typography level="title-lg" startDecorator={<InsightsOutlinedIcon />} sx={{ mb: 3 }}>
                  {t('organization.headings.usage')}
                </Typography>
                <OrganizationUsageSection organization={organization} />
              </TabPanel>
            )}
            {canViewAnalysis && (
              <TabPanel value={OrganizationTabs.Analysis}>
                <Typography level="title-lg" startDecorator={<RateReviewOutlinedIcon />} sx={{ mb: 3 }}>
                  {t('organization.headings.analysis')}
                </Typography>
                <OrganizationAnalysisSection organization={organization} />
              </TabPanel>
            )}
            {canViewBilling && (
              <TabPanel value={OrganizationTabs.Billing}>
                <Typography level="title-lg" startDecorator={<CreditCardOutlinedIcon />} sx={{ mb: 3 }}>
                  {t('organization.headings.billing')}
                </Typography>
                <OrganizationBillingSection organization={organization} />
              </TabPanel>
            )}
            {canManageIntegrations && (
              <>
                <TabPanel value={OrganizationTabs.Integrations}>
                  <Typography level="title-lg" startDecorator={<ExtensionOutlinedIcon />} sx={{ mb: 3 }}>
                    {t('organization.headings.integrations')}
                  </Typography>
                  <OrgSlackIntegration organization={organization} />
                </TabPanel>
                <TabPanel value={OrganizationTabs.GitHub}>
                  <OrgGitHubConnectionTab orgId={organization.id} />
                </TabPanel>
                <TabPanel value={OrganizationTabs.Webhooks}>
                  <Typography level="title-lg" startDecorator={<GitHubIcon />} sx={{ mb: 3 }}>
                    {t('organization.headings.webhooks')}
                  </Typography>
                  <OrgWebhookConfig organization={organization} />
                </TabPanel>
              </>
            )}
            {canManageConnectors && (
              <TabPanel value={OrganizationTabs.Connectors}>
                <Typography level="title-lg" startDecorator={<HubOutlinedIcon />} sx={{ mb: 3 }}>
                  {t('organization.headings.connectors')}
                </Typography>
                <OrgCustomMcpPolicySection key={organization.id} organization={organization} />
              </TabPanel>
            )}
            {canManageConnectors && (
              <TabPanel value={OrganizationTabs.ApiKeys}>
                <Typography level="title-lg" startDecorator={<KeyOutlinedIcon />} sx={{ mb: 3 }}>
                  API Keys
                </Typography>
                <OrgApiKeysSection key={organization.id} organizationId={organization.id} />
                <Typography level="title-md" sx={{ mt: 4, mb: 2 }}>
                  Member API keys
                </Typography>
                <OrgMemberApiKeysSection key={`members-${organization.id}`} organizationId={organization.id} />
              </TabPanel>
            )}
            {canManageOrg && (
              <TabPanel value={OrganizationTabs.Settings}>
                <Typography level="title-lg" startDecorator={<SettingsOutlinedIcon />} sx={{ mb: 3 }}>
                  {t('organization.headings.settings')}
                </Typography>
                <OrganizationSettingsSection organization={organization} />
              </TabPanel>
            )}
          </Box>
        </Tabs>
      </Box>
    </Stack>
  );
};

const OrganizationHeader: FC<{
  organization: WithId<IOrganizationDocument>;
  onSettingsClick: () => void;
}> = ({ organization, onSettingsClick }) => {
  const { t } = useTranslation();
  const { name, description } = organization;
  const initial = name.charAt(0).toUpperCase();
  const { data: subscriptions } = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);
  const subscription = pickDisplayedSubscription(subscriptions ?? []);
  const paymentIssue = !!subscription && isDelinquentSubscriptionStatus(subscription.status);
  const hasActiveSubscription = !!subscription && !subscription.canceledAt && !paymentIssue;
  const { currentSeats } = useOrganizationSeats(organization.id);
  const { currentUser } = useUser();
  const canManageOrg = useMemo(() => {
    if (!currentUser || !organization) return false;
    // Grant admin permissions if user is a system admin
    if (currentUser.isAdmin) return true;
    // Grant full permissions if user is the owner
    if (currentUser.id === organization.userId) return true;
    const memberDetails = organization.users.find(u => u.userId === currentUser.id);
    return memberDetails?.permissions?.some(p => p === Permission.share || p === Permission.update) ?? false;
  }, [currentUser, organization]);

  return (
    <Card variant="outlined" sx={{ mx: { xs: 2, sm: 3 }, p: { xs: 2, sm: 3 } }} data-testid="organization-header">
      <Stack direction="row" spacing={{ xs: 2, sm: 3 }} alignItems={{ xs: 'flex-start', sm: 'center' }}>
        <Avatar size="lg" sx={{ '--Avatar-size': { xs: '48px', sm: '64px' } }}>
          {initial}
        </Avatar>
        <Stack spacing={1} flex={1} minWidth={0}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap gap={1}>
            <Typography level="h3" sx={{ overflowWrap: 'anywhere' }}>
              {name}
            </Typography>
            {canManageOrg && (
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
                size="sm"
                onClick={onSettingsClick}
              >
                {t('organization.headings.settings')}
              </Button>
            )}
          </Stack>
          <Typography level="body-sm" color="neutral">
            {description}
          </Typography>
          <Stack direction="row" spacing={{ xs: 1, sm: 2 }} mt={1} flexWrap="wrap" useFlexGap>
            <Chip size="sm" variant="soft" startDecorator={<GroupOutlinedIcon sx={{ fontSize: 14 }} />}>
              {t('organization.x_members', { count: currentSeats })}
            </Chip>
            <Chip
              size="sm"
              variant="soft"
              startDecorator={<CreditIcon sx={{ fontSize: 14, color: 'var(--Icon-color)' }} />}
            >
              {t('organization.x_credits', creditBalanceParams(organization.currentCredits))}
            </Chip>
            <Chip
              size="sm"
              variant="soft"
              color={paymentIssue ? 'danger' : hasActiveSubscription ? 'success' : 'neutral'}
              startDecorator={<VpnKeyOutlinedIcon sx={{ fontSize: 14 }} />}
            >
              {paymentIssue
                ? t('organization.payment_issue')
                : hasActiveSubscription
                  ? t('organization.team_plan')
                  : t('organization.no_active_plan')}
            </Chip>
          </Stack>
        </Stack>
      </Stack>
    </Card>
  );
};

const OrganizationOverviewSection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const { t, i18n } = useTranslation();
  const { currentSeats, maxSeats, pendingSeats, availableSeats } = useOrganizationSeats(organization.id);
  const { data: subscriptions } = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);

  const subscription = pickDisplayedSubscription(subscriptions ?? []);
  const paymentIssue = !!subscription && isDelinquentSubscriptionStatus(subscription.status);
  const activeSubscription = subscription && !subscription.canceledAt && !paymentIssue ? subscription : undefined;
  // Format next billing date
  const formatDate = (date: Date | string | undefined) => {
    if (!date) return t('organization.overview.not_available');
    return new Date(date).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <Stack spacing={3}>
      <Typography level="title-lg" startDecorator={<BusinessOutlinedIcon />}>
        {t('organization.headings.overview')}
      </Typography>

      {/* First row - Key metrics */}
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <Card variant="outlined" sx={{ flex: 1, minWidth: 200, p: 3 }}>
          <Stack spacing={1}>
            <Typography level="body-xs" color="neutral">
              {t('organization.overview.total_members')}
            </Typography>
            <Typography level="h2">{currentSeats}</Typography>
          </Stack>
        </Card>
        <Card variant="outlined" sx={{ flex: 1, minWidth: 200, p: 3 }}>
          <Stack spacing={1}>
            <Typography
              level="body-xs"
              color="neutral"
              startDecorator={<CreditIcon sx={{ fontSize: 14, color: 'var(--Icon-color)' }} />}
            >
              {t('organization.overview.available_credits')}
            </Typography>
            <Typography level="h2">{formatCreditAmount(organization.currentCredits)}</Typography>
          </Stack>
        </Card>
      </Stack>

      {/* Second row - Detailed cards */}
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        {/* Subscription Status Card */}
        <Card variant="outlined" sx={{ flex: 1, minWidth: 280, p: 3 }} data-testid="subscription-status-card">
          <Stack spacing={2}>
            <Typography level="title-md" startDecorator={<VpnKeyOutlinedIcon sx={{ fontSize: 20 }} />}>
              {t('organization.overview.subscription_status')}
            </Typography>
            <Stack spacing={1}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography level="body-sm" color="neutral">
                  {t('organization.overview.plan')}
                </Typography>
                <Chip
                  size="sm"
                  variant="soft"
                  color={paymentIssue ? 'danger' : activeSubscription ? 'success' : 'neutral'}
                >
                  {paymentIssue
                    ? t('organization.payment_issue')
                    : activeSubscription
                      ? t('organization.team_plan')
                      : t('organization.no_active_plan')}
                </Chip>
              </Stack>
              {activeSubscription && (
                <>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography level="body-sm" color="neutral">
                      {t('organization.overview.status')}
                    </Typography>
                    <Typography level="body-sm">
                      {activeSubscription.canceledAt
                        ? t('organization.overview.canceling')
                        : t('organization.overview.active')}
                    </Typography>
                  </Stack>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography level="body-sm" color="neutral">
                      <EventAvailableOutlinedIcon sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'text-bottom' }} />
                      {t('organization.overview.next_billing')}
                    </Typography>
                    <Typography level="body-sm">{formatDate(activeSubscription.periodEndsAt)}</Typography>
                  </Stack>
                </>
              )}
            </Stack>
          </Stack>
        </Card>

        {/* Seats Utilization Card */}
        <Card variant="outlined" sx={{ flex: 1, minWidth: 280, p: 3 }} data-testid="seats-utilization-card">
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography level="title-md" startDecorator={<GroupOutlinedIcon sx={{ fontSize: 20 }} />}>
                {t('organization.overview.seats_utilization')}
              </Typography>
              <Typography level="body-sm" color="neutral">
                {currentSeats} / {maxSeats}
              </Typography>
            </Stack>
            <LinearProgress
              determinate
              value={maxSeats > 0 ? (currentSeats / maxSeats) * 100 : 0}
              color={currentSeats >= maxSeats ? 'danger' : currentSeats > maxSeats * 0.8 ? 'warning' : 'primary'}
              sx={{ '--LinearProgress-thickness': '8px' }}
              aria-label={t('organization.overview.seats_utilization_label', { current: currentSeats, max: maxSeats })}
            />
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip size="sm" variant="soft" color="primary">
                {t('organization.overview.x_active', { count: currentSeats - pendingSeats })}
              </Chip>
              {pendingSeats > 0 && (
                <Chip size="sm" variant="soft" color="warning">
                  {t('organization.overview.x_pending', { count: pendingSeats })}
                </Chip>
              )}
              <Chip size="sm" variant="soft" color="neutral">
                {t('organization.overview.x_available', { count: availableSeats })}
              </Chip>
            </Stack>
          </Stack>
        </Card>
      </Stack>
    </Stack>
  );
};

export default OrganizationPage;
