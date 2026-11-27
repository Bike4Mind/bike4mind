import { toast } from 'sonner';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SecurityDashboardCloudSnapshot, SecurityDashboardOverview } from '@client/app/hooks/data/admin';

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
    // The Cloud query and mutation remain real; only unrelated dashboard data is doubled.
    useSecurityDashboardOverview: () => ({ ...query, data: overview }),
    useSecurityScanSchedules: () => query,
    useAttackSimulationData: () => query,
    useSecopsTriageStatus: () => query,
    useSecurityDashboardWeb: () => query,
    useSecurityDashboardProwler: () => query,
    useRunWebSecurityScan: () => mutation,
    useRunProwlerScan: () => mutation,
    useRunAttackSimulation: () => mutation,
    useSecurityScanSchedule: () => query,
    useUpdateSecurityScanSchedule: () => mutation,
  };
});

import SecurityDashboard from '../SecurityDashboard';
import { QUEUED_RESULT_DEADLINE_MS, QUEUED_RESULT_TIMEOUT_ERROR } from './CloudScanRequest';
import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
const CLOUD_QUERY_KEY = ['admin', 'security-dashboard', 'cloud'] as const;

const theme = extendTheme({ ...getThemeConfig() });
const NOW = new Date('2026-11-02T12:00:00.000Z');
const BASELINE = '2026-10-30T12:00:00.000Z';
const clients: QueryClient[] = [];
const snapshot = (checkedAt = BASELINE): SecurityDashboardCloudSnapshot => ({
  stage: 'fixture',
  scanType: 'cloud',
  targetUrl: 'https://example.test',
  status: 'pass',
  score: 100,
  summary: '',
  findings: [],
  checkedAt,
});
const overview: SecurityDashboardOverview = {
  overallScore: 100,
  totalChecks: 1,
  passedChecks: 1,
  lastUpdated: BASELINE,
  nextScanInMinutes: null,
  checks: [
    {
      id: 'cloud',
      label: 'Cloud',
      status: 'pass',
      enabled: true,
      score: 100,
      summary: '',
      lastCheckedAt: BASELINE,
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    },
  ],
};
const summaryButton = () => screen.getByTestId('security-scans-summary-cloud-run-btn');
const detailButton = () => screen.getByTestId('cloud-security-run-scan-btn');
const accepted = () => ({ data: { canRun: true, queued: true } });

function renderDashboard(initial: SecurityDashboardCloudSnapshot | null = snapshot()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  if (initial !== null) client.setQueryData(CLOUD_QUERY_KEY, initial);
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
  fakeAdminRouter.reset({ tab: 'security-dashboard', securityView: 'scans', securityScan: 'cloud' });
  transport.get.mockReset();
  transport.post.mockReset();
  transport.get.mockImplementation(async (url: string) => {
    if (url !== '/api/admin/security-dashboard/cloud') throw new Error(`Unexpected fixture GET: ${url}`);
    return { data: snapshot() };
  });
  transport.post.mockResolvedValue(accepted());
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});

describe('connected Cloud summary and detail with real QueryClient and mutation', () => {
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
    expect(transport.post).toHaveBeenCalledWith('/api/admin/security-dashboard/cloud');
    expect(summaryButton()).toBeDisabled();
    expect(detailButton()).toBeDisabled();
    fireEvent.click(screen.getByTestId('security-scans-panel-tabs-web'));
    fireEvent.click(screen.getByTestId('security-scans-panel-tabs-cloud'));
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
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued'));
    expect(summaryButton()).toBeDisabled();
    expect(detailButton()).toBeDisabled();
    fireEvent.click(screen.getByTestId('security-dashboard-views-incident-btn'));
    fireEvent.click(screen.getByTestId('security-dashboard-views-scans-btn'));
    fireEvent.click(screen.getByTestId('security-scans-panel-tabs-cloud'));
    expect(summaryButton()).toBeDisabled();
    fireEvent.click(summaryButton());
    expect(transport.post).toHaveBeenCalledOnce();
    expect(client.getQueryData(CLOUD_QUERY_KEY)).toEqual(snapshot());
  });

  it('keeps same, older, invalid and failed snapshots queued until a successful newer audit arrives', async () => {
    const { client } = renderDashboard();
    fireEvent.click(summaryButton());
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued'));
    for (const value of [BASELINE, '2026-10-29T12:00:00.000Z', 'invalid']) {
      await act(async () => {
        client.setQueryData(CLOUD_QUERY_KEY, snapshot(value));
      });
      expect(summaryButton()).toBeDisabled();
      expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued');
    }
    transport.get.mockRejectedValueOnce(new Error('fixture refetch failed'));
    await act(async () => {
      await client.refetchQueries({ queryKey: CLOUD_QUERY_KEY });
    });
    expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued');
    transport.get.mockResolvedValueOnce({ data: snapshot('2026-11-01T11:00:00.000Z') });
    await act(async () => {
      await client.refetchQueries({ queryKey: CLOUD_QUERY_KEY });
    });
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Run cloud baseline scan'));
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
      await client.refetchQueries({ queryKey: CLOUD_QUERY_KEY });
    });
    expect(summaryButton()).toBeDisabled();
    await act(async () => {
      request.resolve(accepted());
      await request.promise;
    });
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Run cloud baseline scan'));
    expect(summaryButton()).toBeDisabled();
    expect(detailButton()).toBeDisabled();

    expect(transport.post).toHaveBeenCalledOnce();
  });

  it('releases rejected and unacknowledged requests for a deliberate retry', async () => {
    transport.post.mockRejectedValueOnce(new Error('fixture dispatch failed'));
    renderDashboard();
    fireEvent.click(summaryButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to queue cloud baseline scan.'));
    expect(summaryButton()).not.toBeDisabled();
    expect(detailButton()).not.toBeDisabled();
    transport.post.mockResolvedValueOnce({ data: { canRun: true, queued: false } });
    fireEvent.click(detailButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cloud baseline scan was not queued.'));
    expect(summaryButton()).not.toBeDisabled();
    fireEvent.click(summaryButton());
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued'));
    expect(transport.post).toHaveBeenCalledTimes(3);
    expect(toast.success).toHaveBeenCalledWith('Cloud baseline scan queued. Results appear here when it finishes.');
  });

  it('stops polling and releases the request when no result arrives before the deadline', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    renderDashboard();
    await act(async () => {
      fireEvent.click(summaryButton());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUED_RESULT_DEADLINE_MS - 1);
    });
    expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued');
    expect(transport.get).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(summaryButton()).toHaveAttribute('aria-label', 'Run cloud baseline scan');
    expect(summaryButton()).not.toBeDisabled();
    expect(toast.error).toHaveBeenCalledWith(QUEUED_RESULT_TIMEOUT_ERROR);
    const polls = transport.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(transport.get).toHaveBeenCalledTimes(polls);
  });

  it('blocks a cached overview action until the first snapshot request settles', async () => {
    const initial = Promise.withResolvers<{ data: SecurityDashboardCloudSnapshot }>();
    transport.get.mockReturnValueOnce(initial.promise);
    const { client } = renderDashboard(null);
    expect(summaryButton()).toBeDisabled();
    fireEvent.click(summaryButton());
    expect(transport.post).not.toHaveBeenCalled();
    await act(async () => {
      initial.reject(new Error('No snapshot found'));
      await expect(initial.promise).rejects.toThrow('No snapshot found');
    });
    await waitFor(() => expect(client.getQueryState(CLOUD_QUERY_KEY)?.status).toBe('error'));
    expect(summaryButton()).not.toBeDisabled();
    fireEvent.click(summaryButton());
    await waitFor(() => expect(transport.post).toHaveBeenCalledOnce());
  });

  it('allows a first scan after GET reports no snapshot and holds it until a successful finite result', async () => {
    transport.get.mockRejectedValueOnce(new Error('No snapshot found'));
    const { client } = renderDashboard(null);
    await waitFor(() => expect(client.getQueryState(CLOUD_QUERY_KEY)?.status).toBe('error'));
    fireEvent.click(detailButton());
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued'));
    expect(detailButton()).toBeDisabled();
    transport.get.mockResolvedValueOnce({ data: snapshot('invalid') });
    await act(async () => {
      await client.refetchQueries({ queryKey: CLOUD_QUERY_KEY });
    });
    expect(detailButton()).toBeDisabled();
    transport.get.mockResolvedValueOnce({ data: snapshot() });
    await act(async () => {
      await client.refetchQueries({ queryKey: CLOUD_QUERY_KEY });
    });
    await waitFor(() => expect(summaryButton()).not.toBeDisabled());
    expect(detailButton()).not.toBeDisabled();
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
    fireEvent.click(summaryButton());
    await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(2));
    await act(async () => {
      oldRequest.resolve(accepted());
      await oldRequest.promise;
    });
    expect(summaryButton()).toHaveAttribute('aria-label', 'Run cloud baseline scan');
    expect(detailButton()).toBeDisabled();
    await act(async () => {
      newRequest.resolve(accepted());
      await newRequest.promise;
    });
    await waitFor(() => expect(summaryButton()).toHaveAttribute('aria-label', 'Cloud baseline scan queued'));
  });
});
