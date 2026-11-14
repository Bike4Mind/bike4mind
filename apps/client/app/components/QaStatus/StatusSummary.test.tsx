import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import StatusSummary, { formatPercent } from './StatusSummary';
import type { QaSummary } from '@client/app/hooks/data/qaStatus';

const SUMMARY: QaSummary = {
  from: '2026-09-21T12:00:00.000Z',
  to: '2026-09-28T12:00:00.000Z',
  truncated: false,
  products: [
    {
      product: 'product-a',
      e2e: { runs: 13, cleanRuns: 7, passed: 988, tests: 1000, passRate: 0.988 },
      latency: { runs: 1, passedRuns: 1, checks: 8, checksWithinLimit: 8, checkRate: 1 },
      rows: [
        {
          kind: 'e2e',
          suite: 'Full',
          trigger: 'scheduled',
          triggerLabel: 'Scheduled',
          stats: { runs: 12, cleanRuns: 6, passed: 900, tests: 910, passRate: 900 / 910 },
        },
        {
          kind: 'e2e',
          suite: 'Full',
          trigger: 'manual',
          triggerLabel: 'Manual dispatch',
          stats: { runs: 1, cleanRuns: 1, passed: 88, tests: 90, passRate: 88 / 90 },
        },
        {
          kind: 'latency',
          suite: 'AI Latency',
          trigger: 'scheduled',
          triggerLabel: 'Scheduled',
          stats: { runs: 1, passedRuns: 1, checks: 8, checksWithinLimit: 8, checkRate: 1 },
        },
      ],
    },
    { product: 'product-b', e2e: null, latency: null, rows: [] },
  ],
};

describe('formatPercent', () => {
  it('rounds to one decimal and shows a dash for no data', () => {
    expect(formatPercent(0.98765)).toBe('98.8%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(null)).toBe('-');
  });
});

describe('StatusSummary', () => {
  it('shows each product with its E2E and latency figures and a row per suite and trigger', () => {
    render(<StatusSummary summary={SUMMARY} rangeDays={7} branch="main" />, { wrapper: QaTestWrapper });
    const [card, empty] = screen.getAllByTestId('qa-summary-card');
    expect(card).toHaveTextContent('product-a');
    expect(screen.getByTestId('qa-summary-e2e')).toHaveTextContent('E2E98.8%7 of 13 runs with no failures');
    expect(screen.getByTestId('qa-summary-latency')).toHaveTextContent('Latency100.0%1 of 1 run passed');
    expect(screen.getAllByTestId('qa-summary-row').map(r => r.textContent)).toEqual([
      'FullScheduled98.9% . 6 of 12 runs with no failures',
      'FullManual dispatch97.8% . 1 of 1 run with no failures',
      'AI LatencyScheduled100.0% within limit . 1 of 1 run passed',
    ]);
    expect(empty).toHaveTextContent('product-b');
    expect(screen.getByTestId('qa-summary')).toHaveTextContent('branch main . all envs');
  });

  it('names the env filter, warns when truncated, and says when the range is empty', () => {
    render(
      <StatusSummary
        summary={{ ...SUMMARY, products: [], truncated: true }}
        rangeDays={30}
        branch="main"
        env="staging"
      />,
      { wrapper: QaTestWrapper }
    );
    expect(screen.getByTestId('qa-summary')).toHaveTextContent('Last 30 days');
    expect(screen.getByTestId('qa-summary')).toHaveTextContent('staging . all products');
    expect(screen.getByTestId('qa-summary')).toHaveTextContent('oldest were left out');
    expect(screen.getByTestId('qa-summary-empty')).toBeInTheDocument();
  });
});
