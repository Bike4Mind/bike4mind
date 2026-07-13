import AdminSettingsTab from '@client/app/components/admin/AdminSettingsTab';
import FeedbackTab from '@client/app/components/admin/Feedbacks';
import AdminFilesTab from '@client/app/components/admin/FilesTab';
import WorldTimeTab from '@client/app/components/admin/WorldTime';
import SystemPromptsTab from '@client/app/components/admin/SystemPromptsTab';
import ManageGearsTab from '@client/app/components/admin/ManageGearsTab';
import EmailVerificationTab from '@client/app/components/admin/EmailVerificationTab';
import AdminSystemHealthTab from '@client/app/components/admin/AdminSystemHealthTab';
import { useUser } from '@client/app/contexts/UserContext';
import CloseIcon from '@mui/icons-material/Close';
import { IconButton } from '@mui/joy';
import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Box,
  Button,
  Drawer,
  Grid,
  Sheet,
  Stack,
  TabPanel,
  Tabs,
  Typography,
  Badge,
  Tooltip,
} from '@mui/joy';
import { useGetWaitingSubscribersCount } from '@client/app/hooks/data/subscribers';
import { useRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@client/app/contexts/ApiContext';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import { useGetSession } from '@client/app/hooks/data/sessions';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import ModalsAdminTab from './AdminModalTab';
import AdminWhatsNewModalsTab from './AdminWhatsNewModalsTab';
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
import {
  AdminTab,
  SIDEBAR_SECTIONS,
  SIDEBAR_EXPANDED_STORAGE_KEY,
  findSectionKeyForTab,
  type SidebarGate,
  type SidebarItem,
} from './adminSidebarConfig';

export { AdminTab } from './adminSidebarConfig';

const AdminLiveOpsTriageMultiConfigTab = dynamic(() => import('./AdminLiveOpsTriageMultiConfigTab'), {
  ssr: false,
});
const WebhookAuditLogsTab = dynamic(() => import('./WebhookAuditLogs'), { ssr: false });

const MigrateUsersTab = dynamic(() => import('./MigrateUsersTab'), { ssr: false });
const AgentOpsTab = dynamic(() => import('./AgentOpsTab'), { ssr: false });
const AgentExecutionsTab = dynamic(() => import('./AgentExecutionsTab'), { ssr: false });
const SubscribersTab = dynamic(() => import('./SubscribersTab'), { ssr: false });
const PartnerSignupRulesTab = dynamic(() => import('./PartnerSignupRulesTab'), { ssr: false });
const ModelMetricsTab = dynamic(() => import('./ModelMetrics'), { ssr: false });
const EventMetricsTab = dynamic(() => import('./EventMetrics'), { ssr: false });
const SecurityDashboardMock = dynamic(() => import('./SecurityDashboardMock'), { ssr: false });
const Team = lazy(() => import('./Team'));
const SlackWorkspacesTab = dynamic(() => import('./SlackWorkspacesTab'), { ssr: false });
const SlackMetricsPage = dynamic(() => import('./SlackMetrics'), { ssr: false });
const GitHubConnectionTab = dynamic(() => import('./GitHubConnectionTab'), { ssr: false });
const HelpAnalyticsTab = dynamic(() => import('./HelpAnalyticsTab'), { ssr: false });
const ContextInspectorTab = dynamic(() => import('./ContextInspectorTab'), { ssr: false });
const RateLimitsTab = dynamic(() => import('./RateLimits'), { ssr: false });
const DlqReplayTab = dynamic(() => import('./DlqReplayTab'), { ssr: false });
const IntegrationHealthTab = dynamic(() => import('./IntegrationHealth'), { ssr: false });
const SreAgentTab = dynamic(() => import('./SreAgentTab'), { ssr: false });
const SecopsTriageTab = dynamic(() => import('./SecopsTriageTab'), { ssr: false });
const PublishedArtifactsTab = dynamic(() => import('./PublishedArtifactsTab'), { ssr: false });
const ArchitectureDiagramsTab = dynamic(() => import('./ArchitectureDiagramsTab'), { ssr: false });
const DependenciesTab = dynamic(() => import('./DependenciesTab'), { ssr: false });

export const useAdminModal = create<{
  open: boolean;
  activeTab: AdminTab | string | null;
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  setActiveTab: (activeTab: AdminTab | string | null) => void;
}>((set, get) => ({
  open: true, // open by default
  activeTab: AdminTab.Users, // defaults to Users; overridden when migration is available
  setOpen: open => set({ open: typeof open === 'function' ? open(get().open) : open }),
  setActiveTab: (activeTab: AdminTab | string | null) => set({ activeTab }),
}));

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

type SidebarNavProps = {
  enableUserMigration?: boolean;
  showLiveOpsTriageTab: boolean;
  waitingSubscribersCount?: number;
  hiddenNotifications: string[];
  onTabSelect: (tab: AdminTab) => void;
};

const SidebarNav = ({
  enableUserMigration,
  showLiveOpsTriageTab,
  waitingSubscribersCount,
  hiddenNotifications,
  onTabSelect,
}: SidebarNavProps) => {
  const activeTab = useAdminModal(state => state.activeTab);

  // Expand state keyed by section. On mount, restore the user's last choice from
  // localStorage; otherwise expand only the section containing the active tab so
  // the sidebar opens scannable instead of fully expanded.
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = window.localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as Record<string, boolean>;
          return Object.fromEntries(SIDEBAR_SECTIONS.map(s => [s.key, parsed[s.key] ?? false]));
        }
      } catch {
        // Ignore malformed storage and fall through to active-section default.
      }
    }
    const activeKey = findSectionKeyForTab(activeTab);
    return Object.fromEntries(SIDEBAR_SECTIONS.map(s => [s.key, s.key === activeKey]));
  });

  const toggleSection = (key: string) => {
    setExpandedSections(prev => {
      const next = { ...prev, [key]: !prev[key] };
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Persistence is best-effort; ignore quota/serialization failures.
        }
      }
      return next;
    });
  };

  const gates: Record<SidebarGate, boolean> = {
    userMigration: !!enableUserMigration,
    liveOpsTriage: showLiveOpsTriageTab,
  };

  const getMenuButtonSx = (tabValue: AdminTab) => ({
    justifyContent: 'flex-start',
    fontWeight: 500,
    color: activeTab === tabValue ? 'primary.500' : 'neutral.600',
    bgcolor: activeTab === tabValue ? 'primary.50' : 'transparent',
    '&:hover': {
      bgcolor: activeTab === tabValue ? 'primary.100' : 'neutral.50',
    },
    borderRadius: 'md',
  });

  const renderEndDecorator = (item: SidebarItem): ReactNode => {
    if (
      item.badge === 'waitingSubscribers' &&
      waitingSubscribersCount &&
      waitingSubscribersCount > 0 &&
      !hiddenNotifications.includes('waiting-subscribers')
    ) {
      return (
        <Box sx={{ marginLeft: 1 }}>
          <Tooltip title={`Waiting subscribers: ${waitingSubscribersCount}`}>
            <Badge
              badgeContent={waitingSubscribersCount}
              color="danger"
              size="sm"
              sx={{
                '& .MuiBadge-badge': {
                  justifyContent: 'center',
                  fontSize: '10px',
                  minWidth: '14px',
                  height: '14px',
                  padding: '0 3px',
                },
              }}
            />
          </Tooltip>
        </Box>
      );
    }
    return null;
  };

  return (
    <AccordionGroup sx={{ marginLeft: 0.5 }}>
      {SIDEBAR_SECTIONS.map(section => {
        const { Icon: SectionIcon } = section;
        const visibleItems = section.items.filter(item => !item.gate || gates[item.gate]);
        return (
          <Accordion
            key={section.key}
            expanded={expandedSections[section.key] ?? false}
            onChange={() => toggleSection(section.key)}
          >
            <AccordionSummary>
              <SectionIcon color="primary" />
              <Typography color="primary" level="body-md">
                {section.label}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ '& .MuiAccordionDetails-content': { p: 1 } }}>
              <Stack direction={'column'} spacing={1}>
                {visibleItems.map(item => {
                  const { Icon: ItemIcon } = item;
                  return (
                    <Button
                      key={item.tab}
                      {...(item.testid ? { 'data-testid': item.testid } : {})}
                      startDecorator={<ItemIcon />}
                      onClick={() => onTabSelect(item.tab)}
                      variant="plain"
                      sx={getMenuButtonSx(item.tab)}
                      endDecorator={renderEndDecorator(item)}
                    >
                      <Typography level="body-sm" sx={{ color: 'inherit' }}>
                        {item.label}
                      </Typography>
                    </Button>
                  );
                })}
              </Stack>
            </AccordionDetails>
          </Accordion>
        );
      })}
    </AccordionGroup>
  );
};

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

  // LiveOps Triage tab visibility - show everywhere except fork production environments
  const { data: liveopsEnvData } = useQuery({
    queryKey: ['liveops-triage', 'env'],
    queryFn: async () => {
      const { data } = await api.get<{ stage: string; isForkProduction: boolean; showTab: boolean }>(
        '/api/admin/liveops-triage-env'
      );
      return data;
    },
    enabled: currentUser?.isAdmin,
    staleTime: 1000 * 60 * 60, // Cache for 1 hour - environment doesn't change
  });
  const showLiveOpsTriageTab = liveopsEnvData?.showTab ?? false;

  // Get waiting subscribers count for badge
  const waitingSubscribers = useGetWaitingSubscribersCount({ enabled: currentUser?.isAdmin });

  // Set default tab based on migration availability
  useEffect(() => {
    if (enableUserMigration && activeTab === AdminTab.Users) {
      setActiveTab(AdminTab.Migrate);
    }
  }, [enableUserMigration, activeTab, setActiveTab]);

  if (!currentUser?.isAdmin) {
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
              <IconButton onClick={() => setMobileDrawerOpen(true)} size="sm" data-testid="admin-mobile-menu-btn">
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
              <TabPanel value={AdminTab.Users}>{activeTab === AdminTab.Users && <UsersTab />}</TabPanel>
              <TabPanel value={AdminTab.EmailVerification}>
                {activeTab === AdminTab.EmailVerification && <EmailVerificationTab />}
              </TabPanel>
              <TabPanel value={AdminTab.AdminSettings} sx={{ padding: 0 }}>
                {activeTab === AdminTab.AdminSettings && <AdminSettingsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.WorldTime}>{activeTab === AdminTab.WorldTime && <WorldTimeTab />}</TabPanel>
              <TabPanel value={AdminTab.Feedbacks}>{activeTab === AdminTab.Feedbacks && <FeedbackTab />}</TabPanel>
              <TabPanel value={AdminTab.Analytics}>{activeTab === AdminTab.Analytics && <AnalyticsTab />}</TabPanel>
              <TabPanel value={AdminTab.RegistrationInvites} sx={{ padding: 0 }}>
                {activeTab === AdminTab.RegistrationInvites && <InviteCenter />}
              </TabPanel>
              {enableUserMigration && (
                <TabPanel value={AdminTab.Migrate}>{activeTab === AdminTab.Migrate && <MigrateUsersTab />}</TabPanel>
              )}
              <TabPanel value={AdminTab.Modals}>{activeTab === AdminTab.Modals && <ModalsAdminTab />}</TabPanel>
              <TabPanel value={AdminTab.WhatsNewModals} sx={{ padding: { xs: 0, sm: 2 } }}>
                {activeTab === AdminTab.WhatsNewModals && <AdminWhatsNewModalsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.Files}>{activeTab === AdminTab.Files && <AdminFilesTab />}</TabPanel>
              <TabPanel value={AdminTab.Documentation} sx={{ padding: 0 }}>
                {activeTab === AdminTab.Documentation && <DocumentationTab />}
              </TabPanel>
              <TabPanel value={AdminTab.ApiReference}>
                {activeTab === AdminTab.ApiReference && <ApiReferenceTab />}
              </TabPanel>
              <TabPanel value={AdminTab.ArchitectureDiagrams}>
                {activeTab === AdminTab.ArchitectureDiagrams && <ArchitectureDiagramsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.Dependencies}>
                {activeTab === AdminTab.Dependencies && <DependenciesTab />}
              </TabPanel>
              <TabPanel value={AdminTab.ApiCookbook}>
                {activeTab === AdminTab.ApiCookbook && <ApiCookbookTab />}
              </TabPanel>
              <TabPanel value={AdminTab.Subscribers}>
                {activeTab === AdminTab.Subscribers && <SubscribersTab />}
              </TabPanel>
              <TabPanel value={AdminTab.PartnerSignupRules} sx={{ padding: 0 }}>
                {activeTab === AdminTab.PartnerSignupRules && <PartnerSignupRulesTab />}
              </TabPanel>
              <TabPanel value={AdminTab.Subscriptions}>
                {activeTab === AdminTab.Subscriptions && <AdminSubscriptions />}
              </TabPanel>
              <TabPanel value={AdminTab.Organizations}>
                {activeTab === AdminTab.Organizations && <OrganizationsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.CreditAnalytics}>
                {activeTab === AdminTab.CreditAnalytics && <CreditAnalyticsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.SecretsRotation}>
                {activeTab === AdminTab.SecretsRotation && <SecretsRotationTab />}
              </TabPanel>
              <TabPanel value={AdminTab.SystemSecrets}>
                {activeTab === AdminTab.SystemSecrets && <SystemSecretsTab />}
              </TabPanel>
              {showLiveOpsTriageTab && (
                <TabPanel value={AdminTab.LiveOpsTriage}>
                  {activeTab === AdminTab.LiveOpsTriage && <AdminLiveOpsTriageMultiConfigTab />}
                </TabPanel>
              )}
              <TabPanel value={AdminTab.ModelLogs}>{activeTab === AdminTab.ModelLogs && <ModelLogsTab />}</TabPanel>
              <TabPanel value={AdminTab.ModelMetrics}>
                {activeTab === AdminTab.ModelMetrics && <ModelMetricsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.ContextInspector}>
                {activeTab === AdminTab.ContextInspector && <ContextInspectorTab />}
              </TabPanel>
              <TabPanel value={AdminTab.EventMetrics}>
                {activeTab === AdminTab.EventMetrics && <EventMetricsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.SlackMetrics}>
                {activeTab === AdminTab.SlackMetrics && <SlackMetricsPage />}
              </TabPanel>
              <TabPanel value={AdminTab.ManageGears}>
                {activeTab === AdminTab.ManageGears && <ManageGearsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.SystemPrompts}>
                {activeTab === AdminTab.SystemPrompts && <SystemPromptsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.IdentityProviders}>
                {activeTab === AdminTab.IdentityProviders && <IdentityProvidersTab />}
              </TabPanel>
              <TabPanel value={AdminTab.AgentOps}>{activeTab === AdminTab.AgentOps && <AgentOpsTab />}</TabPanel>
              <TabPanel value={AdminTab.AgentExecutions}>
                {activeTab === AdminTab.AgentExecutions && <AgentExecutionsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.LLMDashboard}>
                {activeTab === AdminTab.LLMDashboard && <LLMDashboardTab />}
              </TabPanel>
              <TabPanel value={AdminTab.RapidReply}>{activeTab === AdminTab.RapidReply && <RapidReplyTab />}</TabPanel>
              <TabPanel value={AdminTab.VoiceSettings}>
                {activeTab === AdminTab.VoiceSettings && <VoiceSettingsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.SecurityDashboard}>
                {activeTab === AdminTab.SecurityDashboard && <SecurityDashboardMock />}
              </TabPanel>
              <TabPanel value={AdminTab.Team}>{activeTab === AdminTab.Team && <Team />}</TabPanel>
              <TabPanel value={AdminTab.SystemHealth}>
                {activeTab === AdminTab.SystemHealth && <AdminSystemHealthTab />}
              </TabPanel>
              <TabPanel value={AdminTab.SlackWorkspaces}>
                {activeTab === AdminTab.SlackWorkspaces && <SlackWorkspacesTab />}
              </TabPanel>
              <TabPanel value={AdminTab.ToolDefinitions}>
                {activeTab === AdminTab.ToolDefinitions && <ToolDefinitionsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.EmailMarketing} sx={{ padding: 0 }}>
                {activeTab === AdminTab.EmailMarketing && <EmailMarketingTab />}
              </TabPanel>
              <TabPanel value={AdminTab.WebhookAuditLogs}>
                {activeTab === AdminTab.WebhookAuditLogs && <WebhookAuditLogsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.GitHubConnection}>
                {activeTab === AdminTab.GitHubConnection && <GitHubConnectionTab />}
              </TabPanel>
              <TabPanel value={AdminTab.HelpAnalytics}>
                {activeTab === AdminTab.HelpAnalytics && <HelpAnalyticsTab />}
              </TabPanel>
              <TabPanel value={AdminTab.RateLimits}>{activeTab === AdminTab.RateLimits && <RateLimitsTab />}</TabPanel>
              <TabPanel value={AdminTab.DlqReplay}>{activeTab === AdminTab.DlqReplay && <DlqReplayTab />}</TabPanel>
              <TabPanel value={AdminTab.IntegrationHealth}>
                {activeTab === AdminTab.IntegrationHealth && <IntegrationHealthTab />}
              </TabPanel>
              <TabPanel value={AdminTab.SreAgent}>{activeTab === AdminTab.SreAgent && <SreAgentTab />}</TabPanel>
              <TabPanel value={AdminTab.SecOpsTriage}>
                {activeTab === AdminTab.SecOpsTriage && <SecopsTriageTab />}
              </TabPanel>
              <TabPanel value={AdminTab.PublishedPages}>
                {activeTab === AdminTab.PublishedPages && <PublishedArtifactsTab />}
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
