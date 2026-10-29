import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ useGetUserSubscriptions: vi.fn(), refetch: vi.fn() }));

vi.mock('@client/app/hooks/data/subscriptions', () => ({ useGetUserSubscriptions: mocks.useGetUserSubscriptions }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params: Record<string, string>; children: ReactNode }) => (
    <a href={to.replace('$subscriptionId', params.subscriptionId)} {...rest}>
      {children}
    </a>
  ),
}));

import { SubscriptionSummaryList } from './SubscriptionSummaryList';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const individual = {
  id: 'sub-ind',
  status: 'active',
  source: 'admin_grant',
  planName: 'Pro',
  effectiveCreditsPerCycle: 12000,
  canceledAt: null,
  periodEndsAt: '2026-12-31T00:00:00.000Z',
};
const canceledTeam = {
  organization: { id: 'org-1', name: 'Acme' },
  subscription: {
    id: 'sub-team',
    status: 'canceled',
    source: 'stripe',
    effectiveCreditsPerCycle: 4000,
    canceledAt: '2026-10-01T12:00:00.000Z',
    periodEndsAt: '2026-10-15T12:00:00.000Z',
  },
};

const renderList = () => render(<SubscriptionSummaryList userId="user-1" />, { wrapper: TestWrapper });
const mockResult = (result: object) => mocks.useGetUserSubscriptions.mockReturnValue(result);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SubscriptionSummaryList', () => {
  it('lists individual rows before team rows, each linking to its detail page', () => {
    mockResult({ data: { individualSubscriptions: [individual], teamSubscriptions: [canceledTeam] } });
    renderList();

    const rows = screen.getAllByTestId('subscription-summary-row-link');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('href', '/admin/subscriptions/sub-ind');
    expect(rows[1]).toHaveAttribute('href', '/admin/subscriptions/sub-team');

    expect(rows[0]).toHaveTextContent('Pro');
    expect(rows[0]).toHaveTextContent('Renews Dec 31, 2026');
    expect(rows[0]).toHaveTextContent('12,000 credits');
    expect(within(rows[0]).getByTestId('subscription-summary-comped')).toBeInTheDocument();

    expect(rows[1]).toHaveTextContent('Acme');
    expect(rows[1]).toHaveTextContent('Canceled');
    expect(rows[1]).toHaveTextContent('Ended Oct 1, 2026');
    expect(within(rows[1]).queryByTestId('subscription-summary-comped')).not.toBeInTheDocument();
  });

  it('shows the empty state when the user has no subscriptions', () => {
    mockResult({ data: { individualSubscriptions: [], teamSubscriptions: [] } });
    renderList();
    expect(screen.getByTestId('subscription-summary-empty')).toHaveTextContent('No subscriptions');
  });

  it('shows a skeleton while loading', () => {
    mockResult({ isLoading: true });
    renderList();
    expect(screen.getByTestId('subscription-summary-loading')).toBeInTheDocument();
  });

  it('offers a retry after a load failure', () => {
    mockResult({ isError: true, refetch: mocks.refetch });
    renderList();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});
