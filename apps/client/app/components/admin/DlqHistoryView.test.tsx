import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '@client/app/contexts/ApiContext';
import { getThemeConfig } from '@client/app/utils/themes';
import { DlqHistoryView } from './DlqHistoryView';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
const get = vi.mocked(api.get);
const theme = extendTheme({ ...getThemeConfig() });
const entry = (index: number) => ({
  id: `log-${index}`,
  messageId: `entity-${index}`,
  queueLabel: 'quest',
  sourceQueue: 'Quest Export',
  status: 'discarded',
  operation: 'discard',
  reason: 'Obsolete job',
  replayedBy: 'admin-1',
  replayedByName: 'admin@example.test',
  createdAt: '2026-11-01T12:00:00.000Z',
});
function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>
        <DlqHistoryView queues={[]} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}
beforeEach(() => vi.clearAllMocks());

it('loads cursor pages beyond 200 and displays them through the shared table pager', async () => {
  get.mockImplementation(async (_url, options) => {
    const cursor = Number((options?.params as Record<string, string>)?.cursor ?? 0);
    const end = Math.min(cursor + 50, 225);
    return {
      data: {
        history: Array.from({ length: end - cursor }, (_, index) => entry(cursor + index)),
        nextCursor: end < 225 ? String(end) : null,
      },
    };
  });
  renderHistory();
  await screen.findByTestId('dlq-history-row-log-0');
  expect(
    within(screen.getByTestId('dlq-history-table'))
      .getAllByRole('columnheader')
      .map(node => node.textContent)
  ).toEqual(['Time', 'Action', 'Feature', 'Entity', 'Reason', 'By', 'Result']);
  for (let index = 0; index < 4; index++) {
    fireEvent.click(screen.getByTestId('dlq-history-load-more'));
    await waitFor(() =>
      expect(screen.getByTestId('admin-table-range')).toHaveTextContent(`of ${Math.min(100 + index * 50, 225)}`)
    );
  }
  expect(screen.queryByTestId('dlq-history-load-more')).not.toBeInTheDocument();
  for (let index = 0; index < 8; index++) fireEvent.click(screen.getByTestId('admin-table-next-btn'));
  const row = within(screen.getByTestId('dlq-history-row-log-224'));
  expect(row.getByText('entity-224')).toBeInTheDocument();
  expect(row.getByText('Obsolete job')).toBeInTheDocument();
  expect(get).toHaveBeenLastCalledWith('/api/admin/dlq/history', { params: { cursor: '200' } });
});

it('resets cursor pages and table position when searching, then clears the search', async () => {
  get.mockResolvedValue({
    data: { history: Array.from({ length: 50 }, (_, index) => entry(index)), nextCursor: 'next' },
  });
  renderHistory();
  await screen.findByTestId('dlq-history-row-log-0');
  fireEvent.click(screen.getByTestId('admin-table-next-btn'));
  expect(screen.getByTestId('dlq-history-row-log-25')).toBeInTheDocument();
  fireEvent.change(screen.getByTestId('dlq-history-search'), { target: { value: 'Obsolete' } });
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith('/api/admin/dlq/history', { params: { search: 'Obsolete' } })
  );
  await screen.findByTestId('dlq-history-row-log-0');
  fireEvent.click(screen.getByTestId('dlq-history-clear-filters'));
  await waitFor(() => expect(screen.getByTestId('dlq-history-search')).toHaveValue(''));
});

it('preserves loaded rows and retries the same cursor after a load-more failure', async () => {
  get
    .mockResolvedValueOnce({ data: { history: [entry(0)], nextCursor: 'next' } })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ data: { history: [entry(1)], nextCursor: null } });
  renderHistory();
  await screen.findByTestId('dlq-history-row-log-0');
  fireEvent.click(screen.getByTestId('dlq-history-load-more'));
  await screen.findByRole('alert');
  expect(screen.getByTestId('dlq-history-row-log-0')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('dlq-history-load-more'));
  await screen.findByTestId('dlq-history-row-log-1');
  expect(get).toHaveBeenLastCalledWith('/api/admin/dlq/history', { params: { cursor: 'next' } });
});

it('copies the complete entity ID while retaining its history ID', async () => {
  const messageId = 'full-dead-letter-message-identifier-beyond-twenty-characters';
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  try {
    get.mockResolvedValue({ data: { history: [{ ...entry(0), messageId }], nextCursor: null } });
    renderHistory();
    const row = await screen.findByTestId('dlq-history-row-log-0');
    expect(within(row).getByText(messageId)).toBeInTheDocument();
    expect(within(row).getByTitle('History ID: log-0')).toBeInTheDocument();
    fireEvent.click(within(row).getByTestId('dlq-history-copy-id-log-0'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(messageId));
  } finally {
    vi.unstubAllGlobals();
  }
});
