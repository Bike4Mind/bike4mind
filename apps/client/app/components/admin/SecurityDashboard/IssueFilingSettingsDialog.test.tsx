import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { SecopsTriageConfigSchema } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from '../adminSidebarConfig';
import { useAdminModal } from '../useAdminModal';

const mocks = vi.hoisted(() => ({
  router: {
    state: { location: { pathname: '/admin', search: { tab: 'security-dashboard' } } },
    navigate: vi.fn(),
  },
  useBlocker: vi.fn((_options: { shouldBlockFn: (location: object) => boolean; enableBeforeUnload: boolean }) => ({
    status: 'idle',
  })),
  // One stable object per test: the dialog re-parses the config whenever this reference changes.
  rawConfig: {} as Record<string, unknown>,
  settingsQuery: {
    data: [] as unknown[] | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  update: { mutateAsync: vi.fn(), isPending: false },
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

import { countChangedFields, IssueFilingSettingsDialog } from './IssueFilingSettingsDialog';

const TEST_ID = 'security-issue-filing-settings';
const appTheme = extendTheme({ ...getThemeConfig() });

const renderDialog = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <IssueFilingSettingsDialog onClose={onClose} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { onClose, invalidate };
};

const toggle = (suffix: string) =>
  fireEvent.click(within(screen.getByTestId(`${TEST_ID}-${suffix}`)).getByRole('switch'));
const repoInput = () => within(screen.getByTestId(`${TEST_ID}-github-repo-input`)).getByRole('textbox');
const changes = () => screen.getByTestId(`${TEST_ID}-changes`);
const save = () => fireEvent.click(screen.getByTestId(`${TEST_ID}-save-btn`));

describe('IssueFilingSettingsDialog', () => {
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
    mocks.apiGet.mockReset().mockResolvedValue({ data: { workspaces: [] } });
  });

  it('opens as a dialog titled Issue filing settings with the four setting groups', () => {
    renderDialog();

    const dialog = screen.getByTestId(TEST_ID);
    expect(within(dialog).getByText('Issue filing settings')).toBeInTheDocument();
    for (const [suffix, title] of [
      ['section-master', 'Master controls'],
      ['section-github', 'GitHub settings'],
      ['section-slack', 'Slack notifications'],
      ['section-llm', 'LLM enrichment'],
    ] as const) {
      expect(within(screen.getByTestId(`${TEST_ID}-${suffix}`)).getByRole('heading', { level: 3 })).toHaveTextContent(
        title
      );
    }
  });

  it('describes dry run and the repository without naming a real repository', () => {
    renderDialog();

    expect(screen.getByTestId(`${TEST_ID}-section-master`)).toHaveTextContent(
      'Logs each action without creating, commenting on, reopening or closing GitHub issues. The Slack summary is still posted, marked as a dry run.'
    );
    expect(repoInput()).toHaveAttribute('placeholder', 'owner/repo');
    expect(screen.getByTestId(`${TEST_ID}-section-github`)).toHaveTextContent(
      'GitHub repository where issues are filed, in owner/repo form.'
    );
  });

  it('counts each changed field and only enables Save once something changed', () => {
    renderDialog();
    expect(changes()).toHaveTextContent('No unsaved changes');
    expect(screen.getByTestId(`${TEST_ID}-save-btn`)).toBeDisabled();

    toggle('enabled-switch');
    expect(changes()).toHaveTextContent('1 unsaved change');
    fireEvent.change(repoInput(), { target: { value: 'acme/tracker' } });
    expect(changes()).toHaveTextContent('2 unsaved changes');
    expect(screen.getByTestId(`${TEST_ID}-save-btn`)).not.toBeDisabled();
  });

  it('closes straight away from Cancel when nothing changed', () => {
    const { onClose } = renderDialog();

    fireEvent.click(screen.getByTestId(`${TEST_ID}-cancel-btn`));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(`${TEST_ID}-discard-dialog`)).not.toBeInTheDocument();
  });

  it('asks before discarding edits, and keeps them on Keep editing', () => {
    mocks.rawConfig = { dryRun: true, githubRepo: 'acme/stored' };
    const { onClose } = renderDialog();
    fireEvent.change(repoInput(), { target: { value: 'acme/edited' } });

    fireEvent.click(screen.getByTestId(`${TEST_ID}-cancel-btn`));
    expect(screen.getByTestId(`${TEST_ID}-discard-dialog`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`${TEST_ID}-keep-editing-btn`));
    expect(onClose).not.toHaveBeenCalled();
    expect(repoInput()).toHaveValue('acme/edited');

    fireEvent.click(screen.getByTestId(`${TEST_ID}-close-btn`));
    fireEvent.click(screen.getByTestId(`${TEST_ID}-discard-btn`));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
  });

  it('guards unsaved edits: another admin tab is blocked, and a sidebar switch goes through the router', () => {
    renderDialog();
    const blocker = () => mocks.useBlocker.mock.lastCall![0];
    const admin = (search: object) => ({ pathname: '/admin', search });
    const toUsers = { current: admin({ tab: 'security-dashboard' }), next: admin({ tab: 'users' }) };
    expect(blocker().enableBeforeUnload).toBe(false);
    expect(blocker().shouldBlockFn(toUsers)).toBe(false);

    toggle('enabled-switch');
    expect(blocker().enableBeforeUnload).toBe(true);
    expect(blocker().shouldBlockFn(toUsers)).toBe(true);

    useAdminModal.getState().setActiveTab(AdminTab.Users);
    expect(useAdminModal.getState().activeTab).not.toBe(AdminTab.Users);
    expect(mocks.router.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.router.navigate.mock.calls[0][0].search({ tab: 'security-dashboard' })).toMatchObject({
      tab: 'users',
    });
  });

  it('saves the whole config under the same settings key, refreshes the status and closes', async () => {
    const { onClose, invalidate } = renderDialog();
    toggle('enabled-switch');
    toggle('dry-run-switch');
    fireEvent.change(repoInput(), { target: { value: 'acme/tracker' } });
    save();

    await waitFor(() =>
      expect(mocks.update.mutateAsync).toHaveBeenCalledWith({
        key: 'secopsTriageConfig',
        value: { ...SecopsTriageConfigSchema.parse({}), enabled: true, dryRun: true, githubRepo: 'acme/tracker' },
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Issue filing settings saved');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'secops-triage', 'status'] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves with Cmd+S from inside the form', async () => {
    renderDialog();
    toggle('dry-run-switch');
    fireEvent.keyDown(repoInput(), { key: 's', metaKey: true });

    await waitFor(() => expect(mocks.update.mutateAsync).toHaveBeenCalledTimes(1));
  });

  it('keeps the draft and stays open when saving fails', async () => {
    mocks.update.mutateAsync.mockRejectedValueOnce(new Error('boom'));
    const { onClose } = renderDialog();
    toggle('dry-run-switch');
    save();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save: boom'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(changes()).toHaveTextContent('1 unsaved change');
    expect(within(screen.getByTestId(`${TEST_ID}-dry-run-switch`)).getByRole('switch')).toBeChecked();
  });

  it('locks Save, Cancel and close while a save is in flight', () => {
    mocks.update.isPending = true;
    const { onClose } = renderDialog();
    toggle('enabled-switch');

    const saveButton = screen.getByTestId(`${TEST_ID}-save-btn`);
    expect(saveButton).toBeDisabled();
    expect(within(saveButton).getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByTestId(`${TEST_ID}-cancel-btn`)).toBeDisabled();
    expect(screen.getByTestId(`${TEST_ID}-close-btn`)).toBeDisabled();
    fireEvent.keyDown(repoInput(), { key: 's', metaKey: true });
    expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses to save LLM enrichment without a model', () => {
    renderDialog();
    toggle('llm-enrichment-switch');
    save();

    expect(toast.error).toHaveBeenCalledWith('A model must be selected when LLM enrichment is enabled');
    expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
  });

  it('opens clean when the stored model is no longer offered, keeping it as an unavailable option', async () => {
    mocks.rawConfig = { llmEnrichment: true, modelId: 'model-gone' };
    renderDialog();

    expect(changes()).toHaveTextContent('No unsaved changes');
    const select = screen.getByTestId(`${TEST_ID}-model-select`);
    expect(select).toHaveTextContent('model-gone (not available)');
    fireEvent.click(within(select).getByRole('combobox'));
    expect(await screen.findByTestId(`${TEST_ID}-model-unavailable`)).toHaveTextContent('model-gone (not available)');
    expect(screen.getByRole('option', { name: 'Fast model' })).toBeInTheDocument();
    expect(changes()).toHaveTextContent('No unsaved changes');
  });

  it('opens clean when the stored Slack workspace is no longer listed', async () => {
    mocks.rawConfig = { slackWorkspaceId: 'ws-gone' };
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId(`${TEST_ID}-slack-workspace-select`)).toHaveTextContent('ws-gone (not available)')
    );
    expect(changes()).toHaveTextContent('No unsaved changes');
  });

  it('marks dry run with a warn chip and LLM enrichment with a good chip while they are on', () => {
    mocks.rawConfig = { dryRun: true, llmEnrichment: true, modelId: 'model-fast' };
    renderDialog();

    expect(screen.getByTestId(`${TEST_ID}-dry-run-chip`)).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId(`${TEST_ID}-llm-enrichment-chip`)).toHaveAttribute('data-tone', 'good');
  });

  it('shows a loading state instead of editable defaults while settings load', () => {
    Object.assign(mocks.settingsQuery, { data: undefined, isLoading: true });
    renderDialog();

    expect(screen.getByTestId(`${TEST_ID}-loading`)).toHaveTextContent('Loading issue filing settings');
    expect(screen.queryByTestId(`${TEST_ID}-section-master`)).not.toBeInTheDocument();
  });

  it('shows an error state with a retry instead of editable defaults when settings fail to load', () => {
    Object.assign(mocks.settingsQuery, { data: undefined, isError: true });
    renderDialog();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Issue filing settings could not be loaded.');
    expect(screen.queryByTestId(`${TEST_ID}-section-master`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.settingsQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the form editable when a background refetch fails over loaded settings', () => {
    mocks.rawConfig = { githubRepo: 'acme/stored' };
    Object.assign(mocks.settingsQuery, { data: [], isError: true });
    renderDialog();

    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
    expect(repoInput()).toHaveValue('acme/stored');
    toggle('enabled-switch');
    expect(changes()).toHaveTextContent('1 unsaved change');
  });

  describe('saving', () => {
    it('opens a stored config that breaks a cross-field rule with its stored fields, and names the rule on save', () => {
      mocks.rawConfig = { enabled: true, githubRepo: 'not a repo', slackChannelId: 'C123', maxIssuesPerScan: 5 };
      renderDialog();

      expect(within(screen.getByTestId(`${TEST_ID}-enabled-switch`)).getByRole('switch')).toBeChecked();
      expect(repoInput()).toHaveValue('not a repo');
      expect(screen.getByDisplayValue('C123')).toBeInTheDocument();

      toggle('dry-run-switch');
      save();

      expect(toast.error).toHaveBeenCalledWith(
        'A repository in owner/name form is required when SecOps triage is enabled'
      );
      expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
    });

    it('falls back to the defaults when the stored value cannot be read field by field', () => {
      mocks.rawConfig = { enabled: 'yes', maxIssuesPerScan: 'many' };
      renderDialog();

      expect(within(screen.getByTestId(`${TEST_ID}-enabled-switch`)).getByRole('switch')).not.toBeChecked();
      expect(within(screen.getByTestId(`${TEST_ID}-max-issues-input`)).getByRole('spinbutton')).toHaveValue(20);
      expect(changes()).toHaveTextContent('No unsaved changes');
    });

    it('keeps the stored fields of an enabled config with no repository when the repository is fixed', async () => {
      mocks.rawConfig = { enabled: true, slackChannelId: 'C123', maxIssuesPerScan: 5, severityThreshold: 'critical' };
      renderDialog();

      fireEvent.change(repoInput(), { target: { value: 'acme/fixed' } });
      save();

      await waitFor(() => expect(mocks.update.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mocks.update.mutateAsync.mock.calls[0][0].value).toMatchObject({
        enabled: true,
        githubRepo: 'acme/fixed',
        slackChannelId: 'C123',
        maxIssuesPerScan: 5,
        severityThreshold: 'critical',
      });
    });

    it.each([
      ['empty', ''],
      ['malformed', 'not a repo'],
    ])('refuses to save filing enabled with an %s repository', (_label, repo) => {
      renderDialog();
      toggle('enabled-switch');
      fireEvent.change(repoInput(), { target: { value: repo } });
      save();

      expect(toast.error).toHaveBeenCalledWith(
        'A repository in owner/name form is required when SecOps triage is enabled'
      );
      expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
    });

    it('saves a disabled config without a repository', async () => {
      renderDialog();
      toggle('dry-run-switch');
      save();

      await waitFor(() => expect(mocks.update.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mocks.update.mutateAsync.mock.calls[0][0].value).toMatchObject({ enabled: false, githubRepo: '' });
    });

    it.each(['', '0', '101'])('refuses to save %j max issues per scan with a readable message', value => {
      renderDialog();
      fireEvent.change(within(screen.getByTestId(`${TEST_ID}-max-issues-input`)).getByRole('spinbutton'), {
        target: { value },
      });
      save();

      expect(toast.error).toHaveBeenCalledWith('Max issues per scan must be between 1 and 100');
      expect(mocks.update.mutateAsync).not.toHaveBeenCalled();
    });
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
