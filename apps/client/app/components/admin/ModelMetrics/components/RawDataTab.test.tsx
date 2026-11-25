import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModelMetric } from '../types';
import { RawDataTab } from './RawDataTab';

vi.mock('@client/app/components/common/UsernameText', () => ({ default: () => <span>user</span> }));
vi.mock('@client/app/components/Session/StatusTimeline', () => ({ default: () => <div /> }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const metric = (n: number): ModelMetric =>
  ({
    id: `metric-${n}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    model: { name: `model-${n}` },
    tokenUsage: { inputTokens: n, outputTokens: n * 2, totalTokens: n * 3, creditsUsed: n * 10 },
    performance: { totalResponseTime: 1000, contextRetrievalTime: 100, modelInferenceTime: 900 },
    status: 'done',
  }) as unknown as ModelMetric;

const renderTab = (count: number, onSort = vi.fn()) => {
  render(
    <TestWrapper>
      <RawDataTab
        metrics={Array.from({ length: count }, (_, i) => metric(i + 1))}
        modelInfos={[]}
        simplifiedNames={false}
        sortField="timestamp"
        sortDirection="desc"
        onSort={onSort}
        onShowInfoModal={vi.fn()}
      />
    </TestWrapper>
  );
  return onSort;
};

describe('ModelMetrics RawDataTab', () => {
  it('asks the parent to sort by the clicked column', () => {
    const onSort = renderTab(3);
    fireEvent.click(screen.getByTestId('admin-table-sort-creditsUsed-btn'));
    expect(onSort).toHaveBeenCalledWith('creditsUsed');
  });

  it('pages the rows 25 at a time', () => {
    renderTab(30);
    expect(screen.queryByTestId('admin-table-row-metric-26')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('admin-table-row-metric-26')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-row-metric-1')).not.toBeInTheDocument();
  });

  it('expands a row from its toggle button', () => {
    renderTab(1);
    const toggle = screen.getByTestId('model-metrics-raw-row-toggle-btn');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('model-metrics-raw-row-details')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('model-metrics-raw-row-details')).toHaveTextContent('Request ID: metric-1');
  });

  it('keeps a row open when its details are clicked, and closes it from the rest of the row', () => {
    renderTab(1);
    const row = screen.getByTestId('admin-table-row-metric-1');
    fireEvent.click(row);
    fireEvent.click(within(screen.getByTestId('model-metrics-raw-row-details')).getByText('metric-1'));
    expect(screen.getByTestId('model-metrics-raw-row-details')).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.queryByTestId('model-metrics-raw-row-details')).not.toBeInTheDocument();
  });

  it('toggles a row with Enter', () => {
    renderTab(1);
    const row = screen.getByTestId('admin-table-row-metric-1');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByTestId('model-metrics-raw-row-details')).toBeInTheDocument();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.queryByTestId('model-metrics-raw-row-details')).not.toBeInTheDocument();
  });
});
