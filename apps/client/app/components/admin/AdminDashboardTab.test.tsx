import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';
import type { AdminActivitySummary } from '@client/shared/adminActivitySummary';
import type { PremiumRouteDescriptor } from '@client/app/premiumContract';

const { useAdminActivitySummary, refetch, overviewSpy, premiumRoutes } = vi.hoisted(() => ({
  useAdminActivitySummary: vi.fn(),
  refetch: vi.fn(),
  overviewSpy: vi.fn(),
  premiumRoutes: [] as PremiumRouteDescriptor[],
}));

vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes }));
vi.mock('@tanstack/react-router', () => ({
  Link: React.forwardRef<HTMLAnchorElement, { to: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function MockLink({ to, ...rest }, ref) {
      return <a ref={ref} href={to} {...rest} />;
    }
  ),
}));
vi.mock('./useAdminActivitySummary', () => ({ useAdminActivitySummary }));
vi.mock('./EventMetrics/components/UsageBySourceCard', () => ({
  UsageBySourceCard: () => <div data-testid="usage-by-source-card" />,
}));
vi.mock('./Signups/NewSignupsTile', () => ({
  NewSignupsTile: () => <div data-testid="admin-dashboard-signups-tile" />,
}));
vi.mock('./EventMetrics/components/OverviewTab', () => ({
  OverviewTab: (props: unknown) => {
    overviewSpy(props);
    return <div data-testid="activity-charts" />;
  },
}));

import AdminDashboardTab from './AdminDashboardTab';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const activity: AdminActivitySummary = {
  windowStart: '2026-10-14T00:00:00.000Z',
  windowEnd: '2026-10-20T10:00:00.000Z',
  totalEvents: 2001,
  timeSeriesData: [
    { date: '2026-10-14', count: 1000 },
    { date: '2026-10-20', count: 1001 },
  ],
  categoryBreakdown: [{ category: 'Session', count: 2001, percentage: 100 }],
  topEvents: [{ eventName: 'Session Created', category: 'Session', count: 2001 }],
};

describe('AdminDashboardTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    premiumRoutes.length = 0;
    useAdminActivitySummary.mockReturnValue({
      data: activity,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch,
    });
  });

  it('does not show an extension section when no routes contribute a dashboard', () => {
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByText('More dashboards')).not.toBeInTheDocument();
  });

  it.each([
    ['Client usage', 'CLI means the command-line app'],
    ['Feature activity', 'Counts measure recorded activity, not the number of people'],
    ['Model performance', 'Latency means how long a response takes'],
    ['Credits & costs', 'Margins compare what is charged'],
    ['Recent activity', 'Today is still in progress'],
  ])('explains %s without navigating away from the dashboard', async (term, explanation) => {
    const onNavigate = vi.fn();
    render(<AdminDashboardTab onNavigate={onNavigate} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: `About ${term}` }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(explanation);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('links an installed dashboard to its registered route without loading its page', () => {
    const lazyImport = vi.fn();
    premiumRoutes.push(
      { path: '/example-tool', lazyImport },
      {
        path: '/example-analytics',
        lazyImport,
        adminDashboard: { label: 'Example analytics', description: 'Explore activity and retention.' },
      }
    );
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('admin-dashboard-extension-link')).toHaveAttribute('href', '/example-analytics');
    expect(screen.getByTestId('admin-dashboard-extension-link')).toHaveAccessibleName('Open Example analytics');
    expect(screen.getByText('Explore activity and retention.')).toBeInTheDocument();
    expect(screen.queryByText('example-tool')).not.toBeInTheDocument();
    expect(lazyImport).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows client usage and activity charts with their coverage limits', () => {
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getAllByTestId('usage-by-source-card')).toHaveLength(1);
    expect(screen.getByTestId('activity-charts')).toBeInTheDocument();
    expect(screen.getByText(/count all recorded events/)).toBeInTheDocument();
    expect(screen.getByText(/UTC/)).toBeInTheDocument();
    expect(overviewSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        showUsageBySource: false,
        isCompleteWindow: true,
        chartData: expect.objectContaining({
          topEvents: activity.topEvents,
          timeSeriesData: activity.timeSeriesData,
        }),
      })
    );
  });

  it('requests a fresh server summary when activity is refreshed', () => {
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('admin-dashboard-refresh'));
    expect(refetch).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    [AdminTab.EventMetrics, 'Feature activity'],
    [AdminTab.Analytics, 'User activity & reports'],
    [AdminTab.ModelMetrics, 'Model performance'],
    [AdminTab.CreditAnalytics, 'Credits & costs'],
    [AdminTab.Users, 'Users'],
    [AdminTab.SystemHealth, 'System health'],
  ])('opens the selected admin tool (%s)', (tab, label) => {
    const onNavigate = vi.fn();
    render(<AdminDashboardTab onNavigate={onNavigate} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId(`admin-dashboard-open-${tab}`));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(tab);
    expect(screen.getByTestId(`admin-dashboard-open-${tab}`)).toHaveAccessibleName(`Open ${label}`);
  });

  it('keeps client usage and shortcuts available while activity loads', () => {
    useAdminActivitySummary.mockReturnValue({ isLoading: true, isFetching: true, isError: false, refetch });
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByLabelText('Loading recent activity')).toBeInTheDocument();
    expect(screen.getByTestId('usage-by-source-card')).toBeInTheDocument();
    expect(screen.getByTestId(`admin-dashboard-open-${AdminTab.EventMetrics}`)).toBeEnabled();
    expect(screen.queryByTestId('activity-charts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-dashboard-activity-empty')).not.toBeInTheDocument();
  });

  it('keeps cached activity visible beside the error when a refresh fails and allows retry', () => {
    useAdminActivitySummary.mockReturnValue({
      data: activity,
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch,
    });
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('admin-dashboard-activity-error')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-dashboard-activity-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-charts')).toBeInTheDocument();
    expect(screen.getByTestId('usage-by-source-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-dashboard-refresh'));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('shows only the error when a failed request has no cached activity', () => {
    useAdminActivitySummary.mockReturnValue({
      data: { ...activity, totalEvents: 0 },
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch,
    });
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('admin-dashboard-activity-error')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-dashboard-activity-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-charts')).not.toBeInTheDocument();
  });

  it('shows an empty state when the window has no activity', () => {
    useAdminActivitySummary.mockReturnValue({
      data: { ...activity, totalEvents: 0 },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch,
    });
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('admin-dashboard-activity-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-charts')).not.toBeInTheDocument();
  });
});
