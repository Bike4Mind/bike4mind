import { canAccessAdmin, hasAdminPermission } from '@bike4mind/common';
import AdminSettingsTab from '@client/app/components/admin/AdminSettingsTab';
import FeedbackTab from '@client/app/components/admin/Feedback';
import AdminFilesTab from '@client/app/components/admin/FilesTab';
import WorldTimeTab from '@client/app/components/admin/WorldTime';
import SystemPromptsTab from '@client/app/components/admin/SystemPromptsTab';
import ManageGearsTab from '@client/app/components/admin/ManageGearsTab';
import EmailVerificationTab from '@client/app/components/admin/EmailVerificationTab';
import AdminSystemHealthTab from '@client/app/components/admin/AdminSystemHealthTab';
import { useUser } from '@client/app/contexts/UserContext';
import CloseIcon from '@mui/icons-material/Close';
import { IconButton } from '@mui/joy';
import { Box, Drawer, Grid, Sheet, TabPanel, Tabs, Typography, Tooltip } from '@mui/joy';
import { useGetWaitingSubscribersCount } from '@client/app/hooks/data/subscribers';
import { useLiveOpsTriageEnv } from '@client/app/hooks/data/admin';
import { useRouter } from '@tanstack/react-router';
import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@client/app/contexts/ApiContext';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import { useGetSession } from '@client/app/hooks/data/sessions';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import ModalsAdminTab from './AdminModalTab';
import EmbedKeysTab from './EmbedKeysTab';
import AdminWhatsNewModalsTab from './AdminWhatsNewModalsTab';
import AdminReleaseNotesTab from './ReleaseNotes/AdminReleaseNotesTab';
import { resolveEnvironmentBanner } from './environmentBanner';
import AnalyticsTab from './Analytics';
import UsersTab from './Users';
import dynamic from 'next/dynamic';
import AdminSubscriptions from './Subscriptions';
import OrganizationsTab from './OrganizationsTab';
import CreditAnalyticsTab from './CreditAnalysis';
import SecretsRotationTab from './SecretsRotationTab';
import InviteCenter from './InviteCenter';
import { ModelLogsTab } from './ModelLogsTab';
import IdentityProvidersTab from './IdentityProvidersTab';
import LLMDashboardTab from './LLMDashboardTab';
import RapidReplyTab from './RapidReplyTab';
import VoiceSettingsTab from './VoiceSettingsTab';
import DocumentationTab from './DocumentationTab';
import KnowledgeModal from '../Knowledge/KnowledgeModal';
import { HelpPanel } from '../help';
import { useHelpKeyboardShortcut } from '@client/app/hooks/useHelpKeyboardShortcut';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import HelpCenterIcon from '@mui/icons-material/HelpCenter';
import ToolDefinitionsTab from './ToolDefinitionsTab';
import EmailMarketingTab from './EmailMarketingTab';
import SystemSecretsTab from './SystemSecretsTab';
import MenuIcon from '@mui/icons-material/Menu';
import ApiReferenceTab from './ApiReferenceTab';
import ApiCookbookTab from './ApiCookbookTab';
import { AdminTab } from './adminSidebarConfig';
import { canAccessAdminTab, canRenderAdminTab } from './adminTabRenderability';
import { useAdminTabUrlSync } from './useAdminTabUrlSync';
import { useAdminModal } from './useAdminModal';
import { SidebarNav } from './AdminSidebarNav';

export { AdminTab } from './adminSidebarConfig';

const AdminDashboardTab = dynamic(() => import('./AdminDashboardTab'), { ssr: false });

const AdminLiveOpsTriageMultiConfigTab = dynamic(() => import('./AdminLiveOpsTriageMultiConfigTab'), {
  ssr: false,
});
const WebhookAuditLogsTab = dynamic(() => import('./WebhookAuditLogs'), { ssr: false });
const AuditLogTab = dynamic(() => import('./AuditLog'), { ssr: false });

const MigrateUsersTab = dynamic(() => import('./MigrateUsersTab'), { ssr: false });
const AgentOpsTab = dynamic(() => import('./AgentOpsTab'), { ssr: false });
const AgentExecutionsTab = dynamic(() => import('./AgentExecutionsTab'), { ssr: false });
const SubscribersTab = dynamic(() => import('./SubscribersTab'), { ssr: false });
const PartnerSignupRulesTab = dynamic(() => import('./PartnerSignupRulesTab'), { ssr: false });
const OAuthClientsTab = dynamic(() => import('./OAuthClientsTab'), { ssr: false });
const AdminGrowthPricingTab = dynamic(() => import('./AdminGrowthPricingTab'), { ssr: false });
const ModelMetricsTab = dynamic(() => import('./ModelMetrics'), { ssr: false });
const ModelLifecycleTab = dynamic(() => import('./ModelLifecycleTab'), { ssr: false });
const EventMetricsTab = dynamic(() => import('./EventMetrics'), { ssr: false });
const SecurityDashboardMock = dynamic(() => import('./SecurityDashboardMock'), { ssr: false });
const Team = lazy(() => import('./Team'));
const SlackWorkspacesTab = dynamic(() => import('./SlackWorkspacesTab'), { ssr: false });
const SlackMetricsPage = dynamic(() => import('./SlackMetrics'), { ssr: false });
const GitHubConnectionTab = dynamic(() => import('./GitHubConnectionTab'), { ssr: false });
const HelpAnalyticsTab = dynamic(() => import('./HelpAnalyticsTab'), { ssr: false });
const ContextInspectorTab = dynamic(() => import('./ContextInspectorTab'), { ssr: false });
const RetrievalRateTab = dynamic(() => import('./RetrievalRateTab'), { ssr: false });
const RateLimitsTab = dynamic(() => import('./RateLimits'), { ssr: false });
const DlqReplayTab = dynamic(() => import('./DlqReplayTab'), { ssr: false });
const ApiKeyScopePreflightTab = dynamic(() => import('./ApiKeyScopePreflightTab'), { ssr: false });
const IntegrationHealthTab = dynamic(() => import('./IntegrationHealth'), { ssr: false });
const IntegrationDemandTab = dynamic(() => import('./IntegrationDemandTab'), { ssr: false });
const SreAgentTab = dynamic(() => import('./SreAgentTab'), { ssr: false });
const SecopsTriageTab = dynamic(() => import('./SecopsTriageTab'), { ssr: false });
const PublishedArtifactsTab = dynamic(() => import('./PublishedArtifactsTab'), { ssr: false });
const PrReportTab = dynamic(() => import('./PrReport/PrReportTab'), { ssr: false });
const ArchitectureDiagramsTab = dynamic(() => import('./ArchitectureDiagramsTab'), { ssr: false });
const DependenciesTab = dynamic(() => import('./DependenciesTab'), { ssr: false });

export const useAdminNotifications = create<{
  hiddenNotifications: string[];
  hideNotification: (notificationId: string) => void;
}>((set, get) => ({
  hiddenNotifications: [],
  hideNotification: (notificationId: string) => {
    const current = get().hiddenNotifications;
    if (!current.includes(notificationId)) {
      set({ hiddenNotifications: [...current, notificationId] });
    }
  },
}));

const EnvironmentBanner = () => {
  const router = useRouter();
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';

  const { bannerColor, environmentName } = resolveEnvironmentBanner(hostname, process.env.NEXT_PUBLIC_SERVER_DOMAIN);

  return (
    <Box
      sx={{
        backgroundColor: bannerColor,
        color: 'white',
        padding: '4px 8px',
        textAlign: 'center',
        fontWeight: 'bold',
        position: 'sticky',
        top: 0,
        zIndex: 1100,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        height: '32px',
      }}
    >
      <Box flexBasis="40px" />
      <Typography level="body-sm" sx={{ color: 'white', flexGrow: 1, textAlign: 'center' }}>
        {environmentName}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <Tooltip title="Help Center (Shift+?)" placement="bottom">
          <IconButton
            onClick={() => openHelpPanel()}
            sx={{
              color: 'white',
              padding: '4px',
              '&:hover': {
                backgroundColor: 'rgba(255, 255, 255, 0.2)',
              },
            }}
            size="sm"
            data-testid="admin-help-center-btn"
          >
            <HelpCenterIcon fontSize="small" sx={{ color: 'white' }} />
          </IconButton>
        </Tooltip>
        <IconButton
          onClick={() => router.history.back()}
          sx={{
            color: 'white',
            padding: '4px',
            '&:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
            },
          }}
          size="sm"
        >
          <CloseIcon fontSize="small" sx={{ color: 'white' }} data-testid="close-admin-page-banner-btn" />
        </IconButton>
      </Box>
    </Box>
  );
};

interface AdminPageProps {
  /**
   * Shows the user migration feature in the Admin page
   */
  enableUserMigration?: boolean;
}

const AdminPage = ({ enableUserMigration }: AdminPageProps) => {
  const [activeTab, setActiveTab] = useAdminModal(useShallow(state => [state.activeTab, state.setActiveTab]));
  const hiddenNotifications = useAdminNotifications(state => state.hiddenNotifications);
  const { currentUser } = useUser();

  // LiveOps Triage tab visibility - show everywhere except fork production environments
  const { data: liveopsEnvData, isError: isLiveOpsEnvError } = useLiveOpsTriageEnv(
    hasAdminPermission(currentUser, 'settings:manage')
  );
  const showLiveOpsTriageTab = liveopsEnvData?.showTab ?? false;

  // Selecting a tab this screen cannot draw would leave the content pane blank, so the URL sync
  // treats it as unknown and corrects the store instead.
  const isAdminTabRenderable = useCallback(
    (tab: AdminTab) =>
      canAccessAdminTab(currentUser, tab) &&
      canRenderAdminTab(tab, {
        enableUserMigration,
        liveOpsTriage: isLiveOpsEnvError ? false : liveopsEnvData?.showTab,
      }),
    [currentUser, enableUserMigration, liveopsEnvData, isLiveOpsEnvError]
  );

  useAdminTabUrlSync(
    activeTab,
    setActiveTab,
    isAdminTabRenderable,
    hasAdminPermission(currentUser, 'support:read')
      ? AdminTab.Users
      : hasAdminPermission(currentUser, 'settings:manage')
        ? AdminTab.AdminSettings
        : AdminTab.EmbedKeys
  );

  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  // Admin Floating Chat (docked-session floating chat pattern)
  const ADMIN_SESSION_KEY = 'admin-assistant-session-id';
  const [adminSessionId, setAdminSessionId] = useState<string | null>(null);
  const adminInitialized = useRef(false);

  useEffect(() => {
    if (adminInitialized.current || !currentUser?.isAdmin) return;
    adminInitialized.current = true;

    (async () => {
      const savedId = localStorage.getItem(ADMIN_SESSION_KEY);
      if (savedId) {
        try {
          await api.get(`/api/sessions/${savedId}`);
          setAdminSessionId(savedId);
          return;
        } catch {
          localStorage.removeItem(ADMIN_SESSION_KEY);
        }
      }
      try {
        const { data } = await api.post('/api/sessions/create', { name: 'Admin Assistant' });
        localStorage.setItem(ADMIN_SESSION_KEY, data.id);
        setAdminSessionId(data.id);
      } catch (err) {
        console.error('Failed to create Admin Assistant session:', err);
      }
    })();
  }, [currentUser?.isAdmin]);

  const adminSession = useGetSession(adminSessionId);

  // Set floatingChat layout on mount, restore on unmount
  // FloatingChatWindow auto-minimizes on narrow screens, so no need to check here
  useEffect(() => {
    if (!currentUser?.isAdmin) return;
    setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: false });
    return () => {
      setSessionLayout({ layout: 'hide' });
    };
  }, [currentUser?.isAdmin]);

  // Global keyboard shortcut: Press '?' to toggle Help Center
  useHelpKeyboardShortcut();

  // Get waiting subscribers count for badge
  const waitingSubscribers = useGetWaitingSubscribersCount({ enabled: currentUser?.isAdmin });

  if (!canAccessAdmin(currentUser)) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
        }}
      >
        <Typography level="h1">Admin Access Only</Typography>
      </Box>
    );
  }

  if (![AdminTab.Users, AdminTab.AdminSettings, AdminTab.EmbedKeys].some(tab => canAccessAdminTab(currentUser, tab))) {
    return <Typography color="warning">Missing permission: support:read</Typography>;
  }

  return (
    <>
      <Sheet
        sx={theme => ({
          height: '100vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          '& ::-webkit-scrollbar': { width: '6px', height: '6px' },
          '& ::-webkit-scrollbar-track': { background: 'transparent' },
          '& ::-webkit-scrollbar-thumb': {
            background: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
            borderRadius: '4px',
          },
          '& ::-webkit-scrollbar-thumb:hover': {
            background: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
          },
        })}
      >
        <EnvironmentBanner />
        <Grid container sx={{ flex: 1, minHeight: 0 }}>
          <Grid
            xs={1.5}
            sx={theme => ({
              display: { xs: 'none', md: 'flex' },
              flexDirection: 'column',
              backgroundColor: theme.palette.background.panel,
              height: '100%',
              overflow: 'auto',
            })}
          >
            <SidebarNav
              enableUserMigration={enableUserMigration}
              showLiveOpsTriageTab={showLiveOpsTriageTab}
              waitingSubscribersCount={waitingSubscribers.data?.count}
              hiddenNotifications={hiddenNotifications}
              onTabSelect={setActiveTab}
            />
          </Grid>
          <Grid xs={12} md={10.5} sx={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Mobile hamburger header - visible only on xs */}
            <Box
              sx={{
                display: { xs: 'flex', md: 'none' },
                alignItems: 'center',
                p: 1,
                borderBottom: '1px solid',
                borderColor: 'divider',
                flexShrink: 0,
              }}
            >
              <IconButton
                onClick={() => setMobileDrawerOpen(true)}
                size="sm"
                data-testid="admin-mobile-menu-btn"
                aria-label="Open admin menu"
              >
                <MenuIcon />
              </IconButton>
              <Typography level="title-sm" sx={{ ml: 1 }}>
                Admin
              </Typography>
            </Box>
            <Tabs
              aria-label="Admin tabs"
              value={activeTab}
              onChange={(_, tab) => setActiveTab(tab)}
              orientation="vertical"
              sx={{ flex: 1, minHeight: 0, '& [role="tabpanel"]': { height: '100%', overflow: 'auto' } }}
            >
              <TabPanel value={AdminTab.Dashboard}>
                {activeTab === AdminTab.Dashboard && canAccessAdminTab(currentUser, AdminTab.Dashboard) && (
                  <AdminDashboardTab onNavigate={setActiveTab} />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.Users}>
                {activeTab === AdminTab.Users && canAccessAdminTab(currentUser, AdminTab.Users) && <UsersTab />}
              </TabPanel>
              <TabPanel value={AdminTab.EmailVerification}>
                {activeTab === AdminTab.EmailVerification &&
                  canAccessAdminTab(currentUser, AdminTab.EmailVerification) && <EmailVerificationTab />}
              </TabPanel>
              <TabPanel value={AdminTab.GrowthPricing} sx={{ padding: 0 }}>
                {activeTab === AdminTab.GrowthPricing && canAccessAdminTab(currentUser, AdminTab.GrowthPricing) && (
                  <AdminGrowthPricingTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.AdminSettings} sx={{ padding: 0 }}>
                {activeTab === AdminTab.AdminSettings && canAccessAdminTab(currentUser, AdminTab.AdminSettings) && (
                  <AdminSettingsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.WorldTime}>
                {activeTab === AdminTab.WorldTime && canAccessAdminTab(currentUser, AdminTab.WorldTime) && (
                  <WorldTimeTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.Feedback}>
                {activeTab === AdminTab.Feedback && canAccessAdminTab(currentUser, AdminTab.Feedback) && (
                  <FeedbackTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.Analytics}>
                {activeTab === AdminTab.Analytics && canAccessAdminTab(currentUser, AdminTab.Analytics) && (
                  <AnalyticsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.RegistrationInvites} sx={{ padding: 0 }}>
                {activeTab === AdminTab.RegistrationInvites &&
                  canAccessAdminTab(currentUser, AdminTab.RegistrationInvites) && <InviteCenter />}
              </TabPanel>
              {enableUserMigration && (
                <TabPanel value={AdminTab.Migrate}>
                  {activeTab === AdminTab.Migrate && canAccessAdminTab(currentUser, AdminTab.Migrate) && (
                    <MigrateUsersTab />
                  )}
                </TabPanel>
              )}
              <TabPanel value={AdminTab.Modals}>
                {activeTab === AdminTab.Modals && canAccessAdminTab(currentUser, AdminTab.Modals) && <ModalsAdminTab />}
              </TabPanel>
              <TabPanel value={AdminTab.WhatsNewModals} sx={{ padding: { xs: 0, sm: 2 } }}>
                {activeTab === AdminTab.WhatsNewModals && canAccessAdminTab(currentUser, AdminTab.WhatsNewModals) && (
                  <AdminWhatsNewModalsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ReleaseNotes}>
                {activeTab === AdminTab.ReleaseNotes && canAccessAdminTab(currentUser, AdminTab.ReleaseNotes) && (
                  <AdminReleaseNotesTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.Files}>
                {activeTab === AdminTab.Files && canAccessAdminTab(currentUser, AdminTab.Files) && <AdminFilesTab />}
              </TabPanel>
              <TabPanel value={AdminTab.Documentation} sx={{ padding: 0 }}>
                {activeTab === AdminTab.Documentation && canAccessAdminTab(currentUser, AdminTab.Documentation) && (
                  <DocumentationTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ApiReference}>
                {activeTab === AdminTab.ApiReference && canAccessAdminTab(currentUser, AdminTab.ApiReference) && (
                  <ApiReferenceTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ArchitectureDiagrams}>
                {activeTab === AdminTab.ArchitectureDiagrams &&
                  canAccessAdminTab(currentUser, AdminTab.ArchitectureDiagrams) && <ArchitectureDiagramsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.Dependencies}>
                {activeTab === AdminTab.Dependencies && canAccessAdminTab(currentUser, AdminTab.Dependencies) && (
                  <DependenciesTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ApiCookbook}>
                {activeTab === AdminTab.ApiCookbook && canAccessAdminTab(currentUser, AdminTab.ApiCookbook) && (
                  <ApiCookbookTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.Subscribers}>
                {activeTab === AdminTab.Subscribers && canAccessAdminTab(currentUser, AdminTab.Subscribers) && (
                  <SubscribersTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.PartnerSignupRules} sx={{ padding: 0 }}>
                {activeTab === AdminTab.PartnerSignupRules &&
                  canAccessAdminTab(currentUser, AdminTab.PartnerSignupRules) && <PartnerSignupRulesTab />}
              </TabPanel>
              <TabPanel value={AdminTab.Subscriptions}>
                {activeTab === AdminTab.Subscriptions && canAccessAdminTab(currentUser, AdminTab.Subscriptions) && (
                  <AdminSubscriptions />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.Organizations}>
                {activeTab === AdminTab.Organizations && canAccessAdminTab(currentUser, AdminTab.Organizations) && (
                  <OrganizationsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.CreditAnalytics}>
                {activeTab === AdminTab.CreditAnalytics && canAccessAdminTab(currentUser, AdminTab.CreditAnalytics) && (
                  <CreditAnalyticsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.SecretsRotation}>
                {activeTab === AdminTab.SecretsRotation && canAccessAdminTab(currentUser, AdminTab.SecretsRotation) && (
                  <SecretsRotationTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.SystemSecrets}>
                {activeTab === AdminTab.SystemSecrets && canAccessAdminTab(currentUser, AdminTab.SystemSecrets) && (
                  <SystemSecretsTab />
                )}
              </TabPanel>
              {showLiveOpsTriageTab && (
                <TabPanel value={AdminTab.LiveOpsTriage}>
                  {activeTab === AdminTab.LiveOpsTriage && canAccessAdminTab(currentUser, AdminTab.LiveOpsTriage) && (
                    <AdminLiveOpsTriageMultiConfigTab />
                  )}
                </TabPanel>
              )}
              <TabPanel value={AdminTab.ModelLogs}>
                {activeTab === AdminTab.ModelLogs && canAccessAdminTab(currentUser, AdminTab.ModelLogs) && (
                  <ModelLogsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ModelMetrics}>
                {activeTab === AdminTab.ModelMetrics && canAccessAdminTab(currentUser, AdminTab.ModelMetrics) && (
                  <ModelMetricsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ModelLifecycle}>
                {activeTab === AdminTab.ModelLifecycle && canAccessAdminTab(currentUser, AdminTab.ModelLifecycle) && (
                  <ModelLifecycleTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ContextInspector}>
                {activeTab === AdminTab.ContextInspector &&
                  canAccessAdminTab(currentUser, AdminTab.ContextInspector) && <ContextInspectorTab />}
              </TabPanel>
              <TabPanel value={AdminTab.RetrievalRate}>
                {activeTab === AdminTab.RetrievalRate && canAccessAdminTab(currentUser, AdminTab.RetrievalRate) && (
                  <RetrievalRateTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.EventMetrics}>
                {activeTab === AdminTab.EventMetrics && canAccessAdminTab(currentUser, AdminTab.EventMetrics) && (
                  <EventMetricsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.SlackMetrics}>
                {activeTab === AdminTab.SlackMetrics && canAccessAdminTab(currentUser, AdminTab.SlackMetrics) && (
                  <SlackMetricsPage />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ManageGears}>
                {activeTab === AdminTab.ManageGears && canAccessAdminTab(currentUser, AdminTab.ManageGears) && (
                  <ManageGearsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.SystemPrompts}>
                {activeTab === AdminTab.SystemPrompts && canAccessAdminTab(currentUser, AdminTab.SystemPrompts) && (
                  <SystemPromptsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.IdentityProviders}>
                {activeTab === AdminTab.IdentityProviders &&
                  canAccessAdminTab(currentUser, AdminTab.IdentityProviders) && <IdentityProvidersTab />}
              </TabPanel>
              <TabPanel value={AdminTab.OAuthClients} sx={{ padding: 0 }}>
                {activeTab === AdminTab.OAuthClients && canAccessAdminTab(currentUser, AdminTab.OAuthClients) && (
                  <OAuthClientsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.AgentOps}>
                {activeTab === AdminTab.AgentOps && canAccessAdminTab(currentUser, AdminTab.AgentOps) && (
                  <AgentOpsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.AgentExecutions}>
                {activeTab === AdminTab.AgentExecutions && canAccessAdminTab(currentUser, AdminTab.AgentExecutions) && (
                  <AgentExecutionsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.LLMDashboard}>
                {activeTab === AdminTab.LLMDashboard && canAccessAdminTab(currentUser, AdminTab.LLMDashboard) && (
                  <LLMDashboardTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.RapidReply}>
                {activeTab === AdminTab.RapidReply && canAccessAdminTab(currentUser, AdminTab.RapidReply) && (
                  <RapidReplyTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.VoiceSettings}>
                {activeTab === AdminTab.VoiceSettings && canAccessAdminTab(currentUser, AdminTab.VoiceSettings) && (
                  <VoiceSettingsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.SecurityDashboard}>
                {activeTab === AdminTab.SecurityDashboard &&
                  canAccessAdminTab(currentUser, AdminTab.SecurityDashboard) && <SecurityDashboardMock />}
              </TabPanel>
              <TabPanel value={AdminTab.Team}>
                {activeTab === AdminTab.Team && canAccessAdminTab(currentUser, AdminTab.Team) && <Team />}
              </TabPanel>
              <TabPanel value={AdminTab.SystemHealth}>
                {activeTab === AdminTab.SystemHealth && canAccessAdminTab(currentUser, AdminTab.SystemHealth) && (
                  <AdminSystemHealthTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.SlackWorkspaces}>
                {activeTab === AdminTab.SlackWorkspaces && canAccessAdminTab(currentUser, AdminTab.SlackWorkspaces) && (
                  <SlackWorkspacesTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.EmbedKeys}>
                {activeTab === AdminTab.EmbedKeys && canAccessAdminTab(currentUser, AdminTab.EmbedKeys) && (
                  <EmbedKeysTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ToolDefinitions}>
                {activeTab === AdminTab.ToolDefinitions && canAccessAdminTab(currentUser, AdminTab.ToolDefinitions) && (
                  <ToolDefinitionsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.EmailMarketing} sx={{ padding: 0 }}>
                {activeTab === AdminTab.EmailMarketing && canAccessAdminTab(currentUser, AdminTab.EmailMarketing) && (
                  <EmailMarketingTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.WebhookAuditLogs}>
                {activeTab === AdminTab.WebhookAuditLogs &&
                  canAccessAdminTab(currentUser, AdminTab.WebhookAuditLogs) && <WebhookAuditLogsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.AuditLog}>
                {activeTab === AdminTab.AuditLog && canAccessAdminTab(currentUser, AdminTab.AuditLog) && (
                  <AuditLogTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.GitHubConnection}>
                {activeTab === AdminTab.GitHubConnection &&
                  canAccessAdminTab(currentUser, AdminTab.GitHubConnection) && <GitHubConnectionTab />}
              </TabPanel>
              <TabPanel value={AdminTab.HelpAnalytics}>
                {activeTab === AdminTab.HelpAnalytics && canAccessAdminTab(currentUser, AdminTab.HelpAnalytics) && (
                  <HelpAnalyticsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.RateLimits}>
                {activeTab === AdminTab.RateLimits && canAccessAdminTab(currentUser, AdminTab.RateLimits) && (
                  <RateLimitsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.DlqReplay}>
                {activeTab === AdminTab.DlqReplay && canAccessAdminTab(currentUser, AdminTab.DlqReplay) && (
                  <DlqReplayTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.ApiKeyScopePreflight}>
                {activeTab === AdminTab.ApiKeyScopePreflight &&
                  canAccessAdminTab(currentUser, AdminTab.ApiKeyScopePreflight) && <ApiKeyScopePreflightTab />}
              </TabPanel>
              <TabPanel value={AdminTab.IntegrationHealth}>
                {activeTab === AdminTab.IntegrationHealth &&
                  canAccessAdminTab(currentUser, AdminTab.IntegrationHealth) && <IntegrationHealthTab />}
              </TabPanel>
              <TabPanel value={AdminTab.IntegrationDemand}>
                {activeTab === AdminTab.IntegrationDemand &&
                  canAccessAdminTab(currentUser, AdminTab.IntegrationDemand) && <IntegrationDemandTab />}
              </TabPanel>
              <TabPanel value={AdminTab.SreAgent}>
                {activeTab === AdminTab.SreAgent && canAccessAdminTab(currentUser, AdminTab.SreAgent) && (
                  <SreAgentTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.SecOpsTriage}>
                {activeTab === AdminTab.SecOpsTriage && canAccessAdminTab(currentUser, AdminTab.SecOpsTriage) && (
                  <SecopsTriageTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.PublishedPages}>
                {activeTab === AdminTab.PublishedPages && canAccessAdminTab(currentUser, AdminTab.PublishedPages) && (
                  <PublishedArtifactsTab />
                )}
              </TabPanel>
              <TabPanel value={AdminTab.PrReport}>
                {activeTab === AdminTab.PrReport && canAccessAdminTab(currentUser, AdminTab.PrReport) && (
                  <PrReportTab />
                )}
              </TabPanel>
            </Tabs>
          </Grid>
        </Grid>
      </Sheet>
      {/* Mobile navigation drawer - only reachable via hamburger on xs */}
      <Drawer anchor="left" open={mobileDrawerOpen} onClose={() => setMobileDrawerOpen(false)}>
        <Box
          sx={theme => ({
            width: 280,
            p: 1,
            overflowY: 'auto',
            '&::-webkit-scrollbar': { width: '6px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
              borderRadius: '4px',
            },
            '&::-webkit-scrollbar-thumb:hover': {
              background: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
            },
          })}
        >
          <SidebarNav
            enableUserMigration={enableUserMigration}
            showLiveOpsTriageTab={showLiveOpsTriageTab}
            waitingSubscribersCount={waitingSubscribers.data?.count}
            hiddenNotifications={hiddenNotifications}
            onTabSelect={tab => {
              setActiveTab(tab);
              setMobileDrawerOpen(false);
            }}
          />
        </Box>
      </Drawer>
      <KnowledgeModal />

      {/* Admin Floating Chat - docked-session floating chat pattern */}
      <NotebookFilepondProvider>
        <Box sx={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0, overflow: 'hidden' }}>
          <SessionContainer
            currentSessionId={adminSessionId ?? undefined}
            isLoading={!adminSessionId || adminSession.isPending}
            autoHideOnEmpty={false}
          />
        </Box>
      </NotebookFilepondProvider>
      <HelpPanel />
    </>
  );
};

export default AdminPage;
