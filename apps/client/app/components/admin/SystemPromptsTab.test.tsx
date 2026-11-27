import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({
  default: ({ helpId }: { helpId: string }) => <span data-testid="context-help" data-help-id={helpId} />,
}));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({ getSetting: () => 'file-a' }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({ useUpdateSettings: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('../Knowledge/KnowledgeModal', () => ({
  useKnowledgeModal: () => ({ setOpen: vi.fn(), setSelectedFabFileId: vi.fn(), setViewOnly: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useGetFabFiles: () => ({ data: undefined, isFetching: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import SystemPromptsTab from './SystemPromptsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const PROMPT = {
  promptId: 'optimizer_system',
  name: 'Optimizer system prompt',
  description: 'Sets how the optimizer behaves',
  content: 'You are the optimizer.',
  category: 'system',
  tags: ['system-message'],
  variables: [],
  enabled: true,
  version: 0,
  hasOverride: false,
  hasCodeDefault: true,
  source: 'code',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const LIST_URL = '/api/admin/system-prompts?enabled=all';

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <SystemPromptsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('SystemPromptsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation((url: string) => {
      if (url === LIST_URL) return Promise.resolve({ data: { success: true, data: [PROMPT], count: 1 } });
      if (url === '/api/files/file-a') {
        return Promise.resolve({
          data: { id: 'file-a', fileName: 'rules.md', mimeType: 'text/markdown', fileSize: 10 },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  it('opens with one page header: the sentence-case h1 with its count, help, Refresh and New prompt', async () => {
    renderTab();

    const header = await screen.findByTestId('admin-page-header');
    expect(screen.getByTestId('admin-system-prompts-tab').firstElementChild).toBe(header);
    const title = within(header).getByRole('heading', { level: 1 });
    await waitFor(() => expect(title.textContent).toBe('System prompts (1)'));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByTestId('context-help')).toHaveAttribute('data-help-id', 'admin/system-prompts');
    expect(within(header).getByTestId('system-prompts-refresh-btn')).toHaveTextContent('Refresh');
    expect(within(header).getByTestId('system-prompts-new-btn')).toHaveTextContent('New prompt');
  });

  it('refreshes the prompts from the header and opens New prompt from it', async () => {
    renderTab();
    await screen.findByTestId('system-prompt-row-optimizer_system');

    fireEvent.click(screen.getByTestId('system-prompts-refresh-btn'));
    await waitFor(() => expect(mocks.get.mock.calls.filter(([url]) => url === LIST_URL)).toHaveLength(2));

    fireEvent.click(screen.getByTestId('system-prompts-new-btn'));
    const dialog = await screen.findByTestId('system-prompt-edit-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('New prompt');
  });

  it('shows the hybrid-prompt note as a neutral banner with no icon', async () => {
    renderTab();

    const banner = await screen.findByTestId('system-prompts-info-banner');
    expect(banner).toHaveClass('MuiAlert-colorNeutral');
    expect(banner.querySelector('svg')).toBeNull();
  });

  it('puts the knowledge files in a section of the page, with no card-in-card and no divider heading', async () => {
    const { container } = renderTab();
    await screen.findByTestId('system-files-row-file-a');

    const section = screen.getByTestId('system-files-section');
    expect(section.parentElement).toBe(screen.getByTestId('admin-system-prompts-tab'));
    expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent('Global knowledge files');
    expect(container.querySelectorAll('.MuiCard-root')).toHaveLength(0);
    expect(container.querySelectorAll('hr, [role="separator"]')).toHaveLength(0);
  });
});
