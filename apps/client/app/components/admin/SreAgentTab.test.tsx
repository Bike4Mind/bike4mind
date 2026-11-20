import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SreSourceType } from '@bike4mind/common';
import SreAgentTab, { AutoDispatchSourcesField } from './SreAgentTab';

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => undefined,
  useUpdateSettings: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
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
