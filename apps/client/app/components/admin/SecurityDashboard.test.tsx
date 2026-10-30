import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SecurityDashboardOverview } from '@client/app/hooks/data/admin';
import { SecurityOverviewGrid } from './SecurityDashboard';

const mocks = vi.hoisted(() => ({ overview: vi.fn(), refetch: vi.fn() }));
vi.mock('@client/app/hooks/data/admin', () => ({
  useSecurityDashboardOverview: mocks.overview,
  useSecurityDashboardAiAssessment: () => ({ data: undefined }),
  useSecurityScanSchedules: () => ({ data: {} }),
}));
vi.mock('./SecurityDashboard/ActiveDefenseTab', () => ({ default: () => null }));
vi.mock('./SecurityDashboard/WafTrafficOverview', () => ({ WafTrafficOverview: () => null }));
const theme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);
const data: SecurityDashboardOverview = {
  overallScore: 100,
  totalChecks: 1,
  passedChecks: 1,
  lastUpdated: '2026-01-01T00:00:00Z',
  nextScanInMinutes: null,
  checks: [
    {
      id: 'web',
      label: 'Website',
      status: 'pass',
      enabled: true,
      score: 100,
      summary: 'No findings',
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      lastCheckedAt: null,
    },
  ],
};

describe('Security overview anatomy', () => {
  it('opens an available detail from the shared table without exposing hidden tabs', () => {
    mocks.overview.mockReturnValue({ data, refetch: mocks.refetch });
    const onOpen = vi.fn();
    render(<SecurityOverviewGrid onOpen={onOpen} />, { wrapper });
    expect(screen.getByTestId('admin-data-table')).toBeVisible();
    fireEvent.click(screen.getByTestId('security-open-web-btn'));
    expect(onOpen).toHaveBeenCalledWith('web');
  });

  it('offers a retry when the overview fails instead of leaving a blank screen', () => {
    mocks.overview.mockReturnValue({ isError: true, refetch: mocks.refetch });
    render(<SecurityOverviewGrid onOpen={vi.fn()} />, { wrapper });
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
