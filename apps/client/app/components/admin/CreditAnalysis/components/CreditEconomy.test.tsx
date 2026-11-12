import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ECONOMY_LIMITATIONS } from '@client/shared/creditEconomy';
import { CreditEconomy } from './CreditEconomy';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  refetch: vi.fn(),
  state: {
    query: '',
    view: 'economy',
    filters: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z', owner: 'User', flow: '' },
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => mocks.query(options) }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
vi.mock('../../shared/useAdminListUrlState', () => ({ useAdminListUrlState: () => [mocks.state, mocks.update] }));
const funding = { purchased: 10, subscription: 0, granted: 0, unknown: 5 };
const report = {
  from: '2026-08-01T00:00:00Z',
  to: '2026-09-01T00:00:00Z',
  asOf: '2026-10-01T00:00:00Z',
  netMovement: 10,
  transactionCount: 1,
  flows: [{ flow: 'purchased', credits: 10, rows: 1 }],
  balances: { currentAvailable: null, holders: 2, missingBalances: 1 },
  funding: {
    consumption: funding,
    currentLotRemainingEstimate: funding,
    ledgerUsageDifference: 4,
    stampedRows: 1,
    usageRows: 2,
    invalidOrMissingRows: 1,
    lotCount: 2,
  },
  cohorts: [{ days: 7, maturePurchases: 1, issuedCredits: 10 }],
  limitations: ECONOMY_LIMITATIONS,
};
const theme = extendTheme({ ...getThemeConfig() });
const draw = () =>
  render(
    <CssVarsProvider theme={theme}>
      <CreditEconomy />
    </CssVarsProvider>
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation((options: { queryKey: string[] }) => ({
    data: options.queryKey[1] === 'credit-economy' ? report : { rows: [], total: 0 },
    refetch: mocks.refetch,
  }));
});
describe('CreditEconomy', () => {
  it('shows coverage and unavailable history, not zero historical consumption', () => {
    draw();
    expect(screen.getByTestId('economy-cohorts-table')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('economy-funding-table')).toHaveTextContent('unknown');
    expect(screen.getByText('4 credits unresolved')).toBeInTheDocument();
    expect(screen.getByText('No transactions match these filters')).toBeInTheDocument();
    expect(screen.getByTestId('economy-export-btn')).not.toBeDisabled();
  });
  it('drills into the same flow and keeps dates and owner in shareable filters', () => {
    draw();
    fireEvent.click(screen.getByTestId('economy-drill-purchased-btn'));
    expect(mocks.update).toHaveBeenCalledWith({
      view: 'economy',
      filters: { ...mocks.state.filters, flow: 'purchased' },
    });
    fireEvent.click(screen.getByTestId('economy-window-7-btn'));
    expect(mocks.update).toHaveBeenLastCalledWith({
      view: 'economy',
      filters: expect.objectContaining({ owner: 'User', from: expect.any(String), to: expect.any(String) }),
    });
  });
  it('provides loading and retryable error states and disables export', () => {
    mocks.query.mockReturnValue({ isLoading: true, isFetching: true, refetch: mocks.refetch });
    const { unmount } = draw();
    expect(screen.getByText('Loading credit economy')).toBeInTheDocument();
    expect(screen.getByTestId('economy-export-btn')).toBeDisabled();
    unmount();
    mocks.query.mockReturnValue({ error: new Error('offline'), refetch: mocks.refetch });
    draw();
    expect(screen.getByText('Could not load credit economy.')).toBeInTheDocument();
    expect(screen.getByTestId('economy-export-btn')).toBeDisabled();
  });
  it('exports the report with its limitations, not just displayed numbers', () => {
    const create = vi.fn().mockReturnValue('blob:report');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    draw();
    fireEvent.click(screen.getByTestId('economy-export-btn'));
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    expect(create.mock.calls[0][0].size).toBeGreaterThan(1000);
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:report');
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});
