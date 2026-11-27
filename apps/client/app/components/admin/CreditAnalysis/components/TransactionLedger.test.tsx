import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const { useLedger, refetch } = vi.hoisted(() => ({ useLedger: vi.fn(), refetch: vi.fn() }));
vi.mock('../hooks/useTransactionLedger', () => ({ useTransactionLedger: useLedger }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({ data: { data: [] }, isLoading: false }),
}));
vi.mock('./SessionUsageDetailModal', () => ({
  SessionUsageDetailModal: ({ sessionId, organizationId }: { sessionId: string | null; organizationId?: string }) => (
    <div data-testid="session-detail-stub">
      {sessionId} {organizationId}
    </div>
  ),
}));

import { TransactionLedger } from './TransactionLedger';

const theme = extendTheme({ ...getThemeConfig() });
const row = {
  id: 'tx-1',
  createdAt: '2026-01-01T00:00:00Z',
  type: 'usage',
  source: 'api',
  model: 'model-a',
  credits: -12,
  sessionId: 'session-1',
};
const result = { rows: [row], page: 1, limit: 25, total: 51, totalPages: 3 };
const renderLedger = () =>
  render(
    <CssVarsProvider theme={theme}>
      <TransactionLedger organizationId="org-1" />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  useLedger.mockReturnValue({ data: result, isLoading: false, isFetching: false, error: null, refetch });
});

describe('TransactionLedger', () => {
  it('uses a shared paginated list without local sorting and opens the session detail', () => {
    renderLedger();
    expect(screen.getByTestId('admin-page-header')).toHaveTextContent('Transaction ledger (51)');
    expect(screen.getByTestId('ledger-table')).toHaveTextContent('-12');
    expect(screen.queryByTestId('admin-table-sort-credits-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('ledger-drilldown-btn'));
    expect(screen.getByTestId('session-detail-stub')).toHaveTextContent('session-1 org-1');
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(useLedger).toHaveBeenLastCalledWith('org-1', { days: 30, type: 'all', source: 'all' }, 2, 25);
  });

  it('resets paging for a filter and for page size', () => {
    renderLedger();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    fireEvent.click(screen.getByTestId('admin-filter-days'));
    fireEvent.click(screen.getByTestId('admin-filter-days-90'));
    expect(useLedger).toHaveBeenLastCalledWith('org-1', { days: 90, type: 'all', source: 'all' }, 1, 25);
    fireEvent.click(screen.getByTestId('admin-filter-type'));
    fireEvent.click(screen.getByTestId('admin-filter-type-generic_deduct'));
    expect(useLedger).toHaveBeenLastCalledWith('org-1', expect.objectContaining({ type: 'generic_deduct' }), 1, 25);
    fireEvent.click(screen.getByTestId('admin-filter-source'));
    fireEvent.click(screen.getByTestId('admin-filter-source-api'));
    expect(useLedger).toHaveBeenLastCalledWith('org-1', expect.objectContaining({ source: 'api' }), 1, 25);
    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-50'));
    expect(useLedger).toHaveBeenLastCalledWith('org-1', expect.anything(), 1, 50);
  });

  it('renders loading, error retry, and empty states', () => {
    useLedger.mockReturnValue({ data: result, isFetching: true, refetch });
    const view = renderLedger();
    expect(screen.getAllByTestId('admin-table-skeleton-row')).toHaveLength(8);
    useLedger.mockReturnValue({ error: new Error('Unavailable'), refetch });
    view.rerender(
      <CssVarsProvider theme={theme}>
        <TransactionLedger organizationId="org-1" />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledOnce();
    useLedger.mockReturnValue({ data: { ...result, rows: [], total: 0 }, refetch });
    view.rerender(
      <CssVarsProvider theme={theme}>
        <TransactionLedger organizationId="org-1" />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-empty-state')).toBeInTheDocument();
  });

  it('does not fetch a ledger until an organization is selected', () => {
    render(
      <CssVarsProvider theme={theme}>
        <TransactionLedger />
      </CssVarsProvider>
    );
    expect(useLedger).toHaveBeenCalledWith(null, expect.anything(), 1, 25);
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('Select an organization');
    expect(screen.getByTestId('ledger-refresh-btn')).toBeDisabled();
  });
});
