import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ControlPanel } from './ControlPanel';

vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const noop = () => {};
const renderPanel = (dateFrom: string, dateTo: string) =>
  render(
    <ControlPanel
      metrics={[]}
      filteredMetrics={[]}
      modelInfos={[]}
      dateFrom={dateFrom}
      dateTo={dateTo}
      userFilter=""
      modelFilter=""
      statusFilter=""
      simplifiedNames={false}
      setDateFrom={noop}
      setDateTo={noop}
      setUserFilter={noop}
      setModelFilter={noop}
      setStatusFilter={noop}
      setSimplifiedNames={noop}
      onRefresh={noop}
      onExportCSV={noop}
      onClearFilters={noop}
      onSetDateRange={noop}
      onApplyFilters={noop}
    />,
    { wrapper: TestWrapper }
  );

// The date comparison needs a dayjs plugin, and nothing else on the client registers it.
describe('ControlPanel date range', () => {
  it('accepts a range whose start is before its end', () => {
    renderPanel('2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    expect(screen.queryByText(/From date must be before or equal to To date/)).not.toBeInTheDocument();
  });

  it('flags a range whose start is after its end', () => {
    renderPanel('2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    expect(screen.getByText(/From date must be before or equal to To date/)).toBeInTheDocument();
  });
});
