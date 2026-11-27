import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AnalyticsCohorts, CohortRow } from '@client/app/utils/analyticsCohorts';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));

import { CohortsSection, rampStep } from './CohortsSection';

const theme = extendTheme({ ...getThemeConfig() });
const blank = (n: number) => Array<null>(n).fill(null);

const row = (week: string, size: number | null, percents: (number | null)[]): CohortRow => ({
  week,
  size,
  cells: [
    ...percents.map(percent =>
      percent === null || size === null ? null : { active: Math.round((percent / 100) * size), percent }
    ),
    ...blank(9 - percents.length),
  ],
});

const cohorts = (patch: Partial<AnalyticsCohorts> = {}): AnalyticsCohorts => ({
  signupsMode: 'legit',
  weeks: 12,
  asOf: '2026-06-14',
  missingDays: [],
  cohorts: [row('2026-06-01', 40, [100, 50, 25]), row('2026-06-08', 20, [100, 10])],
  ...patch,
});

function renderSection(signups: 'legit' | 'all' = 'legit') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<CohortsSection signups={signups} />, { wrapper: Wrapper });
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockResolvedValue({ data: cohorts() });
});

describe('rampStep', () => {
  it('maps 0-100 percent onto five accent steps and clamps', () => {
    expect([0, 19.9, 20, 45, 99.9, 100].map(rampStep)).toEqual([0, 0, 1, 2, 4, 4]);
    expect(rampStep(-5)).toBe(0);
    expect(rampStep(250)).toBe(4);
  });
});

describe('CohortsSection', () => {
  it('requests 12 weeks for the Signups toggle it is given, and refetches when it changes', async () => {
    const view = renderSection('all');
    await screen.findByTestId('analytics-cohorts-table');
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/analytics/cohorts', { params: { weeks: 12, signups: 'all' } });

    view.rerender(<CohortsSection signups="legit" />);
    await waitFor(() =>
      expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/analytics/cohorts', {
        params: { weeks: 12, signups: 'legit' },
      })
    );
  });

  it('prints each percent with its number, in rows of week, cohort size and week 0 to 8', async () => {
    renderSection();
    const table = await screen.findByTestId('analytics-cohorts-table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent)
    ).toEqual(['Signup week (UTC)', 'Cohort size', ...Array.from({ length: 9 }, (_, offset) => `Week ${offset}`)]);
    const first = screen.getByTestId('analytics-cohort-row-2026-06-01');
    expect(within(first).getByText('Jun 1 (Mon)')).toBeInTheDocument();
    expect(within(first).getByText('40')).toBeInTheDocument();
    expect(
      within(first)
        .getAllByTestId('analytics-cohort-cell')
        .map(cell => cell.textContent)
    ).toEqual(['100.0%', '50.0%', '25.0%']);
  });

  it('leaves a future cell blank and keeps a real zero printed as 0.0%', async () => {
    mocks.get.mockResolvedValue({ data: cohorts({ cohorts: [row('2026-06-08', 20, [0])] }) });
    renderSection();
    const only = await screen.findByTestId('analytics-cohort-row-2026-06-08');
    const cells = within(only).getAllByTestId('analytics-cohort-cell');
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveTextContent('0.0%');
    // Eight of the nine week cells are blank: no text at all, not "0".
    const bodyCells = within(only).getAllByRole('cell');
    expect(bodyCells.slice(3).every(cell => cell.textContent === '')).toBe(true);
  });

  it('shades by a single accent ramp: a higher percent is a higher step', async () => {
    renderSection();
    await screen.findByTestId('analytics-cohorts-table');
    const steps = within(screen.getByTestId('analytics-cohort-row-2026-06-01'))
      .getAllByTestId('analytics-cohort-cell')
      .map(cell => Number(cell.getAttribute('data-step')));
    expect(steps).toEqual([4, 2, 1]);
  });

  it('shows a blank cohort size when a rollup day is missing, and says how many days', async () => {
    mocks.get.mockResolvedValue({
      data: cohorts({
        missingDays: ['2026-06-03'],
        cohorts: [row('2026-06-01', null, []), row('2026-06-08', 20, [100])],
      }),
    });
    renderSection();
    expect(await screen.findByTestId('analytics-cohorts-missing')).toHaveTextContent(
      'Rollup is missing for 1 day; the cells that depend on it are blank.'
    );
    expect(
      within(screen.getByTestId('analytics-cohort-row-2026-06-01')).queryByTestId('analytics-cohort-cell')
    ).toBeNull();
  });

  it('explains the Signups mode in the caption', async () => {
    renderSection();
    expect(await screen.findByTestId('analytics-cohorts-caption')).toHaveTextContent('not suspected');
  });

  it('describes every signup when the Signups mode is all', async () => {
    mocks.get.mockResolvedValue({ data: cohorts({ signupsMode: 'all' }) });
    renderSection();
    expect(await screen.findByTestId('analytics-cohorts-caption')).toHaveTextContent('all signups');
  });

  it('shows a skeleton while loading', async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderSection();
    expect(await screen.findByTestId('analytics-cohorts-skeleton')).toBeInTheDocument();
  });

  it('shows an empty state when no signup week has been rolled up yet', async () => {
    mocks.get.mockResolvedValue({ data: cohorts({ asOf: null, cohorts: [] }) });
    renderSection();
    expect(await screen.findByText('No cohorts yet')).toBeInTheDocument();
  });

  it('shows an error with Try again and recovers', async () => {
    mocks.get.mockRejectedValueOnce(new Error('boom'));
    renderSection();
    fireEvent.click(await screen.findByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('analytics-cohorts-table')).toBeInTheDocument();
  });
});
