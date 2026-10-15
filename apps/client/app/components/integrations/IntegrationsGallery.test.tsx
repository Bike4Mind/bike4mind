import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IntegrationsEvents, type IntegrationsPageSource, type SettingKey } from '@bike4mind/common';
import type { Connections } from './galleryModel';

const h = vi.hoisted(() => ({
  toggleRequest: vi.fn(),
  connect: vi.fn(),
  navigate: vi.fn(),
  logEvent: vi.fn(),
  stub: (testId: string) => ({ default: () => React.createElement('div', { 'data-testid': testId }) }),
}));

let state: { currentUser: Record<string, unknown> | null; isAdmin: boolean };
let flags: Set<SettingKey>;
let settingsLoad: { isLoading: boolean; authedSettingsLoaded: boolean; error: string | null };
let connections: Connections;
let requests: { counts: Record<string, number>; mine: string[] } | undefined;
let pendingToggles: Set<string>;
let compact: boolean;

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: Record<string, unknown>) => unknown) => selector({ ...state, refreshUser: vi.fn() }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: (key: SettingKey) => flags.has(key), ...settingsLoad }),
}));
vi.mock('@client/app/hooks/data/integrationRequests', () => ({
  useIntegrationRequests: () => ({ data: requests }),
  useToggleIntegrationRequest: (integrationId: string) => ({
    toggle: (variables: { requested: boolean }) => h.toggleRequest({ integrationId, ...variables }),
    isPending: pendingToggles.has(integrationId),
  }),
}));
vi.mock('./useIntegrationConnections', async importOriginal => ({
  ...(await importOriginal<typeof import('./useIntegrationConnections')>()),
  useIntegrationConnections: () => connections,
  useIntegrationConnect: () => ({ connect: h.connect, isPending: () => false }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => compact }));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: h.logEvent }) }));
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

import IntegrationsGallery, { SEARCH_SETTLE_MS } from './IntegrationsGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderGallery = (props: { source?: IntegrationsPageSource } = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <IntegrationsGallery {...props} />
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
  settingsLoad = { isLoading: false, authedSettingsLoaded: true, error: null };
  connections = { 'google-drive': { connected: true } };
  requests = { counts: { hubspot: 41, gmail: 3 }, mine: ['gmail'] };
  pendingToggles = new Set();
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

  it.each([
    ['the settings request is still in flight', { isLoading: true, authedSettingsLoaded: false, error: null }],
    // The public artifact clears isLoading early, but non-public flags are still compiled-in defaults.
    ['only the public settings have arrived', { isLoading: false, authedSettingsLoaded: false, error: null }],
  ])('draws placeholders, not default-derived statuses, while %s', (_label, load) => {
    settingsLoad = load;
    const { rerender, container } = renderGallery();

    expect(screen.getByTestId('integrations-loading')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^integrations-row-/)).toHaveLength(0);
    expect(container.querySelectorAll('[data-status]')).toHaveLength(0);
    expect(screen.getByTestId('integrations-count-line')).not.toHaveTextContent('integrations');
    expect(screen.getByTestId('integrations-status-filter-btn')).toBeDisabled();

    settingsLoad = { isLoading: false, authedSettingsLoaded: true, error: null };
    rerender(
      <CssVarsProvider theme={appTheme}>
        <IntegrationsGallery />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('integrations-loading')).toBeNull();
    expect(screen.getByTestId('integrations-row-google-drive')).toBeInTheDocument();
    expect(screen.getByTestId('integrations-count-line')).toHaveTextContent(/integrations/);
    expect(screen.getByTestId('integrations-status-filter-btn')).toBeEnabled();
  });

  it('draws placeholders as cards below md while settings load', () => {
    settingsLoad = { isLoading: true, authedSettingsLoaded: false, error: null };
    compact = true;
    renderGallery();
    expect(screen.getByTestId('integrations-loading')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^integrations-card-/)).toHaveLength(0);
  });

  it('falls back to the defaults when the settings request fails, rather than loading forever', () => {
    settingsLoad = { isLoading: false, authedSettingsLoaded: false, error: 'Failed to fetch admin settings' };
    renderGallery();
    expect(screen.queryByTestId('integrations-loading')).toBeNull();
    expect(screen.getByTestId('integrations-row-google-drive')).toBeInTheDocument();
  });

  it('keeps the Models tab usable while settings load, since model providers carry no flags', async () => {
    settingsLoad = { isLoading: true, authedSettingsLoaded: false, error: null };
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-tab-models'));
    expect(screen.getByTestId('integrations-model-row-anthropic')).toBeInTheDocument();
    expect(screen.queryByTestId('integrations-loading')).toBeNull();
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

  it("disables an entry's request button while a toggle for it is in flight, and no other", async () => {
    pendingToggles = new Set(['hubspot']);
    renderGallery();
    expect(screen.getByTestId('integrations-request-btn-hubspot')).toBeDisabled();
    expect(screen.getByTestId('integrations-request-btn-gmail')).toBeEnabled();

    fireEvent.click(screen.getByTestId('integrations-request-btn-hubspot'));
    expect(h.toggleRequest).not.toHaveBeenCalled();
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
    await userEvent.click(screen.getByTestId('integrations-open-btn-github'));

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
    await userEvent.click(screen.getByTestId('integrations-open-btn-salesforce'));
    const drawer = await screen.findByTestId('integrations-drawer');
    expect(within(drawer).getByText('Be the first to ask for it.')).toBeInTheDocument();
    await userEvent.click(within(drawer).getByTestId('integrations-drawer-request-btn-salesforce'));
    expect(h.toggleRequest).toHaveBeenCalledWith({ integrationId: 'salesforce', requested: false });
  });

  it('links account integrations to their full settings', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-open-btn-google-drive'));
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
    await userEvent.click(screen.getByTestId('integrations-open-btn-notion'));
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

describe('IntegrationsGallery accessibility', () => {
  const nestedInteractive = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="button"], button, a[href]')].filter(el =>
      el.parentElement?.closest('[role="button"], button, a[href]')
    );

  it.each([
    ['rows', false],
    ['cards', true],
  ])('has no interactive element inside another, in %s', (_label, cards) => {
    compact = cards;
    renderGallery();
    expect(nestedInteractive(screen.getByTestId('integrations-page-body'))).toEqual([]);
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(0);
  });

  it.each([
    ['rows', false, 'integrations-row-github'],
    ['cards', true, 'integrations-card-github'],
  ])('opens a drawer from a real, named button on the name in %s, beside the action button', async (_l, cards, id) => {
    compact = cards;
    renderGallery();
    const container = screen.getByTestId(id);
    const opener = within(container).getByRole('button', { name: 'GitHub details' });
    expect(opener).toHaveTextContent('GitHub');
    expect(opener.tagName).toBe('BUTTON');
    expect(opener).toHaveAttribute('type', 'button');
    // The Connect action is a sibling control, not a descendant of the opener.
    expect(opener.contains(within(container).getByTestId('integrations-action-btn-github'))).toBe(false);

    opener.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('integrations-drawer')).toBeInTheDocument();
  });

  it('opens the drawer from the keyboard with Space as well', async () => {
    renderGallery();
    screen.getByTestId('integrations-open-btn-notion').focus();
    await userEvent.keyboard(' ');
    expect(await screen.findByTestId('integrations-drawer')).toBeInTheDocument();
  });

  it('keeps the action buttons above the opener overlay', () => {
    renderGallery();
    const action = screen.getByTestId('integrations-action-btn-github');
    expect(getComputedStyle(action.parentElement as HTMLElement).zIndex).toBe('1');
    expect(getComputedStyle(action.parentElement as HTMLElement).position).toBe('relative');
    expect(getComputedStyle(screen.getByTestId('integrations-row-github')).position).toBe('relative');
  });

  it('names the filter selects, whose visible text is only their value', async () => {
    renderGallery();
    expect(screen.getByRole('combobox', { name: 'Filter by category' })).toHaveTextContent('All categories');
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toHaveTextContent('All statuses');

    await userEvent.click(screen.getByTestId('integrations-tab-models'));
    expect(screen.getByRole('combobox', { name: 'Filter by model kind' })).toHaveTextContent('All kinds');
  });

  it('labels the drawer dialog by its heading', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-open-btn-github'));
    const dialog = await screen.findByRole('dialog', { name: 'GitHub' });
    expect(dialog).toContainElement(screen.getByTestId('integrations-drawer-title'));
  });
});

describe('IntegrationsGallery analytics', () => {
  const logged = (type: IntegrationsEvents) =>
    h.logEvent.mock.calls.map(([event]) => event).filter(event => event.type === type);

  it('records one page view per visit with its entry point, defaulting to direct', () => {
    const { rerender, unmount } = renderGallery({ source: 'profile_menu' });
    // The page strips ?source= right after; the new prop must not read as a second visit.
    rerender(
      <CssVarsProvider theme={appTheme}>
        <IntegrationsGallery source="direct" />
      </CssVarsProvider>
    );
    expect(logged(IntegrationsEvents.INTEGRATIONS_PAGE_VIEWED)).toEqual([
      { type: IntegrationsEvents.INTEGRATIONS_PAGE_VIEWED, metadata: { entryPoint: 'profile_menu' } },
    ]);
    unmount();

    h.logEvent.mockClear();
    renderGallery();
    expect(logged(IntegrationsEvents.INTEGRATIONS_PAGE_VIEWED)).toEqual([
      { type: IntegrationsEvents.INTEGRATIONS_PAGE_VIEWED, metadata: { entryPoint: 'direct' } },
    ]);
  });

  it('records a search once the query settles, normalized, with what it found', () => {
    vi.useFakeTimers();
    try {
      renderGallery();
      const input = screen.getByTestId('integrations-search-input');
      const typeQuery = (value: string) => fireEvent.change(input, { target: { value } });

      typeQuery('No');
      typeQuery('  NoSuch Thing ');
      act(() => vi.advanceTimersByTime(SEARCH_SETTLE_MS - 1));
      expect(logged(IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED)).toEqual([]);
      act(() => vi.advanceTimersByTime(1));
      expect(logged(IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED)).toEqual([
        {
          type: IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED,
          metadata: { query: 'nosuch thing', resultCount: 0, tab: 'integrations' },
        },
      ]);

      // The same query read differently is not a new search; whitespace alone is none at all.
      typeQuery('nosuch thing');
      act(() => vi.advanceTimersByTime(SEARCH_SETTLE_MS));
      typeQuery('   ');
      act(() => vi.advanceTimersByTime(SEARCH_SETTLE_MS));
      expect(logged(IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED)).toHaveLength(1);

      typeQuery('Notion');
      act(() => vi.advanceTimersByTime(SEARCH_SETTLE_MS));
      expect(logged(IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED)[1].metadata).toEqual({
        query: 'notion',
        resultCount: 1,
        tab: 'integrations',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never records the text of a query holding an @, only that a search settled and what it found', () => {
    vi.useFakeTimers();
    try {
      renderGallery();
      fireEvent.change(screen.getByTestId('integrations-search-input'), { target: { value: ' Ada@Example.com ' } });
      act(() => vi.advanceTimersByTime(SEARCH_SETTLE_MS));

      expect(logged(IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED)).toEqual([
        {
          type: IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED,
          metadata: { redacted: true, resultCount: 0, tab: 'integrations' },
        },
      ]);
      expect(JSON.stringify(h.logEvent.mock.calls)).not.toMatch(/ada@|example/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records each filter pick, but not the reset a tab switch performs', async () => {
    renderGallery();
    await pick('status', 'connected');
    await pick('category', 'crm');
    await userEvent.click(screen.getByTestId('integrations-tab-models'));
    await pick('kind', 'music');

    expect(logged(IntegrationsEvents.INTEGRATIONS_FILTER_CHANGED).map(event => event.metadata)).toEqual([
      { filter: 'status', value: 'connected' },
      { filter: 'category', value: 'crm' },
      { filter: 'kind', value: 'music' },
    ]);
  });

  it('records a drawer open and a connect click, from the row and from the drawer', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-action-btn-github'));
    expect(h.connect).toHaveBeenCalledWith('github');

    await userEvent.click(screen.getByTestId('integrations-open-btn-notion'));
    const drawer = await screen.findByTestId('integrations-drawer');
    await userEvent.click(within(drawer).getByTestId('integrations-drawer-connect-btn'));
    expect(h.connect).toHaveBeenCalledWith('notion');

    // The row's Connect button sits beside the opener, so it never also counts as opening the drawer.
    expect(logged(IntegrationsEvents.INTEGRATIONS_CARD_OPENED).map(event => event.metadata)).toEqual([
      { integrationId: 'notion' },
    ]);
    expect(logged(IntegrationsEvents.INTEGRATIONS_CONNECT_CLICKED).map(event => event.metadata)).toEqual([
      { integrationId: 'github' },
      { integrationId: 'notion' },
    ]);
  });

  it('records a request toggle with the state the click asked for', async () => {
    renderGallery();
    await userEvent.click(screen.getByTestId('integrations-request-btn-hubspot'));
    await userEvent.click(screen.getByTestId('integrations-request-btn-gmail'));

    expect(logged(IntegrationsEvents.INTEGRATIONS_REQUEST_TOGGLED).map(event => event.metadata)).toEqual([
      { integrationId: 'hubspot', requested: true },
      { integrationId: 'gmail', requested: false },
    ]);
  });
});
