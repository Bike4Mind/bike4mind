import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  modals: vi.fn(),
  toggle: vi.fn(),
  remove: vi.fn(),
  env: vi.fn(),
  highlights: vi.fn(),
}));

const idleMutation = (mutate = vi.fn()) => ({ mutate, mutateAsync: vi.fn(), isPending: false });

vi.mock('@client/app/hooks/data/whatsNewModals', () => ({
  useGetWhatsNewModals: mocks.modals,
  useDeleteWhatsNewModal: () => idleMutation(mocks.remove),
  useToggleWhatsNewModal: () => idleMutation(mocks.toggle),
  useCreateWhatsNewModal: () => idleMutation(),
  useUpdateWhatsNewModal: () => idleMutation(),
  useUpdateWhatsNewModalVariants: () => idleMutation(),
  useGetRawModalVariants: () => ({ data: undefined, isLoading: false }),
  useGetHighlightsConfig: mocks.highlights,
  useUpdateHighlightsConfig: () => idleMutation(),
  useGenerateHighlights: () => idleMutation(),
}));
vi.mock('@client/app/hooks/data/admin', () => ({ useLiveOpsTriageEnv: mocks.env }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import AdminWhatsNewModalsTab from './AdminWhatsNewModalsTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <AdminWhatsNewModalsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const modal = (id: string, overrides: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Modal ${id}`,
  enabled: true,
  createdAt: '2026-11-01T00:00:00Z',
  ...overrides,
});

const listResult = (data: unknown[] | undefined, overrides: Record<string, unknown> = {}) => ({
  data,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
  ...overrides,
});

describe('AdminWhatsNewModalsTab', () => {
  beforeEach(() => {
    mocks.modals.mockReset();
    mocks.toggle.mockReset();
    mocks.remove.mockReset();
    // A fork stage hides the weekly highlights section; only the last test shows it.
    mocks.env.mockReturnValue({ data: { stage: 'production', isForkProduction: true } });
    mocks.highlights.mockReturnValue({ data: undefined, isLoading: false, refetch: vi.fn() });
  });

  it('starts with the page header and lists active modals in the table', () => {
    mocks.modals.mockReturnValue(listResult([modal('a'), modal('b', { enabled: false })]));
    renderTab();

    expect(screen.getByRole('heading', { level: 1, name: "What's New modals" })).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-create-btn')).toBeInTheDocument();
    const table = screen.getByTestId('whats-new-active-table');
    expect(within(table).getByTestId('whats-new-row-a')).toHaveTextContent('Modal a');
    expect(within(table).queryByTestId('whats-new-row-b')).not.toBeInTheDocument();
  });

  it('keeps archived modals collapsed until the section is opened', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a'), modal('b', { enabled: false })]));
    renderTab();

    const toggle = screen.getByTestId('whats-new-archived-toggle-btn');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('whats-new-archived-table')).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(screen.getByTestId('whats-new-archived-table')).getByTestId('whats-new-archived-row-b')
    ).toBeInTheDocument();
  });

  it('disables a modal from its row menu', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    renderTab();

    await userEvent.click(screen.getByTestId('whats-new-row-actions-a'));
    await userEvent.click(screen.getByTestId('whats-new-row-toggle-a'));

    expect(mocks.toggle).toHaveBeenCalledWith({ modalId: 'a', enabled: false });
  });

  it('asks before deleting a modal from its row menu', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    renderTab();

    await userEvent.click(screen.getByTestId('whats-new-row-actions-a'));
    await userEvent.click(screen.getByTestId('whats-new-row-delete-a'));
    expect(mocks.remove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('whats-new-delete-confirm-btn'));
    expect(mocks.remove).toHaveBeenCalledWith('a');
  });

  it('offers to create the first modal when there are none', async () => {
    mocks.modals.mockReturnValue(listResult([]));
    renderTab();

    expect(screen.getByText('No modals yet')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('whats-new-empty-create-btn'));
    expect(screen.getByTestId('whats-new-create-dialog')).toBeInTheDocument();
  });

  it('shows a retryable error when the modals fail to load', async () => {
    const result = listResult(undefined, { isError: true });
    mocks.modals.mockReturnValue(result);
    renderTab();

    await userEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(result.refetch).toHaveBeenCalled();
  });

  it('shows the weekly highlights section below the modals on a main environment', () => {
    mocks.env.mockReturnValue({ data: { stage: 'dev', isForkProduction: false } });
    mocks.highlights.mockReturnValue({
      data: { enabled: true, slackChannelId: 'C1', slackTeamId: 'T1' },
      isLoading: false,
      refetch: vi.fn(),
    });
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    renderTab();

    const section = screen.getByTestId('whats-new-highlights');
    expect(within(section).getByRole('heading', { level: 2, name: 'Weekly highlights to Slack' })).toBeInTheDocument();
    expect(within(section).getByTestId('highlights-status-chip')).toHaveTextContent('Enabled');
    expect(within(section).getByTestId('highlights-run-now-btn')).toBeEnabled();
  });
});
