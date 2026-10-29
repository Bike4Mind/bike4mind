import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const { useLog, navigate, refetch } = vi.hoisted(() => ({ useLog: vi.fn(), navigate: vi.fn(), refetch: vi.fn() }));
vi.mock('../hooks/useCreditAdjustmentsLog', () => ({ useCreditAdjustmentsLog: useLog }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
import { CreditAdjustmentsLog } from './CreditAdjustmentsLog';

const theme = extendTheme({ ...getThemeConfig() });
const row = {
  id: 'change',
  createdAt: '2026-01-01T00:00:00Z',
  credits: -25,
  targetUserId: 'user',
  resultingBalance: 0,
  description: 'Test correction',
};
const result = { rows: [row], page: 1, limit: 25, total: 51, totalPages: 3 };
const renderLog = () =>
  render(
    <CssVarsProvider theme={theme}>
      <CreditAdjustmentsLog />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  useLog.mockReturnValue({ data: result, isLoading: false, isFetching: false, error: null, refetch });
});

describe('CreditAdjustmentsLog', () => {
  it('renders audited facts and requests the next server page', () => {
    renderLog();
    expect(screen.getByTestId('admin-page-header')).toHaveTextContent('Credit adjustments (51)');
    expect(screen.getByTestId('adjustments-table')).toHaveTextContent('Test correction');
    expect(screen.getByTestId('adjustments-table')).toHaveTextContent('-25');
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(useLog).toHaveBeenLastCalledWith({ page: 2, limit: 25, days: 90 });
    fireEvent.click(screen.getByTestId('admin-filter-clear-days-btn'));
    expect(useLog).toHaveBeenLastCalledWith({ page: 1, limit: 25, days: undefined });
  });

  it('does not expose a misleading page-local search or sort', () => {
    renderLog();
    expect(screen.queryByTestId('admin-filter-search-input')).toBeNull();
    expect(screen.queryByTestId('admin-table-sort-delta-btn')).toBeNull();
  });

  it('returns to the first server page when the page size changes', () => {
    renderLog();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(useLog).toHaveBeenLastCalledWith({ page: 2, limit: 25, days: 90 });
    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-50'));
    expect(useLog).toHaveBeenLastCalledWith({ page: 1, limit: 50, days: 90 });
  });

  it.each([0, 1])('recovers from an out-of-range server page with %i total pages', totalPages => {
    const rendered = renderLog();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(useLog).toHaveBeenLastCalledWith({ page: 3, limit: 25, days: 90 });
    useLog.mockReturnValue({
      data: { ...result, rows: [], total: totalPages, totalPages },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch,
    });
    rendered.rerender(
      <CssVarsProvider theme={theme}>
        <CreditAdjustmentsLog />
      </CssVarsProvider>
    );
    expect(useLog).toHaveBeenLastCalledWith({ page: 1, limit: 25, days: 90 });
  });

  it('offers retry on errors and refresh on empty results', () => {
    useLog.mockReturnValue({ error: new Error('Try again'), refetch });
    const rendered = renderLog();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledOnce();
    useLog.mockReturnValue({ data: { ...result, rows: [], total: 0, totalPages: 0 }, refetch });
    rendered.rerender(
      <CssVarsProvider theme={theme}>
        <CreditAdjustmentsLog />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-empty-state')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-table-refresh-btn'));
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('shows skeletons instead of stale rows while fetching', () => {
    useLog.mockReturnValue({ data: result, isFetching: true, refetch });
    renderLog();
    expect(screen.getAllByTestId('admin-table-skeleton-row')).toHaveLength(8);
    expect(screen.queryByText('Test correction')).toBeNull();
  });

  it('opens the credits audit trail', () => {
    renderLog();
    fireEvent.click(screen.getByTestId('credit-adjustments-audit-log-link'));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/admin', search: expect.objectContaining({ category: 'credits' }) })
    );
  });
});
