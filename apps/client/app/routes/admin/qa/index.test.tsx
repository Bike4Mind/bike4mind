import { cloneElement, type ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QaTestWrapper } from '@client/app/components/QaStatus/testTheme';
import type { QaStatusSearch } from '@client/app/hooks/data/qaStatus';

let search: QaStatusSearch = {};
vi.mock('@client/app/router', () => ({
  qaStatusRoute: { useSearch: () => search },
}));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
// ResponsiveContainer measures 0x0 in jsdom and renders no children; give the chart a fixed size.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 600, height: 220 }),
}));

const useQaFacets = vi.fn();
const useQaOverview = vi.fn();
const useQaRuns = vi.fn();
vi.mock('@client/app/hooks/data/qaStatus', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/qaStatus')>()),
  useQaFacets: (...args: unknown[]) => useQaFacets(...args),
  useQaOverview: (...args: unknown[]) => useQaOverview(...args),
  useQaRuns: (...args: unknown[]) => useQaRuns(...args),
}));

import QaStatusPage from './index';

/** Local wall-clock time, so day bucketing holds in any timezone. */
const local = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();

const run = (id: string, startedAt: string) => ({
  runId: id,
  suite: 'Core',
  env: 'staging',
  startedAt,
  status: 'failed' as const,
  passRate: 0.5,
  durationMs: 60_000,
  metrics: [],
});

// Four runs over two local days: one point per run on 7d, one per day on 30d.
const series = [run('r1', local(28, 9)), run('r2', local(28, 10)), run('r3', local(28, 11)), run('r4', local(29, 9))];

// The fixture's 0.5 pass rate is under the threshold, so every plotted point renders a failing dot.
const failingDots = () => [
  ...screen.getByTestId('qa-chart-pass-rate').querySelectorAll('[data-testid="qa-chart-failing-dot"]'),
];

beforeEach(() => {
  search = {};
  useQaFacets.mockReset().mockReturnValue({
    data: { products: ['product-a'], tenants: [], envs: [], branches: ['main'] },
  });
  useQaOverview.mockReset().mockReturnValue({ data: { tiles: [], series, flaky: [] }, isError: false });
  useQaRuns.mockReset().mockReturnValue({
    data: { pages: [{ runs: [] }] },
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  });
});

describe('QaStatusPage', () => {
  it('plots daily buckets for a range over a week', () => {
    search = { from: '2026-09-01', to: '2026-09-30' };
    render(<QaStatusPage />, { wrapper: QaTestWrapper });
    expect(useQaOverview).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'product-a', from: '2026-09-01', to: '2026-09-30' })
    );
    expect(failingDots()).toHaveLength(2);
  });

  it('still plots daily buckets for an older range=30d link', () => {
    search = { range: '30d' };
    render(<QaStatusPage />, { wrapper: QaTestWrapper });
    expect(failingDots()).toHaveLength(2);
  });

  it('opens on bike4mind when the URL names no product, even when it is not listed first', () => {
    useQaFacets.mockReturnValue({
      data: { products: ['alpha', 'bike4mind', 'gamma'], tenants: [], envs: [], branches: [] },
    });
    render(<QaStatusPage />, { wrapper: QaTestWrapper });
    expect(useQaOverview).toHaveBeenCalledWith(expect.objectContaining({ product: 'bike4mind' }));
  });

  it('falls back to the first product when bike4mind has no runs, and keeps a product from the URL', () => {
    useQaFacets.mockReturnValue({ data: { products: ['beta', 'gamma'], tenants: [], envs: [], branches: [] } });
    const { unmount } = render(<QaStatusPage />, { wrapper: QaTestWrapper });
    expect(useQaOverview).toHaveBeenLastCalledWith(expect.objectContaining({ product: 'beta' }));
    unmount();
    search = { product: 'gamma' };
    render(<QaStatusPage />, { wrapper: QaTestWrapper });
    expect(useQaOverview).toHaveBeenLastCalledWith(expect.objectContaining({ product: 'gamma' }));
  });

  it('plots one point per run when no range is chosen', () => {
    render(<QaStatusPage />, { wrapper: QaTestWrapper });
    expect(failingDots()).toHaveLength(4);
  });
});
