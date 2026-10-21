import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import dayjs from 'dayjs';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';
import type { EventMetric } from './EventMetrics/types';
import type { PremiumRouteDescriptor } from '@client/app/premiumContract';

const { useEventMetrics, forceRefresh, overviewSpy, premiumRoutes } = vi.hoisted(() => ({
  useEventMetrics: vi.fn(),
  forceRefresh: vi.fn(),
  overviewSpy: vi.fn(),
  premiumRoutes: [] as PremiumRouteDescriptor[],
}));

vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes }));
vi.mock('@tanstack/react-router', () => ({
  Link: React.forwardRef<HTMLAnchorElement, { to: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    ({ to, ...rest }, ref) => <a ref={ref} href={to} {...rest} />
  ),
}));
vi.mock('./EventMetrics/hooks/useEventMetrics', () => ({ useEventMetrics }));
vi.mock('./EventMetrics/components/UsageBySourceCard', () => ({
  UsageBySourceCard: () => <div data-testid="usage-by-source-card" />,
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

const event: EventMetric = {
  id: 'event-1',
  timestamp: '2026-10-20T10:00:00.000Z',
  eventName: 'Session Created',
  eventCategory: 'Session',
  counterValue: 1,
  user: { userId: 'user-1', userName: 'Example', userLevel: 'user' },
};

describe('AdminDashboardTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    premiumRoutes.length = 0;
    useEventMetrics.mockReturnValue({
      data: [event],
      isLoading: false,
      isFetching: false,
      isError: false,
      forceRefresh,
    });
  });

  it('does not show an extension section when no routes contribute a dashboard', () => {
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByText('More dashboards')).not.toBeInTheDocument();
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

  it('requests the last seven calendar days, including all of today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(useEventMetrics).toHaveBeenLastCalledWith({
      dateFrom: dayjs().startOf('day').subtract(6, 'day').toISOString(),
      dateTo: dayjs().endOf('day').toISOString(),
    });
  });

  it('shows client usage and activity charts with their coverage limits', () => {
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getAllByTestId('usage-by-source-card')).toHaveLength(1);
    expect(screen.getByTestId('activity-charts')).toBeInTheDocument();
    expect(screen.getByText(/latest 1,000 matching events/)).toBeInTheDocument();
    expect(overviewSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metrics: [event],
        showUsageBySource: false,
        chartData: expect.objectContaining({
          topEvents: [{ eventName: 'Session Created', category: 'Session', count: 1 }],
        }),
      })
    );
  });

  it('moves the activity window forward when refreshed after midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 23, 59));
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    vi.setSystemTime(new Date(2026, 9, 21, 0, 1));
    fireEvent.click(screen.getByTestId('admin-dashboard-refresh'));

    expect(useEventMetrics).toHaveBeenLastCalledWith({
      dateFrom: dayjs().startOf('day').subtract(6, 'day').toISOString(),
      dateTo: dayjs().endOf('day').toISOString(),
    });
    expect(forceRefresh).toHaveBeenCalledExactlyOnceWith({
      dateFrom: dayjs().startOf('day').subtract(6, 'day').toISOString(),
      dateTo: dayjs().endOf('day').toISOString(),
    });
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
    useEventMetrics.mockReturnValue({ isLoading: true, isFetching: true, isError: false, forceRefresh });
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByLabelText('Loading recent activity')).toBeInTheDocument();
    expect(screen.getByTestId('usage-by-source-card')).toBeInTheDocument();
    expect(screen.getByTestId(`admin-dashboard-open-${AdminTab.EventMetrics}`)).toBeEnabled();
    expect(screen.queryByTestId('activity-charts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-dashboard-activity-empty')).not.toBeInTheDocument();
  });

  it('keeps cached activity visible beside the error when a refresh fails and allows retry', () => {
    useEventMetrics.mockReturnValue({
      data: [event],
      isLoading: false,
      isFetching: false,
      isError: true,
      forceRefresh,
    });
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('admin-dashboard-activity-error')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-dashboard-activity-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-charts')).toBeInTheDocument();
    expect(screen.getByTestId('usage-by-source-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-dashboard-refresh'));
    expect(forceRefresh).toHaveBeenCalledOnce();
  });

  it('shows only the error when a failed request has no cached activity', () => {
    useEventMetrics.mockReturnValue({ data: [], isLoading: false, isFetching: false, isError: true, forceRefresh });
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('admin-dashboard-activity-error')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-dashboard-activity-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-charts')).not.toBeInTheDocument();
  });

  it('shows an empty state when the window has no activity', () => {
    useEventMetrics.mockReturnValue({ data: [], isLoading: false, isFetching: false, isError: false, forceRefresh });
    render(<AdminDashboardTab onNavigate={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('admin-dashboard-activity-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-charts')).not.toBeInTheDocument();
  });
});
