import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';

const { useAnalyticsOverview, useSpend, useSpendFeatures, useAdminRevenueTrend, pulseSpy } = vi.hoisted(() => {
  const idle = () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });
  return {
    useAnalyticsOverview: vi.fn(idle),
    useSpend: vi.fn(idle),
    useSpendFeatures: vi.fn(idle),
    useAdminRevenueTrend: vi.fn(idle),
    pulseSpy: vi.fn(),
  };
});

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select?: (state: unknown) => unknown) => {
    const state = { currentUser: { id: 'admin-1', isAdmin: true } };
    return select ? select(state) : state;
  },
}));
vi.mock('./Analytics/useAnalyticsOverview', () => ({ useAnalyticsOverview }));
vi.mock('./ModelMetrics/hooks/useSpend', () => ({ useSpend }));
vi.mock('./SpendExplorer/useFeatureCost', () => ({ useSpendFeatures }));
vi.mock('./Revenue/useAdminRevenue', () => ({ useAdminRevenueTrend }));
vi.mock('./AiAdvisory/AiAdvisoryStrip', () => ({ AiAdvisoryStrip: () => null }));
vi.mock('./MorningBriefCard', () => ({ MorningBriefCard: () => <div data-testid="admin-morning-brief" /> }));
vi.mock('./Signups/NewSignupsTile', () => ({
  NewSignupsTile: ({ onReview }: { onReview: () => void }) => (
    <button data-testid="admin-dashboard-signups-tile" onClick={onReview} />
  ),
}));
vi.mock('./Analytics/ActiveUsersSection', () => ({
  ActiveUsersSection: () => <div data-testid="admin-dashboard-active-users" />,
}));
vi.mock('./CreditAnalysis/components/DailyAreaChart', () => ({
  DailyAreaChart: () => <div data-testid="admin-dashboard-cost-area" />,
}));
vi.mock('./Dashboard/NeedsAttentionStrip', () => ({
  NeedsAttentionStrip: () => <div data-testid="admin-dashboard-attention" />,
}));
vi.mock('./Dashboard/JumpBackIn', () => ({ JumpBackIn: () => <div data-testid="admin-dashboard-jump" /> }));
vi.mock('./Dashboard/PulseSection', () => ({
  PulseSection: (props: { range: string }) => {
    pulseSpy(props.range);
    return <div data-testid="admin-dashboard-pulse" />;
  },
}));
vi.mock('./Dashboard/UsageBreakdowns', () => ({
  TopFeaturesCard: () => <div data-testid="admin-dashboard-features" />,
  ModelsByCostCard: () => <div data-testid="admin-dashboard-models" />,
  TopAccountsCard: () => <div data-testid="admin-dashboard-accounts" />,
}));
vi.mock('./Dashboard/HealthAndRevenue', () => ({
  PlatformHealthCard: () => <div data-testid="admin-dashboard-health" />,
  RevenueMovementCard: () => <div data-testid="admin-dashboard-revenue" />,
}));

import AdminDashboardTab from './AdminDashboardTab';

const theme = extendTheme({ ...getThemeConfig() });
const renderTab = (onNavigate = vi.fn()) =>
  render(
    <CssVarsProvider theme={theme}>
      <AdminDashboardTab onNavigate={onNavigate} />
    </CssVarsProvider>
  );

describe('AdminDashboardTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leads with the page header and its only h1', () => {
    renderTab();
    const dashboard = screen.getByTestId('admin-dashboard');
    expect(dashboard.firstElementChild).toBe(screen.getByTestId('admin-page-header'));
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Admin dashboard']);
  });

  it('renders every data region in order of daily importance', () => {
    renderTab();
    const order = [
      'admin-dashboard-attention',
      'admin-morning-brief',
      'admin-dashboard-jump',
      'admin-dashboard-pulse',
      'admin-dashboard-active-users',
      'admin-dashboard-cost-chart',
      'admin-dashboard-features',
      'admin-dashboard-models',
      'admin-dashboard-accounts',
      'admin-dashboard-health',
      'admin-dashboard-revenue',
      'admin-dashboard-signups-tile',
    ].map(id => screen.getByTestId(id));
    order.slice(1).forEach((node, index) => {
      expect(order[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('no longer renders the event-scan sections or the shortcut grid', () => {
    renderTab();
    expect(screen.queryByText('Client usage')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Explore admin')).not.toBeInTheDocument();
    expect(screen.queryByText('Watched campaigns')).not.toBeInTheDocument();
  });

  it('defaults to 7 days and re-queries every source when the range changes', () => {
    renderTab();
    expect(useAnalyticsOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: '7d', accounts: 'external' })
    );
    expect(pulseSpy).toHaveBeenLastCalledWith('7d');

    fireEvent.click(screen.getByTestId('admin-dashboard-range-28d'));

    expect(useAnalyticsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ range: '28d' }));
    expect(pulseSpy).toHaveBeenLastCalledWith('28d');
    const [spendWindow] = useSpend.mock.lastCall as unknown as [{ dateFrom: string; dateTo: string }];
    const days = (Date.parse(spendWindow.dateTo) - Date.parse(spendWindow.dateFrom)) / 86_400_000;
    expect(days).toBe(28);
    const [{ range: featureRange, audience }] = useSpendFeatures.mock.lastCall as unknown as [
      { range: { from: Date; to: Date }; audience: string },
    ];
    expect(audience).toBe('external');
    expect(featureRange.from.toISOString()).toBe(spendWindow.dateFrom);
    expect(featureRange.to.toISOString()).toBe(spendWindow.dateTo);
  });

  it('sends signup review to the Users tab', () => {
    const onNavigate = vi.fn();
    renderTab(onNavigate);
    fireEvent.click(screen.getByTestId('admin-dashboard-signups-tile'));
    expect(onNavigate).toHaveBeenCalledWith(AdminTab.Users);
  });
});
