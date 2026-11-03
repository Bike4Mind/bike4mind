import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySignalCounts, type SignupTimeseries } from '@client/app/utils/signupSignals';

const mocks = vi.hoisted(() => ({ useSignupTimeseries: vi.fn() }));
vi.mock('./useSignupTimeseries', async importOriginal => ({
  ...(await importOriginal<typeof import('./useSignupTimeseries')>()),
  useSignupTimeseries: mocks.useSignupTimeseries,
}));
// recharts needs a measured container; jsdom has none, so the chart itself is stubbed.
vi.mock('./SignupChart', () => ({
  SignupChart: ({ testId, mode }: { testId?: string; mode?: string }) => <div data-testid={testId}>{mode}</div>,
}));

import { SignupActivityPanel } from './SignupActivityPanel';
import { NewSignupsTile } from './NewSignupsTile';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (node: React.ReactNode) => render(<CssVarsProvider theme={appTheme}>{node}</CssVarsProvider>);

const bucket = (start: string, total: number, suspected: number) => ({
  start,
  total,
  suspected,
  likelyLegit: total - suspected,
  unclassified: 0,
  bySignal: { ...emptySignalCounts(), domainCadence: suspected },
  baseline: { median: 2, p90: 4 },
});

const series: SignupTimeseries = {
  range: '7d',
  bucket: 'hour',
  since: '2026-03-10T10:00:00.000Z',
  until: '2026-03-10T12:30:00.000Z',
  buckets: [bucket('2026-03-10T11:00:00.000Z', 0, 0), bucket('2026-03-10T12:00:00.000Z', 30, 26)],
  totals: {
    total: 30,
    suspected: 26,
    likelyLegit: 4,
    unclassified: 0,
    bySignal: { ...emptySignalCounts(), domainCadence: 26 },
  },
  truncated: false,
  keysTruncated: false,
};

beforeEach(() => {
  mocks.useSignupTimeseries.mockReset();
  mocks.useSignupTimeseries.mockReturnValue({ data: series, isLoading: false, isError: false, refetch: vi.fn() });
});

describe('SignupActivityPanel', () => {
  it('summarizes legit and suspected counts and switches the breakdown', () => {
    wrap(<SignupActivityPanel range="7d" onRangeChange={vi.fn()} onSelectWindow={vi.fn()} />);
    expect(screen.getByTestId('users-signup-summary').textContent).toContain('4 likely legit, 26 suspected');
    expect(screen.getByTestId('users-signup-chart').textContent).toBe('status');
    fireEvent.click(screen.getByTestId('users-signup-mode-signals'));
    expect(screen.getByTestId('users-signup-chart').textContent).toBe('signals');
  });

  it('filters the user list to a period from the table view', () => {
    const onSelectWindow = vi.fn();
    wrap(<SignupActivityPanel range="7d" onRangeChange={vi.fn()} onSelectWindow={onSelectWindow} />);
    fireEvent.click(screen.getByTestId('users-signup-table-toggle'));
    expect(screen.queryByTestId('users-signup-bucket-filter-2026-03-10T11:00:00.000Z')).toBeNull();
    fireEvent.click(screen.getByTestId('users-signup-bucket-filter-2026-03-10T12:00:00.000Z'));
    expect(onSelectWindow).toHaveBeenCalledWith({
      createdFrom: '2026-03-10T12:00:00.000Z',
      createdTo: '2026-03-10T13:00:00.000Z',
    });
  });

  it('charts the range its owner passes in', () => {
    wrap(<SignupActivityPanel range="90d" onRangeChange={vi.fn()} onSelectWindow={vi.fn()} />);
    expect(mocks.useSignupTimeseries).toHaveBeenCalledWith('90d');
  });

  it('says when the classification scan was capped', () => {
    mocks.useSignupTimeseries.mockReturnValue({
      data: { ...series, truncated: true },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    wrap(<SignupActivityPanel range="7d" onRangeChange={vi.fn()} onSelectWindow={vi.fn()} />);
    expect(screen.getByTestId('users-signup-panel').textContent).toContain('Only the newest signups');
  });
});

describe('SignupActivityPanel load failure', () => {
  it('shows an alert and retries the request', () => {
    const refetch = vi.fn();
    mocks.useSignupTimeseries.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    wrap(<SignupActivityPanel range="7d" onRangeChange={vi.fn()} onSelectWindow={vi.fn()} />);
    expect(screen.getByTestId('users-signup-panel').textContent).toContain('Could not load signups.');
    fireEvent.click(screen.getByTestId('users-signup-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('NewSignupsTile', () => {
  it('shows an alert and a placeholder headline when the load fails', () => {
    mocks.useSignupTimeseries.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    wrap(<NewSignupsTile onReview={vi.fn()} />);
    expect(screen.getByText('Signups could not be loaded. Open Users to retry.')).toBeTruthy();
    expect(screen.getByTestId('admin-dashboard-signups-legit').textContent).toBe('-');
  });

  it('headlines the likely-legit count, not the raw total', () => {
    const onReview = vi.fn();
    wrap(<NewSignupsTile onReview={onReview} />);
    expect(mocks.useSignupTimeseries).toHaveBeenCalledWith('30d');
    expect(screen.getByTestId('admin-dashboard-signups-legit').textContent).toBe('4');
    expect(screen.getByTestId('admin-dashboard-signups-suspected').textContent).toContain('26 suspected');
    fireEvent.click(screen.getByTestId('admin-dashboard-signups-review-btn'));
    expect(onReview).toHaveBeenCalled();
  });
});
