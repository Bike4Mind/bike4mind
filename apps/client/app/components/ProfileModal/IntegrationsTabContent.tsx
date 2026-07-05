import { Box, Stack, Typography } from '@mui/joy';
import EmailIntegrationSection from './SettingsTabContent/EmailIntegrationSection';
import SlackIntegrationSection from './SettingsTabContent/SlackIntegrationSection';
import McpSection from './SettingsTabContent/McpSection';
import GitHubIntegrationSection from './SettingsTabContent/GitHubIntegrationSection';
import JupyterIntegrationSection from './SettingsTabContent/JupyterIntegrationSection';
import BlogIntegrationSection from './SettingsTabContent/BlogIntegrationSection';
import ConnectedAppsSection from './SettingsTabContent/ConnectedAppsSection';
import TokenRotationSection from './SettingsTabContent/TokenRotationSection';
import ApiKeySection from './ApiKeySection';
import WebhookSubscriptionSection from './SettingsTabContent/WebhookSubscriptionSection';
import JiraWebhookSection from './SettingsTabContent/JiraWebhookSection';
import { useUser } from '@client/app/contexts/UserContext';
import { ContextHelpButton } from '@client/app/components/help';

/**
 * Integrations Tab Content
 *
 * Consolidates all external integrations in one place:
 * - Re-authorize Integrations (token rotation, hidden when none connected)
 * - Connected Apps (Okta, Google Drive, Atlassian)
 * - Email-to-Platform
 * - Slack
 * - GitHub
 * - Jupyter Notebooks (CLI-based local execution)
 * - Webhook Subscriptions
 * - Jira Notifications (when Atlassian connected)
 * - Blog Publishing
 * - MCP Servers
 * - API Keys
 */
const IntegrationsTabContent = () => {
  const { currentUser } = useUser();
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <Typography level="h3">Integrations</Typography>
        <ContextHelpButton helpId="features/slack-multi-workspace-oauth" tooltipText="Learn about Integrations" />
      </Stack>
      <Typography level="body-md" sx={{ mb: 4, color: 'text.secondary' }}>
        Connect external services and manage your integrations
      </Typography>

      <Stack spacing={3}>
        {/* Re-authorize Integrations (renders null when none connected) */}
        <TokenRotationSection />

        {/* Connected Apps (Okta, Google Drive, Atlassian) */}
        <ConnectedAppsSection />

        {/* Email Integration */}
        <EmailIntegrationSection />

        {/* Slack Integration */}
        <SlackIntegrationSection />

        {/* Github Integration */}
        <GitHubIntegrationSection userId={currentUser?.id || ''} />

        {/* Jupyter Notebooks */}
        <JupyterIntegrationSection />

        {/* Webhook Subscriptions */}
        <WebhookSubscriptionSection />

        {/* Jira Notifications (only when Atlassian is connected) */}
        {currentUser?.atlassianConnect && currentUser.atlassianConnect.status !== 'needs_reconnect' && (
          <JiraWebhookSection />
        )}

        {/* Blog Publishing */}
        <BlogIntegrationSection />

        {/* MCP Servers */}
        <McpSection />

        {/* API Keys */}
        <ApiKeySection />
      </Stack>
    </Box>
  );
};

export default IntegrationsTabContent;
