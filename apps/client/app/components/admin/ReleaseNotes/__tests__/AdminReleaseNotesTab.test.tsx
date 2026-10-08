import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockGet, mockPost, mockToastError } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: mockPost, patch: vi.fn(), put: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: mockToastError, success: vi.fn() }),
}));

import AdminReleaseNotesTab from '../AdminReleaseNotesTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <AdminReleaseNotesTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const item = { category: 'new', text: 'Faster search', importance: 1, sourcePrs: [] };
const note = (overrides: Record<string, unknown>) => ({
  id: 'n1',
  releaseTag: 'v1.0.0',
  headline: 'Headline',
  summary: '',
  items: [item],
  state: 'scheduled',
  publishAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
  deployedAt: new Date().toISOString(),
  deployedSha: 'abc',
  editedAt: null,
  ...overrides,
});

const serve = (byStatus: Record<string, unknown[]>) =>
  mockGet.mockImplementation(async (url: string, opts?: { params?: { status: string } }) => {
    if (url.endsWith('/config'))
      return { data: { config: { enabled: false, modelId: 'm', embargoHours: 12, denylist: [] }, malformed: false } };
    return { data: { data: byStatus[opts?.params?.status ?? ''] ?? [], next_cursor: null } };
  });

beforeEach(() => vi.clearAllMocks());

describe('AdminReleaseNotesTab', () => {
  it('shows the cache note and a scheduled note with hide and publish-now actions', async () => {
    serve({ scheduled: [note({})] });
    renderTab();
    expect(screen.getByTestId('release-notes-cache-note').textContent).toContain('15 minutes');
    expect(await screen.findByText('Goes live in 5h')).toBeTruthy();

    mockPost.mockResolvedValue({ data: note({ state: 'published' }) });
    fireEvent.click(screen.getByTestId('release-notes-publish-now-btn'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/admin/release-notes/n1/status', { action: 'publishNow' })
    );
  });

  it('a published note offers hide but not publish-now', async () => {
    serve({ published: [note({ state: 'published' })] });
    renderTab();
    fireEvent.click(screen.getByTestId('release-notes-filter-published-btn'));
    expect(await screen.findByTestId('release-notes-hide-btn')).toBeTruthy();
    expect(screen.queryByTestId('release-notes-publish-now-btn')).toBeNull();
  });

  it('disables unhide for a hidden note with no items, and surfaces a server rejection', async () => {
    serve({ hidden: [note({ id: 'empty', state: 'hidden', items: [] }), note({ id: 'full', state: 'hidden' })] });
    renderTab();
    fireEvent.click(screen.getByTestId('release-notes-filter-hidden-btn'));
    await waitFor(() => expect(screen.getAllByTestId('release-notes-unhide-btn')).toHaveLength(2));
    const [emptyBtn, fullBtn] = screen.getAllByTestId('release-notes-unhide-btn') as HTMLButtonElement[];
    expect(emptyBtn.disabled).toBe(true);
    expect(fullBtn.disabled).toBe(false);

    mockPost.mockRejectedValue(new Error('A release note with no items cannot go live'));
    fireEvent.click(fullBtn);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('A release note with no items cannot go live'));
  });
});
