import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { todayUtc } from '@client/app/utils/dateUtils';

type HistoryResult = {
  data:
    { data: Record<string, unknown>[]; meta: { currentPage: number; totalPages: number; total: number } } | undefined;
  isLoading: boolean;
  isError: boolean;
};

const emptyHistory = (): HistoryResult => ({
  data: { data: [], meta: { currentPage: 1, totalPages: 0, total: 0 } },
  isLoading: false,
  isError: false,
});

const mocks = vi.hoisted(() => ({
  lastParams: undefined as Record<string, unknown> | undefined,
  result: undefined as unknown,
  refetch: vi.fn(),
}));

vi.mock('@client/app/hooks/data/emailMarketing', () => ({
  useEmailJobHistory: (_jobId: string | undefined, params: Record<string, unknown>) => {
    mocks.lastParams = params;
    return { ...(mocks.result as object), refetch: mocks.refetch };
  },
}));

const attempt = (id: string, status = 'sent') => ({
  id,
  status,
  recipientEmail: `${id}@example.com`,
  renderedSubject: `Subject ${id}`,
  createdAt: '2026-06-15T12:00:00Z',
  isTestEmail: false,
});

const pageOf = (count: number, total: number, page = 1): HistoryResult => ({
  data: {
    data: Array.from({ length: count }, (_, i) => attempt(`a${(page - 1) * 25 + i + 1}`)),
    meta: { currentPage: page, totalPages: Math.ceil(total / 25), total },
  },
  isLoading: false,
  isError: false,
});

import EmailActivityHistory from './EmailActivityHistory';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderHistory = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EmailActivityHistory jobId="job-1" onViewAttempt={vi.fn()} />
    </CssVarsProvider>
  );

describe('EmailActivityHistory date bounds', () => {
  beforeEach(() => {
    mocks.lastParams = undefined;
    mocks.result = emptyHistory();
  });

  it('starts with the last 30 days set and sends both bounds', () => {
    // Midday UTC keeps the local day equal to the UTC day in every zone the suite runs in.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    try {
      renderHistory();
      expect(screen.getByTestId('email-activity-start-date')).toHaveValue('2026-05-16');
      expect(screen.getByTestId('email-activity-end-date')).toHaveValue('2026-06-15');
      expect(mocks.lastParams).toMatchObject({ startDate: '2026-05-16', endDate: '2026-06-15' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the empty label and omits a bound once it is cleared, then sends it again when set', () => {
    renderHistory();
    fireEvent.click(screen.getByTestId('email-activity-start-date-clear-btn'));
    expect(screen.getByTestId('email-activity-start-date-empty')).toHaveTextContent('From any date');
    expect(mocks.lastParams?.startDate).toBe('');

    fireEvent.click(screen.getByTestId('email-activity-start-date-set-btn'));
    expect(mocks.lastParams?.startDate).toBe(todayUtc());
  });
});

describe('EmailActivityHistory table', () => {
  beforeEach(() => {
    mocks.lastParams = undefined;
    mocks.refetch.mockClear();
    mocks.result = emptyHistory();
  });

  it('requests the first page at the admin default page size', () => {
    renderHistory();
    expect(mocks.lastParams).toMatchObject({ page: 1, limit: 25 });
  });

  it('renders rows in the activity table and pages through the server results', () => {
    mocks.result = pageOf(25, 30);
    renderHistory();
    const table = screen.getByTestId('email-activity-table-frame');
    expect(within(table).getByText('a1@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 25 of 30');

    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(mocks.lastParams).toMatchObject({ page: 2, limit: 25 });
  });

  it('sizes the Time column for the full locale timestamp', () => {
    mocks.result = pageOf(1, 1);
    renderHistory();
    const table = screen.getByTestId('email-activity-table');
    const width = within(table).getByRole('columnheader', { name: 'Time' }).style.width;
    expect(width).toMatch(/^[\d.]+rem$/);
    expect(parseFloat(width)).toBeGreaterThanOrEqual(13.5);
    expect(getComputedStyle(table).minWidth).toBe('74.5rem');
    expect(within(table).getByText(new Date('2026-06-15T12:00:00Z').toLocaleString())).toBeInTheDocument();
  });

  it('goes back to page 1 when the status filter changes', () => {
    mocks.result = pageOf(25, 30);
    renderHistory();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(mocks.lastParams?.page).toBe(2);

    fireEvent.click(screen.getByRole('combobox', { name: /status/i }));
    fireEvent.click(screen.getByRole('option', { name: 'Failed' }));
    expect(mocks.lastParams).toMatchObject({ page: 1, status: 'failed' });
  });

  it('shows the error state when the first load fails, and retry refetches', () => {
    mocks.result = { data: undefined, isLoading: false, isError: true };
    renderHistory();
    expect(screen.getByTestId('admin-error-state')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('shows skeleton rows while the previous page stands in for the next one', () => {
    mocks.result = { ...pageOf(2, 2), isPlaceholderData: true };
    renderHistory();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByText('a1@example.com')).not.toBeInTheDocument();
  });

  it('keeps the rows on screen when a background refetch fails', () => {
    mocks.result = { ...pageOf(2, 2), isError: true };
    renderHistory();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
    expect(screen.getByText('a1@example.com')).toBeInTheDocument();
  });

  it('shows the empty copy when there is no activity', () => {
    renderHistory();
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No email history found');
  });
});
