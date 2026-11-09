import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

type BlockerOptions = {
  enableBeforeUnload: boolean;
  shouldBlockFn(args: {
    current: { pathname: string; search: object };
    next: { pathname: string; search: object };
  }): boolean;
};
const { mockGet, mockPost, mockPut, mockToastError, mockUseBlocker } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockToastError: vi.fn(),
  mockUseBlocker: vi.fn<(options: BlockerOptions) => { status: string }>(() => ({ status: 'idle' })),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: mockPost, patch: vi.fn(), put: mockPut },
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: mockToastError, success: vi.fn() }),
}));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../__tests__/fakeAdminRouter')).fakeRouterModule,
  useBlocker: mockUseBlocker,
}));

import { fakeAdminRouter } from '../../__tests__/fakeAdminRouter';
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

const config = { enabled: false, modelId: 'm', embargoHours: 12, denylist: [] };
const serve = (byStatus: Record<string, unknown[]>) =>
  mockGet.mockImplementation(async (url: string, opts?: { params?: { status: string } }) => {
    if (url.endsWith('/config')) return { data: { config, malformed: false } };
    return { data: { data: byStatus[opts?.params?.status ?? ''] ?? [], next_cursor: null } };
  });
const lastBlocker = () => mockUseBlocker.mock.lastCall?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  fakeAdminRouter.reset({ tab: 'release-notes' });
});

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

  it('opens with the page header and carries the cache note as plain text, not an alert strip', async () => {
    serve({ scheduled: [note({})] });
    renderTab();
    await screen.findByTestId('release-notes-row');

    const tab = screen.getByTestId('admin-release-notes-tab');
    const header = screen.getByTestId('admin-page-header');
    expect(tab.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Release notes');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(header.textContent).toContain('GET /api/v1/whats-new');
    expect(tab.querySelector('.MuiAlert-root')).toBeNull();
  });

  it('lists the notes as rows of one card, with no card inside another', async () => {
    serve({ scheduled: [note({ id: 'a' }), note({ id: 'b', releaseTag: 'v1.0.1' })] });
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId('release-notes-row')).toHaveLength(2));

    const list = screen.getByTestId('release-notes-list');
    expect(within(list).getByRole('heading', { level: 3 }).textContent).toBe('Scheduled notes');
    for (const row of screen.getAllByTestId('release-notes-row')) {
      expect(row.parentElement).toBe(list);
    }
    expect(screen.getByTestId('admin-release-notes-tab').querySelector('.MuiCard-root')).toBeNull();
  });

  it('shows note states and a withheld note as status tones', async () => {
    serve({
      scheduled: [note({ deniedTerm: 'acme' })],
      published: [note({ state: 'published' })],
      hidden: [note({ state: 'hidden' })],
    });
    renderTab();
    // Scoped to the rows: the filter tabs carry the same words.
    const tone = async (label: string) =>
      (await within(await screen.findByTestId('release-notes-row')).findByText(label))
        .closest('[data-tone]')
        ?.getAttribute('data-tone');

    expect(await tone('Goes live in 5h')).toBe('warn');
    expect(screen.getByTestId('release-notes-denied-chip')).toHaveAttribute('data-tone', 'bad');
    fireEvent.click(screen.getByTestId('release-notes-filter-published-btn'));
    expect(await tone('Published')).toBe('good');
    fireEvent.click(screen.getByTestId('release-notes-filter-hidden-btn'));
    expect(await tone('Hidden')).toBe('neutral');
  });

  it('shows the toolkit loading state, then an empty state whose action opens another filter', async () => {
    let release: () => void = () => undefined;
    mockGet.mockImplementation(async (url: string, opts?: { params?: { status: string } }) => {
      if (url.endsWith('/config')) return { data: { config, malformed: false } };
      if (opts?.params?.status === 'scheduled') await new Promise<void>(resolve => (release = resolve));
      return {
        data: { data: opts?.params?.status === 'published' ? [note({ state: 'published' })] : [], next_cursor: null },
      };
    });
    renderTab();

    expect(await screen.findByTestId('release-notes-loading')).toBeTruthy();
    release();
    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty.textContent).toContain('No scheduled release notes');
    expect(within(screen.getByTestId('release-notes-list')).getByTestId('admin-empty-state')).toBe(empty);

    fireEvent.click(screen.getByTestId('release-notes-empty-show-btn'));
    expect(await screen.findByTestId('release-notes-hide-btn')).toBeTruthy();
    expect(screen.getByTestId('release-notes-filter-published-btn')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the toolkit error state with a retry when the list fails to load', async () => {
    let fail = true;
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/config')) return { data: { config, malformed: false } };
      if (fail) throw new Error('Service unavailable');
      return { data: { data: [note({})], next_cursor: null } };
    });
    renderTab();

    const error = await screen.findByTestId('admin-error-state');
    expect(error.textContent).toContain('Service unavailable');
    fail = false;
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('release-notes-row')).toBeTruthy();
  });

  it('saves the settings from one SaveBar at the foot of the page and guards leaving with an unsaved edit', async () => {
    serve({ scheduled: [note({})] });
    mockPut.mockImplementation(async (_url: string, body: unknown) => ({ data: { config: body, malformed: false } }));
    renderTab();
    const here = { pathname: '/admin', search: { tab: 'release-notes' } };
    const otherTab = { pathname: '/admin', search: { tab: 'admin-settings' } };

    fireEvent.click(await screen.findByTestId('release-notes-config-enabled'));
    const tab = screen.getByTestId('admin-release-notes-tab');
    const bar = screen.getByTestId('admin-save-bar');
    expect(screen.getAllByTestId('admin-save-bar')).toHaveLength(1);
    expect(bar).toHaveTextContent('1 unsaved change');
    expect(tab.lastElementChild).toBe(bar);
    expect(lastBlocker()?.shouldBlockFn({ current: here, next: otherTab })).toBe(true);

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mockPut).toHaveBeenCalledWith('/api/admin/release-notes/config', { ...config, enabled: true });
    expect(lastBlocker()?.shouldBlockFn({ current: here, next: otherTab })).toBe(false);
  });
});
