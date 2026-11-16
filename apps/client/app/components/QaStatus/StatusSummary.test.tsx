import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import StatusSummary, { formatPercent, productTitle } from './StatusSummary';
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
    },
    { product: 'product-b', e2e: { runs: 1, cleanRuns: 1, passed: 10, tests: 10, passRate: 1 }, latency: null },
  ],
};

describe('formatPercent', () => {
  it('rounds to one decimal and shows a dash for no data', () => {
    expect(formatPercent(0.98765)).toBe('98.8%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(null)).toBe('-');
  });
});

describe('productTitle', () => {
  it('raises only the first letter', () => {
    expect(productTitle('product-a')).toBe('Product-a');
    expect(productTitle('b4m')).toBe('B4m');
  });
});

describe('StatusSummary', () => {
  const RANGE = { from: '2026-11-10', to: '2026-11-16' };

  it('shows each product with a swatch, its title and its E2E and latency figures', () => {
    render(<StatusSummary summary={SUMMARY} range={RANGE} branch="main" />, { wrapper: QaTestWrapper });
    const [a, b] = screen.getAllByTestId('qa-summary-card');
    expect(a).toHaveTextContent(/^Product-a/);
    expect(b).toHaveTextContent(/^Product-b/);
    const [e2eA, e2eB] = screen.getAllByTestId('qa-summary-e2e');
    expect(e2eA).toHaveTextContent('E2E98.8%7 of 13 runs with no failures');
    expect(e2eB).toHaveTextContent('E2E100.0%1 of 1 run with no failures');
    expect(screen.getAllByTestId('qa-summary-latency')).toHaveLength(1);
    expect(screen.getByTestId('qa-summary-latency')).toHaveTextContent('Latency100.0%1 of 1 run passed');
    expect(screen.getByTestId('qa-summary')).toHaveTextContent(
      '7 days (Nov 10 - Nov 16) . branch main . all envs . all products, scheduled runs'
    );
  });

  it('colors each product by its place among every known product, not among the cards shown', () => {
    const swatches = (order?: string[]) => {
      const { unmount } = render(<StatusSummary summary={SUMMARY} range={RANGE} branch="main" colorOrder={order} />, {
        wrapper: QaTestWrapper,
      });
      const colors = screen.getAllByTestId('qa-summary-swatch').map(el => getComputedStyle(el).backgroundColor);
      unmount();
      return colors;
    };
    const byCardOrder = swatches();
    expect(new Set(byCardOrder).size).toBe(2);
    expect(swatches(['product-b', 'product-a'])).toEqual([byCardOrder[1], byCardOrder[0]]);
  });

  it('names the env filter, warns when truncated, and says when the range is empty', () => {
    render(
      <StatusSummary
        summary={{ ...SUMMARY, products: [], truncated: true }}
        range={{ from: '2026-11-16', to: '2026-11-16' }}
        branch="main"
        env="staging"
      />,
      { wrapper: QaTestWrapper }
    );
    expect(screen.getByTestId('qa-summary')).toHaveTextContent('1 day (Nov 16) . branch main');
    expect(screen.getByTestId('qa-summary')).toHaveTextContent('staging . all products, scheduled runs');
    expect(screen.getByTestId('qa-summary')).toHaveTextContent('oldest were left out');
    expect(screen.getByTestId('qa-summary-empty')).toHaveTextContent('No scheduled runs in this range.');
  });
});
