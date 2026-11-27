import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

type BlockerOptions = { enableBeforeUnload: boolean };
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  useBlocker: vi.fn<(options: BlockerOptions) => { status: string }>(() => ({ status: 'idle' })),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, put: mocks.put, post: mocks.post } }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({
  default: ({ helpId }: { helpId: string }) => <button data-testid="context-help-btn" data-help-id={helpId} />,
}));
// Made-up ids, so the catalog's model-id union is widened through unknown.
const catalogModel = (over: { id: string; name: string; backend: ModelBackend; rank: number }) =>
  ({
    type: 'text',
    contextWindow: 200_000,
    max_tokens: 8192,
    pricing: {},
    supportsImageVariation: false,
    ...over,
  }) as unknown as ModelInfo;
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({
    data: [
      catalogModel({ id: 'model-a', name: 'Model A', backend: ModelBackend.Anthropic, rank: 1 }),
      catalogModel({ id: 'model-b', name: 'Model B', backend: ModelBackend.OpenAI, rank: 2 }),
    ],
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: mocks.useBlocker,
  useRouter: () => ({ state: { location: { pathname: '/admin', search: { tab: 'agent-ops' } } }, navigate: vi.fn() }),
}));

import AgentOpsTab from './AgentOpsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const SETTINGS = {
  id: 'settings-1',
  versions: [],
  currentVersionNumber: 2,
  generationLlmModel: 'model-a',
  rateLimitSeconds: 60,
  totalGenerationsCount: 1234,
  lastGenerationAt: null,
  isEnabled: true,
};
const VERSIONS = [
  {
    versionNumber: 2,
    metaPrompt: 'Second',
    description: 'Tighter persona prompt',
    createdBy: 'admin-1',
    createdAt: '2026-10-02T10:00:00.000Z',
    isActive: true,
  },
  {
    versionNumber: 1,
    metaPrompt: 'First',
    description: '',
    createdBy: 'admin-1',
    createdAt: '2026-09-01T10:00:00.000Z',
    isActive: false,
  },
];

let settingsResponse: unknown = SETTINGS;
let versionsResponse: unknown = VERSIONS;

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AgentOpsTab />
    </CssVarsProvider>
  );

const settingsLoads = () => mocks.get.mock.calls.filter(([url]) => url === '/api/admin/agent-ops-settings').length;

describe('AgentOpsTab', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockClear());
    settingsResponse = SETTINGS;
    versionsResponse = VERSIONS;
    mocks.get.mockReset().mockImplementation(async (url: string) => ({
      data: url === '/api/admin/agent-ops-settings' ? settingsResponse : versionsResponse,
    }));
    mocks.put.mockReset().mockResolvedValue({ data: {} });
    mocks.post.mockReset().mockResolvedValue({ data: { success: true, repairsMade: ['pointer fixed'] } });
  });

  it('opens with the page header: a sentence-case h1 with no icon, help and the page actions', async () => {
    renderTab();

    const header = screen.getByTestId('admin-page-header');
    expect(screen.getByTestId('agent-ops-tab').firstElementChild).toBe(header);
    const title = within(header).getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent(/^Agents$/);
    expect(title.querySelector('svg')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByTestId('context-help-btn')).toHaveAttribute('data-help-id', 'admin/agent-operations');
    expect(within(header).getByTestId('agent-ops-repair-btn')).toHaveTextContent('Repair database');
    expect(within(header).getByTestId('agent-ops-create-version-btn')).toHaveTextContent('Create version');
    await screen.findByTestId('agent-ops-version-row-2');
  });

  it('shows the generation status in one stat strip, with the service as a status chip', async () => {
    renderTab();

    const service = await screen.findByTestId('agent-ops-service-status');
    expect(service).toHaveTextContent('Enabled');
    expect(service).toHaveAttribute('data-tone', 'good');
    const strip = screen.getByTestId('admin-stat-strip');
    expect(strip).toHaveTextContent('Active meta-promptVersion 2');
    expect(strip).toHaveTextContent('Total generations1,234');
    expect(strip).toHaveTextContent('Rate limit60s');
    expect(strip).toHaveTextContent('ModelModel A');
    expect(screen.getByTestId('agent-ops-tab').querySelectorAll('.MuiCard-root')).toHaveLength(0);
  });

  it('marks a disabled service as bad', async () => {
    settingsResponse = { ...SETTINGS, isEnabled: false };
    renderTab();

    const service = await screen.findByTestId('agent-ops-service-status');
    expect(service).toHaveTextContent('Disabled');
    expect(service).toHaveAttribute('data-tone', 'bad');
  });

  it('lists versions in a DataTable that scrolls below its min width, Active good and Inactive neutral', async () => {
    renderTab();
    await screen.findByTestId('agent-ops-version-row-2');

    expect(screen.getByTestId('agent-ops-versions-table')).toHaveStyle({ minWidth: '44rem' });
    expect(screen.getByTestId('agent-ops-version-status-2')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('agent-ops-version-status-1')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('agent-ops-version-row-1')).toHaveTextContent('No description');
    expect(screen.queryByTestId('agent-ops-version-actions-2')).toBeNull();
  });

  it('activates an inactive version from its row menu with the same request', async () => {
    renderTab();
    await screen.findByTestId('agent-ops-version-row-1');

    fireEvent.click(screen.getByTestId('agent-ops-version-actions-1'));
    fireEvent.click(await screen.findByTestId('agent-ops-activate-1'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/agent-ops-settings/versions/1/activate');
    await waitFor(() => expect(settingsLoads()).toBe(2));
  });

  it('creates a version in a dialog and posts the description and content', async () => {
    renderTab();
    await screen.findByTestId('agent-ops-version-row-2');

    fireEvent.click(screen.getByTestId('agent-ops-create-version-btn'));
    const dialog = await screen.findByTestId('agent-ops-create-version-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Create meta-prompt version');
    expect(within(dialog).getByTestId('agent-ops-create-version-confirm-btn')).toBeDisabled();

    fireEvent.change(within(dialog).getByTestId('agent-ops-version-description-input'), {
      target: { value: 'Shorter prompts' },
    });
    fireEvent.change(within(dialog).getByTestId('agent-ops-version-content-input'), {
      target: { value: 'You are the PromptCrafter.' },
    });
    fireEvent.click(within(dialog).getByTestId('agent-ops-create-version-confirm-btn'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/agent-ops-settings', {
      metaPrompt: 'You are the PromptCrafter.',
      description: 'Shorter prompts',
    });
    await waitFor(() => expect(screen.queryByTestId('agent-ops-create-version-dialog')).toBeNull());
  });

  it('stages the generation settings for the page SaveBar and saves them with the same PUT', async () => {
    renderTab();
    const rateLimit = await screen.findByTestId('agent-ops-rate-limit-input');

    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    fireEvent.change(rateLimit, { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('agent-ops-enabled-checkbox'));

    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.useBlocker.mock.lastCall?.[0].enableBeforeUnload).toBe(true);

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(mocks.put).toHaveBeenCalledWith('/api/admin/agent-ops-settings', {
      generationLlmModel: 'model-a',
      rateLimitSeconds: 120,
      isEnabled: false,
    });
    expect(mocks.success).toHaveBeenCalledWith('Settings saved successfully');
    await waitFor(() => expect(settingsLoads()).toBe(2));
  });

  it('clears the SaveBar once the save lands and shows the saved values as the new baseline', async () => {
    mocks.put.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
      settingsResponse = { ...SETTINGS, ...body };
      return { data: {} };
    });
    renderTab();
    fireEvent.change(await screen.findByTestId('agent-ops-rate-limit-input'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() => expect(settingsLoads()).toBe(2));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(screen.getByTestId('agent-ops-rate-limit-input')).toHaveValue(120);
    expect(screen.getByTestId('admin-stat-strip')).toHaveTextContent('Rate limit120s');
    expect(mocks.useBlocker.mock.lastCall?.[0].enableBeforeUnload).toBe(false);
  });

  it.each([1, 3600])('saves and displays the valid rate limit boundary %s', async rateLimitSeconds => {
    mocks.put.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
      settingsResponse = { ...SETTINGS, ...body };
      return { data: {} };
    });
    renderTab();
    fireEvent.change(await screen.findByTestId('agent-ops-rate-limit-input'), {
      target: { value: String(rateLimitSeconds) },
    });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mocks.put).toHaveBeenCalledWith('/api/admin/agent-ops-settings', {
      generationLlmModel: 'model-a',
      rateLimitSeconds,
      isEnabled: true,
    });
    expect(screen.getByTestId('agent-ops-rate-limit-input')).toHaveValue(rateLimitSeconds);
    expect(screen.getByTestId('admin-stat-strip')).toHaveTextContent(`Rate limit${rateLimitSeconds}s`);
  });

  it.each(['', '0', '-1', '1.5', '3601'])('blocks an invalid rate limit %j without writing', async rateLimitSeconds => {
    renderTab();
    fireEvent.change(await screen.findByTestId('agent-ops-rate-limit-input'), { target: { value: rateLimitSeconds } });
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent(
      'Rate limit must be an integer between 1 and 3600 seconds'
    );
    expect(screen.getByTestId('admin-save-confirm-btn')).toBeDisabled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('keeps the staged settings and shows the failure in the SaveBar when the save fails', async () => {
    mocks.put.mockRejectedValueOnce(new Error('Invalid LLM model specified'));
    renderTab();
    fireEvent.change(await screen.findByTestId('agent-ops-rate-limit-input'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() => expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('Invalid LLM model specified'));
    expect(screen.getByTestId('agent-ops-rate-limit-input')).toHaveValue(90);
  });

  it('shows an EmptyState whose action opens the create dialog when there are no versions', async () => {
    versionsResponse = [];
    renderTab();

    const empty = await screen.findByTestId('agent-ops-versions-empty');
    expect(within(empty).getByTestId('admin-empty-state')).toHaveTextContent('No meta-prompt versions');
    fireEvent.click(within(empty).getByTestId('agent-ops-empty-create-btn'));
    expect(await screen.findByTestId('agent-ops-create-version-dialog')).toBeInTheDocument();
  });

  it('shows a LoadingState under the header on the first load', () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderTab();

    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    expect(screen.getByTestId('agent-ops-loading')).toHaveTextContent('Loading agent settings');
  });

  it('shows skeleton rows in the versions table, not its empty state, until the versions answer', async () => {
    mocks.get.mockImplementation((url: string) =>
      url === '/api/admin/agent-ops-settings' ? Promise.resolve({ data: SETTINGS }) : new Promise(() => {})
    );
    renderTab();

    await screen.findByTestId('agent-ops-service-status');
    const table = screen.getByTestId('agent-ops-versions-table-frame');
    expect(within(table).getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('agent-ops-versions-empty')).toBeNull();
  });

  it('shows an ErrorState with Try again when the settings fail to load', async () => {
    mocks.get.mockRejectedValueOnce(new Error('network down'));
    renderTab();

    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Agent settings could not be loaded.');
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('agent-ops-version-row-2')).toBeInTheDocument();
  });

  it('runs the database repair from the header with the same request', async () => {
    renderTab();
    await screen.findByTestId('agent-ops-version-row-2');

    fireEvent.click(screen.getByTestId('agent-ops-repair-btn'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/agent-ops-settings/repair'));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Database repaired! pointer fixed'));
  });

  it('discards the staged settings back to the loaded values without a request', async () => {
    renderTab();
    fireEvent.change(await screen.findByTestId('agent-ops-rate-limit-input'), { target: { value: '300' } });
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));

    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(screen.getByTestId('agent-ops-rate-limit-input')).toHaveValue(60);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('keeps an unsaved settings edit through a repair and an activation', async () => {
    renderTab();
    fireEvent.change(await screen.findByTestId('agent-ops-rate-limit-input'), { target: { value: '120' } });

    fireEvent.click(screen.getByTestId('agent-ops-repair-btn'));
    await waitFor(() => expect(settingsLoads()).toBe(2));
    fireEvent.click(screen.getByTestId('agent-ops-version-actions-1'));
    fireEvent.click(await screen.findByTestId('agent-ops-activate-1'));
    await waitFor(() => expect(settingsLoads()).toBe(3));

    expect(screen.getByTestId('agent-ops-rate-limit-input')).toHaveValue(120);
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('shows the saved values, not the old ones, when the reload after a save fails', async () => {
    renderTab();
    fireEvent.change(await screen.findByTestId('agent-ops-rate-limit-input'), { target: { value: '120' } });
    mocks.get.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await screen.findByTestId('agent-ops-refresh-error');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(screen.getByTestId('agent-ops-rate-limit-input')).toHaveValue(120);
    expect(screen.getByTestId('admin-stat-strip')).toHaveTextContent('Rate limit120s');
  });

  it('shows only the banner, not a versions error, when a settings reload fails', async () => {
    versionsResponse = [];
    renderTab();
    await screen.findByTestId('agent-ops-versions-empty');
    mocks.get.mockRejectedValueOnce(new Error('network down'));

    fireEvent.click(screen.getByTestId('agent-ops-repair-btn'));

    await screen.findByTestId('agent-ops-refresh-error');
    expect(screen.queryByTestId('admin-error-state')).toBeNull();
    expect(screen.getByTestId('agent-ops-versions-empty')).toBeInTheDocument();
  });
});
