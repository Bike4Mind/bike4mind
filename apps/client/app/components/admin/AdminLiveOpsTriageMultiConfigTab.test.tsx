import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: apiGet, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));

import AdminLiveOpsTriageMultiConfigTab from './AdminLiveOpsTriageMultiConfigTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <AdminLiveOpsTriageMultiConfigTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const expectHeaderFirst = (container: HTMLElement) => {
  expect(container.firstElementChild?.firstElementChild).toBe(screen.getByTestId('admin-page-header'));
  expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['LiveOps triage']);
};

describe('AdminLiveOpsTriageMultiConfigTab page header', () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it('leads with the header while configs load', () => {
    apiGet.mockReturnValue(new Promise(() => {}));
    const { container } = renderTab();
    expect(screen.getByTestId('admin-loading-state')).toHaveTextContent('Loading configurations');
    expectHeaderFirst(container);
  });

  it('leads with the header when configs fail to load', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/api/admin/liveops-triage-configs' ? Promise.reject(new Error('boom')) : new Promise(() => {})
    );
    const { container } = renderTab();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent(
      'The triage configurations failed to load.'
    );
    expectHeaderFirst(container);

    const configCalls = () => apiGet.mock.calls.filter(([url]) => url === '/api/admin/liveops-triage-configs').length;
    const before = configCalls();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(configCalls()).toBe(before + 1);
  });

  it('leads with the header once configs load', async () => {
    apiGet.mockImplementation((url: string) =>
      Promise.resolve({ data: url.endsWith('/runs') ? { runs: [] } : url.includes('slack') ? { workspaces: [] } : [] })
    );
    const { container } = renderTab();
    expect(await screen.findByText('Active Runs')).toBeInTheDocument();
    expectHeaderFirst(container);
  });
});
