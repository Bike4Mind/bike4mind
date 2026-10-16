import { useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import { AuthStrategy, McpServerName, type IntegrationId } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useConnectGoogleDrive } from '@client/app/hooks/data/googleDrive';
import { useConnectAtlassian, useConnectNotion, useMcpServers } from '@client/app/hooks/data/mcpServers';
import { useGitHubConnectionStatus } from '@client/app/hooks/data/useGitHubConnectionStatus';
import { getStoredJupyterConfig, subscribeStoredJupyterConfig } from '@client/app/utils/jupyterBrowserClient';
import type { Connections } from './galleryModel';

/**
 * Whether the viewer has connected each integration, read from the same sources the
 * Profile > Integrations tab reads (the user document, the GitHub status probe, the MCP
 * server list, the blog-integration query). Integrations with no per-user connection
 * (Google Calendar, history import, Claude Code, MCP via CLI) are simply absent.
 */
export function useIntegrationConnections(): Connections {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const { data: github } = useGitHubConnectionStatus(currentUser?.id ?? '');
  const { data: mcpServers } = useMcpServers();
  // Same key and fetcher as BlogIntegrationSection, so the two share one cache entry. Admins
  // only: the section, and so the Blog card, renders for nobody else.
  const { data: blog } = useQuery({
    queryKey: ['blog-integration'],
    queryFn: async () => (await api.get<{ connected?: boolean }>('/api/blog-integration')).data,
    enabled: isAdmin,
  });

  // Local to this browser: the Jupyter settings live in localStorage, not on the account, and the
  // drawer's Jupyter form can change them while the gallery is open behind it.
  const jupyterConfigured = useSyncExternalStore(
    subscribeStoredJupyterConfig,
    () => getStoredJupyterConfig() !== null,
    () => false
  );

  const atlassian = currentUser?.atlassianConnect;
  const notion = currentUser?.notionConnect;

  return {
    'google-drive': { connected: !!currentUser?.googleDrive },
    github: { connected: !!github?.connected },
    atlassian: {
      connected: !!atlassian && atlassian.status !== 'needs_reconnect',
      needsReconnect: atlassian?.status === 'needs_reconnect',
    },
    notion: {
      connected: !!notion && notion.status !== 'needs_reconnect',
      needsReconnect: notion?.status === 'needs_reconnect',
    },
    slack: { connected: !!currentUser?.slackSettings?.slackUserId },
    linkedin: { connected: !!mcpServers?.some(s => s.name === McpServerName.LinkedIn && s.enabled) },
    email: { connected: !!currentUser?.platformEmailAddress },
    blog: { connected: !!blog?.connected },
    okta: { connected: currentUser?.authProviders?.some(p => p.strategy === AuthStrategy.Okta) ?? false },
    jupyter: { connected: jupyterConfigured },
  };
}

export const CONNECTABLE_IDS = ['google-drive', 'github', 'atlassian', 'notion', 'slack', 'okta'] as const;
export type ConnectableId = (typeof CONNECTABLE_IDS)[number];

export const isConnectable = (id: IntegrationId): id is ConnectableId =>
  (CONNECTABLE_IDS as readonly string[]).includes(id);

const errorMessage = (error: unknown, fallback: string): string =>
  isAxiosError(error) && typeof error.response?.data?.error === 'string' ? error.response.data.error : fallback;

/**
 * Start each connectable integration's existing OAuth flow - the same hooks and endpoints the
 * Profile > Integrations tab uses. Every flow leaves the page; its callback lands on /profile.
 */
export function useIntegrationConnect() {
  const connectDrive = useConnectGoogleDrive();
  const connectAtlassian = useConnectAtlassian();
  const connectNotion = useConnectNotion();
  const [redirecting, setRedirecting] = useState<ConnectableId | null>(null);

  const redirectTo = async (id: ConnectableId, fetchUrl: () => Promise<string>, failure: string) => {
    setRedirecting(id);
    try {
      window.location.href = await fetchUrl();
    } catch (error) {
      toast.error(errorMessage(error, failure));
      setRedirecting(null);
    }
  };

  const connect = (id: ConnectableId) => {
    switch (id) {
      case 'google-drive':
        connectDrive.mutate(undefined, {
          onError: error => toast.error(errorMessage(error, 'Could not connect Google Drive. Try again.')),
        });
        return;
      case 'atlassian':
        // The hook toasts its own failures.
        connectAtlassian.mutate();
        return;
      case 'notion':
        connectNotion.mutate();
        return;
      case 'github':
        void redirectTo(
          id,
          async () => (await api.post<{ authUrl: string }>('/api/auth/github/authorize')).data.authUrl,
          'Could not connect GitHub. Try again.'
        );
        return;
      case 'slack':
        void redirectTo(
          id,
          async () => (await api.get<{ redirectUrl: string }>('/api/slack/oauth/user-link/initiate')).data.redirectUrl,
          'Could not connect Slack. Try again.'
        );
        return;
      case 'okta':
        setRedirecting(id);
        window.location.href = `/api/auth/${AuthStrategy.Okta}`;
        return;
    }
  };

  const isPending = (id: IntegrationId): boolean =>
    redirecting === id ||
    (id === 'google-drive' && connectDrive.isPending) ||
    (id === 'atlassian' && connectAtlassian.isPending) ||
    (id === 'notion' && connectNotion.isPending);

  return { connect, isPending };
}
