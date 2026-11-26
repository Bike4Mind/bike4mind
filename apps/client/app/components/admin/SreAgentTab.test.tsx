import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SreAgentConfigSchema, SreSourceType } from '@bike4mind/common';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import SreAgentTab, {
  AutoDispatchSourcesField,
  PatternLibraryPanel,
  PipelineTrackingCard,
  type TrackingDocSummary,
} from './SreAgentTab';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  useBlocker: vi.fn(() => ({ status: 'idle' })),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => mocks.settings[key],
  useUpdateSettings: () => ({ mutate: mocks.mutate, mutateAsync: mocks.mutateAsync, isPending: false }),
}));
// The configuration form stages into SettingsDraftProvider, whose leave-page guard reads the router.
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('./__tests__/fakeAdminRouter')).fakeRouterModule,
  useBlocker: mocks.useBlocker,
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });

function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper });
}

function renderTab() {
  return renderWithClient(<SreAgentTab />);
}

describe('SreAgentTab', () => {
  // The shell frames its direct child only; SRE keeps its nested panels flush with its header.
  it('keeps nested sub-tab content flush with the page header', () => {
    renderTab();

    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(panels).toHaveLength(3);
    for (const panel of panels) {
      expect(getComputedStyle(panel).paddingLeft).toBe('0px');
      expect(getComputedStyle(panel).paddingRight).toBe('0px');
    }
  });
});

describe('SreAgentTab configuration', () => {
  const stored = SreAgentConfigSchema.parse({
    repos: [
      { owner: 'acme', repo: 'widgets' },
      { owner: 'acme', repo: 'gadgets' },
    ],
  });

  beforeEach(() => {
    mocks.settings = { sreAgentConfig: stored };
    mocks.mutate.mockReset();
    mocks.mutateAsync.mockReset();
    mocks.mutateAsync.mockResolvedValue({});
    mocks.useBlocker.mockClear();
  });

  const openConfiguration = () => {
    renderTab();
    fireEvent.click(screen.getByTestId('sre-tab-configuration'));
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    fireEvent.click(screen.getByTestId('sre-repo-remove-0'));
  };

  it('stages an edit for the shared SaveBar and saves the whole config in one update', async () => {
    openConfiguration();

    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(screen.queryByTestId('sre-config-save-btn')).toBeNull();
    expect(screen.queryByTestId('sre-unsaved-changes-chip')).toBeNull();
    expect(mocks.useBlocker).toHaveBeenLastCalledWith(expect.objectContaining({ enableBeforeUnload: true }));

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
        key: 'sreAgentConfig',
        value: { ...stored, repos: [stored.repos[1]] },
      })
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
  });

  it('discards the staged edit back to the stored config without a write', () => {
    openConfiguration();
    expect(screen.queryByTestId('sre-repo-remove-1')).toBeNull();

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(screen.getByTestId('sre-repo-remove-1')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('puts a failed save on the SaveBar and keeps the edit', async () => {
    mocks.mutateAsync.mockRejectedValue(new Error('denied'));
    openConfiguration();
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    expect(await screen.findByText('SRE agent configuration was not saved: denied.')).toBeInTheDocument();
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(screen.queryByTestId('sre-repo-remove-1')).toBeNull();
  });
});

describe('AutoDispatchSourcesField', () => {
  function renderField(sources: SreSourceType[]) {
    const onChange = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <AutoDispatchSourcesField sources={sources} onChange={onChange} />
      </CssVarsProvider>
    );
    const checkbox = (source: SreSourceType) =>
      screen.getByTestId(`sre-auto-dispatch-source-${source}`).querySelector('input') as HTMLInputElement;
    return { onChange, checkbox };
  }

  it('leaves every source unchecked for an empty list', () => {
    const { checkbox } = renderField([]);
    expect(checkbox(SreSourceType.CLOUDWATCH).checked).toBe(false);
    expect(checkbox(SreSourceType.GITHUB_ISSUE).checked).toBe(false);
  });

  it('adds a source when it is checked', () => {
    const { onChange, checkbox } = renderField([SreSourceType.CLOUDWATCH]);
    fireEvent.click(checkbox(SreSourceType.GITHUB_ISSUE));
    expect(onChange).toHaveBeenCalledWith([SreSourceType.CLOUDWATCH, SreSourceType.GITHUB_ISSUE]);
  });

  it('removes a source when it is unchecked', () => {
    const { onChange, checkbox } = renderField([SreSourceType.CLOUDWATCH, SreSourceType.GITHUB_ISSUE]);
    fireEvent.click(checkbox(SreSourceType.CLOUDWATCH));
    expect(onChange).toHaveBeenCalledWith([SreSourceType.GITHUB_ISSUE]);
  });
});

describe('PipelineTrackingCard dismiss', () => {
  const doc = {
    id: 'doc1',
    errorFingerprint: 'fp-0123456789abcdef',
    source: 'CLOUDWATCH',
    status: 'failed',
    errorMessage: 'TypeError: boom',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
  } as unknown as TrackingDocSummary;

  afterEach(() => {
    vi.mocked(api.post).mockReset();
  });

  it('dismisses with the entered reason and closes the dialog on success', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { success: true, fingerprint: doc.errorFingerprint } });
    renderWithClient(<PipelineTrackingCard doc={doc} />);

    expect(screen.getByTestId('sre-tracking-card-doc1')).toHaveTextContent('TypeError: boom');
    fireEvent.click(screen.getByTestId('sre-tracking-dismiss-doc1'));
    expect(screen.getByTestId('sre-dismiss-confirm-doc1')).toBeDisabled();
    fireEvent.change(screen.getByTestId('sre-dismiss-reason-doc1'), { target: { value: 'flaky staging run' } });
    fireEvent.click(screen.getByTestId('sre-dismiss-confirm-doc1'));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/sre/tracking/doc1/dismiss', {
        reason: expect.stringContaining('flaky staging run'),
      })
    );
    await waitFor(() => expect(screen.queryByTestId('sre-dismiss-doc1')).not.toBeInTheDocument());
  });

  it('keeps the dialog and the reason open when the dismiss fails', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('nope'));
    renderWithClient(<PipelineTrackingCard doc={doc} />);

    fireEvent.click(screen.getByTestId('sre-tracking-dismiss-doc1'));
    fireEvent.change(screen.getByTestId('sre-dismiss-reason-doc1'), { target: { value: 'flaky staging run' } });
    fireEvent.click(screen.getByTestId('sre-dismiss-confirm-doc1'));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('sre-dismiss-confirm-doc1')).not.toBeDisabled());
    expect(screen.getByTestId('sre-dismiss-reason-doc1')).toHaveValue('flaky staging run');
  });
});

describe('PatternLibraryPanel', () => {
  const pattern = {
    id: 'p1',
    errorFingerprint: 'fp1',
    name: 'Null config on boot',
    isActive: true,
    matchCount: 4,
    successCount: 3,
    failureCount: 1,
    diagnosis: { confidence: 80 },
    createdAt: '2026-01-01T00:00:00Z',
  };
  const toggleButton = () => within(screen.getByTestId('sre-pattern-toggle-p1')).getByRole('button');

  afterEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.patch).mockReset();
  });

  it('sends one toggle while the first is still pending', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [pattern] });
    vi.mocked(api.patch).mockReturnValue(new Promise(() => {}));
    renderWithClient(<PatternLibraryPanel repoSlugs={[]} />);

    await screen.findByText('Null config on boot');
    fireEvent.click(toggleButton());
    await waitFor(() => expect(toggleButton()).toBeDisabled());
    fireEvent.click(toggleButton());

    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith('/api/sre/patterns/p1', { isActive: false });
  });

  it('keeps the loaded rows when the refetch after a toggle fails', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({ data: [pattern] })
      .mockRejectedValue(new Error('down'));
    vi.mocked(api.patch).mockResolvedValue({ data: {} });
    renderWithClient(<PatternLibraryPanel repoSlugs={[]} />);

    await screen.findByText('Null config on boot');
    fireEvent.click(toggleButton());

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggleButton()).not.toBeDisabled());
    expect(screen.getByText('Null config on boot')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
  });

  it('shows the saved state when the refetch after a toggle fails', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({ data: [pattern] })
      .mockRejectedValue(new Error('down'));
    vi.mocked(api.patch).mockResolvedValue({ data: { ...pattern, isActive: false } });
    renderWithClient(<PatternLibraryPanel repoSlugs={[]} />);

    await screen.findByText('Null config on boot');
    fireEvent.click(toggleButton());

    await waitFor(() => expect(screen.getByTestId('sre-pattern-toggle-p1')).toHaveTextContent('Inactive'));
  });

  it('toasts and re-enables the toggle when the update fails', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [pattern] });
    vi.mocked(api.patch).mockRejectedValue(new Error('nope'));
    renderWithClient(<PatternLibraryPanel repoSlugs={[]} />);

    await screen.findByText('Null config on boot');
    fireEvent.click(toggleButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update pattern'));
    await waitFor(() => expect(toggleButton()).not.toBeDisabled());
  });

  it('sets and clears the root cause issue', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [{ ...pattern, rootCauseTrackingIssue: 12 }] });
    vi.mocked(api.patch).mockResolvedValue({ data: {} });
    renderWithClient(<PatternLibraryPanel repoSlugs={[]} />);

    fireEvent.click(await screen.findByTestId('sre-pattern-issue-p1'));
    const input = within(screen.getByTestId('sre-pattern-issue-input-p1')).getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '34' } });
    fireEvent.click(screen.getByTestId('sre-pattern-issue-save-p1'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith('/api/sre/patterns/p1', { rootCauseTrackingIssue: 34 })
    );

    fireEvent.click(await screen.findByTestId('sre-pattern-issue-p1'));
    fireEvent.change(within(screen.getByTestId('sre-pattern-issue-input-p1')).getByRole('spinbutton'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('sre-pattern-issue-save-p1'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith('/api/sre/patterns/p1', { rootCauseTrackingIssue: null })
    );
  });

  // A retry with no cached rows puts the query back to pending, so the table's skeleton is the busy state.
  it('shows the error state on a failed first load and the loading table while Retry refetches', async () => {
    let calls = 0;
    vi.mocked(api.get).mockImplementation(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('down')) : new Promise(() => {});
    });
    renderWithClient(<PatternLibraryPanel repoSlugs={[]} />);

    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Patterns failed to load.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));

    await waitFor(() => expect(screen.getByTestId('sre-patterns-table')).toHaveAttribute('aria-busy', 'true'));
    expect(calls).toBe(2);
  });

  it('lists every pattern the endpoint returns, paged in the table footer', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...pattern, id: `p${index}`, name: `Pattern ${index}` }));
    vi.mocked(api.get).mockResolvedValue({ data: many });
    renderWithClient(<PatternLibraryPanel repoSlugs={[]} />);

    await screen.findByText('Pattern 0');
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 25 of 30');
  });
});
