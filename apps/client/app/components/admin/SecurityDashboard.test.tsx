import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SecurityScan } from './securityDashboardSearch';

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
const mocks = vi.hoisted(() => ({
  query: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
}));
vi.mock('@client/app/hooks/data/admin', () => {
  const query = mocks.query;
  const mutation = { mutate: vi.fn(), isPending: false };
  return {
    useSecurityDashboardWeb: () => query,
    useRunWebSecurityScan: () => mutation,
    useSecurityDashboardCloud: () => query,
    useRunCloudSecurityScan: () => mutation,
    useSecurityDashboardProwler: () => query,
    useRunProwlerScan: () => mutation,
    useSecurityScanSchedule: () => ({ data: undefined }),
    useUpdateSecurityScanSchedule: () => mutation,
  };
});
vi.mock('./SecurityDashboard/IncidentView', () => ({
  IncidentView: () => <div data-testid="incident-view-stub" />,
}));
vi.mock('./SecurityDashboard/WafTrafficOverview', () => ({
  WafTrafficOverview: ({ isActive }: { isActive?: boolean }) => (
    <div data-testid="waf-overview-stub" data-active={String(isActive)} />
  ),
}));
vi.mock('./SecurityDashboard/ActiveDefenseTab', () => ({ default: () => <div data-testid="active-defense-stub" /> }));
vi.mock('./SecurityDashboard/ScanSummaryTable', () => ({
  ScanSummaryTable: ({
    activeScan,
    onSelect,
  }: {
    activeScan: SecurityScan;
    onSelect: (scan: SecurityScan) => void;
  }) => (
    <div data-testid="scan-summary-stub" data-active={activeScan}>
      <button type="button" data-testid="scan-summary-stub-cloud" onClick={() => onSelect('cloud')} />
    </div>
  ),
}));

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import SecurityDashboard from './SecurityDashboard';

const theme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={theme}>
      <SecurityDashboard />
    </CssVarsProvider>
  );

describe('SecurityDashboard views', () => {
  beforeEach(() => {
    Object.assign(mocks.query, { data: undefined, isLoading: false, isError: false });
    mocks.query.refetch.mockClear();
    fakeAdminRouter.reset({ tab: 'security-dashboard' });
  });

  it('opens the incident view on a bare tab link', () => {
    renderPage();
    expect(screen.getByTestId('admin-page-header')).toHaveTextContent('Security');
    expect(screen.getByTestId('security-dashboard-views-incident-btn')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('incident-view-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('waf-overview-stub')).not.toBeInTheDocument();
  });

  it('keeps the selected view in the URL and mounts the firewall only while it is open', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('security-dashboard-views-firewall-btn'));

    expect(fakeAdminRouter.search).toMatchObject({ tab: 'security-dashboard', securityView: 'firewall' });
    expect(screen.getByTestId('waf-overview-stub')).toHaveAttribute('data-active', 'true');
    expect(screen.queryByTestId('incident-view-stub')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('security-dashboard-views-incident-btn'));
    expect(fakeAdminRouter.search).not.toHaveProperty('securityView');
    expect(screen.queryByTestId('waf-overview-stub')).not.toBeInTheDocument();
  });

  it('opens the scan panel a link names', () => {
    fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'scans', securityScan: 'active-defense' });
    renderPage();
    expect(screen.getByTestId('scan-summary-stub')).toHaveAttribute('data-active', 'active-defense');
    expect(screen.getByTestId('security-scans-active-defense-panel')).toContainElement(
      screen.getByTestId('active-defense-stub')
    );
  });

  it('switches the scan panel from the summary table and the panel control', () => {
    fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'scans' });
    renderPage();
    expect(screen.getByTestId('security-scans-web-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('scan-summary-stub-cloud'));
    expect(fakeAdminRouter.search).toMatchObject({ securityView: 'scans', securityScan: 'cloud' });
    expect(screen.getByTestId('security-scans-cloud-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('security-scans-panel-tabs-web'));
    expect(fakeAdminRouter.search).not.toHaveProperty('securityScan');
    expect(screen.getByTestId('security-scans-web-panel')).toBeInTheDocument();
  });

  it('drops the scan panel when leaving the Scans view', () => {
    fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'scans', securityScan: 'prowler' });
    renderPage();
    fireEvent.click(screen.getByTestId('security-dashboard-views-incident-btn'));
    expect(fakeAdminRouter.search).toEqual({ tab: 'security-dashboard' });
  });

  it('falls back to the incident view for an unknown view', () => {
    act(() => fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'overview' }));
    renderPage();
    expect(screen.getByTestId('incident-view-stub')).toBeInTheDocument();
  });

  it('shows an error with retry, not the empty message, when the website scan fails to load', () => {
    fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'scans' });
    mocks.query.isError = true;
    renderPage();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load the website security scan.');
    expect(screen.queryByText(/No website security scan has been recorded/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.query.refetch).toHaveBeenCalled();
  });

  it('shows the empty message when the website scan loaded with no data', () => {
    fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'scans' });
    renderPage();
    expect(screen.getByText(/No website security scan has been recorded/)).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
  });

  it('shows an error, not the empty message, when the Prowler audit fails to load', () => {
    fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'scans', securityScan: 'prowler' });
    mocks.query.isError = true;
    renderPage();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load the Prowler audit.');
    expect(screen.queryByText(/No Prowler audit data found/)).not.toBeInTheDocument();
  });
});
