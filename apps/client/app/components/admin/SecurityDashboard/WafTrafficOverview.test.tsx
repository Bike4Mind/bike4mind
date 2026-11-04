import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ traffic: vi.fn(), logs: vi.fn(), blocked: vi.fn() }));
vi.mock('@/app/hooks/data/admin', () => ({
  useSecurityDashboardWafTraffic: mocks.traffic,
  useSecurityDashboardWafLogsInsights: mocks.logs,
  useSecurityDashboardWafBlockedRequests: mocks.blocked,
}));
vi.mock('./WafTopRulesChart', () => ({ WafTopRulesChart: () => <div data-testid="waf-top-rules-stub" /> }));
vi.mock('./WafTrafficGauge', () => ({ WafTrafficGauge: () => <div data-testid="waf-gauge-stub" /> }));
vi.mock('./WafLogsInsightsSection', () => ({ WafLogsInsightsSection: () => <div data-testid="waf-logs-stub" /> }));

import { WafTrafficOverview } from './WafTrafficOverview';

const theme = extendTheme({ ...getThemeConfig() });
const renderOverview = () =>
  render(
    <CssVarsProvider theme={theme}>
      <WafTrafficOverview />
    </CssVarsProvider>
  );

const idle = { data: undefined, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() };

describe('WafTrafficOverview loading', () => {
  beforeEach(() => {
    mocks.logs.mockReturnValue(idle);
    mocks.blocked.mockReturnValue(idle);
  });

  it('shows a labelled loading state while the first traffic query is pending', () => {
    mocks.traffic.mockReturnValue({ ...idle, isLoading: true, isFetching: true });
    renderOverview();
    expect(screen.getByTestId('waf-traffic-loading')).toHaveTextContent('Loading firewall traffic');
    expect(screen.queryByTestId('waf-traffic-updating')).not.toBeInTheDocument();
  });

  it('keeps the data and shows the updating bar while refetching', () => {
    mocks.traffic.mockReturnValue({
      ...idle,
      isFetching: true,
      data: { enabled: true, totals: { allowed: 1, blocked: 2, counted: 3 } },
    });
    renderOverview();
    expect(screen.getByTestId('waf-traffic-updating')).toHaveTextContent('Updating');
    expect(screen.getByTestId('waf-gauge-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('waf-traffic-loading')).not.toBeInTheDocument();
  });
});
