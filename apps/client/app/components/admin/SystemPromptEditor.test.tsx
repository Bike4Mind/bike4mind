import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.delete },
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import SystemPromptEditor from './SystemPromptEditor';

const appTheme = extendTheme({ ...getThemeConfig() });

const STAMP = '2026-10-01T00:00:00.000Z';
const PROMPTS = [
  {
    promptId: 'optimizer_system',
    name: 'Optimizer system prompt',
    description: 'Sets how the optimizer behaves',
    content: 'You are the optimizer.',
    category: 'system',
    tags: ['system-message', 'optimizer', 'scheduling', 'extra'],
    variables: ['userName'],
    enabled: true,
    version: 3,
    activeVersion: 3,
    hasOverride: true,
    hasCodeDefault: true,
    divergesFromCodeDefault: true,
    source: 'db',
    usageCount: 1200,
    successCount: 1188,
    lastUpdatedByName: 'Admin',
    createdAt: STAMP,
    updatedAt: STAMP,
  },
  {
    promptId: 'briefing_main',
    name: 'Briefing main prompt',
    description: 'Carries the briefing data',
    content: 'Summarize {{data}}.',
    category: 'automation',
    tags: ['user-message'],
    variables: ['data'],
    enabled: false,
    version: 0,
    hasOverride: false,
    hasCodeDefault: true,
    source: 'code',
    createdAt: STAMP,
    updatedAt: STAMP,
  },
  {
    promptId: 'custom_db_only',
    name: 'Custom prompt',
    description: 'Only lives in the database',
    content: 'Custom.',
    category: 'admin',
    tags: ['custom'],
    variables: [],
    enabled: true,
    version: 1,
    activeVersion: 1,
    hasOverride: true,
    hasCodeDefault: false,
    source: 'db',
    usageCount: 0,
    successCount: 0,
    lastUpdatedByName: 'Admin',
    createdAt: STAMP,
    updatedAt: STAMP,
  },
];

const LIST_URL = '/api/admin/system-prompts?';
const listResponse = (data: unknown[]) => ({ data: { success: true, data, count: data.length } });
const historyResponse = { data: { success: true, data: { history: [], defaultPrompt: null, currentVersion: 3 } } };

const respondWith = (list: () => Promise<unknown> = () => Promise.resolve(listResponse(PROMPTS))) =>
  mocks.get.mockImplementation((url: string) => {
    if (url.startsWith(LIST_URL)) return list();
    if (url.endsWith('/history')) return Promise.resolve(historyResponse);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

const listCalls = () => mocks.get.mock.calls.map(([url]) => url as string).filter(url => url.startsWith(LIST_URL));

const renderEditor = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <SystemPromptEditor
          renderHeader={header => (
            <div data-testid="test-header" data-count={header.count ?? ''}>
              <button type="button" data-testid="test-header-refresh" onClick={header.onRefresh} />
              <button type="button" data-testid="test-header-new" onClick={header.onCreate} />
            </div>
          )}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const openRowMenu = async (promptId: string) =>
  fireEvent.click(await screen.findByTestId(`system-prompt-row-actions-${promptId}`));

describe('SystemPromptEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respondWith();
    mocks.post.mockResolvedValue({ data: { success: true, data: {}, message: 'ok' } });
    mocks.delete.mockResolvedValue({ data: { success: true, message: 'deleted' } });
  });

  it('lists the prompts in a DataTable wide enough that no column crushes at 768 px', async () => {
    const { container } = renderEditor();

    const table = await screen.findByTestId('system-prompts-table');
    expect(table).toHaveStyle({ minWidth: '70rem' });
    expect(table).toContainElement(await screen.findByTestId('system-prompt-row-optimizer_system'));
    expect(screen.getByTestId('system-prompt-name-optimizer_system')).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(container.querySelectorAll('.MuiCard-root')).toHaveLength(0);
    expect(screen.getByTestId('test-header')).toHaveAttribute('data-count', '3');
  });

  it('shows status, source, role and drift as admin status chips', async () => {
    renderEditor();

    const enabled = await screen.findByTestId('system-prompt-status-optimizer_system');
    expect(enabled).toHaveTextContent('Enabled');
    expect(enabled).toHaveAttribute('data-tone', 'good');
    const disabled = screen.getByTestId('system-prompt-status-briefing_main');
    expect(disabled).toHaveTextContent('Disabled');
    expect(disabled).toHaveAttribute('data-tone', 'neutral');

    expect(screen.getByTestId('system-prompt-source-optimizer_system')).toHaveTextContent('DB');
    expect(screen.getByTestId('system-prompt-source-optimizer_system')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('system-prompt-source-briefing_main')).toHaveTextContent('Code');
    expect(screen.getByTestId('system-prompt-role-optimizer_system')).toHaveTextContent('System');
    expect(screen.getByTestId('system-prompt-role-optimizer_system')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('system-prompt-role-briefing_main')).toHaveTextContent('Main');
    expect(screen.getByTestId('system-prompt-diverged-optimizer_system')).toHaveAttribute('data-tone', 'warn');
  });

  it('keeps view, edit and delete out of the row until its "..." menu opens', async () => {
    renderEditor();
    const row = await screen.findByTestId('system-prompt-row-optimizer_system');

    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).getByTestId('system-prompt-row-actions-optimizer_system')).toHaveAttribute(
      'aria-label',
      'Actions for Optimizer system prompt'
    );
  });

  it('opens the details of the prompt whose menu was used', async () => {
    renderEditor();
    await openRowMenu('briefing_main');
    fireEvent.click(await screen.findByTestId('system-prompt-row-view-briefing_main'));

    const dialog = await screen.findByTestId('system-prompt-view-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Briefing main prompt');
    expect(within(dialog).getByTestId('system-prompt-view-id')).toHaveTextContent('briefing_main');
    expect(within(dialog).getByTestId('system-prompt-view-status')).toHaveAttribute('data-tone', 'neutral');
  });

  it('opens the edit dialog with the prompt in its description and its fields filled in', async () => {
    renderEditor();
    await openRowMenu('optimizer_system');
    const edit = await screen.findByTestId('system-prompt-row-edit-optimizer_system');
    expect(edit).toHaveTextContent('Edit override');
    fireEvent.click(edit);

    const dialog = await screen.findByTestId('system-prompt-edit-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Edit prompt');
    expect(within(dialog).getByTestId('system-prompt-edit-name')).toHaveTextContent('Optimizer system prompt');
    expect(within(dialog).getByTestId('system-prompt-name-input')).toHaveValue('Optimizer system prompt');
    expect(within(dialog).getByTestId('system-prompt-content-input')).toHaveValue('You are the optimizer.');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/system-prompts/optimizer_system/history'));
  });

  it('offers delete only for a DB-only prompt and confirms it in an alert dialog that sends the same request', async () => {
    renderEditor();
    await openRowMenu('optimizer_system');
    await screen.findByTestId('system-prompt-row-view-optimizer_system');
    expect(screen.queryByTestId('system-prompt-delete-btn-optimizer_system')).toBeNull();

    await openRowMenu('custom_db_only');
    fireEvent.click(await screen.findByTestId('system-prompt-delete-btn-custom_db_only'));

    const dialog = await screen.findByTestId('system-prompt-delete-dialog');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveTextContent('Custom prompt');
    const confirm = within(dialog).getByTestId('system-prompt-delete-confirm-btn');
    expect(confirm).toHaveTextContent('Delete prompt');
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/api/admin/system-prompts/custom_db_only'));
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('system-prompt-delete-dialog')).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('System prompt "Custom prompt" deleted');
  });

  it('narrows with a FilterBar, search first, and sends the same query parameters', async () => {
    renderEditor();
    await screen.findByTestId('system-prompt-row-optimizer_system');
    expect(listCalls()).toEqual([`${LIST_URL}enabled=all`]);

    const bar = screen.getByTestId('admin-filter-bar');
    expect(bar.firstElementChild).toContainElement(screen.getByTestId('admin-filter-search-input'));

    fireEvent.click(screen.getByTestId('admin-filter-prompt-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-prompt-status-false'));
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=false`));

    fireEvent.click(screen.getByTestId('admin-filter-prompt-source'));
    fireEvent.click(await screen.findByTestId('admin-filter-prompt-source-db'));
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=false&source=db`));

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'brief' } });
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=false&search=brief&source=db`));

    fireEvent.click(screen.getByTestId('admin-filter-prompt-category'));
    fireEvent.click(await screen.findByTestId('admin-filter-prompt-category-automation'));
    await waitFor(() =>
      expect(listCalls()).toContain(`${LIST_URL}category=automation&enabled=false&search=brief&source=db`)
    );
  });

  it('offers Clear filters when the filters match nothing, and New prompt when there are no prompts', async () => {
    respondWith(() => Promise.resolve(listResponse([])));
    renderEditor();

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No system prompts yet');
    fireEvent.click(within(empty).getByTestId('system-prompts-empty-new-btn'));
    const dialog = await screen.findByTestId('system-prompt-edit-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('New prompt');
    fireEvent.click(within(dialog).getByTestId('system-prompt-edit-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('system-prompt-edit-dialog')).toBeNull());

    fireEvent.click(screen.getByTestId('admin-filter-prompt-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-prompt-status-true'));
    const filtered = await screen.findByText('No prompts match these filters');
    fireEvent.click(
      within(filtered.closest('[data-testid="admin-empty-state"]') as HTMLElement).getByTestId(
        'system-prompts-empty-clear-btn'
      )
    );
    await waitFor(() => expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No system prompts yet'));
    expect(screen.getByTestId('admin-filter-prompt-status')).toHaveAttribute('aria-label', 'Filter by Status');
  });

  it('shows the table skeleton on first load', async () => {
    respondWith(() => new Promise(() => {}));
    renderEditor();

    expect(await screen.findAllByTestId('admin-table-skeleton-row')).not.toHaveLength(0);
    expect(screen.getByTestId('system-prompts-table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('test-header')).toHaveAttribute('data-count', '');
  });

  it('keeps the rows on screen under the updating bar while a refetch runs', async () => {
    renderEditor();
    await screen.findByTestId('system-prompt-row-optimizer_system');
    expect(screen.queryByTestId('system-prompts-updating-bar')).toBeNull();

    respondWith(() => new Promise(() => {}));
    fireEvent.click(screen.getByTestId('test-header-refresh'));

    expect(await screen.findByTestId('system-prompts-updating-bar')).toBeInTheDocument();
    expect(screen.getByTestId('system-prompt-row-optimizer_system')).toBeInTheDocument();
  });

  it('shows ErrorState with Try again when the list fails to load', async () => {
    respondWith(() => Promise.reject(new Error('boom')));
    renderEditor();

    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Could not load system prompts.');
    respondWith();
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('system-prompt-row-optimizer_system')).toBeInTheDocument();
  });

  it('creates a prompt from the header action with the same payload', async () => {
    renderEditor();
    await screen.findByTestId('system-prompt-row-optimizer_system');
    fireEvent.click(screen.getByTestId('test-header-new'));

    const dialog = await screen.findByTestId('system-prompt-edit-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('New prompt');
    fireEvent.change(within(dialog).getByTestId('system-prompt-id-input'), { target: { value: 'weekly_digest' } });
    fireEvent.change(within(dialog).getByTestId('system-prompt-name-input'), { target: { value: 'Weekly digest' } });
    fireEvent.change(within(dialog).getByTestId('system-prompt-description-input'), {
      target: { value: 'Summarizes the week' },
    });
    fireEvent.change(within(dialog).getByTestId('system-prompt-content-input'), {
      target: { value: 'Summarize {{week}}.' },
    });
    fireEvent.click(within(dialog).getByTestId('system-prompt-create-btn'));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/system-prompts', {
        promptId: 'weekly_digest',
        name: 'Weekly digest',
        description: 'Summarizes the week',
        content: 'Summarize {{week}}.',
        category: 'system',
        tags: ['system'],
        variables: [],
        enabled: true,
      })
    );
    await waitFor(() => expect(screen.queryByTestId('system-prompt-edit-dialog')).toBeNull());
  });
});
