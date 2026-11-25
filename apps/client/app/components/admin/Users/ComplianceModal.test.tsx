import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import ComplianceModal, { useComplianceModal } from './ComplianceModal';
import type { UserComplianceResponse } from '@bike4mind/common';

const mockData = vi.fn();

vi.mock('@client/app/hooks/data/userCompliance', () => ({
  useGetUserCompliance: () => mockData(),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
};

const NEVER_ACCEPTED: UserComplianceResponse = {
  aupAcceptedVersion: null,
  aupAcceptedAt: null,
  ageAttestedAdult: null,
  currentPolicyVersion: 'v1',
  isCurrent: false,
  moderationIncidents: [],
  flags: { isBanned: false, isModerated: false, disputePending: false },
  recentAuthEvents: [],
};

beforeEach(() => {
  useComplianceModal.setState({ userId: 'u1' });
  mockData.mockReset();
});

describe('ComplianceModal', () => {
  it('renders in the admin dialog frame and closes on Escape', () => {
    mockData.mockReturnValue({ data: NEVER_ACCEPTED, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    expect(screen.getByRole('dialog', { name: 'User compliance' })).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('compliance-modal'), { key: 'Escape' });
    expect(useComplianceModal.getState().userId).toBeNull();
  });

  it('renders the "never accepted" empty state when there are no acceptances', () => {
    mockData.mockReturnValue({ data: NEVER_ACCEPTED, isLoading: false });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    expect(screen.getByTestId('compliance-modal')).toBeInTheDocument();
    expect(screen.getByTestId('compliance-never-accepted')).toBeInTheDocument();
  });

  it('renders all four sections with data', () => {
    mockData.mockReturnValue({
      data: {
        ...NEVER_ACCEPTED,
        isCurrent: true,
        aupAcceptedVersion: 'v1',
        aupAcceptedAt: '2026-06-01T00:00:00Z',
        ageAttestedAdult: true,
        moderationIncidents: [
          {
            labels: [{ name: 'Explicit', parentName: 'Explicit', confidence: 0.98 }],
            provider: 'openai',
            model: 'gpt-image-1',
            createdAt: '2026-06-02T00:00:00Z',
          },
        ],
        recentAuthEvents: [
          { event: 'login', actorIp: '1.2.3.4', userAgent: 'jest', createdAt: '2026-06-03T00:00:00Z' },
        ],
      },
      isLoading: false,
    });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    expect(screen.getByTestId('compliance-legal-section')).toBeInTheDocument();
    expect(screen.getByTestId('compliance-incidents-table')).toBeInTheDocument();
    expect(screen.getByTestId('compliance-flags')).toBeInTheDocument();
    expect(screen.getByTestId('compliance-auth-events')).toBeInTheDocument();
    expect(screen.queryByTestId('compliance-never-accepted')).not.toBeInTheDocument();
  });

  it('shows an error state (not a permanent spinner) when the query fails', () => {
    mockData.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      refetch: vi.fn(),
    });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    expect(screen.getByTestId('compliance-error')).toBeInTheDocument();
    // must NOT fall through to a section render
    expect(screen.queryByTestId('compliance-legal-section')).not.toBeInTheDocument();
  });

  it('shows the loading state while the initial fetch is in flight', () => {
    mockData.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('compliance-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('compliance-legal-section')).not.toBeInTheDocument();
  });

  it('renders a stale acceptance (accepted an old/grandfathered version, isCurrent false)', () => {
    mockData.mockReturnValue({
      data: {
        ...NEVER_ACCEPTED,
        isCurrent: false,
        aupAcceptedVersion: 'grandfathered',
        aupAcceptedAt: '2025-01-01T00:00:00Z',
        ageAttestedAdult: true,
      },
      isLoading: false,
    });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    // acceptance details render (not the "never accepted" empty state)...
    expect(screen.getByTestId('compliance-legal-section')).toBeInTheDocument();
    expect(screen.queryByTestId('compliance-never-accepted')).not.toBeInTheDocument();
    // ...and the stale status is shown
    expect(screen.getByText('Not current')).toBeInTheDocument();
  });

  it('shows each empty list as its own message', () => {
    mockData.mockReturnValue({ data: NEVER_ACCEPTED, isLoading: false });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    expect(within(screen.getByTestId('compliance-incidents-table')).getByTestId('admin-empty-state')).toHaveTextContent(
      'No incidents'
    );
    expect(within(screen.getByTestId('compliance-auth-events')).getByTestId('admin-empty-state')).toHaveTextContent(
      'No recent events'
    );
  });

  it('formats incident labels with confidence and shows a dash for a missing actor', () => {
    mockData.mockReturnValue({
      data: {
        ...NEVER_ACCEPTED,
        moderationIncidents: [
          {
            labels: [
              { name: 'Explicit', parentName: 'Explicit', confidence: 0.98 },
              { name: 'Violence', parentName: 'Violence', confidence: 0.5 },
            ],
            provider: 'openai',
            model: 'gpt-image-1',
            createdAt: '2026-06-02T00:00:00Z',
          },
        ],
        recentAuthEvents: [
          { event: 'logout', actorIp: '1.2.3.4', userAgent: 'agent-x', createdAt: '2026-06-03T00:00:00Z' },
          {
            event: 'session_revoked',
            actorUserId: 'admin-1',
            actorIp: '5.6.7.8',
            userAgent: 'agent-y',
            createdAt: '2026-06-04T00:00:00Z',
          },
        ],
      },
      isLoading: false,
    });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    expect(screen.getByText('Explicit (98%), Violence (50%)')).toBeInTheDocument();
    const logoutRow = screen.getByText('logout').closest('tr') as HTMLElement;
    expect(within(logoutRow).getByLabelText('No actor')).toHaveTextContent('\u2014');
    const revokedRow = screen.getByText('session_revoked').closest('tr') as HTMLElement;
    expect(within(revokedRow).getByText('admin-1').closest('td')).toHaveAttribute('data-cell-wrap');
    expect(within(revokedRow).getByText('5.6.7.8').closest('td')).toHaveAttribute('data-cell-wrap');
  });

  it('renders every returned row without a pager', () => {
    mockData.mockReturnValue({
      data: {
        ...NEVER_ACCEPTED,
        recentAuthEvents: Array.from({ length: 30 }, (_, i) => ({
          event: `event-${i}`,
          actorIp: '1.2.3.4',
          userAgent: 'agent',
          createdAt: '2026-06-03T00:00:00Z',
        })),
      },
      isLoading: false,
    });
    render(<ComplianceModal />, { wrapper: TestWrapper });
    expect(screen.getByText('event-0')).toBeInTheDocument();
    expect(screen.getByText('event-29')).toBeInTheDocument();
    expect(document.getElementById('compliance-auth-events-page-size-label')).toBeNull();
  });
});
