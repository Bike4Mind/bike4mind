import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { SecopsTriageConfigSchema } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';

const mocks = vi.hoisted(() => ({
  router: {
    state: { location: { pathname: '/admin', search: { tab: 'sec-ops-triage' } } },
    navigate: vi.fn(),
  },
  useBlocker: vi.fn((_options: { shouldBlockFn: (location: object) => boolean; enableBeforeUnload: boolean }) => ({
    status: 'idle',
  })),
  // One stable object per test: the tab re-parses the config whenever this reference changes.
  rawConfig: {} as Record<string, unknown>,
  settingsQuery: {
    data: [] as unknown[] | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  update: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => mocks.router,
  useBlocker: mocks.useBlocker,
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => mocks.rawConfig,
  useSettingsFromServer: () => mocks.settingsQuery,
  useUpdateSettings: () => mocks.update,
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'model-fast', name: 'Fast model', type: 'text' }] }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { workspaces: [] } }) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import SecopsTriageTab, { countChangedFields } from './SecopsTriageTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <SecopsTriageTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const SECTIONS = [
  ['secops-triage-section-master', 'Master controls'],
  ['secops-triage-section-github', 'GitHub settings'],
  ['secops-triage-section-slack', 'Slack notifications'],
  ['secops-triage-section-llm', 'LLM enrichment'],
] as const;

const toggle = (testId: string) => fireEvent.click(within(screen.getByTestId(testId)).getByRole('switch'));

describe('SecopsTriageTab', () => {
  beforeEach(() => {
    mocks.rawConfig = {};
    Object.assign(mocks.settingsQuery, { data: [], isLoading: false, isError: false, isFetching: false });
    mocks.settingsQuery.refetch.mockReset();
    mocks.update.mutateAsync.mockReset().mockResolvedValue({});
    mocks.update.isPending = false;
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    mocks.router.navigate.mockReset();
    mocks.useBlocker.mockClear();
    useAdminModal.setState(useAdminModal.getInitialState());
  });

  it('opens with the page header as its first element: sentence-case h1, one-line description, no icon', () => {
    renderTab();
    const tab = screen.getByTestId('admin-secops-triage-tab');
    const header = screen.getByTestId('admin-page-header');

    expect(tab.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^SecOps triage$/);
    expect(header).toHaveTextContent('Creates GitHub issues for critical and high security scan findings');
    expect(screen.queryByTestId('SecurityIcon')).not.toBeInTheDocument();
  });

  it('caps the settings page at the 1280 px detail width instead of 800 px', () => {
    renderTab();
    expect(screen.getByTestId('admin-secops-triage-tab')).toHaveStyle({ maxWidth: '1280px' });
  });

  it('renders each group as one settings card with a section title and no card inside it', () => {
    renderTab();
    const tab = screen.getByTestId('admin-secops-triage-tab');

    for (const [testId, title] of SECTIONS) {
      const section = screen.getByTestId(testId);
      expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent(title);
      // Nothing wraps a section: it sits in the form column, which sits directly in the page.
      expect(section.parentElement?.parentElement).toBe(tab);
    }
    // Joy's Card has no role or test id, so "no card inside a settings card" is checked by its class.
    expect(tab.querySelectorAll('.MuiCard-root')).toHaveLength(0);
  });

  it('shows the save bar only after an edit, counts each changed field and discards back to the stored values', () => {
    renderTab();
    expect(screen.queryByTestId('admin-save-bar')).not.toBeInTheDocument();

    toggle('secops-triage-enabled-switch');
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');

    fireEvent.change(within(screen.getByTestId('secops-triage-github-repo-input')).getByRole('textbox'), {
      target: { value: 'example-org/example-repo' },
    });
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('2 unsaved changes');

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(screen.queryByTestId('admin-save-bar')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('secops-triage-enabled-switch')).getByRole('switch')).not.toBeChecked();
  });

  it('discards back to the stored config, not to the defaults', () => {
    mocks.rawConfig = { dryRun: true, githubRepo: 'example-org/stored' };
    renderTab();
    const repo = () => within(screen.getByTestId('secops-triage-github-repo-input')).getByRole('textbox');

    toggle('secops-triage-enabled-switch');
    fireEvent.change(repo(), { target: { value: 'example-org/edited' } });
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('2 unsaved changes');

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(within(screen.getByTestId('secops-triage-dry-run-switch')).getByRole('switch')).toBeChecked();
    expect(within(screen.getByTestId('secops-triage-enabled-switch')).getByRole('switch')).not.toBeChecked();
    expect(repo()).toHaveValue('example-org/stored');
  });

  it('guards unsaved edits: another admin tab is blocked, and a sidebar switch goes through the router', () => {
    renderTab();
    const blocker = () => mocks.useBlocker.mock.lastCall![0];
    const admin = (search: object) => ({ pathname: '/admin', search });
    const toUsers = { current: admin({ tab: 'sec-ops-triage' }), next: admin({ tab: 'users' }) };
    expect(blocker().enableBeforeUnload).toBe(false);
    expect(blocker().shouldBlockFn(toUsers)).toBe(false);

    toggle('secops-triage-enabled-switch');
    expect(blocker().enableBeforeUnload).toBe(true);
    expect(blocker().shouldBlockFn(toUsers)).toBe(true);
    expect(
      blocker().shouldBlockFn({
        current: admin({ tab: 'sec-ops-triage' }),
        next: admin({ tab: 'sec-ops-triage', q: 'x' }),
      })
    ).toBe(false);

    useAdminModal.getState().setActiveTab(AdminTab.Users);
    expect(useAdminModal.getState().activeTab).not.toBe(AdminTab.Users);
    expect(mocks.router.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.router.navigate.mock.calls[0][0].search({ tab: 'sec-ops-triage' })).toMatchObject({ tab: 'users' });

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(useAdminModal.getState().tabChangeGuard).toBeNull();
  });

  it('saves the whole config under the same settings key from the save bar', async () => {
    renderTab();
    toggle('secops-triage-enabled-switch');
    toggle('secops-triage-dry-run-switch');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() =>
      expect(mocks.update.mutateAsync).toHaveBeenCalledWith({
        key: 'secopsTriageConfig',
        value: { ...SecopsTriageConfigSchema.parse({}), enabled: true, dryRun: true },
      })
    );
    expect(toast.success).toHaveBeenCalledWith('SecOps Triage configuration saved');
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).not.toBeInTheDocument());
  });

  it('keeps the draft and the save bar when saving fails', async () => {
    mocks.update.mutateAsync.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    toggle('secops-triage-enabled-switch');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save: boom'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(within(screen.getByTestId('secops-triage-enabled-switch')).getByRole('switch')).toBeChecked();
  });

  it('locks Save and Discard while a save is in flight', () => {
    mocks.update.isPending = true;
    renderTab();
    toggle('secops-triage-enabled-switch');

    const save = screen.getByTestId('admin-save-confirm-btn');
    expect(save).toBeDisabled();
    expect(within(save).getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByTestId('admin-save-discard-btn')).toBeDisabled();
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
  });

  it('still refuses to save LLM enrichment without a model', () => {
    renderTab();
    toggle('secops-triage-llm-enrichment-switch');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    expect(toast.error).toHaveBeenCalledWith('A model must be selected when LLM Enrichment is enabled.');
    expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
  });

  it('opens clean when the stored model is no longer offered, keeping it as an unavailable option', async () => {
    mocks.rawConfig = { llmEnrichment: true, modelId: 'model-gone' };
    renderTab();

    expect(screen.queryByTestId('admin-save-bar')).not.toBeInTheDocument();
    const select = screen.getByTestId('secops-triage-model-select');
    expect(select).toHaveTextContent('model-gone (not available)');
    fireEvent.click(within(select).getByRole('combobox'));
    expect(await screen.findByTestId('secops-triage-model-unavailable')).toHaveTextContent(
      'model-gone (not available)'
    );
    expect(screen.getByRole('option', { name: 'Fast model' })).toBeInTheDocument();
    expect(screen.queryByTestId('admin-save-bar')).not.toBeInTheDocument();
  });

  it('opens clean when the stored Slack workspace is no longer listed', async () => {
    mocks.rawConfig = { slackWorkspaceId: 'ws-gone' };
    renderTab();

    await waitFor(() =>
      expect(screen.getByTestId('secops-triage-slack-workspace-select')).toHaveTextContent('ws-gone (not available)')
    );
    expect(screen.queryByTestId('admin-save-bar')).not.toBeInTheDocument();
  });

  it('marks dry run with a warn chip and LLM enrichment with a good chip while they are on', () => {
    mocks.rawConfig = { dryRun: true, llmEnrichment: true, modelId: 'model-fast' };
    renderTab();

    expect(screen.getByTestId('secops-triage-dry-run-chip')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId('secops-triage-llm-enrichment-chip')).toHaveAttribute('data-tone', 'good');
  });

  it('keeps the header and shows a loading state instead of editable defaults while settings load', () => {
    Object.assign(mocks.settingsQuery, { data: undefined, isLoading: true });
    renderTab();

    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    expect(screen.getByTestId('secops-triage-loading')).toHaveTextContent('Loading SecOps triage settings');
    expect(screen.queryByTestId('secops-triage-section-master')).not.toBeInTheDocument();
  });

  it('shows an error state with a retry instead of editable defaults when settings fail to load', () => {
    Object.assign(mocks.settingsQuery, { data: undefined, isError: true });
    renderTab();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('SecOps triage settings could not be loaded.');
    expect(screen.queryByTestId('secops-triage-section-master')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.settingsQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the form editable when a background refetch fails over loaded settings', () => {
    mocks.rawConfig = { githubRepo: 'example-org/stored' };
    Object.assign(mocks.settingsQuery, { data: [], isError: true });
    renderTab();

    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('secops-triage-github-repo-input')).getByRole('textbox')).toHaveValue(
      'example-org/stored'
    );
    toggle('secops-triage-enabled-switch');
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
  });
});

describe('countChangedFields', () => {
  const saved = SecopsTriageConfigSchema.parse({});

  it('counts the two priority selects as separate fields', () => {
    expect(countChangedFields(saved, saved)).toBe(0);
    expect(countChangedFields({ ...saved, severityToPriority: { critical: 'P1', high: 'P0' } }, saved)).toBe(2);
  });

  it('treats a cleared optional field the same as one that was never set', () => {
    expect(countChangedFields({ ...saved, slackChannelId: undefined }, saved)).toBe(0);
    expect(countChangedFields({ ...saved, slackChannelId: 'C123' }, saved)).toBe(1);
  });
});
