import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { buildProfile, ProfileTestWrapper } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'admin1' } }) }));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useGetUserProductAccess: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('../../../Subscriptions/SubscriptionSummaryList', () => ({ SubscriptionSummaryList: () => null }));
vi.mock('../actions/useAdminUserUpdate', () => ({ useAdminUserUpdate: () => vi.fn() }));

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
});

describe('OverviewTab recent activity', () => {
  it('lists the recent timeline entries from every source', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [adminRow, creditRow], nextCursor: null } });
    renderTab();

    const rows = await screen.findAllByTestId('user-profile-recent-activity-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('Bought credits');
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
