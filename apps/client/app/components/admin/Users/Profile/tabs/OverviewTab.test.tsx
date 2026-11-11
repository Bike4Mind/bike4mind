import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { buildProfile, ProfileTestWrapper } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  currentUser: { id: 'admin1' } as { id: string; isAdmin: boolean; adminPermissions?: string[] },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useGetUserProductAccess: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('../../../Subscriptions/SubscriptionSummaryList', () => ({ SubscriptionSummaryList: () => null }));
vi.mock('../RiskEvidenceCard', () => ({
  RiskEvidenceCard: ({ userId }: { userId: string }) => <div data-testid="risk-evidence-card-stub">{userId}</div>,
}));
vi.mock('../actions/useAdminUserUpdate', () => ({ useAdminUserUpdate: () => vi.fn() }));
vi.mock('../DetectionLinkedAccountsCard', () => ({ DetectionLinkedAccountsCard: () => null }));

import { OverviewTab } from './OverviewTab';

const adminRow = {
  type: 'admin',
  id: 'a1',
  at: '2026-10-20T09:00:00.000Z',
  summary: 'updated isBanned',
  audit: makeAuditEntry({
    id: 'a1',
    action: 'user.profile.updated',
    changes: [{ field: 'isBanned', before: false, after: true }],
  }),
};
const creditRow = {
  type: 'credit',
  id: 'c1',
  at: '2026-10-19T09:00:00.000Z',
  summary: 'Bought credits: +5,000 credits',
  credits: 5000,
  transactionType: 'purchase',
};

const renderTab = () => {
  const onViewActivity = vi.fn();
  const onViewCredits = vi.fn();
  render(
    <OverviewTab
      user={buildProfile()}
      onAction={vi.fn()}
      onViewActivity={onViewActivity}
      onViewCredits={onViewCredits}
    />,
    { wrapper: ProfileTestWrapper }
  );
  return { onViewActivity, onViewCredits };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = { id: 'admin1' };
});

describe('OverviewTab internal account row', () => {
  it.each([
    [{ isInternal: false }, 'Customer'],
    [{ isInternal: true }, 'Internal account'],
    [{ isInternal: false, isAdmin: true }, 'Internal account (admin)'],
  ])('shows %o as %s and opens the internal-account action', (flags, text) => {
    const onAction = vi.fn();
    render(
      <OverviewTab user={buildProfile(flags)} onAction={onAction} onViewActivity={vi.fn()} onViewCredits={vi.fn()} />,
      { wrapper: ProfileTestWrapper }
    );

    expect(screen.getByTestId('user-profile-fact-internal')).toHaveTextContent(text);
    fireEvent.click(screen.getByTestId('user-profile-internal-btn'));
    expect(onAction).toHaveBeenCalledWith('internalAccount');
  });
});

describe('OverviewTab recent activity', () => {
  it('lists the recent timeline entries from every source', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [adminRow, creditRow], nextCursor: null } });
    renderTab();

    const rows = await screen.findAllByTestId('user-profile-recent-activity-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('Bought credits');
    expect(screen.getByTestId('risk-evidence-card-stub')).toHaveTextContent(buildProfile().id);
  });

  it('leaves api requests out of the first request by default', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [adminRow], nextCursor: null } });
    renderTab();

    await screen.findAllByTestId('user-profile-recent-activity-row');
    const types = String(mocks.get.mock.calls[0][1].params.types).split(',');
    expect(types).not.toContain('api_request');
    expect(types).toContain('admin');
  });

  it('opens the audit drawer for an admin row and the Credits tab for a credit row', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [adminRow, creditRow], nextCursor: null } });
    const { onViewActivity, onViewCredits } = renderTab();

    const [adminLink, creditLink] = await screen.findAllByTestId('user-profile-recent-activity-row-open-btn');
    fireEvent.click(adminLink);
    expect(await screen.findByTestId('audit-drawer')).toBeInTheDocument();

    fireEvent.click(creditLink);
    expect(onViewCredits).toHaveBeenCalledTimes(1);
    expect(onViewActivity).not.toHaveBeenCalled();
  });

  it('says so when the timeline fails to load', async () => {
    mocks.get.mockRejectedValue(new Error('boom'));
    renderTab();

    expect(await screen.findByText('Activity could not be loaded.')).toBeInTheDocument();
  });
});

describe('OverviewTab API key trust row', () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue({ data: { entries: [], nextCursor: null, notes: [], items: [] } });
  });

  it('is enabled for a full admin', () => {
    mocks.currentUser = { id: 'admin1', isAdmin: true };
    renderTab();
    expect(screen.getByTestId('user-profile-key-trust-btn')).toBeEnabled();
  });

  it('is disabled with the missing permission for a delegate without keys:revoke', () => {
    mocks.currentUser = { id: 'd1', isAdmin: false, adminPermissions: ['support:read'] };
    renderTab();
    expect(screen.getByTestId('user-profile-key-trust-btn')).toBeDisabled();
    expect(screen.getByTestId('user-profile-key-trust-btn-reason')).toHaveAttribute(
      'aria-label',
      'Missing permission: keys:revoke'
    );
  });

  it('is disabled for a keys:revoke delegate on an account with admin access', () => {
    mocks.currentUser = { id: 'd1', isAdmin: false, adminPermissions: ['keys:revoke'] };
    render(
      <OverviewTab
        user={buildProfile({ isAdmin: true })}
        onAction={vi.fn()}
        onViewActivity={vi.fn()}
        onViewCredits={vi.fn()}
      />,
      { wrapper: ProfileTestWrapper }
    );
    expect(screen.getByTestId('user-profile-key-trust-btn')).toBeDisabled();
    expect(screen.getByTestId('user-profile-key-trust-btn-reason')).toHaveAttribute(
      'aria-label',
      'Only full administrators can act on accounts with admin access'
    );
  });

  it('is enabled for a delegate with keys:revoke', () => {
    mocks.currentUser = { id: 'd1', isAdmin: false, adminPermissions: ['keys:revoke'] };
    renderTab();
    expect(screen.getByTestId('user-profile-key-trust-btn')).toBeEnabled();
  });
});
