import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SecopsTriageRunSummary } from '@client/pages/api/admin/secops-triage/status';

const mocks = vi.hoisted(() => ({
  status: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@client/app/hooks/data/admin', () => ({ useSecopsTriageStatus: () => mocks.status }));

import { RecentFilingRunsCard } from './RecentFilingRunsCard';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const appTheme = extendTheme({ ...getThemeConfig() });
const renderCard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <RecentFilingRunsCard />
    </CssVarsProvider>
  );

const run = (overrides: Partial<SecopsTriageRunSummary>): SecopsTriageRunSummary => ({
  scanSource: 'web-owasp',
  status: 'completed',
  dryRun: false,
  findingCount: 1,
  startedAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
  ...overrides,
});

const withRuns = (recentRuns: SecopsTriageRunSummary[]) => ({
  stage: 'test-stage',
  enabled: true,
  dryRun: false,
  severityThreshold: 'high',
  maxIssuesPerScan: 20,
  github: { connected: true, repo: 'acme/tracker', check: { ok: true } },
  recentRuns,
  latestRunPerSource: [],
});

describe('RecentFilingRunsCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    Object.assign(mocks.status, { data: withRuns([]), isLoading: false, isError: false });
    mocks.status.refetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists each run with when, which scan and its outcome in words, including skips and their reason', () => {
    mocks.status.data = withRuns([
      run({ counts: { created: 2, updated: 0, reopened: 0, closed: 0, suppressed: 0, belowThreshold: 1, overCap: 0 } }),
      run({ scanSource: 'cloud', status: 'skipped', reason: 'no_github_connection' }),
      run({ scanSource: 'active-defense', status: 'failed', error: 'rate limited' }),
    ]);
    renderCard();

    const first = screen.getByTestId('security-filing-runs-row-0');
    expect(first).toHaveTextContent('Website');
    expect(first).toHaveTextContent('5 minutes ago');
    expect(within(first).getByTestId('security-filing-runs-outcome')).toHaveTextContent(
      '1 finding, 1 below threshold, 2 created'
    );
    const second = screen.getByTestId('security-filing-runs-row-1');
    expect(second).toHaveTextContent('Cloud baseline or Prowler');
    expect(second).toHaveTextContent('Skipped: there is no GitHub connection');
    expect(screen.getByTestId('security-filing-runs-row-2')).toHaveTextContent('Failed: rate limited');
  });

  it('shows all ten runs the status returns, in order', () => {
    mocks.status.data = withRuns(Array.from({ length: 10 }, () => run({ scanSource: 'secrets' })));
    renderCard();

    expect(screen.getAllByTestId('security-filing-runs-outcome')).toHaveLength(10);
    expect(screen.getByTestId('security-filing-runs-row-9')).toHaveTextContent('Secrets');
  });

  it('shows an empty state with a refresh when there are no runs', () => {
    renderCard();

    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No filing runs yet');
    fireEvent.click(screen.getByTestId('security-filing-runs-refresh-btn'));
    expect(mocks.status.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an error with a retry when the status fails to load', () => {
    Object.assign(mocks.status, { data: undefined, isError: true });
    renderCard();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Filing runs could not be loaded.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.status.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows loading rows while the status loads', () => {
    Object.assign(mocks.status, { data: undefined, isLoading: true });
    renderCard();

    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('admin-empty-state')).not.toBeInTheDocument();
  });
});
