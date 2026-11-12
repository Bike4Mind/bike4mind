import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  del: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  setTargetFile: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, delete: mocks.del } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'admin-1' } }) }));
vi.mock('@client/app/utils/react-query', () => ({ useSubscribeCollection: vi.fn() }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createAppFileOnServerWithUpload: vi.fn() }));
vi.mock('react-filepond', () => ({
  FilePond: () => <div data-testid="filepond" />,
  registerPlugin: vi.fn(),
}));
vi.mock('./EditTagModal', () => ({
  default: () => null,
  useEditAppFileTagModal: (select: (s: { setTargetFile: typeof mocks.setTargetFile }) => unknown) =>
    select({ setTargetFile: mocks.setTargetFile }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import AdminFilesTab from './index';

const appTheme = extendTheme({ ...getThemeConfig() });

const file = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `${id}.pdf`,
  path: `files/${id}.pdf`,
  size: 2048,
  mimeType: 'application/pdf',
  tags: ['Quarterly Reports'],
  status: 'complete',
  userId: { id: 'admin-1', name: 'Admin One', email: 'admin@example.com' },
  createdAt: new Date().toISOString(),
  ...overrides,
});

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <AdminFilesTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    data: [
      file('f1'),
      file('f2', {
        status: 'pending',
        tags: [],
        userId: { id: 'someone-else', name: 'Other Admin', email: 'other@example.com' },
      }),
      file('f3', { userId: null }),
    ],
  });
  mocks.del.mockResolvedValue({ data: { id: 'f1' } });
});

describe('AdminFilesTab', () => {
  it('lists files under a page header with the upload drop zone', async () => {
    renderTab();
    const row = await screen.findByTestId('admin-files-row-f1');
    expect(screen.getByRole('heading', { level: 1, name: /Files/ })).toHaveTextContent('(3)');
    expect(screen.getByTestId('admin-files-dropzone')).toBeInTheDocument();
    expect(row).toHaveTextContent('files/f1.pdf');
    expect(row).toHaveTextContent('Quarterly Reports');
    expect(within(row).getByTestId('admin-files-status-f1')).toHaveTextContent('Complete');
    expect(screen.getByTestId('admin-files-status-f2')).toHaveTextContent('Pending');
    expect(screen.getByTestId('admin-files-row-f3')).toHaveTextContent('Deleted user');
  });

  it('offers delete only on files the signed-in admin uploaded', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-files-row-actions-f1'));
    expect(await screen.findByTestId('admin-files-delete-f1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-files-row-actions-f2'));
    expect(await screen.findByTestId('admin-files-edit-f2')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-files-delete-f2')).toBeNull();
  });

  it('opens the tag editor from the row and from its menu', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-files-row-f2'));
    expect(mocks.setTargetFile).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'f2' }));
    fireEvent.click(screen.getByTestId('admin-files-row-actions-f3'));
    fireEvent.click(await screen.findByTestId('admin-files-edit-f3'));
    expect(mocks.setTargetFile).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'f3' }));
  });

  it('deletes a file after a confirmed reason', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-files-row-actions-f1'));
    fireEvent.click(await screen.findByTestId('admin-files-delete-f1'));
    const dialog = await screen.findByTestId('admin-files-delete-dialog');
    fireEvent.change(within(dialog).getByTestId('admin-files-delete-dialog-reason-input'), {
      target: { value: 'Uploaded in error' },
    });
    fireEvent.click(within(dialog).getByTestId('admin-files-delete-dialog-confirm-btn'));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/api/app-files/delete', { data: { id: 'f1' } }));
    expect(mocks.success).toHaveBeenCalledWith('File deleted');
    await waitFor(() => expect(screen.queryByTestId('admin-files-delete-dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog open and reports a failed delete', async () => {
    mocks.del.mockRejectedValue(new Error('boom'));
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-files-row-actions-f1'));
    fireEvent.click(await screen.findByTestId('admin-files-delete-f1'));
    const dialog = await screen.findByTestId('admin-files-delete-dialog');
    fireEvent.change(within(dialog).getByTestId('admin-files-delete-dialog-reason-input'), {
      target: { value: 'Uploaded in error' },
    });
    fireEvent.click(within(dialog).getByTestId('admin-files-delete-dialog-confirm-btn'));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('The file could not be deleted. Try again.'));
    expect(screen.getByTestId('admin-files-delete-dialog')).toBeInTheDocument();
  });

  it('shows an empty state when there are no files', async () => {
    mocks.get.mockResolvedValue({ data: [] });
    renderTab();
    expect(await screen.findByText('No files yet')).toBeInTheDocument();
  });
});
