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
  status: null as Record<string, unknown> | null,
  statusError: null as Error | null,
  apiGet: vi.fn(),
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
  api: { get: mocks.apiGet },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import SecopsTriageTab, { countChangedFields, describeTriageRun } from './SecopsTriageTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <SecopsTriageTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const readyStatus = () => ({
  stage: 'test-stage',
  enabled: true,
  github: { connected: true, repo: 'test-org/test-repo', check: { ok: true } },
  recentRuns: [],
});

const SECTIONS = [
  ['secops-triage-section-master', 'Master controls'],
  ['secops-triage-section-github', 'GitHub settings'],
  ['secops-triage-section-slack', 'Slack notifications'],
  ['secops-triage-section-llm', 'LLM enrichment'],
] as const;

const toggle = (testId: string) => fireEvent.click(within(screen.getByTestId(testId)).getByRole('switch'));
const repoInput = () => within(screen.getByTestId('secops-triage-github-repo-input')).getByRole('textbox');

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
    mocks.status = readyStatus();
    mocks.statusError = null;
    mocks.apiGet.mockReset().mockImplementation(async (url: string) => {
      if (url !== '/api/admin/secops-triage/status') return { data: { workspaces: [] } };
      if (mocks.statusError) throw mocks.statusError;
      return { data: mocks.status };
    });
  });

  it('opens with the page header as its first element: sentence-case h1, one-line description, no icon', () => {
    renderTab();
    const tab = screen.getByTestId('admin-secops-triage-tab');
    const header = screen.getByTestId('admin-page-header');

    expect(tab.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^SecOps triage$/);
    expect(header).toHaveTextContent(
      'Files a GitHub issue for each critical or high finding reported by a security scan, and closes it when the finding is gone. A finding seen again reopens its issue, unless the issue was closed as not planned or as a duplicate.'
    );
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
    fireEvent.change(repoInput(), { target: { value: 'test-org/test-repo' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() =>
      expect(mocks.update.mutateAsync).toHaveBeenCalledWith({
        key: 'secopsTriageConfig',
        value: { ...SecopsTriageConfigSchema.parse({}), enabled: true, dryRun: true, githubRepo: 'test-org/test-repo' },
      })
    );
    expect(toast.success).toHaveBeenCalledWith('SecOps Triage configuration saved');
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).not.toBeInTheDocument());
  });

  it('keeps the draft and the save bar when saving fails', async () => {
    mocks.update.mutateAsync.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    toggle('secops-triage-dry-run-switch');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save: boom'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(within(screen.getByTestId('secops-triage-dry-run-switch')).getByRole('switch')).toBeChecked();
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

    expect(toast.error).toHaveBeenCalledWith('A model must be selected when LLM enrichment is enabled');
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

  it('describes dry run and the repository without naming a real repository', () => {
    renderTab();

    expect(screen.getByTestId('secops-triage-section-master')).toHaveTextContent(
      'Logs each action without creating, commenting on, reopening or closing GitHub issues. The Slack summary is still posted, marked as a dry run.'
    );
    expect(repoInput()).toHaveAttribute('placeholder', 'owner/repo');
    expect(screen.getByTestId('secops-triage-section-github')).toHaveTextContent(
      'GitHub repository where issues are filed, in owner/repo form.'
    );
  });

  describe('saving', () => {
    it.each([
      ['empty', ''],
      ['malformed', 'not a repo'],
    ])('refuses to save triage enabled with an %s repository', (_label, repo) => {
      renderTab();
      toggle('secops-triage-enabled-switch');
      fireEvent.change(repoInput(), { target: { value: repo } });
      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

      expect(toast.error).toHaveBeenCalledWith(
        'A repository in owner/name form is required when SecOps triage is enabled'
      );
      expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
    });

    it('saves a disabled config without a repository', async () => {
      renderTab();
      toggle('secops-triage-dry-run-switch');
      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

      await waitFor(() => expect(mocks.update.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mocks.update.mutateAsync.mock.calls[0][0].value).toMatchObject({ enabled: false, githubRepo: '' });
    });

    it.each(['', '0', '101'])('refuses to save %j max issues per scan with a readable message', value => {
      renderTab();
      fireEvent.change(within(screen.getByTestId('secops-triage-max-issues-input')).getByRole('spinbutton'), {
        target: { value },
      });
      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

      expect(toast.error).toHaveBeenCalledWith('Max issues per scan must be between 1 and 100');
      expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
    });

    it('refreshes the status after a save', async () => {
      renderTab();
      await screen.findByTestId('secops-triage-status-connection-chip');
      const statusCalls = () =>
        mocks.apiGet.mock.calls.filter(([url]) => url === '/api/admin/secops-triage/status').length;
      expect(statusCalls()).toBe(1);

      toggle('secops-triage-dry-run-switch');
      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

      await waitFor(() => expect(statusCalls()).toBe(2));
    });
  });

  describe('status section', () => {
    const status = () => screen.getByTestId('secops-triage-section-status');
    const run = (overrides: Record<string, unknown>) => ({
      scanSource: 'web-owasp',
      status: 'completed',
      dryRun: false,
      findingCount: 1,
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      ...overrides,
    });

    it('comes first in the form, above the master controls, and says it reflects the saved settings', async () => {
      renderTab();

      expect(status().nextElementSibling).toBe(screen.getByTestId('secops-triage-section-master'));
      expect(within(status()).getByRole('heading')).toHaveTextContent('Status');
      expect(status()).toHaveTextContent('Checks the saved settings, not unsaved edits.');
      await screen.findByTestId('secops-triage-status-connection-chip');
    });

    it('shows a loading state inside the section while the form is already usable', () => {
      mocks.apiGet.mockImplementation(async (url: string) =>
        url === '/api/admin/secops-triage/status' ? new Promise(() => {}) : { data: { workspaces: [] } }
      );
      renderTab();

      expect(within(status()).getByTestId('secops-triage-status-loading')).toHaveTextContent('Loading status');
      toggle('secops-triage-enabled-switch');
      expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    });

    it('shows a connected, ready repository and no runs yet', async () => {
      renderTab();

      expect(await screen.findByTestId('secops-triage-status-connection-chip')).toHaveTextContent('Connected');
      expect(screen.getByTestId('secops-triage-status-connection-chip')).toHaveAttribute('data-tone', 'good');
      expect(screen.getByTestId('secops-triage-status-repo-chip')).toHaveTextContent('Ready');
      expect(screen.getByTestId('secops-triage-status-repo')).toHaveTextContent('test-org/test-repo');
      expect(screen.getByTestId('secops-triage-status-last-run')).toHaveTextContent('No runs recorded yet');
    });

    it('shows no connection', async () => {
      mocks.status = { ...readyStatus(), github: { connected: false, repo: 'test-org/test-repo', check: null } };
      renderTab();

      expect(await screen.findByTestId('secops-triage-status-connection-chip')).toHaveTextContent('Not connected');
      expect(screen.getByTestId('secops-triage-status-repo-chip')).toHaveTextContent('Could not be checked');
    });

    it.each([
      ['not_configured', 'Not set', 'neutral'],
      ['not_allowed', "Not in the connection's allowed repositories", 'bad'],
      ['not_found', 'Not found', 'bad'],
      ['public', 'Public (must be private)', 'bad'],
      ['archived', 'Archived (read-only)', 'bad'],
      ['issues_disabled', 'Issues disabled', 'bad'],
    ])('labels a %s repository', async (reason, label, tone) => {
      mocks.status = {
        ...readyStatus(),
        github: { connected: true, repo: 'test-org/test-repo', check: { ok: false, reason } },
      };
      renderTab();

      const chip = await screen.findByTestId('secops-triage-status-repo-chip');
      expect(chip).toHaveTextContent(label);
      expect(chip).toHaveAttribute('data-tone', tone);
    });

    it('says the repository could not be checked when the lookup failed', async () => {
      mocks.status = {
        ...readyStatus(),
        github: { connected: true, repo: 'test-org/test-repo', check: null, checkError: true },
      };
      renderTab();

      expect(await screen.findByTestId('secops-triage-status-repo-chip')).toHaveTextContent('Could not be checked');
    });

    it('shows the last run with its source and outcome, and up to five earlier runs beneath it', async () => {
      mocks.status = {
        ...readyStatus(),
        recentRuns: [
          run({
            counts: { created: 0, updated: 0, reopened: 0, closed: 0, suppressed: 0, belowThreshold: 1, overCap: 0 },
          }),
          ...Array.from({ length: 7 }, () => run({ scanSource: 'secrets', status: 'skipped', reason: 'disabled' })),
        ],
      };
      renderTab();

      const lastRun = await screen.findByTestId('secops-triage-status-last-run');
      expect(lastRun).toHaveTextContent('Website scan');
      expect(lastRun).toHaveTextContent('1 finding, 1 below threshold, 0 created');
      expect(within(lastRun).getByText('5 minutes ago')).toBeInTheDocument();
      const earlier = screen.getByTestId('secops-triage-status-earlier-runs');
      expect(within(earlier).getAllByRole('listitem')).toHaveLength(5);
      expect(earlier).toHaveTextContent('Secrets scan');
      expect(earlier).toHaveTextContent('Skipped: triage is disabled');
    });

    it('keeps the form usable and offers a retry when the status request fails', async () => {
      mocks.statusError = new Error('boom');
      renderTab();

      const error = await within(status()).findByTestId('admin-error-state');
      expect(error).toHaveTextContent('Status could not be loaded.');
      expect(screen.getByTestId('secops-triage-section-master')).toBeInTheDocument();
      toggle('secops-triage-dry-run-switch');
      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
      await waitFor(() => expect(mocks.update.mutateAsync).toHaveBeenCalledTimes(1));

      mocks.statusError = null;
      fireEvent.click(within(status()).getByTestId('admin-error-retry-btn'));
      expect(await screen.findByTestId('secops-triage-status-connection-chip')).toHaveTextContent('Connected');
    });
  });
});

describe('describeTriageRun', () => {
  const base = {
    scanSource: 'web-owasp',
    dryRun: false,
    findingCount: 1,
    startedAt: '2026-11-17T10:00:00.000Z',
  };
  const counts = { created: 0, updated: 0, reopened: 0, closed: 0, suppressed: 0, belowThreshold: 0, overCap: 0 };

  it('summarises a completed run, adding only the non-zero extra counts', () => {
    expect(describeTriageRun({ ...base, status: 'completed', counts: { ...counts, belowThreshold: 1 } })).toBe(
      '1 finding, 1 below threshold, 0 created'
    );
    expect(
      describeTriageRun({
        ...base,
        status: 'completed',
        findingCount: 6,
        counts: { ...counts, created: 1, updated: 1, reopened: 1, closed: 1, suppressed: 1, overCap: 1 },
      })
    ).toBe(
      '6 findings, 0 below threshold, 1 created, 1 updated, 1 reopened, 1 closed, 1 left closed, 1 over the per-scan cap'
    );
    expect(describeTriageRun({ ...base, status: 'completed', dryRun: true, counts })).toBe(
      'Dry run: 1 finding, 0 below threshold, 0 created'
    );
  });

  it.each([
    ['disabled', 'Skipped: triage is disabled'],
    ['invalid_config', 'Skipped: the saved configuration is invalid'],
    ['no_github_connection', 'Skipped: there is no GitHub connection'],
    ['not_allowed', "Skipped: the repository is not in the connection's allowed repositories"],
    ['archived', 'Skipped: the repository is archived'],
    ['public', 'Skipped: the repository is public'],
  ])('explains a run skipped for %s', (reason, text) => {
    expect(describeTriageRun({ ...base, status: 'skipped', reason })).toBe(text);
  });

  it('shows the error of a failed run', () => {
    expect(describeTriageRun({ ...base, status: 'failed', error: 'rate limited' })).toBe('Failed: rate limited');
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
