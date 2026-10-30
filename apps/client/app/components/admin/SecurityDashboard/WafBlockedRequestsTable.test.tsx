import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SecurityDashboardWafBlockedRequestsResult } from '@client/app/hooks/data/admin';
import { WafBlockedRequestsTable } from './WafBlockedRequestsTable';

const theme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);
const data: SecurityDashboardWafBlockedRequestsResult = {
  enabled: true,
  stage: 'test',
  range: '24h',
  checkedAt: '2026-01-01T00:00:00Z',
  total: 2,
  requests: ['GET', 'POST'].map((httpMethod, index) => ({
    timestamp: '2026-01-01T00:00:00Z',
    action: 'BLOCK',
    terminatingRuleId: 'synthetic-rule',
    clientIp: '192.0.2.1',
    country: 'ZZ',
    headers: [],
    uri: `/synthetic-${index}`,
    args: '',
    httpVersion: 'HTTP/2',
    httpMethod,
    requestId: `request-${index}`,
  })),
};
describe('WafBlockedRequestsTable', () => {
  it('preserves method filtering and clears it without dropping request data', () => {
    render(<WafBlockedRequestsTable data={data} range="24h" />, { wrapper });
    const table = within(screen.getByTestId('waf-blocked-requests-table'));
    expect(table.getByText('/synthetic-0')).toBeVisible();
    fireEvent.mouseDown(screen.getByTestId('filter-search-httpMethod'));
    fireEvent.click(screen.getByTestId('waf-filter-httpMethod-GET'));
    fireEvent.keyDown(screen.getByTestId('filter-btn-httpMethod'), { key: 'Escape' });
    expect(table.queryByText('/synthetic-1')).toBeNull();
    fireEvent.click(screen.getByTestId('waf-clear-filters'));
    expect(table.getByText('/synthetic-1')).toBeVisible();
  });
  it('searches URI options and retains selections while searching again', async () => {
    render(<WafBlockedRequestsTable data={data} range="24h" />, { wrapper });
    const input = screen.getByTestId('filter-search-uri');
    await userEvent.type(input, 'synthetic-1');
    expect(screen.queryByTestId('waf-filter-uri-/synthetic-0')).toBeNull();
    await userEvent.click(screen.getByTestId('waf-filter-uri-/synthetic-1'));
    const table = within(screen.getByTestId('waf-blocked-requests-table'));
    expect(table.queryByText('/synthetic-0')).toBeNull();
    expect(table.getByText('/synthetic-1')).toBeVisible();
    await userEvent.type(input, 'synthetic-0');
    await userEvent.click(screen.getByTestId('waf-filter-uri-/synthetic-0'));
    expect(table.getByText('/synthetic-0')).toBeVisible();
    expect(table.getByText('/synthetic-1')).toBeVisible();
  });
  it('retries failed queries', () => {
    const retry = vi.fn();
    render(<WafBlockedRequestsTable isError error={new Error('Try again')} range="24h" onRetry={retry} />, { wrapper });
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(retry).toHaveBeenCalledOnce();
  });
});
