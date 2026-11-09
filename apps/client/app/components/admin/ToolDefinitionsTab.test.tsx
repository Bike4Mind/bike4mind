import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, put: mocks.put, delete: mocks.delete },
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({
  default: ({ helpId }: { helpId: string }) => <span data-testid="context-help" data-help-id={helpId} />,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));

import ToolDefinitionsTab from './ToolDefinitionsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const tool = (overrides: Record<string, unknown>) => ({
  description: 'Full description of the tool',
  parameters: { type: 'object' },
  version: 0,
  source: 'code',
  hasOverride: false,
  usageCount: 0,
  successCount: 0,
  errorCount: 0,
  lastUsedAt: null,
  enabled: true,
  ...overrides,
});
const TOOLS = [
  tool({
    toolId: 'weather_info',
    toolName: 'Weather Info',
    shortDescription: 'Looks up the weather for a place',
    category: 'Utility',
    tags: ['weather', 'data', 'search'],
  }),
  tool({
    toolId: 'github_search',
    toolName: 'Search Code',
    shortDescription: 'Searches code in a repository',
    category: 'MCP: Github',
    tags: ['search'],
    enabled: false,
    version: 2,
    source: 'database',
    hasOverride: true,
    usageCount: 40,
    successCount: 30,
  }),
];
const LIST_URL = '/api/admin/tool-definitions?';
const listResponse = (tools: unknown[], total = tools.length) => ({
  data: {
    tools,
    total,
    categories: ['MCP: Github', 'Utility'],
    pagination: { page: 1, limit: 50, totalPages: Math.ceil(total / 50), hasNextPage: total > 50, hasPrevPage: false },
  },
});

const respondWith = (list: () => Promise<unknown> = () => Promise.resolve(listResponse(TOOLS))) =>
  mocks.get.mockImplementation((url: string) =>
    url.startsWith(LIST_URL) ? list() : Promise.reject(new Error(`unexpected GET ${url}`))
  );
const listCalls = () => mocks.get.mock.calls.map(([url]) => url as string).filter(url => url.startsWith(LIST_URL));

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <ToolDefinitionsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const openRowMenu = async (toolId: string) => fireEvent.click(await screen.findByTestId(`tool-row-actions-${toolId}`));

describe('ToolDefinitionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respondWith();
    mocks.put.mockImplementation((url: string, body: object) =>
      Promise.resolve({ data: { toolId: url.split('/').pop(), ...body } })
    );
    mocks.delete.mockResolvedValue({ data: { toolId: 'github_search' } });
  });

  it('opens with the Tools page header: a sentence-case h1 with the count, help and Refresh', async () => {
    renderTab();

    const header = await screen.findByTestId('admin-page-header');
    expect(screen.getByTestId('admin-tool-definitions-tab').firstElementChild).toBe(header);
    const title = within(header).getByRole('heading', { level: 1 });
    await waitFor(() => expect(title.textContent).toBe('Tools (2)'));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByTestId('context-help')).toHaveAttribute('data-help-id', 'admin/tool-definitions');
    expect(within(header).getByTestId('tools-refresh-btn')).toHaveTextContent('Refresh');
  });

  it('refetches the list from the header Refresh button', async () => {
    renderTab();
    await screen.findByTestId('tool-row-weather_info');

    fireEvent.click(screen.getByTestId('tools-refresh-btn'));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1]).toBe(`${LIST_URL}enabled=all&page=1&limit=50`);
  });

  it('keeps the rows on screen under the updating bar while a refetch runs', async () => {
    renderTab();
    await screen.findByTestId('tool-row-weather_info');
    expect(screen.queryByTestId('tools-updating-bar')).toBeNull();

    respondWith(() => new Promise(() => {}));
    fireEvent.click(screen.getByTestId('tools-refresh-btn'));

    expect(await screen.findByTestId('tools-updating-bar')).toBeInTheDocument();
    expect(screen.getByTestId('tool-row-weather_info')).toBeInTheDocument();
  });

  it('lists the tools one level deep in a DataTable with a 68rem minWidth and one-line names', async () => {
    const { container } = renderTab();

    const table = await screen.findByTestId('tools-table');
    expect(table).toHaveStyle({ minWidth: '68rem' });
    expect(table).toContainElement(await screen.findByTestId('tool-row-weather_info'));
    expect(screen.getByTestId('tool-name-weather_info')).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(container.querySelectorAll('.MuiCard-root')).toHaveLength(0);
  });

  it('shows status as a chip instead of green and red icons', async () => {
    renderTab();

    const enabled = await screen.findByTestId('tool-status-weather_info');
    expect(enabled).toHaveTextContent('Enabled');
    expect(enabled).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('tool-status-github_search')).toHaveTextContent('Disabled');
    expect(screen.getByTestId('tool-status-github_search')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('tool-source-github_search')).toHaveTextContent('DB');
    expect(screen.getByTestId('tool-source-github_search')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.queryByTestId('CheckCircleIcon')).toBeNull();
    expect(screen.queryByTestId('CancelIcon')).toBeNull();
  });

  it('keeps the row actions in a "..." menu instead of icons in every row', async () => {
    renderTab();
    const row = await screen.findByTestId('tool-row-weather_info');

    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).getByTestId('tool-row-actions-weather_info')).toHaveAttribute(
      'aria-label',
      'Actions for Weather Info'
    );
  });

  it('narrows with a FilterBar, search first, and sends the same query parameters', async () => {
    renderTab();
    await screen.findByTestId('tool-row-weather_info');
    expect(listCalls()).toEqual([`${LIST_URL}enabled=all&page=1&limit=50`]);

    const bar = screen.getByTestId('admin-filter-bar');
    expect(bar.firstElementChild).toContainElement(screen.getByTestId('admin-filter-search-input'));
    expect(screen.getByTestId('admin-filter-search-input')).toHaveAttribute(
      'aria-label',
      'Search name, description or tags'
    );

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'weather' } });
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=all&search=weather&page=1&limit=50`));

    fireEvent.click(screen.getByTestId('admin-filter-tool-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-tool-status-false'));
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=false&search=weather&page=1&limit=50`));

    fireEvent.click(screen.getByTestId('admin-filter-tool-category'));
    fireEvent.click(await screen.findByTestId('admin-filter-tool-category-Utility'));
    await waitFor(() =>
      expect(listCalls()).toContain(`${LIST_URL}category=Utility&enabled=false&search=weather&page=1&limit=50`)
    );
  });

  it('opens the edit dialog from the row menu with the tool in its description and saves the same payload', async () => {
    renderTab();
    await openRowMenu('weather_info');
    fireEvent.click(await screen.findByTestId('tool-row-edit-weather_info'));

    const dialog = await screen.findByTestId('tool-edit-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Edit tool');
    expect(within(dialog).getByTestId('tool-edit-name')).toHaveTextContent('Weather Info');
    const short = within(dialog).getByTestId('tool-edit-short-description-input');
    expect(short).toHaveValue('Looks up the weather for a place');
    expect(within(dialog).getByTestId('tool-edit-description-input')).toHaveValue('Full description of the tool');
    expect(within(dialog).getByTestId('tool-edit-save-btn')).toBeDisabled();

    fireEvent.change(short, { target: { value: 'Current weather and forecast for a place' } });
    fireEvent.click(within(dialog).getByTestId('tool-edit-save-btn'));

    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/admin/tool-definitions/weather_info', {
        description: 'Full description of the tool',
        shortDescription: 'Current weather and forecast for a place',
        enabled: true,
      })
    );
    await waitFor(() => expect(screen.queryByTestId('tool-edit-dialog')).toBeNull());
  });

  it('opens the details of the tool whose menu was used', async () => {
    renderTab();
    await openRowMenu('github_search');
    fireEvent.click(await screen.findByTestId('tool-row-view-github_search'));

    const dialog = await screen.findByTestId('tool-view-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Search Code');
    expect(within(dialog).getByTestId('tool-view-id')).toHaveTextContent('github_search');
    expect(within(dialog).getByTestId('tool-view-status')).toHaveAttribute('data-tone', 'neutral');
    expect(within(dialog).queryByTestId('tool-view-no-tags')).toBeNull();
  });

  it('says No tags in the details of a tool with an empty tag list', async () => {
    respondWith(() => Promise.resolve(listResponse([{ ...TOOLS[0], tags: [] }])));
    renderTab();
    await openRowMenu('weather_info');
    fireEvent.click(await screen.findByTestId('tool-row-view-weather_info'));

    const dialog = await screen.findByTestId('tool-view-dialog');
    expect(within(dialog).getByTestId('tool-view-no-tags')).toHaveTextContent('No tags');
  });

  it('offers revert only for an override and confirms it in an alert dialog that sends the same request', async () => {
    renderTab();
    await openRowMenu('weather_info');
    await screen.findByTestId('tool-row-edit-weather_info');
    expect(screen.queryByTestId('tool-row-revert-weather_info')).toBeNull();

    await openRowMenu('github_search');
    fireEvent.click(await screen.findByTestId('tool-row-revert-github_search'));

    const dialog = await screen.findByTestId('tool-revert-dialog');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveTextContent('Search Code');
    fireEvent.click(within(dialog).getByTestId('tool-revert-confirm-btn'));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/api/admin/tool-definitions/github_search'));
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('tool-revert-dialog')).toBeNull());
  });

  it('keeps the revert confirm open on Esc and the X while the revert is in flight', async () => {
    mocks.delete.mockReturnValue(new Promise(() => {}));
    renderTab();
    await openRowMenu('github_search');
    fireEvent.click(await screen.findByTestId('tool-row-revert-github_search'));
    const dialog = await screen.findByTestId('tool-revert-dialog');
    fireEvent.click(within(dialog).getByTestId('tool-revert-confirm-btn'));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(dialog).getByTestId('tool-revert-dialog-close-btn'));
    expect(screen.getByTestId('tool-revert-dialog')).toBeInTheDocument();
    expect(within(dialog).getByTestId('tool-revert-cancel-btn')).toBeDisabled();
  });

  it('pages on the server from the table footer', async () => {
    respondWith(() => Promise.resolve(listResponse(TOOLS, 120)));
    renderTab();
    await screen.findByTestId('tool-row-weather_info');

    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 2 of 120');
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=all&page=2&limit=50`));
  });

  it('sends the page size picked in the table footer as the limit', async () => {
    respondWith(() => Promise.resolve(listResponse(TOOLS, 120)));
    renderTab();
    await screen.findByTestId('tool-row-weather_info');

    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(await screen.findByTestId('admin-table-page-size-25'));
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=all&page=1&limit=25`));
  });

  it('goes back to page 1 when a filter changes', async () => {
    respondWith(() => Promise.resolve(listResponse(TOOLS, 120)));
    renderTab();
    await screen.findByTestId('tool-row-weather_info');
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=all&page=2&limit=50`));

    fireEvent.click(screen.getByTestId('admin-filter-tool-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-tool-status-false'));
    await waitFor(() => expect(listCalls().at(-1)).toBe(`${LIST_URL}enabled=false&page=1&limit=50`));
  });

  it('waits for a 300 ms pause in typing, then searches once with the last term', async () => {
    renderTab();
    await screen.findByTestId('tool-row-weather_info');
    const searches = () => listCalls().filter(url => url.includes('search='));

    vi.useFakeTimers();
    try {
      const input = screen.getByTestId('admin-filter-search-input');
      fireEvent.change(input, { target: { value: 'w' } });
      await act(() => vi.advanceTimersByTimeAsync(100));
      fireEvent.change(input, { target: { value: 'we' } });
      await act(() => vi.advanceTimersByTimeAsync(100));
      fireEvent.change(input, { target: { value: 'wea' } });
      await act(() => vi.advanceTimersByTimeAsync(299));
      expect(searches()).toEqual([]);

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(searches()).toEqual([`${LIST_URL}enabled=all&search=wea&page=1&limit=50`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers Clear filters when the filters match nothing', async () => {
    renderTab();
    await screen.findByTestId('tool-row-weather_info');
    respondWith(() => Promise.resolve(listResponse([])));

    fireEvent.click(screen.getByTestId('admin-filter-tool-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-tool-status-true'));

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No tools match these filters');
    fireEvent.click(within(empty).getByTestId('tools-empty-clear-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('admin-filter-tool-status')).toHaveAttribute('aria-label', 'Filter by Status')
    );
  });

  it('clears the search with the other filters in one step, with no request for the stale term', async () => {
    renderTab();
    await screen.findByTestId('tool-row-weather_info');
    respondWith(() => Promise.resolve(listResponse([])));

    fireEvent.click(screen.getByTestId('admin-filter-tool-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-tool-status-true'));
    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'zzz' } });
    await waitFor(() => expect(listCalls()).toContain(`${LIST_URL}enabled=true&search=zzz&page=1&limit=50`));
    fireEvent.click(within(await screen.findByTestId('admin-empty-state')).getByTestId('tools-empty-clear-btn'));

    // The unfiltered list is already cached from the first load, so it shows without a new request.
    expect(await screen.findByTestId('tool-row-weather_info')).toBeInTheDocument();
    expect(screen.getByTestId('admin-filter-search-input')).toHaveValue('');
    expect(listCalls()).not.toContain(`${LIST_URL}enabled=all&search=zzz&page=1&limit=50`);
  });

  it('shows the table skeleton on first load and ErrorState with Try again on a failure', async () => {
    respondWith(() => new Promise(() => {}));
    const { unmount } = renderTab();
    expect(await screen.findAllByTestId('admin-table-skeleton-row')).not.toHaveLength(0);
    unmount();

    respondWith(() => Promise.reject(new Error('boom')));
    renderTab();
    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Could not load the tools.');
    respondWith();
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('tool-row-weather_info')).toBeInTheDocument();
  });
});
