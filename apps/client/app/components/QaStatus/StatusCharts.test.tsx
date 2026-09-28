import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import StatusCharts from './StatusCharts';

describe('StatusCharts', () => {
  it('shows an empty state per chart with no data', () => {
    render(<StatusCharts series={[]} />, { wrapper: QaTestWrapper });
    for (const id of ['pass-rate', 'duration', 'credits', 'latency']) {
      expect(screen.getByTestId(`qa-chart-${id}-empty`)).toBeInTheDocument();
    }
  });

  it('renders the pass rate chart when there is data', () => {
    const series = [
      {
        runId: 'r1',
        suite: 'Core',
        env: 'staging',
        startedAt: '2026-09-28T09:00:00.000Z',
        status: 'passed' as const,
        passRate: 1,
        durationMs: 60_000,
        metrics: [],
      },
    ];
    render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-chart-pass-rate')).toBeInTheDocument();
    expect(screen.queryByTestId('qa-chart-pass-rate-empty')).toBeNull();
    expect(screen.getByTestId('qa-chart-credits-empty')).toBeInTheDocument();
  });
});
