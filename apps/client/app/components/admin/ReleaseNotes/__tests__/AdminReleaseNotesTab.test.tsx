import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.restoreAllMocks();
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
    for (const btn of [emptyBtn, fullBtn]) {
      expect(btn).toHaveClass('MuiButton-variantOutlined', 'MuiButton-colorNeutral');
    }

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
    expect(header.textContent).toContain("What's new modals");
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
    // Scoped to the list: the filter tabs carry the same words.
    const tone = async (label: string) =>
      (await within(screen.getByTestId('release-notes-list')).findByText(label))
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

  it('renders row actions as neutral secondary buttons, none danger or success', async () => {
    serve({ scheduled: [note({})] });
    renderTab();
    await screen.findByTestId('release-notes-row');

    for (const id of ['release-notes-edit-btn', 'release-notes-hide-btn', 'release-notes-publish-now-btn']) {
      const button = screen.getByTestId(id);
      expect(button, id).toHaveClass('MuiButton-variantOutlined', 'MuiButton-colorNeutral');
      expect(button, id).not.toHaveClass('MuiButton-colorDanger');
      expect(button, id).not.toHaveClass('MuiButton-colorSuccess');
    }
  });

  it('types the release tag as a mono id and lets a long withheld chip shrink to the row', async () => {
    serve({ scheduled: [note({ deniedTerm: 'a-very-long-denylisted-term-that-would-overflow-a-phone-row' })] });
    renderTab();

    const tag = await screen.findByTestId('release-notes-row-tag');
    expect(tag).toHaveTextContent('v1.0.0');
    expect(tag).toHaveClass('MuiTypography-body-xs');
    expect(getComputedStyle(tag).fontFamily).toContain('--joy-fontFamily-code');
    expect(screen.getByTestId('release-notes-denied-chip')).toHaveStyle({ maxWidth: '100%' });
  });

  it('keeps the previous rows on screen under an updating bar while a new filter loads', async () => {
    let releasePublished: () => void = () => undefined;
    mockGet.mockImplementation(async (url: string, opts?: { params?: { status: string } }) => {
      if (url.endsWith('/config')) return { data: { config, malformed: false } };
      if (opts?.params?.status === 'published') {
        await new Promise<void>(resolve => (releasePublished = resolve));
        return {
          data: { data: [note({ id: 'p1', state: 'published', headline: 'Published one' })], next_cursor: null },
        };
      }
      return { data: { data: [note({ headline: 'Scheduled one' })], next_cursor: null } };
    });
    renderTab();
    expect(await screen.findByText('Scheduled one')).toBeTruthy();
    expect(screen.queryByTestId('release-notes-updating')).toBeNull();
    expect(screen.getByText('Goes live in 5h')).toBeTruthy();

    fireEvent.click(screen.getByTestId('release-notes-filter-published-btn'));
    expect(await screen.findByTestId('release-notes-updating')).toBeTruthy();
    expect(screen.getByText('Scheduled one')).toBeTruthy();
    expect(screen.getByText('Goes live in 5h')).toBeTruthy();
    expect(screen.queryByTestId('release-notes-loading')).toBeNull();

    releasePublished();
    expect(await screen.findByText('Published one')).toBeTruthy();
    expect(screen.queryByText('Scheduled one')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('release-notes-updating')).toBeNull());
  });

  it('shows loading when switching from an empty list while a new filter loads', async () => {
    let releasePublished: () => void = () => undefined;
    mockGet.mockImplementation(async (url: string, opts?: { params?: { status: string } }) => {
      if (url.endsWith('/config')) return { data: { config, malformed: false } };
      if (opts?.params?.status === 'published') {
        await new Promise<void>(resolve => (releasePublished = resolve));
        return {
          data: { data: [note({ id: 'p1', state: 'published', headline: 'Published one' })], next_cursor: null },
        };
      }
      return { data: { data: [], next_cursor: null } };
    });
    renderTab();
    expect(await screen.findByText('No scheduled release notes')).toBeTruthy();

    fireEvent.click(screen.getByTestId('release-notes-filter-published-btn'));
    expect(await screen.findByTestId('release-notes-loading')).toBeTruthy();
    expect(screen.queryByText('No published release notes')).toBeNull();

    releasePublished();
    expect(await screen.findByText('Published one')).toBeTruthy();
    expect(screen.queryByTestId('release-notes-loading')).toBeNull();
  });

  it('refreshes countdowns for all retained rows when another page arrives', async () => {
    const initialTime = new Date('2026-11-09T00:00:00Z').getTime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(initialTime);
    const firstNote = note({});
    mockGet.mockImplementation(async (url: string, opts?: { params?: { cursor?: string } }) => {
      if (url.endsWith('/config')) return { data: { config, malformed: false } };
      if (opts?.params?.cursor === 'c2') {
        return { data: { data: [note({ id: 'n2' })], next_cursor: null } };
      }
      return { data: { data: [firstNote], next_cursor: 'c2' } };
    });
    renderTab();
    expect(await screen.findByText('Goes live in 5h')).toBeTruthy();

    clock.mockReturnValue(initialTime + 2 * 60 * 60 * 1000);
    fireEvent.click(screen.getByTestId('release-notes-load-more-btn'));

    expect(await screen.findByText('Goes live in 3h')).toBeTruthy();
    expect(screen.getByText('Goes live in 5h')).toBeTruthy();
    expect(screen.getAllByTestId('release-notes-row')).toHaveLength(2);
  });

  it('keeps the rows and shows the error above them when a later page fails to load', async () => {
    mockGet.mockImplementation(async (url: string, opts?: { params?: { cursor?: string } }) => {
      if (url.endsWith('/config')) return { data: { config, malformed: false } };
      if (opts?.params?.cursor === 'c2') throw new Error('Service unavailable');
      return { data: { data: [note({})], next_cursor: 'c2' } };
    });
    renderTab();

    fireEvent.click(await screen.findByTestId('release-notes-load-more-btn'));
    const listError = await screen.findByTestId('release-notes-list-error');
    expect(listError.textContent).toContain('Service unavailable');
    expect(screen.getByTestId('release-notes-row')).toBeTruthy();
    expect(screen.queryByTestId('admin-error-state')).toBeNull();
    expect(within(listError).getByTestId('release-notes-list-retry-btn')).toBeTruthy();
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
