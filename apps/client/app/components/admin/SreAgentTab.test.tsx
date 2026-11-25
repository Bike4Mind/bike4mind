import type { ReactNode } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SreAgentConfigSchema, SreSourceType } from '@bike4mind/common';
import SreAgentTab, { AutoDispatchSourcesField } from './SreAgentTab';

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
  api: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<SreAgentTab />, { wrapper: Wrapper });
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
