import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SecurityDashboardProwlerSnapshot } from '@client/app/hooks/data/admin';

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: transport.get, post: transport.post } }));
vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'fixture-admin', isAdmin: true } }),
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./IncidentView', () => ({ IncidentView: () => <div data-testid="incident-view-stub" /> }));
vi.mock('./WafTrafficOverview', () => ({ WafTrafficOverview: () => <div /> }));
vi.mock('./IssueFilingCard', () => ({ IssueFilingCard: () => <div /> }));
vi.mock('./RecentFilingRunsCard', () => ({ RecentFilingRunsCard: () => <div /> }));
vi.mock('./ActiveDefenseTab', () => ({ default: () => <div />, ACTIVE_DEFENSE_COOLDOWN_MS: 30 * 60 * 1000 }));
vi.mock('@client/app/hooks/data/admin', async importOriginal => {
  const actual = await importOriginal<typeof import('@client/app/hooks/data/admin')>();
  const query = { data: undefined, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() };
  const mutation = { mutate: vi.fn(), isPending: false };
  return {
    ...actual,
    // The Prowler query and mutation remain real; only unrelated dashboard data is doubled.
    useSecurityDashboardOverview: () => query,
    useSecurityScanSchedules: () => query,
    useAttackSimulationData: () => query,
    useSecopsTriageStatus: () => query,
    useSecurityDashboardWeb: () => query,
    useSecurityDashboardCloud: () => query,
    useRunWebSecurityScan: () => mutation,
    useRunCloudSecurityScan: () => mutation,
    useRunAttackSimulation: () => mutation,
    useSecurityScanSchedule: () => query,
    useUpdateSecurityScanSchedule: () => mutation,
  };
});

import SecurityDashboard from '../SecurityDashboard';
import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { SECURITY_DASHBOARD_PROWLER_QUERY_KEY } from '@client/app/hooks/data/admin';

const theme = extendTheme({ ...getThemeConfig() });
const NOW = new Date('2026-11-02T12:00:00.000Z');
const BASELINE = '2026-10-30T12:00:00.000Z';
const clients: QueryClient[] = [];
const snapshot = (checkedAt = BASELINE): SecurityDashboardProwlerSnapshot => ({
  stage: 'fixture',
  scanType: 'cloud-prowler',
  targetUrl: 'https://example.test',
  status: 'pass',
  score: 100,
  summary: '',
  findings: [],
  checkedAt,
});
const summaryButton = () => screen.getByTestId('security-scans-summary-prowler-run-btn');
const detailButton = () => screen.getByTestId('prowler-run-scan-btn');
const accepted = () => ({ data: { queued: true, environment: 'fixture' } });

function renderDashboard(initial: SecurityDashboardProwlerSnapshot | null = snapshot()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(SECURITY_DASHBOARD_PROWLER_QUERY_KEY, initial);
  const view = render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>
        <SecurityDashboard />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { client, ...view };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'scans', securityScan: 'prowler' });
  transport.get.mockReset();
  transport.post.mockReset();
  transport.get.mockImplementation(async (url: string) => {
    if (url !== '/api/admin/security-dashboard/cloud-prowler') throw new Error(`Unexpected fixture GET: ${url}`);
    return { data: snapshot() };
  });
  transport.post.mockResolvedValue(accepted());
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});

describe('connected Prowler summary and detail with real QueryClient and mutation', () => {
  it('claims simultaneous connected clicks before rendering and retains the accepted gate across views', async () => {
    const request = Promise.withResolvers<ReturnType<typeof accepted>>();
    transport.post.mockReturnValue(request.promise);
    const { client } = renderDashboard();
    const summary = summaryButton();
    const detail = detailButton();
    act(() => {
      summary.click();
      detail.click();
    });
    await waitFor(() => expect(transport.post).toHaveBeenCalledOnce());
    expect(transport.post).toHaveBeenCalledWith('/api/admin/security-dashboard/cloud-prowler');
    expect(summaryButton()).toBeDisabled();
    expect(detailButton()).toBeDisabled();
    fireEvent.click(screen.getByTestId('security-scans-panel-tabs-web'));
    fireEvent.click(screen.getByTestId('security-scans-panel-tabs-prowler'));
    expect(detailButton()).toBeDisabled();
    await act(async () => {
      request.resolve(accepted());
      await request.promise;
    });
    await waitFor(() => expect(client.isMutating()).toBe(0));
    await act(async () => {
      fireEvent.click(summaryButton());
    });
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(transport.post).toHaveBeenCalledOnce();
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Prowler scan queued'));
    expect(summaryButton()).toBeDisabled();
    expect(screen.queryByTestId('prowler-run-scan-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('security-dashboard-views-incident-btn'));
    fireEvent.click(screen.getByTestId('security-dashboard-views-scans-btn'));
    fireEvent.click(screen.getByTestId('security-scans-panel-tabs-prowler'));
    expect(summaryButton()).toBeDisabled();
    expect(screen.getByText(/Scan queued \(~10 min\)/)).toBeTruthy();
    fireEvent.click(summaryButton());
    expect(transport.post).toHaveBeenCalledOnce();
    expect(client.getQueryData(SECURITY_DASHBOARD_PROWLER_QUERY_KEY)).toEqual(snapshot());
  });

  it('keeps same, older, invalid and failed snapshots queued until a successful newer audit arrives', async () => {
    const { client } = renderDashboard();
    fireEvent.click(summaryButton());
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Prowler scan queued'));
    for (const value of [BASELINE, '2026-10-29T12:00:00.000Z', 'invalid']) {
      await act(async () => {
        client.setQueryData(SECURITY_DASHBOARD_PROWLER_QUERY_KEY, snapshot(value));
      });
      expect(summaryButton()).toBeDisabled();
      expect(summaryButton()).toHaveAttribute('aria-label', 'Prowler scan queued');
    }
    transport.get.mockRejectedValueOnce(new Error('fixture refetch failed'));
    await act(async () => {
      await client.refetchQueries({ queryKey: SECURITY_DASHBOARD_PROWLER_QUERY_KEY });
    });
    expect(summaryButton()).toHaveAttribute('aria-label', 'Prowler scan queued');
    transport.get.mockResolvedValueOnce({ data: snapshot('2026-11-01T11:00:00.000Z') });
    await act(async () => {
      await client.refetchQueries({ queryKey: SECURITY_DASHBOARD_PROWLER_QUERY_KEY });
    });
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Run Prowler scan'));
    expect(summaryButton()).not.toBeDisabled();
    expect(detailButton()).not.toBeDisabled();
    fireEvent.click(detailButton());
    await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(2));
  });

  it('recognizes results arriving before acknowledgement while still applying the existing cooldown', async () => {
    const request = Promise.withResolvers<ReturnType<typeof accepted>>();
    transport.post.mockReturnValue(request.promise);
    const { client } = renderDashboard();
    fireEvent.click(detailButton());
    await waitFor(() => expect(transport.post).toHaveBeenCalledOnce());
    transport.get.mockResolvedValueOnce({ data: snapshot('2026-11-02T11:00:00.000Z') });
    await act(async () => {
      await client.refetchQueries({ queryKey: SECURITY_DASHBOARD_PROWLER_QUERY_KEY });
    });
    expect(summaryButton()).toBeDisabled();
    await act(async () => {
      request.resolve(accepted());
      await request.promise;
    });
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Run Prowler scan'));
    expect(summaryButton()).toBeDisabled();
    expect(detailButton()).toBeDisabled();
    expect(detailButton()).toHaveTextContent('Cooldown active');
    expect(transport.post).toHaveBeenCalledOnce();
  });

  it('releases shared failure for a deliberate retry and does not claim queued:false as success', async () => {
    transport.post.mockRejectedValueOnce(new Error('fixture dispatch failed'));
    renderDashboard();
    fireEvent.click(summaryButton());
    await screen.findByText(/Failed to queue Prowler scan/);
    expect(summaryButton()).not.toBeDisabled();
    expect(detailButton()).not.toBeDisabled();
    transport.post.mockResolvedValueOnce({ data: { queued: false, environment: 'fixture' } });
    fireEvent.click(detailButton());
    await screen.findByText('Prowler scan was not queued.');
    expect(summaryButton()).not.toBeDisabled();
    transport.post.mockResolvedValueOnce(accepted());
    fireEvent.click(summaryButton());
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Prowler scan queued'));
    expect(transport.post).toHaveBeenCalledTimes(3);
    expect(summaryButton()).toBeDisabled();
  });

  it('keeps an accepted empty-stage request gated until its first finite audit result', async () => {
    const { client } = renderDashboard(null);
    fireEvent.click(detailButton());
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Prowler scan queued'));
    await act(async () => {
      client.setQueryData(SECURITY_DASHBOARD_PROWLER_QUERY_KEY, null);
    });
    expect(summaryButton()).toBeDisabled();
    transport.get.mockResolvedValueOnce({ data: snapshot('2026-11-01T11:00:00.000Z') });
    await act(async () => {
      await client.refetchQueries({ queryKey: SECURITY_DASHBOARD_PROWLER_QUERY_KEY });
    });
    await waitFor(() => expect(summaryButton()).not.toBeDisabled());
  });

  it('does not let an unmounted owner acknowledge a replacement dashboard request', async () => {
    const oldRequest = Promise.withResolvers<ReturnType<typeof accepted>>();
    const newRequest = Promise.withResolvers<ReturnType<typeof accepted>>();
    transport.post.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const oldView = renderDashboard();
    fireEvent.click(detailButton());
    await waitFor(() => expect(transport.post).toHaveBeenCalledOnce());
    oldView.unmount();
    renderDashboard();
    expect(summaryButton()).not.toBeDisabled();
    fireEvent.click(summaryButton());
    await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(2));
    await act(async () => {
      oldRequest.resolve(accepted());
      await oldRequest.promise;
    });
    expect(summaryButton()).toBeDisabled();
    expect(summaryButton()).toHaveAttribute('aria-label', 'Run Prowler scan');
    expect(detailButton()).toBeDisabled();
    await act(async () => {
      newRequest.resolve(accepted());
      await newRequest.promise;
    });
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Prowler scan queued'));
  });
});
