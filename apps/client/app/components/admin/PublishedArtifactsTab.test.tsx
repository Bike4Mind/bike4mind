import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  currentUser: { isAdmin: true, adminPermissions: [] } as { isAdmin: boolean; adminPermissions?: string[] },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, post: mocks.post, delete: mocks.del },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import PublishedArtifactsTab from './PublishedArtifactsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const artifact = (publicId: string, overrides: Record<string, unknown> = {}) => ({
  publicId,
  tier: 'user',
  scopeId: 'someone',
  slug: `page-${publicId}`,
  title: `Page ${publicId}`,
  visibility: 'public',
  ownerId: 'owner-1',
  moderationStatus: 'reported',
  reportCount: 2,
  source: { kind: 'bundle' },
  publishedAt: new Date().toISOString(),
  ...overrides,
});

const listResponse = (artifacts: unknown[], total = artifacts.length) => ({ data: { artifacts, total } });

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <PublishedArtifactsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((url: string) =>
    url.endsWith('/reports')
      ? Promise.resolve({
          data: {
            reports: [
              { reason: 'phishing', details: 'Fake login', status: 'open', createdAt: new Date().toISOString() },
            ],
          },
        })
      : Promise.resolve(listResponse([artifact('a1'), artifact('a2', { reportCount: 1, source: { kind: 'reply' } })]))
  );
  mocks.post.mockResolvedValue({ data: {} });
  mocks.del.mockResolvedValue({ data: {} });
});

describe('PublishedArtifactsTab', () => {
  it('lists reported pages under a page header with their public paths', async () => {
    renderTab();
    expect(await screen.findByTestId('admin-published-row-a1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /Published pages/ })).toHaveTextContent('(2)');
    expect(screen.getByTestId('admin-published-row-a1')).toHaveTextContent('/p/u/someone/page-a1');
    expect(screen.getByTestId('admin-published-row-a2')).toHaveTextContent('/p/r/a2');
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/published-artifacts?status=reported&limit=50&skip=0');
  });

  it('refetches from the first page when the status filter changes', async () => {
    renderTab();
    await screen.findByTestId('admin-published-row-a1');
    fireEvent.click(screen.getByTestId('admin-published-pages-status-taken_down'));
    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith('/api/admin/published-artifacts?status=taken_down&limit=50&skip=0')
    );
  });

  it('pages through the server result with the table footer', async () => {
    mocks.get.mockResolvedValue(listResponse([artifact('a1')], 120));
    renderTab();
    await screen.findByTestId('admin-published-row-a1');
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 1 of 120');
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith('/api/admin/published-artifacts?status=reported&limit=50&skip=50')
    );
  });

  it('opens a page with its reports and takes it down with an audited reason', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-published-row-a1'));
    const detail = await screen.findByTestId('admin-published-detail');
    expect(await within(detail).findByTestId('admin-published-reports')).toHaveTextContent('Fake login');

    fireEvent.click(within(detail).getByTestId('admin-published-takedown-a1'));
    const dialog = await screen.findByTestId('admin-published-takedown-dialog');
    fireEvent.change(within(dialog).getByTestId('admin-published-takedown-dialog-reason-input'), {
      target: { value: 'Credential phishing page' },
    });
    fireEvent.click(within(dialog).getByTestId('admin-published-takedown-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/published-artifacts/a1/takedown', {
        reason: 'Credential phishing page',
      })
    );
    expect(mocks.success).toHaveBeenCalledWith('Page taken down');
    await waitFor(() => expect(screen.queryByTestId('admin-published-takedown-dialog')).not.toBeInTheDocument());
  });

  it('restores a taken-down page', async () => {
    mocks.get.mockImplementation((url: string) =>
      url.endsWith('/reports')
        ? Promise.resolve({ data: { reports: [] } })
        : Promise.resolve(listResponse([artifact('a3', { moderationStatus: 'taken_down', takedownReason: 'Spam' })]))
    );
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-published-row-a3'));
    const detail = await screen.findByTestId('admin-published-detail');
    expect(detail).toHaveTextContent('Spam');
    expect(within(detail).queryByTestId('admin-published-takedown-a3')).toBeNull();

    fireEvent.click(within(detail).getByTestId('admin-published-restore-a3'));
    const dialog = await screen.findByTestId('admin-published-restore-dialog');
    fireEvent.change(within(dialog).getByTestId('admin-published-restore-dialog-reason-input'), {
      target: { value: 'Taken down in error' },
    });
    fireEvent.click(within(dialog).getByTestId('admin-published-restore-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/api/admin/published-artifacts/a3/takedown'));
    expect(mocks.success).toHaveBeenCalledWith('Page restored');
  });

  it('keeps the dialog open and reports a failed takedown', async () => {
    mocks.post.mockRejectedValue(new Error('boom'));
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-published-row-a1'));
    fireEvent.click(await screen.findByTestId('admin-published-takedown-a1'));
    const dialog = await screen.findByTestId('admin-published-takedown-dialog');
    fireEvent.change(within(dialog).getByTestId('admin-published-takedown-dialog-reason-input'), {
      target: { value: 'Credential phishing page' },
    });
    fireEvent.click(within(dialog).getByTestId('admin-published-takedown-dialog-confirm-btn'));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('The page could not be taken down. Try again.'));
    expect(screen.getByTestId('admin-published-takedown-dialog')).toBeInTheDocument();
  });

  it('shows an empty state when nothing is reported', async () => {
    mocks.get.mockResolvedValue(listResponse([]));
    renderTab();
    expect(await screen.findByText('No pages for this filter')).toBeInTheDocument();
  });
});
