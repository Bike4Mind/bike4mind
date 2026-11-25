import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  modals: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/hooks/data/modals', () => ({ useGetModals: mocks.modals }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useGetPresignedUrl: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('@client/app/utils/modalsAPICalls', () => ({
  deleteModalFromServer: mocks.remove,
  updateModal: mocks.update,
  createModal: mocks.create,
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/components/modals/GenericModal', () => ({
  default: ({ title }: { title?: string }) => <div data-testid="generic-modal-preview">{title}</div>,
}));
vi.mock('./AdminModalTabNew', () => ({
  default: ({ modalData }: { modalData: { title?: string } | null }) => (
    <div data-testid="edit-modal-new">{modalData?.title ?? 'new'}</div>
  ),
}));

import ModalsAdminTab from './AdminModalTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <ModalsAdminTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const modal = (id: string, overrides: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Modal ${id}`,
  description: `About ${id}`,
  enabled: true,
  isBanner: false,
  priority: 0,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  ...overrides,
});

const listResult = (data: unknown[] | undefined, overrides: Record<string, unknown> = {}) => ({
  data,
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
  ...overrides,
});

const rowIds = () =>
  within(screen.getByTestId('admin-modals-table'))
    .queryAllByTestId(/^admin-modals-row-[^-]+$/)
    .map(row => row.getAttribute('data-testid'));

const openMenu = (id: string) => userEvent.click(screen.getByTestId(`admin-modals-row-actions-${id}`));

describe('ModalsAdminTab', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
  });

  it('lists modals with their status and type', () => {
    mocks.modals.mockReturnValue(listResult([modal('a'), modal('b', { enabled: false, isBanner: true })]));
    renderTab();

    expect(rowIds()).toEqual(['admin-modals-row-a', 'admin-modals-row-b']);
    const rowB = screen.getByTestId('admin-modals-row-b');
    expect(within(rowB).getByText('Inactive')).toBeInTheDocument();
    expect(within(rowB).getByText('Banner')).toBeInTheDocument();
  });

  it('narrows the rows by search', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a'), modal('b', { tags: ['beta'] })]));
    renderTab();

    await userEvent.type(screen.getByTestId('admin-modals-search-input'), 'beta');
    expect(rowIds()).toEqual(['admin-modals-row-b']);

    await userEvent.clear(screen.getByTestId('admin-modals-search-input'));
    await userEvent.type(screen.getByTestId('admin-modals-search-input'), 'nothing here');
    expect(screen.getByText('No modals match this search')).toBeInTheDocument();
  });

  it('shows the second title line, each row description and the time of day', () => {
    mocks.modals.mockReturnValue(
      listResult([
        modal('a', { subtitle: 'Sub a' }),
        modal('b', { isBanner: true, title: 'Banner b', textMessage: 'Message b', description: 'Notes b' }),
      ])
    );
    renderTab();

    const rowA = screen.getByTestId('admin-modals-row-a');
    expect(within(rowA).getByText('Sub a')).toBeInTheDocument();
    expect(within(rowA).getByText('About a')).toBeInTheDocument();
    expect(within(rowA).getAllByText(/^\d{2}:\d{2}\s?[AP]M$/)).toHaveLength(2);
    const rowB = screen.getByTestId('admin-modals-row-b');
    expect(within(rowB).getByText('Banner b')).toBeInTheDocument();
    expect(within(rowB).getByText('Message b')).toBeInTheDocument();
    expect(within(rowB).getByText('Notes b')).toBeInTheDocument();
  });

  it('sorts banners by the title it shows, not the banner message', async () => {
    mocks.modals.mockReturnValue(
      listResult([modal('a', { isBanner: true, title: 'Zeta', textMessage: 'aaa' }), modal('b', { title: 'Alpha' })])
    );
    renderTab();

    await userEvent.click(screen.getByRole('button', { name: /Title/ }));
    expect(rowIds()).toEqual(['admin-modals-row-b', 'admin-modals-row-a']);
  });

  it('sorts by priority', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a', { priority: 5 }), modal('b', { priority: 1 })]));
    renderTab();

    await userEvent.click(screen.getByRole('button', { name: /Priority/ }));
    expect(rowIds()).toEqual(['admin-modals-row-b', 'admin-modals-row-a']);
  });

  it('opens the editor from the row menu', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    renderTab();

    await openMenu('a');
    await userEvent.click(screen.getByTestId('admin-modals-row-edit-a'));
    expect(screen.getByTestId('edit-modal-new')).toHaveTextContent('Modal a');
  });

  it('keeps the loaded rows when a background refetch fails', () => {
    mocks.modals.mockReturnValue(listResult([modal('a')], { isError: true, error: new Error('offline') }));
    renderTab();
    expect(rowIds()).toEqual(['admin-modals-row-a']);
    expect(screen.queryByText(/Couldn't load modals/)).toBeNull();
  });

  it('disables a modal from the row menu', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    mocks.update.mockResolvedValue(undefined);
    renderTab();

    await openMenu('a');
    await userEvent.click(screen.getByTestId('admin-modals-row-toggle-a'));
    expect(mocks.update).toHaveBeenCalledWith('a', expect.objectContaining({ enabled: false }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('Modal disabled'));
  });

  it('deletes a modal only after its title is typed', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    mocks.remove.mockResolvedValue(undefined);
    renderTab();

    await openMenu('a');
    await userEvent.click(screen.getByTestId('admin-modals-row-delete-a'));
    await userEvent.click(screen.getByTestId('admin-modals-delete-dialog-reason-input-preset-0'));
    const confirm = screen.getByTestId('admin-modals-delete-confirm-btn');
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByTestId('admin-modals-delete-dialog-typed-input'), 'Modal a');
    await userEvent.click(confirm);
    expect(mocks.remove).toHaveBeenCalledWith('a');
    await waitFor(() => expect(screen.queryByTestId('admin-modals-delete-dialog')).not.toBeInTheDocument());
  });

  it('keeps the delete dialog open when the delete fails', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a', { title: '' })]));
    mocks.remove.mockRejectedValue(new Error('boom'));
    renderTab();

    await openMenu('a');
    await userEvent.click(screen.getByTestId('admin-modals-row-delete-a'));
    await userEvent.click(screen.getByTestId('admin-modals-delete-dialog-reason-input-preset-0'));
    await userEvent.type(screen.getByTestId('admin-modals-delete-dialog-typed-input'), 'delete');
    await userEvent.click(screen.getByTestId('admin-modals-delete-confirm-btn'));
    expect(mocks.remove).toHaveBeenCalledWith('a');
    expect(screen.getByTestId('admin-modals-delete-dialog')).toBeInTheDocument();
  });

  it('offers to create the first modal when there are none', async () => {
    mocks.modals.mockReturnValue(listResult([]));
    renderTab();

    expect(screen.getByText('No modals yet')).toBeInTheDocument();
  });

  it('shows a retryable error when the modals fail to load', async () => {
    const result = listResult(undefined, { isError: true, error: new Error('down') });
    mocks.modals.mockReturnValue(result);
    renderTab();

    await userEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(result.refetch).toHaveBeenCalled();
  });
});
