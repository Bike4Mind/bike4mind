import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import SreAgentTab from './SreAgentTab';

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
  // The admin shell frames every [role="tabpanel"] under it (AdminPage.tsx) unless the panel opts
  // out, so a nested sub-tab panel without the attribute gets inset from the page title.
  it('opts every nested sub-tab panel out of the admin shell framing', () => {
    renderTab();

    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(panels).toHaveLength(3);
    for (const panel of panels) {
      expect(panel).toHaveAttribute('data-admin-self-framed');
    }
  });
});
