import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type {
  AttackSimulationData,
  SecurityDashboardOverview,
  SecurityDashboardProwlerSnapshot,
  SecurityScanSchedules,
} from '@client/app/hooks/data/admin';

const mocks = vi.hoisted(() => ({ overview: vi.fn(), schedules: vi.fn(), prowler: vi.fn(), attack: vi.fn() }));
vi.mock('@client/app/hooks/data/admin', () => ({
  useSecurityDashboardOverview: mocks.overview,
  useSecurityScanSchedules: mocks.schedules,
  useSecurityDashboardProwler: mocks.prowler,
  useAttackSimulationData: mocks.attack,
}));

import { compactSeverityCounts, ScanSummaryTable } from './ScanSummaryTable';

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

const renderTable = (onSelect = vi.fn()) => {
  render(
    <CssVarsProvider theme={theme}>
      <ScanSummaryTable activeScan="web" onSelect={onSelect} />
    </CssVarsProvider>
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

  it('summarizes severity counts compactly', () => {
    expect(compactSeverityCounts({ critical: 1, low: 3 }, ['critical', 'high', 'medium', 'low'])).toBe(
      '1 critical, 3 low'
    );
    expect(compactSeverityCounts({}, ['critical'])).toBe('None');
  });
});
