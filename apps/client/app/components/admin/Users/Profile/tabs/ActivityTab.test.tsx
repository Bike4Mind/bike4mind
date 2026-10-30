import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { ProfileTestWrapper } from '../profileTestUtils';
import type { ActivitySearch } from '../activitySearch';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}));

import { ActivityTab } from './ActivityTab';

const USER_ID = 'test-user-1';

const usage = (id: string, at: string) => ({
  type: 'usage',
  id,
  at,
  summary: `Started notebook "${id}"`,
  detail: 'Via Web app',
  notebookId: id,
});
const adminRow = {
  type: 'admin',
  id: 'a1',
  at: '2026-10-20T09:00:00.000Z',
  summary: 'updated isBanned',
  audit: makeAuditEntry({
    id: 'a1',
    action: 'user.profile.updated',
    reason: 'Chargeback',
    changes: [{ field: 'isBanned', before: false, after: true }],
  }),
};
const credit = {
  type: 'credit',
  id: 'c1',
  at: '2026-10-19T09:00:00.000Z',
  summary: 'Bought credits: +5,000 credits',
  credits: 5000,
  transactionType: 'purchase',
};

const lastParams = () => (mocks.get.mock.calls.at(-1)?.[1] as { params: Record<string, string> }).params;

const renderTab = (search: ActivitySearch = {}) => {
  mocks.search = { tab: 'activity', ...search };
  const onOpenCredits = vi.fn();
  render(<ActivityTab userId={USER_ID} onOpenCredits={onOpenCredits} />, { wrapper: ProfileTestWrapper });
  return { onOpenCredits };
};

/** Applies the search updater the tab passed to navigate, the way the router would. */
const navigatedSearch = () => {
  const { search, replace } = mocks.navigate.mock.calls.at(-1)?.[0] as {
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
    replace: boolean;
  };
  return { search: search(mocks.search), replace };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActivityTab', () => {
  it('renders the merged timeline in server order with plain-language rows', async () => {
    mocks.get.mockResolvedValue({
      data: { entries: [usage('Quarterly plan', '2026-10-21T09:00:00.000Z'), adminRow, credit], nextCursor: null },
    });
    renderTab();

    const rows = await screen.findAllByTestId('user-timeline-row');
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Started notebook "Quarterly plan"'),
      expect.stringContaining('Suspended account'),
      expect.stringContaining('Bought credits: +5,000 credits'),
    ]);
    expect(rows[1]).toHaveTextContent('Reason: Chargeback');
    expect(within(rows[0]).getByRole('time')).toHaveAttribute('datetime', '2026-10-21T09:00:00.000Z');
    expect(screen.queryByTestId('user-timeline-load-more-btn')).not.toBeInTheDocument();
  });

  it('asks the endpoint for every source when the URL has no filter', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [], nextCursor: null } });
    renderTab();

    await screen.findByText('No activity yet');
    expect(mocks.get).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/timeline`, {
      params: { types: 'admin,credit,key,signin,usage', limit: '30' },
    });
  });

  it('sends the URL filters to the endpoint as inclusive UTC instants', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [], nextCursor: null } });
    renderTab({ types: 'signin,admin', from: '2026-10-01', to: '2026-10-07' });

    await screen.findByText('No activity matches these filters');
    expect(lastParams()).toEqual({
      types: 'admin,signin',
      limit: '30',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-07T23:59:59.999Z',
    });
    expect(screen.getByTestId('user-timeline-filter-type-signin')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('user-timeline-filter-type-usage')).toHaveAttribute('aria-pressed', 'false');
  });

  it('writes a source chip into the URL without a history entry and keeps the tab', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [], nextCursor: null } });
    renderTab();
    await screen.findByText('No activity yet');

    fireEvent.click(screen.getByTestId('user-timeline-filter-type-credit'));

    expect(navigatedSearch()).toEqual({
      search: { tab: 'activity', types: 'credit', from: undefined, to: undefined },
      replace: true,
    });
  });

  it('writes the date range into the URL and clears every filter', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [], nextCursor: null } });
    renderTab({ types: 'admin', to: '2026-10-07' });
    await screen.findByText('No activity matches these filters');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    expect(navigatedSearch().search).toMatchObject({ types: 'admin', from: '2026-10-01', to: '2026-10-07' });

    fireEvent.click(screen.getByTestId('user-timeline-clear-btn'));
    expect(navigatedSearch().search).toEqual({ tab: 'activity', types: undefined, from: undefined, to: undefined });
  });

  it('loads the next page from the returned cursor', async () => {
    mocks.get
      .mockResolvedValueOnce({ data: { entries: [usage('first', '2026-10-21T09:00:00.000Z')], nextCursor: 'CURSOR' } })
      .mockResolvedValueOnce({ data: { entries: [usage('second', '2026-10-20T09:00:00.000Z')], nextCursor: null } });
    renderTab();

    fireEvent.click(await screen.findByTestId('user-timeline-load-more-btn'));

    await waitFor(() => expect(screen.getAllByTestId('user-timeline-row')).toHaveLength(2));
    expect(lastParams()).toMatchObject({ cursor: 'CURSOR' });
    expect(screen.queryByTestId('user-timeline-load-more-btn')).not.toBeInTheDocument();
  });

  it('opens the audit entry for an admin row and the credits tab for a credit row', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [adminRow, credit], nextCursor: null } });
    const { onOpenCredits } = renderTab();

    const [adminLink, creditLink] = await screen.findAllByTestId('user-timeline-row-open-btn');
    fireEvent.click(adminLink);
    expect(await screen.findByTestId('audit-drawer')).toBeInTheDocument();
    fireEvent.click(creditLink);
    expect(onOpenCredits).toHaveBeenCalled();
  });

  it('shows a retryable error', async () => {
    mocks.get.mockRejectedValue(new Error('boom'));
    renderTab();
    expect(await screen.findByText('The activity could not be loaded.')).toBeInTheDocument();
  });
});
