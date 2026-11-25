import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SideAppsResponse, SideAppUsersResponse } from '@client/shared/sideApps';

const mockUseSideApps = vi.fn();
const mockUseSideAppUsers = vi.fn();
const mockDownloadApps = vi.fn();
const mockDownloadUsers = vi.fn();

vi.mock('../hooks/useSideApps', () => ({
  useSideApps: (...args: unknown[]) => mockUseSideApps(...args),
  useSideAppUsers: (...args: unknown[]) => mockUseSideAppUsers(...args),
}));
vi.mock('../utils/sideAppsCsv', () => ({
  downloadSideAppsCsv: (...args: unknown[]) => mockDownloadApps(...args),
  downloadSideAppUsersCsv: (...args: unknown[]) => mockDownloadUsers(...args),
}));
vi.mock('./ViewUserProfile', () => ({
  default: ({ userId }: { userId: string }) => <button data-testid={`view-profile-${userId}`}>View</button>,
}));
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { SideAppsDashboard } from './SideAppsDashboard';
import { useCreditAnalysisStore } from '../store';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const refusals = (reasons: { reason: string; class: 'policy' | 'app_fault' | 'our_fault'; count: number }[]) => ({
  total: reasons.reduce((sum, entry) => sum + entry.count, 0),
  byClass: { policy: 0, app_fault: 0, our_fault: 0 },
  byReason: reasons,
});

const response: SideAppsResponse = {
  days: 30,
  spendWindowDays: 30,
  requestWindowDays: 30,
  attributionStartedAt: '2026-10-01T00:00:00.000Z',
  totals: {
    credits: 60,
    activeUsers: 3,
    byTier: { paid: 10, unpaid: 30, org: 15, unrecorded: 5 },
    unpaidShare: 0.75,
    outcomes: { completed: 8, failed: 1, interrupted: 1, failureRate: 0.2 },
    daily: [{ day: '2026-11-16', credits: 60 }],
  },
  apps: [
    {
      clientId: 'app-a',
      name: 'App A',
      spend: {
        credits: 60,
        payingUsers: 3,
        byTier: { paid: 10, unpaid: 30, org: 15, unrecorded: 5 },
        daily: [],
      },
      requests: { total: 10, byTier: { paid: 4, unpaid: 4, unrecorded: 2 }, byEndpoint: [] },
      outcomes: { completed: 8, failed: 1, interrupted: 1, failureRate: 0.2 },
      topFailureCodes: [{ code: 'http_503', count: 1 }],
      refusals: refusals([{ reason: 'scope_exceeded', class: 'policy', count: 2 }]),
    },
  ],
  unknownClient: refusals([{ reason: 'unknown_client', class: 'our_fault', count: 4 }]),
};

const usersResponse: SideAppUsersResponse = {
  clientId: 'app-a',
  name: 'App A',
  days: 30,
  spendWindowDays: 30,
  requestWindowDays: 30,
  attributionStartedAt: null,
  totalUsers: 1,
  limit: 200,
  unattributedOrgCredits: 3,
  users: [
    {
      userId: 'u1',
      name: 'User One',
      email: 'one@example.test',
      currentTier: 'unknown',
      credits: 20,
      creditsByTier: { paid: 20, unpaid: 0, org: 0, unrecorded: 0 },
      requests: 5,
      requestsByEndpoint: [{ endpoint: '/api/x', count: 5 }],
      failedRequests: 1,
      refusals: 0,
      lastUsedAt: '2026-11-16T00:00:00.000Z',
      topModels: [{ model: 'model-a', credits: 20 }],
    },
  ],
};

const ready = (data: unknown) => ({
  data,
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  useCreditAnalysisStore.setState({ sideAppClientId: null });
  mockUseSideApps.mockReturnValue(ready(response));
  mockUseSideAppUsers.mockReturnValue(ready(undefined));
});

const renderDashboard = () =>
  render(
    <TestWrapper>
      <SideAppsDashboard />
    </TestWrapper>
  );

describe('SideAppsDashboard', () => {
  it('shows the key numbers, the window note and an app row', () => {
    renderDashboard();
    const strip = screen.getByTestId('admin-stat-strip');
    expect(strip).toHaveTextContent('75.0%');
    expect(strip).toHaveTextContent('20.0%');
    expect(screen.getByTestId('side-apps-note')).toHaveTextContent(/at most 90 days/);
    expect(screen.getByTestId('side-apps-row-app-a')).toHaveTextContent('App A');
    expect(screen.getByTestId('side-apps-failure-rate-app-a')).toHaveAttribute('title', 'http_503: 1');
    expect(screen.queryByTestId('side-apps-drilldown')).toBeNull();
  });

  it('lists the unknown client counter as its own refusal row', () => {
    renderDashboard();
    const table = screen.getByTestId('side-apps-refusal-table');
    expect(table).toHaveTextContent('Unknown client');
    expect(table).toHaveTextContent('unknown_client');
    expect(table).toHaveTextContent('scope_exceeded');
  });

  it('shows a loading state', () => {
    mockUseSideApps.mockReturnValue({ ...ready(undefined), isLoading: true });
    renderDashboard();
    expect(screen.getByTestId('side-apps-loading')).toBeInTheDocument();
  });

  it('shows an error state with retry', () => {
    mockUseSideApps.mockReturnValue({ ...ready(undefined), error: new Error('boom') });
    renderDashboard();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows the empty state when no app has activity', () => {
    mockUseSideApps.mockReturnValue(
      ready({
        ...response,
        totals: { ...response.totals, credits: 0, unpaidShare: null },
        apps: [],
        unknownClient: refusals([]),
      })
    );
    renderDashboard();
    expect(screen.getByText('No side app activity in this window')).toBeInTheDocument();
    expect(screen.getByText('No spend in this window.')).toBeInTheDocument();
  });

  it('opens the per-user table for a preselected client and reports unknown tiers as unknown', () => {
    useCreditAnalysisStore.setState({ sideAppClientId: 'app-a' });
    mockUseSideAppUsers.mockReturnValue(ready(usersResponse));
    renderDashboard();
    expect(mockUseSideAppUsers).toHaveBeenCalledWith('app-a', 30);
    expect(screen.getByTestId('side-apps-user-tier-u1')).toHaveTextContent('unknown');
    expect(screen.getByTestId('view-profile-u1')).toBeInTheDocument();
    expect(screen.getByTestId('side-apps-unattributed-org')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('side-apps-close-btn'));
    expect(useCreditAnalysisStore.getState().sideAppClientId).toBeNull();
  });

  it('exports both tables', () => {
    useCreditAnalysisStore.setState({ sideAppClientId: 'app-a' });
    mockUseSideAppUsers.mockReturnValue(ready(usersResponse));
    renderDashboard();
    fireEvent.click(screen.getByTestId('side-apps-export-btn'));
    expect(mockDownloadApps).toHaveBeenCalledWith(response);
    expect(mockDownloadUsers).toHaveBeenCalledWith(usersResponse);
  });
});
