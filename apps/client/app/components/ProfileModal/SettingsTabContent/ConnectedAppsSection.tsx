import { useUser } from '@client/app/contexts/UserContext';
import { useConnectGoogleDrive, useDisconnectGoogleDrive } from '@client/app/hooks/data/googleDrive';
import {
  useConnectAtlassian,
  useDisconnectAtlassian,
  useConnectNotion,
  useDisconnectNotion,
  useUpdateNotionSettings,
} from '@client/app/hooks/data/mcpServers';
import SiGoogledrive, { defaultColor as SiGoogledriveHex } from '@icons-pack/react-simple-icons/icons/SiGoogledrive';
import SiOkta, { defaultColor as SiOktaHex } from '@icons-pack/react-simple-icons/icons/SiOkta';
import SiAtlassian, { defaultColor as SiAtlassianHex } from '@icons-pack/react-simple-icons/icons/SiAtlassian';
import SiNotion, { defaultColor as SiNotionHex } from '@icons-pack/react-simple-icons/icons/SiNotion';
import { Box, Button, Input, Switch, Typography } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import { AuthStrategy } from '@bike4mind/common';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { useEffect, useState } from 'react';
import SectionContainer from '../SectionContainer';
import NotionPagePicker, { type AllowedPage } from './NotionPagePicker';

const getCookieValue = (name: string): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }
  const cookieString = document.cookie || '';
  const cookies = cookieString.split(';').map(part => part.trim());
  const target = cookies.find(cookie => cookie.startsWith(`${name}=`));
  if (!target) {
    return null;
  }
  return decodeURIComponent(target.split('=').slice(1).join('='));
};

const clearCookie = (name: string) => {
  if (typeof document === 'undefined') {
    return;
  }
  document.cookie = `${name}=; Path=/; Max-Age=0`;
};

const ConnectedAppsSection = () => {
  const { t } = useTranslation();
  const currentUser = useUser(state => state.currentUser);
  const refreshUser = useUser(state => state.refreshUser);
  const isGoogleDriveConnected = !!currentUser?.googleDrive;
  const isAccountLinkedToOkta =
    currentUser?.authProviders?.some(provider => provider.strategy === AuthStrategy.Okta) ?? false;

  const connectGoogleDrive = useConnectGoogleDrive();
  const disconnectGoogleDrive = useDisconnectGoogleDrive();

  // Atlassian connection
  const connectAtlassian = useConnectAtlassian();
  const disconnectAtlassian = useDisconnectAtlassian();
  const atlassianConnect = currentUser?.atlassianConnect;
  const isAtlassianConnected = !!atlassianConnect && atlassianConnect.status !== 'needs_reconnect';
  const atlassianNeedsReconnect = atlassianConnect?.status === 'needs_reconnect';
  const atlassianSiteName = atlassianConnect?.siteName;

  // Notion connection
  const connectNotion = useConnectNotion();
  const disconnectNotion = useDisconnectNotion();
  const notionConnect = currentUser?.notionConnect;
  const isNotionConnected = !!notionConnect && notionConnect.status !== 'needs_reconnect';
  const notionNeedsReconnect = notionConnect?.status === 'needs_reconnect';
  const notionWorkspaceName = notionConnect?.workspaceName;

  // Handle OAuth callback status
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const atlassianStatus = params.get('atlassian');

    if (!atlassianStatus) {
      return;
    }

    const removeAtlassianParam = () => {
      params.delete('atlassian');
      const queryString = params.toString();
      const hash = window.location.hash ?? '';
      const nextUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ''}${hash}`;
      window.history.replaceState(null, '', nextUrl);
    };

    if (atlassianStatus === 'connected') {
      // Check if there's actually a success cookie to confirm this is a real callback
      const successCookie = getCookieValue('atlassian_connected');
      if (successCookie) {
        clearCookie('atlassian_connected');
        void refreshUser();
        toast.success('Atlassian connected successfully!');
        removeAtlassianParam();
      }
      // If no cookie, it's a stale URL from browser back - do nothing
    } else if (atlassianStatus === 'error') {
      // Only process error if the error cookie exists
      const errorMessage = getCookieValue('atlassian_error');
      if (errorMessage) {
        clearCookie('atlassian_error');
        // Display the specific error from the backend
        toast.error(errorMessage, { duration: 6000 });
        removeAtlassianParam();
      }
      // If no cookie, it's a stale URL from browser back - do nothing
    }
  }, [refreshUser]);

  // Handle Notion OAuth callback status
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const notionStatus = params.get('notion');

    if (!notionStatus) {
      return;
    }

    const removeNotionParam = () => {
      params.delete('notion');
      const queryString = params.toString();
      const hash = window.location.hash ?? '';
      const nextUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ''}${hash}`;
      window.history.replaceState(null, '', nextUrl);
    };

    if (notionStatus === 'connected') {
      const successCookie = getCookieValue('notion_connected');
      if (successCookie) {
        clearCookie('notion_connected');
        void refreshUser();
        toast.success('Notion connected successfully!');
        removeNotionParam();
      }
    } else if (notionStatus === 'error') {
      const errorMessage = getCookieValue('notion_error');
      if (errorMessage) {
        clearCookie('notion_error');
        toast.error(errorMessage, { duration: 6000 });
        removeNotionParam();
      }
    }
  }, [refreshUser]);

  const handleOktaAccount = async (action: 'okta-link' | 'okta-unlink') => {
    if (action === 'okta-link') {
      window.location.href = `/api/auth/${AuthStrategy.Okta}`;
    } else if (action === 'okta-unlink') {
      try {
        await api.post('/api/auth/unlink', {
          strategy: AuthStrategy.Okta,
        });
        toast.success('Your account has been unlinked from Okta.');
        // Refresh so the Okta card reflects the unlinked state without a reload.
        void refreshUser();
      } catch (error) {
        console.error('Error unlinking account from Okta:', error);
        // Surface the server's message (e.g. the last-sign-in-method lockout guard);
        // fall back to a generic message otherwise.
        const message =
          isAxiosError(error) && typeof error.response?.data?.error === 'string'
            ? error.response.data.error
            : 'An error occurred while unlinking your account from Okta.';
        toast.error(message);
      }
    }
  };

  return (
    <SectionContainer title={t('settings.connected_apps.title')}>
      <Box
        className="connected-apps-grid"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: '1.25rem',
        }}
      >
        <AppContainer
          name="Link Account to Okta"
          isConnected={isAccountLinkedToOkta}
          loading={false}
          onConnect={() => handleOktaAccount('okta-link')}
          onDisconnect={() => handleOktaAccount('okta-unlink')}
          logo={<SiOkta color={SiOktaHex} />}
        />
        <AppContainer
          name="Google Drive"
          isConnected={isGoogleDriveConnected}
          loading={connectGoogleDrive.isPending || disconnectGoogleDrive.isPending}
          onConnect={() => connectGoogleDrive.mutate()}
          onDisconnect={() => disconnectGoogleDrive.mutate()}
          logo={<SiGoogledrive color={SiGoogledriveHex} />}
        />
        <AppContainer
          name="Atlassian (Jira, Confluence)"
          subtitle={atlassianSiteName}
          isConnected={isAtlassianConnected}
          needsReconnect={atlassianNeedsReconnect}
          loading={connectAtlassian.isPending || disconnectAtlassian.isPending}
          onConnect={() => connectAtlassian.mutate()}
          onDisconnect={() => disconnectAtlassian.mutate()}
          logo={<SiAtlassian color={SiAtlassianHex} />}
        />
        <Box sx={{ gridColumn: { md: '1 / -1' } }}>
          <NotionAppContainer
            isConnected={isNotionConnected}
            needsReconnect={notionNeedsReconnect}
            workspaceName={notionWorkspaceName}
            writeEnabled={notionConnect?.writeEnabled ?? false}
            rootPageId={notionConnect?.rootPageId ?? ''}
            accessMode={notionConnect?.accessMode ?? 'all'}
            allowedPages={notionConnect?.allowedPages ?? []}
            excludedPageIds={notionConnect?.excludedPageIds ?? []}
            loading={connectNotion.isPending || disconnectNotion.isPending}
            onConnect={() => connectNotion.mutate()}
            onDisconnect={() => disconnectNotion.mutate()}
          />
        </Box>
      </Box>
    </SectionContainer>
  );
};

/**
 * Notion-specific app container with write access toggle and root page ID settings.
 */
const NotionAppContainer = ({
  isConnected,
  needsReconnect,
  workspaceName,
  writeEnabled,
  rootPageId,
  accessMode,
  allowedPages,
  excludedPageIds,
  loading,
  onConnect,
  onDisconnect,
}: {
  isConnected: boolean;
  needsReconnect?: boolean;
  workspaceName?: string;
  writeEnabled: boolean;
  rootPageId: string;
  accessMode: 'all' | 'selected';
  allowedPages: AllowedPage[];
  excludedPageIds: string[];
  loading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) => {
  const { t } = useTranslation();
  const updateSettings = useUpdateNotionSettings();
  const [localRootPageId, setLocalRootPageId] = useState(rootPageId);

  // Sync local state when server value changes
  useEffect(() => {
    setLocalRootPageId(rootPageId);
  }, [rootPageId]);

  const handleWriteToggle = (checked: boolean) => {
    updateSettings.mutate(
      { writeEnabled: checked },
      {
        onSuccess: () => {
          toast.success(checked ? 'Notion write access enabled' : 'Notion write access disabled');
        },
      }
    );
  };

  const handleAccessModeToggle = (checked: boolean) => {
    const newMode = checked ? 'selected' : 'all';
    updateSettings.mutate(
      { accessMode: newMode },
      {
        onSuccess: () => {
          toast.success(
            newMode === 'selected' ? 'Page-level access control enabled' : 'Full workspace access restored'
          );
        },
      }
    );
  };

  const handlePagePermissionsSave = (pages: AllowedPage[], excluded: string[]) => {
    updateSettings.mutate(
      { allowedPages: pages, excludedPageIds: excluded },
      {
        onSuccess: () => {
          toast.success('Page permissions updated');
        },
      }
    );
  };

  const handleRootPageSave = () => {
    const trimmed = localRootPageId.trim();
    if (trimmed === rootPageId) return;

    updateSettings.mutate(
      { rootPageId: trimmed || null },
      {
        onSuccess: () => {
          toast.success(trimmed ? 'Root page updated' : 'Root page cleared');
        },
      }
    );
  };

  const borderColor = needsReconnect
    ? 'warning.outlinedBorder'
    : isConnected
      ? 'success.outlinedBorder'
      : 'neutral.outlinedBorder';

  return (
    <Box
      className="connected-app-container"
      data-testid="notion-app-container"
      sx={theme => ({
        backgroundColor: theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
        display: 'flex',
        flexDirection: 'column',
        p: '16px',
        gap: '12px',
        border: '1px solid',
        borderRadius: '8px',
        borderColor,
        height: '100%',
        transition: 'border-color 0.2s ease',
      })}
    >
      {/* Header row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <Box
          className="connected-app-info"
          sx={{ flex: 1, minWidth: 0, display: 'flex', gap: '16px', alignItems: 'center' }}
        >
          <SiNotion color={SiNotionHex} />
          <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
              Notion
            </Typography>
            {workspaceName && (
              <Typography level="body-sm" sx={{ fontSize: '14px', color: 'text.tertiary' }}>
                {workspaceName}
              </Typography>
            )}
          </Box>
        </Box>

        <Button
          className={`connected-app-button ${needsReconnect ? 'connected-app-reconnect' : isConnected ? 'connected-app-disconnect' : 'connected-app-connect'}`}
          loading={loading}
          color={needsReconnect ? 'warning' : isConnected ? 'danger' : undefined}
          onClick={() => (needsReconnect ? onConnect() : isConnected ? onDisconnect() : onConnect())}
          sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {needsReconnect
            ? t('settings.connected_apps.reconnect', 'Reconnect')
            : isConnected
              ? t('settings.connected_apps.unlink')
              : t('settings.connected_apps.link')}
        </Button>
      </Box>

      {needsReconnect && (
        <Typography level="body-xs" sx={{ color: 'warning.600', fontSize: '12px' }}>
          {t(
            'settings.connected_apps.connection_expired',
            'Connection expired. Please reconnect to continue using this integration.'
          )}
        </Typography>
      )}

      {/* Settings panel - only visible when connected */}
      {isConnected && (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            pt: '8px',
            borderTop: '1px solid',
            borderColor: 'divider',
          }}
        >
          {/* Write access toggle */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <Box>
              <Typography level="body-sm" sx={{ fontWeight: 500 }}>
                Write access
              </Typography>
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                Allow creating pages and appending content
              </Typography>
            </Box>
            <Switch
              data-testid="notion-write-toggle"
              checked={writeEnabled}
              onChange={e => handleWriteToggle(e.target.checked)}
              disabled={updateSettings.isPending}
            />
          </Box>

          {/* Page-level access control toggle */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <Box>
              <Typography level="body-sm" sx={{ fontWeight: 500 }}>
                Restrict to selected pages
              </Typography>
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                Only allow access to specific pages and their children
              </Typography>
            </Box>
            <Switch
              data-testid="notion-access-mode-toggle"
              checked={accessMode === 'selected'}
              onChange={e => handleAccessModeToggle(e.target.checked)}
              disabled={updateSettings.isPending}
            />
          </Box>

          {/* Page picker - shown when access mode is 'selected' */}
          {accessMode === 'selected' && (
            <NotionPagePicker
              allowedPages={allowedPages}
              excludedPageIds={excludedPageIds}
              onSave={handlePagePermissionsSave}
              saving={updateSettings.isPending}
            />
          )}

          {/* Root page ID (legacy - for write scoping) */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <Typography level="body-sm" sx={{ fontWeight: 500 }}>
              Root page ID
            </Typography>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              All content will be created under this page. Find the page ID in its Notion URL.
            </Typography>
            <Box sx={{ display: 'flex', gap: '8px', mt: '4px' }}>
              <Input
                data-testid="notion-root-page-input"
                size="sm"
                placeholder="e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                value={localRootPageId}
                onChange={e => setLocalRootPageId(e.target.value)}
                sx={{ flex: 1, fontFamily: 'monospace', fontSize: '12px' }}
              />
              <Button
                data-testid="notion-root-page-save"
                size="sm"
                variant="outlined"
                disabled={localRootPageId.trim() === rootPageId || updateSettings.isPending}
                loading={updateSettings.isPending}
                onClick={handleRootPageSave}
              >
                Save
              </Button>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
};

const AppContainer = ({
  isConnected,
  needsReconnect,
  loading,
  onConnect,
  onDisconnect,
  logo,
  name,
  subtitle,
}: {
  isConnected: boolean;
  needsReconnect?: boolean;
  loading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  logo: React.ReactNode;
  name: string;
  subtitle?: string;
}) => {
  const { t } = useTranslation();

  // Determine border color based on connection state using MUI Joy semantic tokens
  const borderColor = needsReconnect
    ? 'warning.outlinedBorder'
    : isConnected
      ? 'success.outlinedBorder'
      : 'neutral.outlinedBorder';

  return (
    <Box
      className="connected-app-container"
      sx={theme => ({
        backgroundColor: theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
        display: 'flex',
        flexDirection: 'column',
        p: '16px',
        gap: '12px',
        border: '1px solid',
        borderRadius: '8px',
        borderColor,
        height: '100%',
        transition: 'border-color 0.2s ease',
      })}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <Box
          className="connected-app-info"
          sx={{ flex: 1, minWidth: 0, display: 'flex', gap: '16px', alignItems: 'center' }}
        >
          {logo}
          <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
              {name}
            </Typography>
            {subtitle && (
              <Typography level="body-sm" sx={{ fontSize: '14px', color: 'text.tertiary' }}>
                {subtitle}
              </Typography>
            )}
          </Box>
        </Box>

        <Button
          className={`connected-app-button ${needsReconnect ? 'connected-app-reconnect' : isConnected ? 'connected-app-disconnect' : 'connected-app-connect'}`}
          loading={loading}
          color={needsReconnect ? 'warning' : isConnected ? 'danger' : undefined}
          onClick={() => (needsReconnect ? onConnect() : isConnected ? onDisconnect() : onConnect())}
          sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {needsReconnect
            ? t('settings.connected_apps.reconnect', 'Reconnect')
            : isConnected
              ? t('settings.connected_apps.unlink')
              : t('settings.connected_apps.link')}
        </Button>
      </Box>
      {needsReconnect && (
        <Typography level="body-xs" sx={{ color: 'warning.600', fontSize: '12px' }}>
          {t(
            'settings.connected_apps.connection_expired',
            'Connection expired. Please reconnect to continue using this integration.'
          )}
        </Typography>
      )}
    </Box>
  );
};

export default ConnectedAppsSection;
