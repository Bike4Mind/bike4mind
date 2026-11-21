import { CloudScanRequestProvider } from './CloudScanRequest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { toast } from 'sonner';
import type {
  AttackSimulationData,
  SecurityDashboardOverview,
  SecurityDashboardProwlerSnapshot,
  SecurityScanSchedules,
} from '@client/app/hooks/data/admin';
import type { SecopsTriageRunSummary, SecopsTriageStatusResponse } from '@client/pages/api/admin/secops-triage/status';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  schedules: vi.fn(),
  prowler: vi.fn(),
  attack: vi.fn(),
  filing: vi.fn(),
  runWeb: { mutate: vi.fn(), isPending: false },
  runCloud: { mutate: vi.fn(), isPending: false },
  runProwler: { mutate: vi.fn(), isPending: false },
  runProbes: { mutate: vi.fn(), isPending: false },
  currentUser: { isAdmin: true } as Record<string, unknown>,
}));
vi.mock('@client/app/hooks/data/admin', () => ({
  SECURITY_DASHBOARD_CLOUD_QUERY_KEY: ['admin', 'security-dashboard', 'cloud'],
  useSecurityDashboardCloud: () => ({
    data: {
      checkedAt: mocks.overview().data?.checks.find((check: { id: string }) => check.id === 'cloud')?.lastCheckedAt,
    },
    isLoading: false,
  }),
  SECURITY_DASHBOARD_PROWLER_QUERY_KEY: ['admin', 'security-dashboard', 'cloud-prowler'],
  useSecurityDashboardOverview: mocks.overview,
  useSecurityScanSchedules: mocks.schedules,
  useSecurityDashboardProwler: mocks.prowler,
  useAttackSimulationData: mocks.attack,
  useSecopsTriageStatus: mocks.filing,
  useRunWebSecurityScan: () => mocks.runWeb,
  useRunCloudSecurityScan: () => mocks.runCloud,
  useRunProwlerScan: () => mocks.runProwler,
  useRunAttackSimulation: () => mocks.runProbes,
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { compactSeverityCounts, ScanSummaryTable } from './ScanSummaryTable';
import { ProwlerScanRequestProvider } from './ProwlerScanRequest';
import { SECURITY_DASHBOARD_PROWLER_QUERY_KEY } from '@client/app/hooks/data/admin';

const theme = extendTheme({ ...getThemeConfig() });
const NOW = new Date('2026-11-02T12:00:00.000Z');

const overview: SecurityDashboardOverview = {
  overallScore: 80,
  totalChecks: 2,
  passedChecks: 1,
  lastUpdated: '2026-11-02T10:00:00.000Z',
  nextScanInMinutes: null,
  checks: [
    {
      id: 'web',
      label: 'Website',
      status: 'warning',
      enabled: true,
      score: 70,
      summary: '',
      severityCounts: { critical: 0, high: 2, medium: 5, low: 0 },
      lastCheckedAt: '2026-11-01T12:00:00.000Z',
    },
    {
      id: 'cloud',
      label: 'Cloud',
      status: 'disabled',
      enabled: false,
      score: null,
      summary: '',
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      lastCheckedAt: null,
    },
  ],
};

const schedules: SecurityScanSchedules = {
  web: { enabled: true, dayOfWeek: 0, timeOfDay: '02:00', nextRunAt: '2026-11-05T12:00:00.000Z' },
  cloud: { enabled: false, dayOfWeek: 0, timeOfDay: '02:00', nextRunAt: null },
};

const prowler: SecurityDashboardProwlerSnapshot = {
  stage: 'test',
  scanType: 'cloud-prowler',
  targetUrl: 'https://example.com',
  status: 'pass',
  score: 100,
  summary: '',
  findings: [],
  checkedAt: '2026-10-30T12:00:00.000Z',
};

const attack = {
  stage: 'test',
  runs: [{ runId: 'run-1', status: 'completed', startedAt: '2026-11-02T09:00:00.000Z' }],
  findings: [
    { fingerprint: 'a', severity: 'P1', status: 'new' },
    { fingerprint: 'b', severity: 'P2', status: 'resolved' },
  ],
} as unknown as AttackSimulationData;

const filingRun = (overrides: Partial<SecopsTriageRunSummary>): SecopsTriageRunSummary => ({
  scanSource: 'web-owasp',
  status: 'completed',
  dryRun: false,
  findingCount: 3,
  startedAt: '2026-11-01T12:05:00.000Z',
  ...overrides,
});

const filing: SecopsTriageStatusResponse = {
  stage: 'test',
  enabled: true,
  dryRun: false,
  severityThreshold: 'high',
  maxIssuesPerScan: 20,
  github: { connected: true, repo: 'acme/tracker', check: { ok: true } },
  recentRuns: [],
  latestRunPerSource: [
    filingRun({
      counts: { created: 2, updated: 0, reopened: 0, closed: 1, suppressed: 0, belowThreshold: 0, overCap: 0 },
    }),
    filingRun({ scanSource: 'cloud', status: 'skipped', reason: 'disabled' }),
  ],
};

const renderTable = (onSelect = vi.fn()) => {
  const client = new QueryClient();
  client.setQueryData(SECURITY_DASHBOARD_PROWLER_QUERY_KEY, mocks.prowler().data);
  render(
    <QueryClientProvider client={client}>
      <ProwlerScanRequestProvider>
        <CloudScanRequestProvider>
          <CssVarsProvider theme={theme}>
            <ScanSummaryTable activeScan="web" onSelect={onSelect} />
          </CssVarsProvider>
        </CloudScanRequestProvider>
      </ProwlerScanRequestProvider>
    </QueryClientProvider>
  );
  return onSelect;
};

describe('ScanSummaryTable', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    mocks.overview.mockReturnValue({ data: overview, isError: false, refetch: vi.fn() });
    mocks.schedules.mockReturnValue({ data: schedules, refetch: vi.fn() });
    mocks.prowler.mockReturnValue({ data: prowler, isLoading: false, isError: false, refetch: vi.fn() });
    mocks.attack.mockReturnValue({ data: attack, isLoading: false, isError: false, refetch: vi.fn() });
    mocks.filing.mockReturnValue({ data: filing, isError: false, refetch: vi.fn() });
    for (const runner of [mocks.runWeb, mocks.runCloud, mocks.runProwler, mocks.runProbes]) {
      runner.mutate.mockReset();
      runner.isPending = false;
    }
    mocks.currentUser = { isAdmin: true };
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('lists one row per scan type with its status, findings and next run', () => {
    renderTable();
    const row = (id: string) => screen.getByTestId(`security-scans-summary-${id}-row`);
    expect(row('web')).toHaveTextContent('Website');
    expect(screen.getByTestId('security-scans-summary-web-status')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId('security-scans-summary-web-findings')).toHaveTextContent('2 high, 5 medium');
    expect(screen.getByTestId('security-scans-summary-web-next')).toHaveTextContent('in 3 days');

    expect(screen.getByTestId('security-scans-summary-cloud-status')).toHaveTextContent('Not run');
    expect(screen.getByTestId('security-scans-summary-cloud-status')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('security-scans-summary-cloud-next')).toHaveTextContent('Manual');

    expect(screen.getByTestId('security-scans-summary-prowler-status')).toHaveTextContent('Passed');
    expect(screen.getByTestId('security-scans-summary-prowler-findings')).toHaveTextContent('None');
    expect(within(row('prowler')).getByTestId('security-scans-summary-prowler-next')).toHaveTextContent('Manual');

    expect(screen.getByTestId('security-scans-summary-active-defense-status')).toHaveTextContent('Findings open');
    expect(screen.getByTestId('security-scans-summary-active-defense-findings')).toHaveTextContent('1 P1');
  });

  it('selects the scan whose row is clicked', () => {
    const onSelect = renderTable();
    fireEvent.click(screen.getByTestId('security-scans-summary-prowler-row'));
    expect(onSelect).toHaveBeenCalledWith('prowler');
  });

  it('marks a scan whose data failed to load as unavailable rather than failing', () => {
    mocks.overview.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
    renderTable();
    expect(screen.getByTestId('security-scans-summary-web-status')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('security-scans-summary-web-status')).toHaveAttribute('data-tone', 'neutral');
  });

  it('shows the next run as unavailable, not manual, when the schedules failed to load', () => {
    mocks.schedules.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
    renderTable();
    for (const id of ['web', 'cloud']) {
      expect(screen.getByTestId(`security-scans-summary-${id}-next`)).toHaveTextContent('Unavailable');
    }
    expect(screen.getByTestId('security-scans-summary-prowler-next')).toHaveTextContent('Manual');
  });

  it('skeletons the web and cloud next run, and hides the updating bar, until the schedules arrive', () => {
    mocks.schedules.mockReturnValue({ data: undefined, isError: false, isFetching: true, refetch: vi.fn() });
    renderTable();
    for (const id of ['web', 'cloud']) {
      expect(screen.queryByTestId(`security-scans-summary-${id}-next`)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId('security-scans-summary-prowler-next')).toHaveTextContent('Manual');
    expect(screen.queryByTestId('security-scans-summary-updating')).not.toBeInTheDocument();
  });

  it('summarizes severity counts compactly', () => {
    expect(compactSeverityCounts({ critical: 1, low: 3 }, ['critical', 'high', 'medium', 'low'])).toBe(
      '1 critical, 3 low'
    );
    expect(compactSeverityCounts({}, ['critical'])).toBe('None');
  });

  it('skeletons the last run, findings and next run cells of a row that is still loading', () => {
    mocks.overview.mockReturnValue({ data: undefined, isError: false, isFetching: true, refetch: vi.fn() });
    renderTable();
    const row = screen.getByTestId('security-scans-summary-web-row');
    expect(row).not.toHaveTextContent('\u2014');
    expect(screen.queryByTestId('security-scans-summary-web-findings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('security-scans-summary-web-next')).not.toBeInTheDocument();
    expect(screen.queryByTestId('security-scans-summary-updating')).not.toBeInTheDocument();
  });

  describe('Issues column', () => {
    const issues = (id: string) => screen.getByTestId(`security-scans-summary-${id}-issues`);

    it("shows the outcome of each scan's latest filing run in words", () => {
      renderTable();
      expect(issues('web')).toHaveTextContent('2 created, 1 closed');
      expect(issues('cloud')).toHaveTextContent('Skipped: triage is disabled');
    });

    it('gives Prowler the cloud run, since both scans file under the cloud source', () => {
      renderTable();
      expect(issues('prowler')).toHaveTextContent('Skipped: triage is disabled');
    });

    it('shows a dash for a scan with no filing run', () => {
      renderTable();
      expect(issues('active-defense')).toHaveTextContent(/^\u2014$/);
    });

    it('shows a dash in every row when no filing run exists yet', () => {
      mocks.filing.mockReturnValue({ data: { ...filing, latestRunPerSource: [] }, isError: false, refetch: vi.fn() });
      renderTable();
      for (const id of ['web', 'cloud', 'prowler', 'active-defense']) {
        expect(issues(id)).toHaveTextContent(/^\u2014$/);
      }
    });

    it('says unavailable when the filing status failed to load', () => {
      mocks.filing.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
      renderTable();
      expect(issues('web')).toHaveTextContent('Unavailable');
    });

    it('skeletons the cell while the filing status loads', () => {
      mocks.filing.mockReturnValue({ data: undefined, isError: false, isFetching: true, refetch: vi.fn() });
      renderTable();
      expect(screen.queryByTestId('security-scans-summary-web-issues')).not.toBeInTheDocument();
      expect(screen.getByTestId('security-scans-summary-web-findings')).toHaveTextContent('2 high, 5 medium');
    });
  });

  describe('row Run action', () => {
    const runButton = (id: string) => screen.getByTestId(`security-scans-summary-${id}-run-btn`);

    it('gives every scan row a Run button named for its scan', () => {
      renderTable();
      expect(runButton('web')).toHaveAccessibleName('Run website scan');
      expect(runButton('cloud')).toHaveAccessibleName('Run cloud baseline scan');
      expect(runButton('prowler')).toHaveAccessibleName('Run Prowler scan');
      expect(runButton('active-defense')).toHaveAccessibleName('Run active defense probes');
    });

    it.each([
      ['web', mocks.runWeb, 'Website scan queued. Results appear here when it finishes.'],
      ['cloud', mocks.runCloud, 'Cloud baseline scan queued. Results appear here when it finishes.'],
      ['prowler', mocks.runProwler, 'Prowler scan queued. Results arrive in about 10 minutes.'],
      ['active-defense', mocks.runProbes, 'Active defense probes started.'],
    ] as const)('starts the %s scan with its own request without selecting the row', (id, runner, message) => {
      const onSelect = renderTable();
      fireEvent.click(runButton(id));

      expect(runner.mutate).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
      act(() => {
        if (id === 'cloud') runner.mutate.mock.calls[0][1].onSuccess({ canRun: true, queued: true });
        else if (id === 'prowler') runner.mutate.mock.calls[0][1].onSuccess({ queued: true, environment: 'fixture' });
        else runner.mutate.mock.calls[0][1].onSuccess();
      });
      expect(toast.success).toHaveBeenCalledWith(message);
    });

    it('reports a scan that could not be started', () => {
      renderTable();
      fireEvent.click(runButton('web'));
      mocks.runWeb.mutate.mock.calls[0][1].onError({ response: { data: { error: 'Scan already running' } } });
      expect(toast.error).toHaveBeenCalledWith('Website scan could not be started: Scan already running');
    });

    it('disables the button during the cooldown and says when it is available again', () => {
      const recent = { ...overview.checks[0], lastCheckedAt: '2026-11-02T10:00:00.000Z' };
      mocks.overview.mockReturnValue({
        data: { ...overview, checks: [recent, overview.checks[1]] },
        isError: false,
        refetch: vi.fn(),
      });
      const onSelect = renderTable();

      expect(runButton('web')).toBeDisabled();
      const blocked = within(screen.getByTestId('security-scans-summary-web-row')).getByTestId(
        'admin-missing-permission-action'
      );
      expect(blocked).toHaveAttribute('aria-label', 'Available again in 22 hours');
      fireEvent.click(blocked);
      expect(mocks.runWeb.mutate).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
      expect(runButton('cloud')).not.toBeDisabled();
    });

    it('uses the 30 minute active defense cooldown from the last finished run', () => {
      mocks.attack.mockReturnValue({
        data: {
          ...attack,
          runs: [
            { runId: 'run-2', status: 'running', startedAt: '2026-11-02T11:58:00.000Z' },
            {
              runId: 'run-1',
              status: 'completed',
              startedAt: '2026-11-02T11:40:00.000Z',
              finishedAt: '2026-11-02T11:50:00.000Z',
            },
          ],
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      renderTable();

      expect(runButton('active-defense')).toBeDisabled();
      expect(
        within(screen.getByTestId('security-scans-summary-active-defense-row')).getByTestId(
          'admin-missing-permission-action'
        )
      ).toHaveAttribute('aria-label', 'Available again in 20 minutes');
    });

    it('waits for the last run before allowing a start', () => {
      mocks.overview.mockReturnValue({ data: undefined, isError: false, refetch: vi.fn() });
      renderTable();

      expect(runButton('web')).toBeDisabled();
      expect(
        within(screen.getByTestId('security-scans-summary-web-row')).getByTestId('admin-missing-permission-action')
      ).toHaveAttribute('aria-label', 'Available once the last run has loaded');
    });

    it('disables the button while its scan is starting', () => {
      mocks.runProwler.isPending = true;
      renderTable();
      expect(runButton('prowler')).toBeDisabled();
      expect(runButton('web')).not.toBeDisabled();
    });

    it('disables every Run button for an admin without settings:manage', () => {
      mocks.currentUser = { isAdmin: false, adminPermissions: ['support:read'] };
      renderTable();
      for (const id of ['web', 'cloud', 'prowler', 'active-defense']) {
        expect(runButton(id)).toBeDisabled();
      }
    });
  });

  it('shows an updating bar above the table while loaded data refetches', () => {
    mocks.attack.mockReturnValue({
      data: attack,
      isLoading: false,
      isError: false,
      isFetching: true,
      refetch: vi.fn(),
    });
    renderTable();
    expect(screen.getByTestId('security-scans-summary-updating')).toHaveTextContent('Updating');
    expect(screen.getByTestId('security-scans-summary-web-findings')).toHaveTextContent('2 high, 5 medium');
  });
});
