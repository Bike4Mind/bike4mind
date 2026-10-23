import { useId, useState, type ReactNode } from 'react';
import { Box, Button, Divider, Drawer, IconButton, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import {
  AuthStrategy,
  INTEGRATION_CATEGORY_LABELS,
  type DerivedIntegration,
  type IntegrationCapabilityKind,
  type IntegrationId,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useDisconnectGoogleDrive } from '@client/app/hooks/data/googleDrive';
import { useDisconnectAtlassian, useDisconnectNotion } from '@client/app/hooks/data/mcpServers';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { openInNewTab } from '@client/app/utils/externalLinks';
import { describeStoppedDriveSyncs } from '@client/app/components/ProfileModal/SettingsTabContent/ConnectedAppsSection';
import SlackIntegrationSection from '@client/app/components/ProfileModal/SettingsTabContent/SlackIntegrationSection';
import GitHubIntegrationSection from '@client/app/components/ProfileModal/SettingsTabContent/GitHubIntegrationSection';
import EmailIntegrationSection from '@client/app/components/ProfileModal/SettingsTabContent/EmailIntegrationSection';
import JupyterIntegrationSection from '@client/app/components/ProfileModal/SettingsTabContent/JupyterIntegrationSection';
import BlogIntegrationSection from '@client/app/components/ProfileModal/SettingsTabContent/BlogIntegrationSection';
import JiraWebhookSection from '@client/app/components/ProfileModal/SettingsTabContent/JiraWebhookSection';
import WebhookSubscriptionSection from '@client/app/components/ProfileModal/SettingsTabContent/WebhookSubscriptionSection';
import McpSection from '@client/app/components/ProfileModal/SettingsTabContent/McpSection';
import IntegrationLogo from './IntegrationLogo';
import { ADMIN_ONLY_NOTE, IntegrationStatusLabel, RequestButton, requestCountText } from './IntegrationStatusLabel';
import type { ConnectionState } from './galleryModel';
import { isConnectable, type ConnectableId } from './useIntegrationConnections';

const CLI_DOCS_URL = 'https://docs.bike4mind.com/cli/';

const KIND_LABELS: Record<IntegrationCapabilityKind, string> = {
  'agent-tools': 'Agent tools',
  'data-lake': 'Data lake',
  webhooks: 'Webhooks',
  'sign-in': 'Sign-in',
  import: 'Import',
  notifications: 'Messaging',
  publishing: 'Publishing',
};

const ACCOUNT_NAMES: Record<Exclude<ConnectableId, 'github' | 'slack'>, string> = {
  'google-drive': 'Google Drive',
  atlassian: 'Atlassian',
  notion: 'Notion',
  okta: 'Okta',
};

const unlinkError = (error: unknown, fallback: string): string =>
  isAxiosError(error) && typeof error.response?.data?.error === 'string' ? error.response.data.error : fallback;

/**
 * Connect and disconnect for the account-level integrations whose full settings live inside
 * Profile > Integrations' Connected Apps card. Same hooks and endpoints as that card, so both
 * surfaces stay one implementation; everything beyond the link itself stays there.
 */
const AccountConnectionPanel = ({
  id,
  connection,
  connecting,
  onConnect,
}: {
  id: keyof typeof ACCOUNT_NAMES;
  connection: ConnectionState;
  connecting: boolean;
  onConnect: () => void;
}) => {
  const navigate = useNavigate();
  const confirm = useConfirmation();
  const refreshUser = useUser(s => s.refreshUser);
  const disconnectDrive = useDisconnectGoogleDrive();
  const disconnectAtlassian = useDisconnectAtlassian();
  const disconnectNotion = useDisconnectNotion();
  const name = ACCOUNT_NAMES[id];
  const [unlinkingOkta, setUnlinkingOkta] = useState(false);

  const disconnecting =
    disconnectDrive.isPending || disconnectAtlassian.isPending || disconnectNotion.isPending || unlinkingOkta;

  const disconnect = () => {
    if (id === 'atlassian') return disconnectAtlassian.mutate();
    if (id === 'notion') return disconnectNotion.mutate();
    if (id === 'okta') {
      if (unlinkingOkta) return;
      setUnlinkingOkta(true);
      void api
        .post('/api/auth/unlink', { strategy: AuthStrategy.Okta })
        .then(() => {
          toast.success('Your account has been unlinked from Okta.');
          void refreshUser();
        })
        .catch(error => toast.error(unlinkError(error, 'An error occurred while unlinking your account from Okta.')))
        .finally(() => setUnlinkingOkta(false));
      return;
    }
    // Unlinking revokes the grant at Google and stops Drive folder syncs, so it is confirmed,
    // exactly as on Profile > Integrations.
    confirm({
      type: 'danger',
      title: 'Unlink Google Drive',
      description:
        "This revokes Bike4Mind's access to your Google Drive at Google. Any Drive folder sync authorized with this account, personal or organization, will stop until it is reconnected. You can link Google Drive again at any time.",
      okLabel: 'Unlink',
      onOk: () =>
        disconnectDrive.mutate(undefined, {
          onSuccess: impact => {
            void refreshUser();
            const warning = describeStoppedDriveSyncs(impact);
            if (warning) toast.warning(`Google Drive disconnected. ${warning}`, { duration: 8000 });
            else toast.success('Google Drive disconnected.');
          },
          onError: () => toast.error('Could not disconnect Google Drive. Please try again.'),
        }),
    });
  };

  return (
    <Stack gap="12px">
      <Stack direction="row" gap="8px" flexWrap="wrap">
        {connection.connected ? (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            loading={disconnecting}
            onClick={disconnect}
            data-testid="integrations-drawer-disconnect-btn"
          >
            Disconnect {name}
          </Button>
        ) : (
          <Button size="sm" loading={connecting} onClick={onConnect} data-testid="integrations-drawer-connect-btn">
            {connection.needsReconnect ? `Reconnect ${name}` : `Connect ${name}`}
          </Button>
        )}
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => navigate({ to: '/profile', search: { tab: 'integrations' } })}
          data-testid="integrations-drawer-more-settings-link"
        >
          More settings
        </Button>
      </Stack>
      {connection.needsReconnect && (
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          The connection to {name} expired or was revoked. Reconnect to use it again.
        </Typography>
      )}
    </Stack>
  );
};

/** A plain pointer to where an integration is managed today. */
const LinkOut = ({
  text,
  label,
  onClick,
  external,
}: {
  text: string;
  label: string;
  onClick: () => void;
  external?: boolean;
}) => (
  <Stack gap="12px" alignItems="flex-start">
    <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
      {text}
    </Typography>
    <Button
      size="sm"
      variant="outlined"
      color="neutral"
      endDecorator={external ? <OpenInNewIcon sx={{ fontSize: '16px' }} /> : undefined}
      onClick={onClick}
      data-testid="integrations-drawer-link-btn"
    >
      {label}
    </Button>
  </Stack>
);

interface IntegrationDrawerProps {
  derived: DerivedIntegration | null;
  connection: ConnectionState | undefined;
  connecting: boolean;
  onConnect: (id: ConnectableId) => void;
  requested: boolean;
  requestCount: number;
  onToggleRequest: (id: IntegrationId, requested: boolean) => void;
  onClose: () => void;
}

/**
 * The right-hand panel for one integration: what it does, each capability's status, and the
 * existing management UI where one maps 1:1 to the integration (rendered as is).
 */
const IntegrationDrawer = ({
  derived,
  connection,
  connecting,
  onConnect,
  requested,
  requestCount,
  onToggleRequest,
  onClose,
}: IntegrationDrawerProps) => {
  const navigate = useNavigate();
  const currentUser = useUser(s => s.currentUser);
  const titleId = useId();

  const manage = (id: IntegrationId): ReactNode => {
    const state = connection ?? { connected: false };
    switch (id) {
      case 'google-drive':
      case 'notion':
      case 'okta':
        return (
          <AccountConnectionPanel id={id} connection={state} connecting={connecting} onConnect={() => onConnect(id)} />
        );
      case 'atlassian':
        return (
          <Stack gap="24px">
            <AccountConnectionPanel
              id={id}
              connection={state}
              connecting={connecting}
              onConnect={() => onConnect(id)}
            />
            {state.connected && <JiraWebhookSection />}
          </Stack>
        );
      case 'github':
        return (
          <Stack gap="24px">
            <GitHubIntegrationSection userId={currentUser?.id ?? ''} />
            <WebhookSubscriptionSection />
          </Stack>
        );
      case 'slack':
        return <SlackIntegrationSection />;
      case 'linkedin':
        return <McpSection />;
      case 'email':
        return <EmailIntegrationSection />;
      case 'jupyter':
        return <JupyterIntegrationSection />;
      case 'blog':
        return <BlogIntegrationSection />;
      case 'history-import':
        return (
          <LinkOut
            text="Upload a ChatGPT or Claude export from Settings; each conversation becomes a notebook."
            label="Import from Settings"
            onClick={() => navigate({ to: '/profile', search: { tab: 'settings' } })}
          />
        );
      case 'b4m-oauth':
        return (
          <LinkOut
            text="Apps you have let sign in with your Bike4Mind account are listed under Approved apps in Settings, where you can revoke them."
            label="Review approved apps"
            onClick={() => navigate({ to: '/profile', search: { tab: 'settings' } })}
          />
        );
      case 'claude-code':
        return (
          <LinkOut
            text="Pairing starts from the Tavern: connect Claude Code there and run the bridge on your machine."
            label="Open the Tavern"
            // `/tavern` is a codegen-mounted premium route, not in Tanstack's static route union
            // (same cast as SidenavNav).
            onClick={() => navigate({ to: '/tavern' } as never)}
          />
        );
      case 'mcp-cli':
        return (
          <LinkOut
            text="Add MCP servers to your Bike4Mind CLI configuration and their tools are available in CLI sessions."
            label="CLI documentation"
            external
            onClick={() => openInNewTab(CLI_DOCS_URL)}
          />
        );
      default:
        return null;
    }
  };

  const integration = derived?.integration;
  const planned = integration?.stage === 'planned';

  return (
    <Drawer
      anchor="right"
      open={!!derived}
      onClose={onClose}
      slotProps={{ content: { 'aria-labelledby': titleId, sx: { width: { xs: '100%', sm: '560px' }, p: 0 } } }}
    >
      {derived && integration && (
        <Box
          data-testid="integrations-drawer"
          sx={{ p: { xs: '20px', sm: '24px' }, overflowY: 'auto', height: '100%' }}
        >
          <Stack direction="row" alignItems="flex-start" gap="12px">
            <IntegrationLogo logo={integration.logo} size={40} muted={planned} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography id={titleId} level="title-lg" data-testid="integrations-drawer-title">
                {integration.name}
              </Typography>
              <Stack direction="row" alignItems="center" gap="10px" sx={{ mt: '2px' }}>
                <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                  {INTEGRATION_CATEGORY_LABELS[integration.category]}
                </Typography>
                <IntegrationStatusLabel derived={derived} testId="integrations-drawer-status" />
              </Stack>
            </Box>
            <IconButton
              size="sm"
              variant="plain"
              onClick={onClose}
              aria-label="Close"
              data-testid="integrations-drawer-close"
            >
              <CloseIcon />
            </IconButton>
          </Stack>

          <Typography level="body-md" sx={{ mt: '16px' }}>
            {integration.description}
          </Typography>
          {derived.adminOnly && (
            <Typography
              level="body-sm"
              data-testid="integrations-drawer-admin-note"
              sx={{ mt: '8px', color: 'text.tertiary' }}
            >
              {ADMIN_ONLY_NOTE}: an admin flag behind it is off, so other users see it as Coming soon.
            </Typography>
          )}

          {derived.capabilities.length > 0 && (
            <>
              <Typography level="title-sm" sx={{ mt: '24px', mb: '8px' }}>
                What it does
              </Typography>
              <Stack divider={<Divider />} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px' }}>
                {derived.capabilities.map(c => (
                  <Stack
                    key={c.capability.id}
                    direction="row"
                    alignItems="center"
                    gap="12px"
                    data-testid={`integrations-drawer-capability-${c.capability.id}`}
                    sx={{ px: '12px', py: '10px' }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                        {c.capability.label}
                      </Typography>
                      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                        {KIND_LABELS[c.capability.kind]}
                      </Typography>
                    </Box>
                    <IntegrationStatusLabel derived={c} />
                  </Stack>
                ))}
              </Stack>
            </>
          )}

          <Box sx={{ mt: '24px' }}>
            {planned ? (
              <Stack direction="row" alignItems="center" gap="12px">
                <RequestButton
                  integrationId={integration.id}
                  requested={requested}
                  onToggle={onToggleRequest}
                  testId={`integrations-drawer-request-btn-${integration.id}`}
                />
                <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                  {requestCount > 0 ? requestCountText(requestCount) : 'Be the first to ask for it.'}
                </Typography>
              </Stack>
            ) : derived.status === 'coming-soon' ? (
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                Not available on this workspace yet.
              </Typography>
            ) : (
              manage(integration.id)
            )}
          </Box>
          {!planned && derived.status !== 'coming-soon' && isConnectable(integration.id) && (
            <Typography level="body-xs" sx={{ mt: '16px', color: 'text.tertiary' }}>
              Connecting takes you to the provider and back to your profile settings.
            </Typography>
          )}
        </Box>
      )}
    </Drawer>
  );
};

export default IntegrationDrawer;
