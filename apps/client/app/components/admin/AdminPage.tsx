import AdminSettingsTab from '@client/app/components/admin/AdminSettingsTab';
import FeedbackTab from '@client/app/components/admin/Feedback';
import AdminFilesTab from '@client/app/components/admin/FilesTab';
import WorldTimeTab from '@client/app/components/admin/WorldTime';
import SystemPromptsTab from '@client/app/components/admin/SystemPromptsTab';
import ManageGearsTab from '@client/app/components/admin/ManageGearsTab';
import EmailVerificationTab from '@client/app/components/admin/EmailVerificationTab';
import AdminSystemHealthTab from '@client/app/components/admin/AdminSystemHealthTab';
import { useUser } from '@client/app/contexts/UserContext';
import { Box, TabPanel, Tabs } from '@mui/joy';
import { useLiveOpsTriageEnv } from '@client/app/hooks/data/admin';
import { lazy, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import { useGetSession } from '@client/app/hooks/data/sessions';
import { useAdminChatLayout } from './useAdminChatLayout';
import { useAdminAssistantSession } from './useAdminAssistantSession';
import { useAdminAssistantChatContext } from './useAdminAssistantChatContext';
import ModalsAdminTab from './AdminModalTab';
import EmbedKeysTab from './EmbedKeysTab';
import AdminWhatsNewModalsTab from './AdminWhatsNewModalsTab';
import AdminReleaseNotesTab from './ReleaseNotes/AdminReleaseNotesTab';
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
import { AdminCommandPalette } from './shared/AdminCommandPalette';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import ToolDefinitionsTab from './ToolDefinitionsTab';
import EmailMarketingTab from './EmailMarketingTab';
import SystemSecretsTab from './SystemSecretsTab';
import ApiReferenceTab from './ApiReferenceTab';
import ApiCookbookTab from './ApiCookbookTab';
import { AdminTab } from './adminSidebarConfig';
import { canRenderAdminTab } from './adminTabRenderability';
import { useAdminTabUrlSync } from './useAdminTabUrlSync';
import { useAdminModal } from './useAdminModal';
import { UndoToastProvider } from './shared/UndoToast';

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
const WaitlistTab = dynamic(() => import('./WaitlistTab'), { ssr: false });
const SignupDomainHoldsTab = dynamic(() => import('./SignupDomainHoldsTab'), { ssr: false });
const SignupRiskReviewTab = dynamic(() => import('./SignupRiskReviewTab'), { ssr: false });
const HeldSignupGrantsTab = dynamic(() => import('./HeldSignupGrantsTab'), { ssr: false });
const PartnerSignupRulesTab = dynamic(() => import('./PartnerSignupRulesTab'), { ssr: false });
const OAuthClientsTab = dynamic(() => import('./OAuthClientsTab'), { ssr: false });
const AdminGrowthPricingTab = dynamic(() => import('./AdminGrowthPricingTab'), { ssr: false });
const ModelMetricsTab = dynamic(() => import('./ModelMetrics'), { ssr: false });
const ModelLifecycleTab = dynamic(() => import('./ModelLifecycleTab'), { ssr: false });
const EventMetricsTab = dynamic(() => import('./EventMetrics'), { ssr: false });
const AnalyticsTab = dynamic(() => import('./Analytics'), { ssr: false });
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

// Re-exported for the tabs that dismiss notices; the store itself is shared with AdminLayout.
export { useAdminNotifications } from './useAdminNotifications';

interface AdminPageProps {
  /**
   * Shows the user migration feature in the Admin page
   */
  enableUserMigration?: boolean;
}

const AdminPage = ({ enableUserMigration }: AdminPageProps) => {
  const [activeTab, setActiveTab] = useAdminModal(useShallow(state => [state.activeTab, state.setActiveTab]));
  const { currentUser } = useUser();

  // LiveOps Triage tab visibility - show everywhere except fork production environments
  const { data: liveopsEnvData, isError: isLiveOpsEnvError } = useLiveOpsTriageEnv(!!currentUser?.isAdmin);
  const showLiveOpsTriageTab = liveopsEnvData?.showTab ?? false;

  // Selecting a tab this screen cannot draw would leave the content pane blank, so the URL sync
  // treats it as unknown and corrects the store instead.
  const isAdminTabRenderable = useCallback(
    (tab: AdminTab) =>
      canRenderAdminTab(tab, {
        enableUserMigration,
        liveOpsTriage: isLiveOpsEnvError ? false : liveopsEnvData?.showTab,
      }),
    [enableUserMigration, liveopsEnvData, isLiveOpsEnvError]
  );

  useAdminTabUrlSync(activeTab, setActiveTab, isAdminTabRenderable);

  // Admin Floating Chat (docked-session floating chat pattern)
  const adminSessionId = useAdminAssistantSession(!!currentUser?.isAdmin);
  useAdminAssistantChatContext(activeTab);
  const adminSession = useGetSession(adminSessionId);

  // Mount the assistant as the minimized pill so it is on hand without covering the page; restore on unmount
  useAdminChatLayout(!!currentUser?.isAdmin);

  return (
    <UndoToastProvider>
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <AdminCommandPalette onNavigate={setActiveTab} onOpenHelp={openHelpPanel} />
        <Tabs
          aria-label="Admin tabs"
          value={activeTab}
          onChange={(_, tab) => setActiveTab(tab)}
          orientation="vertical"
          sx={{ flex: 1, minHeight: 0, '& [role="tabpanel"]': { height: '100%', overflow: 'auto' } }}
        >
          <TabPanel value={AdminTab.Dashboard}>
            {activeTab === AdminTab.Dashboard && <AdminDashboardTab onNavigate={setActiveTab} />}
          </TabPanel>
          <TabPanel value={AdminTab.Users}>{activeTab === AdminTab.Users && <UsersTab />}</TabPanel>
          <TabPanel value={AdminTab.EmailVerification}>
            {activeTab === AdminTab.EmailVerification && <EmailVerificationTab />}
          </TabPanel>
          <TabPanel value={AdminTab.GrowthPricing} sx={{ padding: 0 }}>
            {activeTab === AdminTab.GrowthPricing && <AdminGrowthPricingTab />}
          </TabPanel>
          <TabPanel value={AdminTab.AdminSettings} sx={{ padding: 0 }}>
            {activeTab === AdminTab.AdminSettings && <AdminSettingsTab />}
          </TabPanel>
          <TabPanel value={AdminTab.WorldTime}>{activeTab === AdminTab.WorldTime && <WorldTimeTab />}</TabPanel>
          <TabPanel value={AdminTab.Feedback}>{activeTab === AdminTab.Feedback && <FeedbackTab />}</TabPanel>
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
          <TabPanel value={AdminTab.ReleaseNotes}>
            {activeTab === AdminTab.ReleaseNotes && <AdminReleaseNotesTab />}
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
          <TabPanel value={AdminTab.ApiCookbook}>{activeTab === AdminTab.ApiCookbook && <ApiCookbookTab />}</TabPanel>
          <TabPanel value={AdminTab.Waitlist}>{activeTab === AdminTab.Waitlist && <WaitlistTab />}</TabPanel>
          <TabPanel value={AdminTab.SignupDomainHolds} sx={{ padding: 0 }}>
            {activeTab === AdminTab.SignupDomainHolds && <SignupDomainHoldsTab />}
          </TabPanel>
          <TabPanel value={AdminTab.SignupRiskReview} sx={{ padding: 0 }}>
            {activeTab === AdminTab.SignupRiskReview && <SignupRiskReviewTab />}
          </TabPanel>
          <TabPanel value={AdminTab.HeldSignupGrants} sx={{ padding: 0 }}>
            {activeTab === AdminTab.HeldSignupGrants && <HeldSignupGrantsTab />}
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
          <TabPanel value={AdminTab.ModelLifecycle}>
            {activeTab === AdminTab.ModelLifecycle && <ModelLifecycleTab />}
          </TabPanel>
          <TabPanel value={AdminTab.ContextInspector}>
            {activeTab === AdminTab.ContextInspector && <ContextInspectorTab />}
          </TabPanel>
          <TabPanel value={AdminTab.RetrievalRate}>
            {activeTab === AdminTab.RetrievalRate && <RetrievalRateTab />}
          </TabPanel>
          <TabPanel value={AdminTab.EventMetrics}>
            {activeTab === AdminTab.EventMetrics && <EventMetricsTab />}
          </TabPanel>
          <TabPanel value={AdminTab.SlackMetrics}>
            {activeTab === AdminTab.SlackMetrics && <SlackMetricsPage />}
          </TabPanel>
          <TabPanel value={AdminTab.ManageGears}>{activeTab === AdminTab.ManageGears && <ManageGearsTab />}</TabPanel>
          <TabPanel value={AdminTab.SystemPrompts}>
            {activeTab === AdminTab.SystemPrompts && <SystemPromptsTab />}
          </TabPanel>
          <TabPanel value={AdminTab.IdentityProviders}>
            {activeTab === AdminTab.IdentityProviders && <IdentityProvidersTab />}
          </TabPanel>
          <TabPanel value={AdminTab.OAuthClients} sx={{ padding: 0 }}>
            {activeTab === AdminTab.OAuthClients && <OAuthClientsTab />}
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
          <TabPanel value={AdminTab.EmbedKeys}>{activeTab === AdminTab.EmbedKeys && <EmbedKeysTab />}</TabPanel>
          <TabPanel value={AdminTab.ToolDefinitions}>
            {activeTab === AdminTab.ToolDefinitions && <ToolDefinitionsTab />}
          </TabPanel>
          <TabPanel value={AdminTab.EmailMarketing} sx={{ padding: 0 }}>
            {activeTab === AdminTab.EmailMarketing && <EmailMarketingTab />}
          </TabPanel>
          <TabPanel value={AdminTab.WebhookAuditLogs}>
            {activeTab === AdminTab.WebhookAuditLogs && <WebhookAuditLogsTab />}
          </TabPanel>
          <TabPanel value={AdminTab.AuditLog}>{activeTab === AdminTab.AuditLog && <AuditLogTab />}</TabPanel>
          <TabPanel value={AdminTab.GitHubConnection}>
            {activeTab === AdminTab.GitHubConnection && <GitHubConnectionTab />}
          </TabPanel>
          <TabPanel value={AdminTab.HelpAnalytics}>
            {activeTab === AdminTab.HelpAnalytics && <HelpAnalyticsTab />}
          </TabPanel>
          <TabPanel value={AdminTab.RateLimits}>{activeTab === AdminTab.RateLimits && <RateLimitsTab />}</TabPanel>
          <TabPanel value={AdminTab.DlqReplay}>{activeTab === AdminTab.DlqReplay && <DlqReplayTab />}</TabPanel>
          <TabPanel value={AdminTab.ApiKeyScopePreflight}>
            {activeTab === AdminTab.ApiKeyScopePreflight && <ApiKeyScopePreflightTab />}
          </TabPanel>
          <TabPanel value={AdminTab.IntegrationHealth}>
            {activeTab === AdminTab.IntegrationHealth && <IntegrationHealthTab />}
          </TabPanel>
          <TabPanel value={AdminTab.IntegrationDemand}>
            {activeTab === AdminTab.IntegrationDemand && <IntegrationDemandTab />}
          </TabPanel>
          <TabPanel value={AdminTab.SreAgent}>{activeTab === AdminTab.SreAgent && <SreAgentTab />}</TabPanel>
          <TabPanel value={AdminTab.SecOpsTriage}>
            {activeTab === AdminTab.SecOpsTriage && <SecopsTriageTab />}
          </TabPanel>
          <TabPanel value={AdminTab.PublishedPages}>
            {activeTab === AdminTab.PublishedPages && <PublishedArtifactsTab />}
          </TabPanel>
          <TabPanel value={AdminTab.PrReport}>{activeTab === AdminTab.PrReport && <PrReportTab />}</TabPanel>
        </Tabs>
        <KnowledgeModal />

        {/* Admin Floating Chat - docked-session floating chat pattern */}
        <NotebookFilepondProvider>
          <Box sx={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0, overflow: 'hidden' }}>
            <SessionContainer
              currentSessionId={adminSessionId ?? undefined}
              isLoading={!adminSessionId || adminSession.isPending}
              autoHideOnEmpty={false}
              floatingChatCloseToPill
              floatingChatDockable={false}
            />
          </Box>
        </NotebookFilepondProvider>
      </Box>
    </UndoToastProvider>
  );
};

export default AdminPage;
