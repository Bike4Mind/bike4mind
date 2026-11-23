import {
  IOrganizationDocument,
  WithId,
  hasOrgPermission,
  isOrgOwnerOrCurrentAdmin,
  isOrgOwnerOrPlatformAdmin,
} from '@bike4mind/common';
import { AdminPageHeader, SegmentedControl } from '@client/app/components/admin/shared';
import Breadcrumbs from '@client/app/components/common/Breadcrumbs';
import OrganizationMembers from '@client/app/components/organizations/Member';
import OrganizationLibrarySection from '@client/app/components/organizations/OrganizationLibrarySection';
import OrganizationGroups from '@client/app/components/organizations/OrganizationGroups';
import OrganizationBillingSection from '@client/app/components/organizations/OrganizationBillingSection';
import OrganizationSettingsSection from '@client/app/components/organizations/OrganizationSettingsSection';
import OrganizationAvatar from '@client/app/components/organizations/OrganizationAvatar';
import OrganizationRetentionSection from '@client/app/components/organizations/OrganizationRetentionSection';
import OrganizationUsageSection from '@client/app/components/organizations/OrganizationUsageSection';
import OrganizationAnalysisSection from '@client/app/components/organizations/OrganizationAnalysisSection';
import OrgSlackIntegration from '@client/app/components/organizations/OrgSlackIntegration';
import OrgWebhookConfig from '@client/app/components/organizations/OrgWebhookConfig';
import OrgGitHubConnectionTab from '@client/app/components/organizations/OrgGitHubConnectionTab';
import OrgCustomMcpPolicySection from '@client/app/components/organizations/OrgCustomMcpPolicySection';
import OrgModelPolicySection from '@client/app/components/organizations/OrgModelPolicySection';
import OrgDomainsTab from '@client/app/components/organizations/OrgDomainsTab';
import OrgApiKeysSection from '@client/app/components/organizations/OrgApiKeysSection';
import OrgMemberApiKeysSection from '@client/app/components/organizations/OrgMemberApiKeysSection';
import OrganizationAuditSection from '@client/app/components/organizations/OrganizationAuditSection';
import TeamOnboardingChecklist from '@client/app/components/organizations/TeamOnboardingChecklist';
import OwnerOnlyNote from '@client/app/components/organizations/OwnerOnlyNote';
import { readTeamPreference, recentTeamsKey, rememberTeam } from '@client/app/components/organizations/teamPreferences';
import { isAxiosError } from 'axios';
import CreditIcon from '@client/app/components/svgs/icons/CreditIcon';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOrganization, useOrganizationSeats } from '@client/app/hooks/data/organizations';
import { useGetSubscriptionsByOwner } from '@client/app/hooks/data/subscriptions';
import { SubscriptionOwnerType, pickDisplayedSubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import { getOrgPlanState, isLiveOrgPlan, orgPlanChipColor } from '@client/app/components/organizations/orgPlanState';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { creditBalanceParams, formatCreditAmount } from '@client/app/utils/formatCredits';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
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
import WorkspacePremiumOutlinedIcon from '@mui/icons-material/WorkspacePremiumOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import GroupWorkOutlinedIcon from '@mui/icons-material/GroupWorkOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined';
import LocalLibraryOutlinedIcon from '@mui/icons-material/LocalLibraryOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import {
  canManageOrgApiKeys,
  canManageOrgConnectors,
  canManageOrgDomains,
  canManageOrgGroups,
  canManageOrgIntegrations,
  canManageOrgSettings,
  canViewOrgAnalysis,
  canViewOrgBilling,
  canViewOrgAudit,
  canViewOrgUsage,
  IntegrationSections,
  isOrgTabLocked,
  LEGACY_INTEGRATION_TABS,
  ORG_TAB_AUDIENCE,
  OrganizationTabs,
  resolveIntegrationSection,
  resolveOrgTabView,
  visibleIntegrationSections,
  type OrgTabAccess,
} from '@client/app/routes/organizations/orgTabAccess';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { FC, Fragment, ReactNode, useEffect, useId, useMemo, type AriaAttributes } from 'react';
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
      {
        tab: OrganizationTabs.Library,
        icon: <LocalLibraryOutlinedIcon />,
        visible: () => true,
        testId: 'organization-library-tab',
      },
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
      {
        tab: OrganizationTabs.Domains,
        icon: <LanguageOutlinedIcon />,
        visible: a => a.canManageDomains,
        testId: 'org-tab-domains',
      },
      // A manager gets it as a locked entry: plan, credits and seats read-only, changes owner-only.
      { tab: OrganizationTabs.Billing, icon: <CreditCardOutlinedIcon />, visible: a => a.canViewBilling },
      { tab: OrganizationTabs.ApiKeys, icon: <KeyOutlinedIcon />, visible: a => a.canManageApiKeys },
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
  const { data: organization, isLoading, isError, error, refetch } = useGetOrganization(id as string);
  const { activeSeats } = useOrganizationSeats(id as string);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string; section?: string };
  const { currentUser } = useUser();
  const isMobile = useIsMobile();
  const sectionId = useId();

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

  // Every gate is computed here once and passed down; children never re-derive them. Each tab and
  // section asks the org permission its routes check - see orgTabAccess.ts for each rule.
  const access = useMemo<OrgTabAccess>(
    () => ({
      canManageOrg: canManageOrgSettings(currentUser, organization),
      canViewUsage: canViewOrgUsage(currentUser, organization),
      canViewAnalysis: canViewOrgAnalysis(currentUser, organization),
      canManageIntegrations: canManageOrgIntegrations(currentUser, organization),
      canManageGroups: canManageOrgGroups(currentUser, organization),
      canViewBilling: canViewOrgBilling(currentUser, organization),
      canManageConnectors: canManageOrgConnectors(currentUser, organization),
      canManageApiKeys: canManageOrgApiKeys(currentUser, organization),
      canManageDomains: canManageOrgDomains(currentUser, organization),
      canViewAudit: canViewOrgAudit(currentUser, organization),
      seesLockedTabs: !!currentUser && !!organization && isOrgOwnerOrCurrentAdmin(currentUser, organization),
    }),
    [currentUser, organization]
  );

  const canManageModelPolicy =
    !!currentUser && !!organization && hasOrgPermission(currentUser, organization, 'managePolicies');

  // Only the billing owner or a platform admin may add or remove managers (admins route authz).
  const canSetAdmins = !!currentUser && !!organization && isOrgOwnerOrPlatformAdmin(currentUser, organization);

  // A ?tab= deep link can ask for a tab this caller never gets rendered, so the request is sent
  // back through the same visibility rules the rail applies. Resolved during render rather than
  // in an effect on purpose: the gates read the org document, which lands a render after mount, and
  // until it does they deny everyone; deriving re-answers the question the moment it arrives.
  // The answer is deliberately not written back to the URL - rewriting ?tab=usage to ?tab=overview
  // would break the link for this caller the day they are granted access, and make one shared URL
  // mean different things to different people.
  // A refused tab is named in a notice on Overview, so the link does not silently land elsewhere.
  // Not for a caller who already manages the team: they were refused for another reason (a personal
  // team has no Groups or Domains; Audit excludes platform admins), so "ask the owner" would mislead.
  const tabView = resolveOrgTabView(requestedTab, access);
  const selectedTab = tabView.tab;
  const audience = tabView.denied && currentUser ? ORG_TAB_AUDIENCE[tabView.denied] : undefined;
  const deniedAudience = audience === 'managers' && access.seesLockedTabs ? undefined : audience;
  const selectedSection = resolveIntegrationSection(requestedSection, access);
  const integrationSections = visibleIntegrationSections(access);
  // Share current grouped tab order and access rules across the rail and phone selector.
  const visibleTabs = RAIL_GROUPS.flatMap(group =>
    group.tabs.filter(entry => entry.visible(access) || isOrgTabLocked(entry.tab, access))
  );
  const tabId = (tab: OrganizationTabs) => `${sectionId}-tab-${tab}`;
  const panelId = (tab: OrganizationTabs) => `${sectionId}-panel-${tab}`;
  const panelAccessibility = (
    tab: OrganizationTabs
  ): Pick<AriaAttributes, 'aria-label' | 'aria-labelledby'> & { id: string } => ({
    id: panelId(tab),
    ...(isMobile
      ? { 'aria-labelledby': undefined, 'aria-label': t(`organization.tabs.${tab}`) }
      : { 'aria-labelledby': tabId(tab) }),
  });

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

  useEffect(() => {
    if (organization && !isError && currentUser) rememberTeam(currentUser.id, organization.id);
  }, [organization, isError, currentUser]);

  if (isError || (!isLoading && !organization)) {
    const status = isAxiosError(error) ? error.response?.status : undefined;
    const knownTeam = currentUser && readTeamPreference(recentTeamsKey(currentUser.id)).includes(id as string);
    const unavailable = status === 400 || status === 404 || !error;
    return (
      <Stack spacing={2} alignItems="center" sx={{ p: 4 }} role="alert" data-testid="organization-error-state">
        <Typography level="h2">
          {status === 403 || (unavailable && knownTeam)
            ? 'You no longer have access'
            : unavailable
              ? 'Team not found'
              : 'Could not load team'}
        </Typography>
        <Typography>
          {unavailable
            ? 'This team may have been removed or is not available to your account.'
            : 'Please try again or return to your teams.'}
        </Typography>
        {!unavailable && status !== 403 && (
          <Button onClick={() => refetch()} data-testid="organization-retry-btn">
            Retry
          </Button>
        )}
        <Button onClick={() => navigate({ to: '/organizations' })} data-testid="organization-back-btn">
          All teams
        </Button>
      </Stack>
    );
  }

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
      gap={{ xs: '16px', sm: '24px' }}
      sx={theme => ({
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
        {currentUser?.id === organization.userId &&
          new URLSearchParams(window.location.search).get('team_created') === 'true' && (
            <Alert color="success" sx={{ mb: 2 }} data-testid="organization-created-confirmation">
              Team created successfully! Get started with the checklist below.
            </Alert>
          )}
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
                startDecorator={visibleTabs.find(entry => entry.tab === selectedTab)?.icon}
                slotProps={{
                  button: { 'aria-label': 'Team section', 'data-testid': 'organization-tabs-select' },
                  listbox: { 'aria-label': 'Team sections' },
                }}
              >
                {visibleTabs.map(entry => {
                  const locked = isOrgTabLocked(entry.tab, access);
                  return (
                    <Option
                      key={entry.tab}
                      value={entry.tab}
                      // Joy takes a non-string child's label from innerText, so name it explicitly: the
                      // closed Select then shows the tab name alone, without the lock icon's title.
                      label={t(`organization.tabs.${entry.tab}`)}
                      data-testid={
                        locked
                          ? `organization-tabs-option-locked-${entry.tab}`
                          : `organization-tabs-option-${entry.tab}`
                      }
                    >
                      {t(`organization.tabs.${entry.tab}`)}
                      {locked && (
                        <LockOutlinedIcon
                          titleAccess={t('organization.access_notice.owner_only')}
                          sx={{ ml: 'auto', color: 'text.tertiary' }}
                        />
                      )}
                    </Option>
                  );
                })}
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
                // The rail is as tall as the page, which can be shorter than its entries; scroll it
                // rather than letting the last entries (Settings) fall off-screen. Entries keep their
                // height so the column overflows instead of squashing them.
                overflowY: 'auto',
                flexWrap: 'nowrap',
                '& > *': { flexShrink: 0 },
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
                const tabs = group.tabs.filter(entry => entry.visible(access) || isOrgTabLocked(entry.tab, access));
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
                    {tabs.map(entry => {
                      const locked = isOrgTabLocked(entry.tab, access);
                      return (
                        <Tab
                          key={entry.tab}
                          value={entry.tab}
                          id={tabId(entry.tab)}
                          aria-controls={
                            entry.tab === OrganizationTabs.Audit && selectedTab !== OrganizationTabs.Audit
                              ? undefined
                              : panelId(entry.tab)
                          }
                          data-testid={locked ? `organization-tab-locked-${entry.tab}` : entry.testId}
                        >
                          {entry.icon}
                          {t(`organization.tabs.${entry.tab}`)}
                          {locked && (
                            <LockOutlinedIcon
                              titleAccess={t('organization.access_notice.owner_only')}
                              sx={{ ml: 'auto', color: 'text.tertiary' }}
                            />
                          )}
                        </Tab>
                      );
                    })}
                  </Fragment>
                );
              })}
            </TabList>
          )}

          <Box sx={{ p: { xs: 1, sm: 3 }, flex: 1, overflow: 'auto', minWidth: 0 }}>
            <TabPanel value={OrganizationTabs.Overview} {...panelAccessibility(OrganizationTabs.Overview)}>
              {tabView.denied && deniedAudience && (
                <Alert
                  color="warning"
                  variant="soft"
                  startDecorator={<LockOutlinedIcon />}
                  sx={{ mb: 3 }}
                  data-testid="organization-tab-denied-notice"
                >
                  {t(`organization.access_notice.denied_${deniedAudience}`, {
                    tab: t(`organization.tabs.${tabView.denied}`),
                  })}
                </Alert>
              )}
              {header(OrganizationTabs.Overview)}
              {currentUser?.id === organization.userId && !organization.personal && (
                <TeamOnboardingChecklist
                  key={`${currentUser.id}:${organization.id}`}
                  organization={organization}
                  userId={currentUser.id}
                  onOpen={requestTab}
                />
              )}
              <OrganizationOverviewSection organization={organization} />
              <OrganizationRetentionSection key={organization.id} organization={organization} />
            </TabPanel>
            <TabPanel value={OrganizationTabs.Library} {...panelAccessibility(OrganizationTabs.Library)}>
              {header(OrganizationTabs.Library)}
              {selectedTab === OrganizationTabs.Library && (
                <OrganizationLibrarySection
                  key={organization.id}
                  organizationId={organization.id}
                  canManage={!!currentUser && hasOrgPermission(currentUser, organization, 'manageContent')}
                />
              )}
            </TabPanel>
            <TabPanel value={OrganizationTabs.Members} {...panelAccessibility(OrganizationTabs.Members)}>
              {/* Seat numbers live only in the tab's seat summary (OrgSeatSummary). */}
              {header(OrganizationTabs.Members, { count: activeSeats })}
              {currentUser && <OrganizationMembers organization={organization} />}
            </TabPanel>
            {access.canManageGroups && (
              <TabPanel value={OrganizationTabs.Groups} {...panelAccessibility(OrganizationTabs.Groups)}>
                {header(OrganizationTabs.Groups)}
                <OrganizationGroups organization={organization} canSetAdmins={canSetAdmins} />
              </TabPanel>
            )}
            {access.canViewUsage && (
              <TabPanel value={OrganizationTabs.Usage} {...panelAccessibility(OrganizationTabs.Usage)}>
                {header(OrganizationTabs.Usage)}
                <OrganizationUsageSection organization={organization} />
              </TabPanel>
            )}
            {access.canViewAnalysis && (
              <TabPanel value={OrganizationTabs.Analysis} {...panelAccessibility(OrganizationTabs.Analysis)}>
                {header(OrganizationTabs.Analysis)}
                <OrganizationAnalysisSection organization={organization} />
              </TabPanel>
            )}
            {selectedSection && (
              <TabPanel value={OrganizationTabs.Integrations} {...panelAccessibility(OrganizationTabs.Integrations)}>
                {header(OrganizationTabs.Integrations)}
                {!access.canManageIntegrations && (
                  <Box sx={{ mb: 3 }}>
                    <OwnerOnlyNote testId="organization-integrations-owner-only">
                      {t('organization.access_notice.integrations_locked')}
                    </OwnerOnlyNote>
                  </Box>
                )}
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
              <TabPanel value={OrganizationTabs.Billing} {...panelAccessibility(OrganizationTabs.Billing)}>
                {header(OrganizationTabs.Billing)}
                <OrganizationBillingSection organization={organization} />
              </TabPanel>
            )}
            {isOrgTabLocked(OrganizationTabs.Billing, access) && (
              <TabPanel value={OrganizationTabs.Billing} {...panelAccessibility(OrganizationTabs.Billing)}>
                {header(OrganizationTabs.Billing, {
                  description: t('organization.access_notice.billing_locked_description'),
                })}
                <LockedBillingSummary organization={organization} />
              </TabPanel>
            )}
            {access.canManageDomains && (
              <TabPanel value={OrganizationTabs.Domains} {...panelAccessibility(OrganizationTabs.Domains)}>
                {header(OrganizationTabs.Domains)}
                <OrgDomainsTab key={organization.id} organizationId={organization.id} />
              </TabPanel>
            )}
            {access.canManageApiKeys && (
              <TabPanel value={OrganizationTabs.ApiKeys} {...panelAccessibility(OrganizationTabs.ApiKeys)}>
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
              <TabPanel value={OrganizationTabs.Audit} {...panelAccessibility(OrganizationTabs.Audit)}>
                {header(OrganizationTabs.Audit)}
                <OrganizationAuditSection key={organization.id} organizationId={organization.id} />
              </TabPanel>
            )}
            {access.canManageOrg && (
              <TabPanel value={OrganizationTabs.Settings} {...panelAccessibility(OrganizationTabs.Settings)}>
                {header(OrganizationTabs.Settings)}
                <OrganizationSettingsSection organization={organization} />
                {canManageModelPolicy && (
                  <Box sx={{ mt: 4 }}>
                    <OrgModelPolicySection key={organization.id} organization={organization} />
                  </Box>
                )}
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

/**
 * The Billing tab for a manager: credits and seats read-only, with every change left to the owner.
 * Until granular roles land, the owner is the only one the Billing routes accept.
 */
const LockedBillingSummary: FC<{ organization: WithId<IOrganizationDocument> }> = ({ organization }) => {
  const { t } = useTranslation();
  const { currentSeats, maxSeats } = useOrganizationSeats(organization.id);
  return (
    <Stack spacing={2} data-testid="organization-billing-locked">
      <OwnerOnlyNote testId="organization-billing-owner-only">
        {t('organization.access_notice.billing_locked')}
      </OwnerOnlyNote>
      <Card variant="outlined" sx={{ p: 3 }}>
        <Typography level="title-sm">{t('organization.access_notice.billing_summary')}</Typography>
        <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          <Stack spacing={0.5}>
            <Typography level="body-xs" color="neutral">
              {t('organization.access_notice.credits_remaining')}
            </Typography>
            <Typography level="h4" data-testid="organization-billing-locked-credits">
              {formatCreditAmount(organization.currentCredits)}
            </Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography level="body-xs" color="neutral">
              {t('organization.access_notice.seats_used')}
            </Typography>
            <Typography level="h4" data-testid="organization-billing-locked-seats">
              {/* maxSeats 0 is a plan with no seat cap, so there is no "of" to show. */}
              {maxSeats > 0
                ? t('organization.access_notice.seats_value', { current: currentSeats, max: maxSeats })
                : currentSeats}
            </Typography>
          </Stack>
        </Stack>
      </Card>
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
  const { data: subscriptions } = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);
  const planState = getOrgPlanState(pickDisplayedSubscription(subscriptions ?? []));
  const { activeSeats } = useOrganizationSeats(organization.id);

  return (
    <Card variant="outlined" sx={{ mx: { xs: 2, sm: 3 }, p: { xs: 2, sm: 3 } }} data-testid="organization-header">
      <Stack direction="row" spacing={{ xs: 2, sm: 3 }} alignItems={{ xs: 'flex-start', sm: 'center' }}>
        <OrganizationAvatar
          organization={organization}
          size="lg"
          sx={{ '--Avatar-size': { xs: '48px', sm: '64px' } }}
        />
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
                data-testid="organization-header-settings-btn"
              >
                {t('organization.tabs.settings')}
              </Button>
            )}
          </Stack>
          <Typography level="body-sm" color="neutral">
            {description}
          </Typography>
          <Stack direction="row" spacing={{ xs: 1, sm: 2 }} mt={1} flexWrap="wrap" useFlexGap>
            <Chip size="sm" variant="soft" startDecorator={<GroupOutlinedIcon sx={{ fontSize: 14 }} />}>
              {t('organization.x_members', { count: activeSeats })}
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
              color={orgPlanChipColor(planState)}
              startDecorator={<WorkspacePremiumOutlinedIcon sx={{ fontSize: 14 }} />}
            >
              {t(`organization.plan_states.${planState}`)}
            </Chip>
          </Stack>
        </Stack>
      </Stack>
    </Card>
  );
};

const OrganizationOverviewSection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const { t, i18n } = useTranslation();
  const { activeSeats } = useOrganizationSeats(organization.id);
  const { data: subscriptions } = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);

  const subscription = pickDisplayedSubscription(subscriptions ?? []);
  const planState = getOrgPlanState(subscription);
  const activeSubscription = subscription && isLiveOrgPlan(planState) ? subscription : undefined;
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
            <Typography level="h2">{activeSeats}</Typography>
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
                <Chip size="sm" variant="soft" color={orgPlanChipColor(planState)}>
                  {t(`organization.plan_states.${planState}`)}
                </Chip>
              </Stack>
              {activeSubscription && (
                <>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography level="body-sm" color="neutral">
                      {t('organization.overview.status')}
                    </Typography>
                    <Typography level="body-sm">
                      {planState === 'ending'
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
      </Stack>
    </Stack>
  );
};

export default OrganizationPage;
