import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SettingKey } from '@bike4mind/common';
import type { Connections } from './galleryModel';

const h = vi.hoisted(() => ({
  toggleRequest: vi.fn(),
  connect: vi.fn(),
  navigate: vi.fn(),
  stub: (testId: string) => ({ default: () => React.createElement('div', { 'data-testid': testId }) }),
}));

let state: { currentUser: Record<string, unknown> | null; isAdmin: boolean };
let flags: Set<SettingKey>;
let connections: Connections;
let requests: { counts: Record<string, number>; mine: string[] } | undefined;
let compact: boolean;

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: Record<string, unknown>) => unknown) => selector({ ...state, refreshUser: vi.fn() }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: (key: SettingKey) => flags.has(key) }),
}));
vi.mock('@client/app/hooks/data/integrationRequests', () => ({
  useIntegrationRequests: () => ({ data: requests }),
  useToggleIntegrationRequest: () => ({ mutate: h.toggleRequest }),
}));
vi.mock('./useIntegrationConnections', async importOriginal => ({
  ...(await importOriginal<typeof import('./useIntegrationConnections')>()),
  useIntegrationConnections: () => connections,
  useIntegrationConnect: () => ({ connect: h.connect, isPending: () => false }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => compact }));
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes: [] }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useDisconnectGoogleDrive: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useDisconnectAtlassian: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectNotion: () => ({ mutate: vi.fn(), isPending: false }),
}));
// The existing Profile > Integrations sections are rendered as is in the drawer; their own
// suites cover them, so here they only need to show up.
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/ConnectedAppsSection', () => ({
  describeStoppedDriveSyncs: () => null,
}));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/SlackIntegrationSection', () => h.stub('stub-slack'));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/GitHubIntegrationSection', () => h.stub('stub-github'));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/EmailIntegrationSection', () => h.stub('stub-email'));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/JupyterIntegrationSection', () =>
  h.stub('stub-jupyter')
);
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/BlogIntegrationSection', () => h.stub('stub-blog'));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/JiraWebhookSection', () => h.stub('stub-jira'));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/WebhookSubscriptionSection', () =>
  h.stub('stub-webhooks')
);
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/McpSection', () => h.stub('stub-mcp'));

import IntegrationsGallery from './IntegrationsGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderGallery = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <IntegrationsGallery />
    </CssVarsProvider>
  );

const group = (key: string) => screen.getByTestId(`integrations-group-${key}`);
const rowIds = () =>
  screen
    .queryAllByTestId(/^integrations-row-/)
    .map(el => el.getAttribute('data-testid')!.replace('integrations-row-', ''));
const pick = async (filter: string, option: string) => {
  await userEvent.click(screen.getByTestId(`integrations-${filter}-filter-btn`));
  await userEvent.click(await screen.findByTestId(`integrations-${filter}-option-${option}`));
};

beforeEach(() => {
  vi.clearAllMocks();
  state = { currentUser: { id: 'u1', tags: [] }, isAdmin: false };
  flags = new Set<SettingKey>(['EnableMCPServer', 'EnableDataLakes']);
  connections = { 'google-drive': { connected: true } };
  requests = { counts: { hubspot: 41, gmail: 3 }, mine: ['gmail'] };
  compact = false;
});

describe('IntegrationsGallery', () => {
  it('pins Connected first, groups by category, and puts the roadmap last', () => {
    renderGallery();

    const groups = screen.getAllByTestId(/^integrations-group-(?!header)/).map(el => el.getAttribute('data-testid'));
    expect(groups[0]).toBe('integrations-group-connected');
    expect(groups[groups.length - 1]).toBe('integrations-group-coming-soon');
    expect(within(group('connected')).getByTestId('integrations-row-google-drive')).toBeInTheDocument();
    expect(within(group('dev-tools')).getByTestId('integrations-row-github')).toBeInTheDocument();
    expect(within(group('coming-soon')).getByTestId('integrations-row-hubspot')).toBeInTheDocument();
    expect(screen.getByTestId('integrations-count-line')).toHaveTextContent(
      /^12 integrations, 12 models, 19 on the roadmap\.$/
    );
  });

  it('hides the admin-only and Tavern-only entries from a regular user', () => {
    renderGallery();
    expect(screen.queryByTestId('integrations-row-blog')).toBeNull();
    expect(screen.queryByTestId('integrations-row-claude-code')).toBeNull();
  });

  it('shows a flagged-off entry to admins as Beta with the admin-only note, and as Coming soon to others', async () => {
    flags = new Set<SettingKey>();
    const { unmount } = renderGallery();
    expect(within(group('coming-soon')).getByTestId('integrations-row-notion')).toBeInTheDocument();
    expect(screen.queryByTestId('integrations-action-btn-notion')).toBeNull();
    unmount();

    state = { ...state, isAdmin: true };
    renderGallery();
    expect(screen.getByTestId('integrations-status-notion')).toHaveAttribute('data-status', 'beta');
    expect(
      within(screen.getByTestId('integrations-status-notion')).getByLabelText('Only admins can see this')
    ).toBeInTheDocument();
    expect(screen.getByTestId('integrations-row-blog')).toBeInTheDocument();
  });

  it('keeps a Beta tag on a connected beta entry', () => {
    connections = { linkedin: { connected: true } };
    renderGallery();
    const status = screen.getByTestId('integrations-status-linkedin');
    expect(status).toHaveAttribute('data-status', 'connected');
    expect(within(status).getByText('Beta')).toBeInTheDocument();
  });

  it('filters by search text', async () => {
    renderGallery();
    await userEvent.type(screen.getByTestId('integrations-search-input'), 'notion');
    expect(rowIds()).toEqual(['notion']);

    await userEvent.clear(screen.getByTestId('integrations-search-input'));
    await userEvent.type(screen.getByTestId('integrations-search-input'), 'no such thing');
    expect(rowIds()).toEqual([]);
    expect(screen.getByTestId('integrations-empty')).toBeInTheDocument();
  });

  it('filters by status and category from compact selects that name the active value', async () => {
    renderGallery();
    expect(screen.getByTestId('integrations-status-filter-btn')).toHaveTextContent('All statuses');
    await pick('status', 'connected');
    expect(rowIds()).toEqual(['google-drive']);
    expect(screen.getByTestId('integrations-status-filter-btn')).toHaveTextContent('Status: Connected');

    await pick('status', 'coming-soon');
    expect(rowIds()).toContain('hubspot');
    expect(rowIds()).not.toContain('github');

    await pick('category', 'crm');
    expect(rowIds()).toEqual(['hubspot', 'salesforce']);
    expect(screen.getByTestId('integrations-category-filter-btn')).toHaveTextContent('Category: CRM');
  });

  it('shows how many entries each filter value holds', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-status-filter-btn'));
    expect(await screen.findByTestId('integrations-status-option-connected')).toHaveTextContent(/^Connected1$/);
    expect(screen.getByTestId('integrations-status-option-coming-soon')).toHaveTextContent(/^Coming soon19$/);
  });

  it('toggles a request and shows the request count', async () => {
    renderGallery();
    expect(screen.getByTestId('integrations-request-count-hubspot')).toHaveTextContent('41 requests');
    expect(screen.getByTestId('integrations-request-btn-hubspot')).toHaveTextContent('Request');
    expect(screen.getByTestId('integrations-request-btn-gmail')).toHaveTextContent('Requested');

    await userEvent.click(screen.getByTestId('integrations-request-btn-hubspot'));
    expect(h.toggleRequest).toHaveBeenCalledWith({ integrationId: 'hubspot', requested: false });
    await userEvent.click(screen.getByTestId('integrations-request-btn-gmail'));
    expect(h.toggleRequest).toHaveBeenCalledWith({ integrationId: 'gmail', requested: true });
    // The button acts on its own; it never also opens the row's drawer.
    expect(screen.queryByTestId('integrations-drawer')).toBeNull();
  });

  it('starts the existing connect flow from the row', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-action-btn-github'));
    expect(h.connect).toHaveBeenCalledWith('github');
    expect(screen.getByTestId('integrations-action-btn-google-drive')).toHaveTextContent('Manage');
  });

  it('offers Reconnect when a grant needs it', () => {
    connections = { atlassian: { connected: false, needsReconnect: true } };
    renderGallery();
    expect(screen.getByTestId('integrations-action-btn-atlassian')).toHaveTextContent('Reconnect');
  });

  it('opens the drawer with capabilities and the existing management UI', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-row-github'));

    const drawer = await screen.findByTestId('integrations-drawer');
    expect(within(drawer).getByTestId('integrations-drawer-title')).toHaveTextContent('GitHub');
    expect(within(drawer).getByTestId('integrations-drawer-capability-github-tools')).toBeInTheDocument();
    expect(within(drawer).getByTestId('integrations-drawer-capability-github-lake')).toHaveTextContent('Coming soon');
    expect(within(drawer).getByTestId('stub-github')).toBeInTheDocument();
    expect(within(drawer).getByTestId('stub-webhooks')).toBeInTheDocument();

    await userEvent.click(within(drawer).getByTestId('integrations-drawer-close'));
    await waitFor(() => expect(screen.queryByTestId('integrations-drawer')).toBeNull());
  });

  it('offers a request, not management, in a roadmap drawer', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-row-salesforce'));
    const drawer = await screen.findByTestId('integrations-drawer');
    expect(within(drawer).getByText('Be the first to ask for it.')).toBeInTheDocument();
    await userEvent.click(within(drawer).getByTestId('integrations-drawer-request-btn-salesforce'));
    expect(h.toggleRequest).toHaveBeenCalledWith({ integrationId: 'salesforce', requested: false });
  });

  it('links account integrations to their full settings', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-row-google-drive'));
    const drawer = await screen.findByTestId('integrations-drawer');
    expect(within(drawer).getByTestId('integrations-drawer-disconnect-btn')).toHaveTextContent(
      'Disconnect Google Drive'
    );
    await userEvent.click(within(drawer).getByTestId('integrations-drawer-more-settings-link'));
    expect(h.navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'integrations' } });
  });

  it('lists model providers on the Models tab', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-tab-models'));
    expect(screen.getByTestId('integrations-model-row-anthropic')).toBeInTheDocument();
    expect(screen.getByTestId('integrations-model-group-voice')).toBeInTheDocument();
    expect(screen.queryByTestId('integrations-row-github')).toBeNull();

    await pick('kind', 'music');
    expect(screen.queryAllByTestId(/^integrations-model-row-/).map(el => el.getAttribute('data-testid'))).toEqual([
      'integrations-model-row-lyria',
    ]);
  });

  it('renders cards instead of dense rows below md', async () => {
    compact = true;
    renderGallery();
    expect(screen.queryAllByTestId(/^integrations-row-/)).toHaveLength(0);
    expect(within(group('connected')).getByTestId('integrations-card-google-drive')).toBeInTheDocument();
    expect(within(group('coming-soon')).getByTestId('integrations-card-hubspot')).toBeInTheDocument();
    expect(screen.getByTestId('integrations-request-count-hubspot')).toHaveTextContent('41 requests');

    await userEvent.click(screen.getByTestId('integrations-request-btn-hubspot'));
    expect(h.toggleRequest).toHaveBeenCalledWith({ integrationId: 'hubspot', requested: false });
    await userEvent.click(screen.getByTestId('integrations-card-notion'));
    expect(await screen.findByTestId('integrations-drawer')).toBeInTheDocument();
  });

  it('renders model cards below md', async () => {
    compact = true;
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-tab-models'));
    expect(screen.getByTestId('integrations-model-card-anthropic')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^integrations-model-row-/)).toHaveLength(0);
  });
});
