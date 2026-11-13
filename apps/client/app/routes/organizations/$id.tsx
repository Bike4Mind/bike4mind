import { IOrganizationDocument, WithId, isOrgOwnerOrCurrentAdmin, isOrgOwnerOrPlatformAdmin } from '@bike4mind/common';
import { AdminPageHeader, SegmentedControl } from '@client/app/components/admin/shared';
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
import OrganizationAuditSection from '@client/app/components/organizations/OrganizationAuditSection';
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
import { creditBalanceParams, formatCreditAmount } from '@client/app/utils/formatCredits';
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  LinearProgress,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Typography,
} from '@mui/joy';
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import CreditCardOutlinedIcon from '@mui/icons-material/CreditCardOutlined';
import WorkspacePremiumOutlinedIcon from '@mui/icons-material/WorkspacePremiumOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import GroupWorkOutlinedIcon from '@mui/icons-material/GroupWorkOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined';
import {
  canManageOrgConnectors,
  canManageOrgIntegrations,
  canManageOrgSettings,
  canViewOrgAnalysis,
  canViewOrgBilling,
  canViewOrgAudit,
  canViewOrgUsage,
  IntegrationSections,
  LEGACY_INTEGRATION_TABS,
  OrganizationTabs,
  resolveAccessibleTab,
  resolveIntegrationSection,
  visibleIntegrationSections,
  type OrgTabAccess,
} from '@client/app/routes/organizations/orgTabAccess';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { FC, Fragment, ReactNode, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type RailTab = {
  tab: OrganizationTabs;
  icon: ReactNode;
  visible: (access: OrgTabAccess) => boolean;
  testId?: string;
};

/** The rail, grouped. A group whose tabs are all hidden for this caller renders no label. */
const RAIL_GROUPS: ReadonlyArray<{ key: 'team' | 'insights' | 'integrations' | 'admin'; tabs: RailTab[] }> = [
  {
    key: 'team',
    tabs: [
      { tab: OrganizationTabs.Overview, icon: <BusinessOutlinedIcon />, visible: () => true },
      { tab: OrganizationTabs.Members, icon: <GroupOutlinedIcon />, visible: () => true },
      { tab: OrganizationTabs.Groups, icon: <GroupWorkOutlinedIcon />, visible: a => a.canManageGroups },
    ],
  },
  {
    key: 'insights',
    tabs: [
      { tab: OrganizationTabs.Usage, icon: <InsightsOutlinedIcon />, visible: a => a.canViewUsage },
      { tab: OrganizationTabs.Analysis, icon: <RateReviewOutlinedIcon />, visible: a => a.canViewAnalysis },
    ],
  },
  {
    key: 'integrations',
    tabs: [
      {
        tab: OrganizationTabs.Integrations,
        icon: <ExtensionOutlinedIcon />,
        visible: a => visibleIntegrationSections(a).length > 0,
      },
    ],
  },
  {
    key: 'admin',
    tabs: [
      { tab: OrganizationTabs.Billing, icon: <CreditCardOutlinedIcon />, visible: a => a.canViewBilling },
      // Same gate as Connectors: owner, current manager or platform admin.
      { tab: OrganizationTabs.ApiKeys, icon: <KeyOutlinedIcon />, visible: a => a.canManageConnectors },
      {
        tab: OrganizationTabs.Audit,
        icon: <HistoryOutlinedIcon />,
        visible: a => !!a.canViewAudit,
        testId: 'organization-audit-tab',
      },
      { tab: OrganizationTabs.Settings, icon: <SettingsOutlinedIcon />, visible: a => a.canManageOrg },
    ],
  },
];

const OrganizationPage: FC = () => {
  const { t } = useTranslation();
  const { id } = useParams({ strict: false });
  const { data: organization, isLoading } = useGetOrganization(id as string);
  const { maxSeats, currentSeats } = useOrganizationSeats(id as string);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string; section?: string };
  const { currentUser } = useUser();

  // A pre-merge ?tab=github|webhooks|connectors reads as the Integrations section it moved to, on the
  // first paint, and the effect below rewrites the URL to the current shape.
  const legacySection = search.tab ? LEGACY_INTEGRATION_TABS[search.tab] : undefined;

  // The URL is the only place the requested tab lives; the page keeps no copy, so Back and a
  // pasted link move it like a click does. An unknown value names no tab, which would leave Tabs
  // with nothing selected, so it reads as Overview.
  const requestedTab = legacySection
    ? OrganizationTabs.Integrations
    : search.tab && Object.values(OrganizationTabs).includes(search.tab as OrganizationTabs)
      ? (search.tab as OrganizationTabs)
      : OrganizationTabs.Overview;
  const requestedSection = legacySection ?? search.section;

  useEffect(() => {
    if (!legacySection) return;
    navigate({
      to: '/organizations/$id',
      params: { id: id as string },
      search: { tab: OrganizationTabs.Integrations, section: legacySection },
      replace: true,
    });
  }, [legacySection, id, navigate]);

  // Replace rather than push: a tab click is a view change, not a destination, and pushing would
  // put one back-stack entry per click between the caller and the page they arrived from.
  const requestTab = (tab: OrganizationTabs) => {
    navigate({ to: '/organizations/$id', params: { id: id as string }, search: { tab }, replace: true });
  };
  const requestSection = (section: IntegrationSections) => {
    navigate({
      to: '/organizations/$id',
      params: { id: id as string },
      search: { tab: OrganizationTabs.Integrations, section },
      replace: true,
    });
  };

  // Every gate is computed here once and passed down; children never re-derive them. Usage and the
  // GitHub/Slack/Webhooks integrations are owner-only, Analysis is open to managers, Connectors to
  // owners and current managers - see orgTabAccess.ts for each rule and the server gate it mirrors.
  const access = useMemo<OrgTabAccess>(
    () => ({
      canManageOrg: canManageOrgSettings(currentUser, organization),
      canViewUsage: canViewOrgUsage(currentUser, organization),
      canViewAnalysis: canViewOrgAnalysis(currentUser, organization),
      canManageIntegrations: canManageOrgIntegrations(currentUser, organization),
      // Who may manage group instances + membership: the same isOrgOwnerOrCurrentAdmin rule
      // assertCanManageOrgGroups enforces. Personal orgs never have groups.
      canManageGroups:
        !!currentUser &&
        !!organization &&
        !organization.personal &&
        isOrgOwnerOrCurrentAdmin(currentUser, organization),
      canViewBilling: canViewOrgBilling(currentUser, organization),
      canManageConnectors: canManageOrgConnectors(currentUser, organization),
      canViewAudit: canViewOrgAudit(currentUser, organization),
    }),
    [currentUser, organization]
  );

  // Only the billing owner or a platform admin may add or remove managers (admins route authz).
  const canSetAdmins = !!currentUser && !!organization && isOrgOwnerOrPlatformAdmin(currentUser, organization);

  // A ?tab= deep link can ask for a tab this caller never gets rendered, so the request is sent
  // back through the same visibility rules the rail applies. Resolved during render rather than
  // in an effect on purpose: the gates read the org document, which lands a render after mount, and
  // until it does they deny everyone; deriving re-answers the question the moment it arrives.
  // The answer is deliberately not written back to the URL - rewriting ?tab=usage to ?tab=overview
  // would break the link for this caller the day they are granted access, and make one shared URL
  // mean different things to different people.
  const selectedTab = resolveAccessibleTab(requestedTab, access);
  const selectedSection = resolveIntegrationSection(requestedSection, access);
  const integrationSections = visibleIntegrationSections(access);

  // Unlike tabs, a section this caller cannot see is rewritten: sections are renamed and regrouped
  // per role, so a stale link lands on the one they get. Waits for the load (gates deny until then)
  // and for the legacy rewrite above to settle, so it never races or loops.
  const resolvedSection = currentUser && organization ? selectedSection : undefined;
  useEffect(() => {
    if (legacySection || !resolvedSection || selectedTab !== OrganizationTabs.Integrations) return;
    if (!search.section || search.section === resolvedSection) return;
    navigate({
      to: '/organizations/$id',
      params: { id: id as string },
      search: { tab: OrganizationTabs.Integrations, section: resolvedSection },
      replace: true,
    });
  }, [legacySection, resolvedSection, selectedTab, search.section, id, navigate]);

  useDocumentTitle(organization?.name, t('organization.document_title_suffix'));

  if (isLoading || !organization) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100%" width="100%">
        <CircularProgress />
      </Box>
    );
  }

  const header = (tab: OrganizationTabs, extra?: { count?: number; description?: string }) => (
    <Box sx={{ mb: 3 }}>
      <AdminPageHeader
        level="section"
        title={t(`organization.tabs.${tab}`)}
        count={extra?.count}
        description={extra?.description ?? t(`organization.descriptions.${tab}`)}
      />
    </Box>
  );

  return (
    <Stack
      gap="24px"
      height="100vh"
      sx={theme => ({
        backgroundColor: theme.palette.background.level1,
        pt: '24px',
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
      <Box sx={{ mx: '24px' }}>
        <Breadcrumbs
          items={[{ name: t('organization.organizations'), href: '/organizations' }, { name: organization.name }]}
        />
      </Box>

      <OrganizationHeader
        organization={organization}
        canManageOrg={access.canManageOrg}
        onSettingsClick={() => requestTab(OrganizationTabs.Settings)}
      />

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Tabs
          orientation="vertical"
          sx={{
            borderRadius: 'sm',
            flex: 1,
            overflow: 'hidden',
            minHeight: 0,
          }}
          value={selectedTab}
          onChange={(_, value) => requestTab(value as OrganizationTabs)}
        >
          <TabList
            data-testid="organization-tabs"
            sx={{
              width: '240px',
              borderRight: '1px solid',
              borderColor: 'divider',
              p: 2,
              '& .MuiTab-root': {
                justifyContent: 'flex-start',
                px: 2,
                py: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                '& svg': { fontSize: 16 },
                '&.Mui-selected': {
                  backgroundColor: 'background.level2',
                  fontWeight: 'bold',
                },
              },
            }}
          >
            {RAIL_GROUPS.map(group => {
              const tabs = group.tabs.filter(entry => entry.visible(access));
              if (tabs.length === 0) return null;
              return (
                <Fragment key={group.key}>
                  <Typography
                    level="body-xs"
                    role="presentation"
                    data-testid={`organization-tab-group-${group.key}`}
                    sx={{ px: 2, pt: 1.5, pb: 0.5, fontWeight: 600, color: 'text.tertiary' }}
                  >
                    {t(`organization.tab_groups.${group.key}`)}
                  </Typography>
                  {tabs.map(entry => (
                    <Tab key={entry.tab} value={entry.tab} data-testid={entry.testId}>
                      {entry.icon}
                      {t(`organization.tabs.${entry.tab}`)}
                    </Tab>
                  ))}
                </Fragment>
              );
            })}
          </TabList>

          <Box sx={{ p: 3, flex: 1, overflow: 'auto' }}>
            <TabPanel value={OrganizationTabs.Overview}>
              {header(OrganizationTabs.Overview)}
              <OrganizationOverviewSection organization={organization} />
            </TabPanel>
            <TabPanel value={OrganizationTabs.Members}>
              {header(OrganizationTabs.Members, {
                count: currentSeats,
                description: t('organization.descriptions.members', { current: currentSeats, max: maxSeats }),
              })}
              {currentUser && <OrganizationMembers organization={organization} />}
            </TabPanel>
            {access.canManageGroups && (
              <TabPanel value={OrganizationTabs.Groups}>
                {header(OrganizationTabs.Groups)}
                <OrganizationGroups organization={organization} canSetAdmins={canSetAdmins} />
              </TabPanel>
            )}
            {access.canViewUsage && (
              <TabPanel value={OrganizationTabs.Usage}>
                {header(OrganizationTabs.Usage)}
                <OrganizationUsageSection organization={organization} />
              </TabPanel>
            )}
            {access.canViewAnalysis && (
              <TabPanel value={OrganizationTabs.Analysis}>
                {header(OrganizationTabs.Analysis)}
                <OrganizationAnalysisSection organization={organization} />
              </TabPanel>
            )}
            {selectedSection && (
              <TabPanel value={OrganizationTabs.Integrations}>
                {header(OrganizationTabs.Integrations)}
                {integrationSections.length > 1 && (
                  <Box sx={{ mb: 3 }}>
                    <SegmentedControl
                      aria-label={t('organization.tabs.integrations')}
                      data-testid="organization-integration-sections"
                      value={selectedSection}
                      onChange={requestSection}
                      options={integrationSections.map(section => ({
                        value: section,
                        label: t(`organization.integration_sections.${section}`),
                      }))}
                    />
                  </Box>
                )}
                <IntegrationSection section={selectedSection} organization={organization} />
              </TabPanel>
            )}
            {access.canViewBilling && (
              <TabPanel value={OrganizationTabs.Billing}>
                {header(OrganizationTabs.Billing)}
                <OrganizationBillingSection organization={organization} />
              </TabPanel>
            )}
            {access.canManageConnectors && (
              <TabPanel value={OrganizationTabs.ApiKeys}>
                {header(OrganizationTabs.ApiKeys)}
                <OrgApiKeysSection key={organization.id} organizationId={organization.id} />
                <Typography level="title-md" component="h3" sx={{ mt: 4, mb: 2 }}>
                  {t('organization.api_keys.member_keys')}
                </Typography>
                <OrgMemberApiKeysSection key={`members-${organization.id}`} organizationId={organization.id} />
              </TabPanel>
            )}
            {/* Mounted only while selected, so the audit query runs only when someone opens the tab. */}
            {access.canViewAudit && selectedTab === OrganizationTabs.Audit && (
              <TabPanel value={OrganizationTabs.Audit}>
                {header(OrganizationTabs.Audit)}
                <OrganizationAuditSection key={organization.id} organizationId={organization.id} />
              </TabPanel>
            )}
            {access.canManageOrg && (
              <TabPanel value={OrganizationTabs.Settings}>
                {header(OrganizationTabs.Settings)}
                <OrganizationSettingsSection organization={organization} />
              </TabPanel>
            )}
          </Box>
        </Tabs>
      </Box>
    </Stack>
  );
};

/** One Integrations sub-section: a section title and description over the existing panel. */
const IntegrationSection: FC<{ section: IntegrationSections; organization: WithId<IOrganizationDocument> }> = ({
  section,
  organization,
}) => {
  const { t } = useTranslation();
  return (
    <Stack spacing={2} data-testid={`organization-integration-section-${section}`}>
      <Box>
        <Typography level="title-md" component="h3">
          {t(`organization.integration_sections.${section}`)}
        </Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
          {t(`organization.integration_descriptions.${section}`)}
        </Typography>
      </Box>
      {section === IntegrationSections.GitHub && <OrgGitHubConnectionTab orgId={organization.id} />}
      {section === IntegrationSections.Slack && <OrgSlackIntegration organization={organization} />}
      {section === IntegrationSections.Webhooks && <OrgWebhookConfig organization={organization} />}
      {section === IntegrationSections.Connectors && (
        <OrgCustomMcpPolicySection key={organization.id} organization={organization} />
      )}
    </Stack>
  );
};

const OrganizationHeader: FC<{
  organization: WithId<IOrganizationDocument>;
  canManageOrg: boolean;
  onSettingsClick: () => void;
}> = ({ organization, canManageOrg, onSettingsClick }) => {
  const { t } = useTranslation();
  const { name, description } = organization;
  const initial = name.charAt(0).toUpperCase();
  const { data: subscriptions } = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);
  const subscription = pickDisplayedSubscription(subscriptions ?? []);
  const paymentIssue = !!subscription && isDelinquentSubscriptionStatus(subscription.status);
  const hasActiveSubscription = !!subscription && !subscription.canceledAt && !paymentIssue;
  const { currentSeats } = useOrganizationSeats(organization.id);

  return (
    <Card variant="outlined" sx={{ mx: 3, p: 3 }}>
      <Stack direction="row" spacing={3} alignItems="center">
        <Avatar size="lg" sx={{ '--Avatar-size': '64px' }}>
          {initial}
        </Avatar>
        <Stack spacing={1} flex={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography level="h3">{name}</Typography>
            {canManageOrg && (
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
                size="sm"
                onClick={onSettingsClick}
                data-testid="organization-header-settings-btn"
              >
                {t('organization.tabs.settings')}
              </Button>
            )}
          </Stack>
          <Typography level="body-sm" color="neutral">
            {description}
          </Typography>
          <Stack direction="row" spacing={2} mt={1}>
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
              startDecorator={<WorkspacePremiumOutlinedIcon sx={{ fontSize: 14 }} />}
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
            <Typography level="title-md" startDecorator={<WorkspacePremiumOutlinedIcon sx={{ fontSize: 20 }} />}>
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
