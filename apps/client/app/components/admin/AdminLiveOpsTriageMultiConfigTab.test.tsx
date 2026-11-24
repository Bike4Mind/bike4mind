import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab, SIDEBAR_SECTIONS } from './adminSidebarConfig';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AdminLiveOpsTriageMultiConfigTab from './AdminLiveOpsTriageMultiConfigTab';

const theme = extendTheme({ ...getThemeConfig() });
const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <AdminLiveOpsTriageMultiConfigTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const respond = (configs: () => Promise<unknown>) =>
  get.mockImplementation((url: string) => {
    if (url === '/api/admin/liveops-triage-configs') return configs();
    if (url === '/api/admin/liveops-triage-configs/runs')
      return Promise.resolve({ data: { runs: [], activeCount: 0 } });
    return Promise.resolve({ data: { workspaces: [] } });
  });

const expectPageHeaderFirst = (container: HTMLElement) => {
  const header = screen.getByTestId('admin-page-header');
  const title = screen.getByRole('heading', { level: 1 });
  expect(container.firstElementChild?.firstElementChild).toBe(header);
  expect(screen.getAllByRole('heading')[0]).toBe(title);
  expect(header).toContainElement(title);
  expect(title).toHaveAccessibleName('LiveOps triage');
};

describe('AdminLiveOpsTriageMultiConfigTab page header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the page like its sidebar item', () => {
    expect(SIDEBAR_SECTIONS.flatMap(s => s.items).find(i => i.tab === AdminTab.LiveOpsTriage)?.label).toBe(
      'LiveOps triage'
    );
  });

  it('opens with the header as the only h1 once configurations load', async () => {
    respond(() => Promise.resolve({ data: [] }));
    const { container } = renderTab();

    expect(await screen.findByText('Active Runs')).toBeInTheDocument();
    expectPageHeaderFirst(container);
  });

  it('keeps the header above the spinner while configurations load', () => {
    respond(() => new Promise(() => {}));
    const { container } = renderTab();

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expectPageHeaderFirst(container);
  });

  it('keeps the header above the error when configurations fail to load', async () => {
    respond(() => Promise.reject(new Error('boom')));
    const { container } = renderTab();

    expect(await screen.findByText('Failed to load configurations. Please try again.')).toBeInTheDocument();
    expectPageHeaderFirst(container);
  });
});
