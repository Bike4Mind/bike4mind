import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSignupGrantPendingRow, AdminSignupGrantPendingSummary } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from '../../adminSidebarConfig';
import { useAdminModal } from '../../useAdminModal';
import { PendingSection } from './PendingSection';

const mocks = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  list: {} as Record<string, unknown>,
  listArgs: [] as unknown[],
  summary: {} as Record<string, unknown>,
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}));

vi.mock('@client/app/hooks/data/adminSignupGrant', () => ({
  useAdminSignupGrantPendingList: (filters: unknown) => {
    mocks.listArgs.push(filters);
    return mocks.list;
  },
  useAdminSignupGrantPendingSummary: () => mocks.summary,
}));

vi.mock('./PendingBulkDialog', () => ({
  PendingBulkDialog: ({ kind, userIds }: { kind: string; userIds: string[] }) => (
    <div data-testid="pending-bulk-dialog-stub" data-kind={kind} data-ids={userIds.join(',')} />
  ),
}));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const row = (overrides: Partial<AdminSignupGrantPendingRow> = {}): AdminSignupGrantPendingRow => ({
  id: 'a'.repeat(24),
  email: 'held@example.com',
  createdAt: '2026-11-01T00:00:00.000Z',
  source: 'default',
  stage: 'signup',
  status: 'held',
  held: { reason: 'budget_exhausted', since: '2026-11-02T00:00:00.000Z', credits: 500 },
  blocked: null,
  remaining: 4321,
  dripRemaining: 3000,
  rewards: { queuedCount: 2, queuedCredits: 200, pausedCount: 0, pausedCredits: 0 },
  ...overrides,
});

const listOf = (rows: AdminSignupGrantPendingRow[], extra: Record<string, unknown> = {}, canRelease = true) => ({
  data: { pages: [{ data: rows, nextCursor: null, viewer: { canRelease } }] },
  isPending: false,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  ...extra,
});

const SUMMARY: AdminSignupGrantPendingSummary = {
  exposure: { accountsWithRemaining: 7, totalRemaining: 12000, totalDripRemaining: 9000 },
  trickle: { day: '2026-11-06', spentToday: 150, limit: 1000, missing: false },
  queue: { held: 3, oldestHeldAt: '2026-11-02T00:00:00.000Z' },
};

const selectFirstRow = () =>
  fireEvent.click(within(screen.getByTestId(`admin-table-select-${'a'.repeat(24)}`)).getByRole('checkbox'));

const tiles = () => screen.getAllByTestId('admin-stat-tile').map(tile => tile.textContent);

describe('PendingSection', () => {
  beforeEach(() => {
    mocks.search = {};
    mocks.navigate.mockClear();
    mocks.listArgs = [];
    mocks.list = listOf([row()]);
    mocks.summary = { data: SUMMARY, isError: false };
    useAdminModal.setState(useAdminModal.getInitialState());
  });

  it('shows the exposure header from the summary', () => {
    render(<PendingSection />, { wrapper: Wrapper });
    const [accounts, drip, trickle, queue] = tiles();
    expect(accounts).toContain('7');
    expect(drip).toContain('9,000');
    expect(drip).toContain('12,000 left in all grants');
    expect(trickle).toContain('150 of 1,000');
    expect(queue).toContain('3');
    expect(queue).toContain('oldest');
  });

  it('shows Unavailable, not zero, for a part whose read failed', () => {
    mocks.summary = { data: { ...SUMMARY, trickle: null, exposure: null }, isError: false };
    render(<PendingSection />, { wrapper: Wrapper });
    const [accounts, drip, trickle, queue] = tiles();
    expect(accounts).toContain('Unavailable');
    expect(drip).toContain('Unavailable');
    expect(trickle).toContain('Unavailable');
    expect(queue).toContain('3');
  });

  it('renders each row with the remaining the payload carries', () => {
    const blocked = row({ id: 'b'.repeat(24), status: 'blocked', held: null, blocked: { at: null }, remaining: 80 });
    mocks.list = listOf([row(), blocked]);
    render(<PendingSection />, { wrapper: Wrapper });
    expect(screen.getByTestId(`pending-row-remaining-${'a'.repeat(24)}`)).toHaveTextContent('4,321');
    expect(screen.getByTestId(`pending-row-remaining-${'b'.repeat(24)}`)).toHaveTextContent('80');
    expect(screen.getByTestId(`pending-row-state-${'a'.repeat(24)}`)).toHaveTextContent('Held: Daily pool spent');
    expect(screen.getByTestId(`pending-row-state-${'b'.repeat(24)}`)).toHaveTextContent('Blocked');
  });

  it('labels a locked row by why it is locked', () => {
    const awaiting = row({ id: 'c'.repeat(24), status: 'locked', stage: 'pending_email', held: null });
    const forfeited = row({ id: 'd'.repeat(24), status: 'locked', stage: 'signup', held: null });
    mocks.list = listOf([awaiting, forfeited]);
    render(<PendingSection />, { wrapper: Wrapper });
    expect(screen.getByTestId(`pending-row-state-${'c'.repeat(24)}`)).toHaveTextContent('Awaiting email');
    expect(screen.getByTestId(`pending-row-state-${'d'.repeat(24)}`)).toHaveTextContent(/^Locked$/);
  });

  it('opens the account on its Credits tab', () => {
    render(<PendingSection />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId(`pending-row-link-${'a'.repeat(24)}`));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/admin/users/$userId',
      params: { userId: 'a'.repeat(24) },
      search: { tab: 'credits' },
    });
  });

  it('passes URL filters to the list query and writes a filter change to the URL', () => {
    mocks.search = { pendingStatus: 'held', pendingSort: 'remaining', pendingSource: 'bogus' };
    render(<PendingSection />, { wrapper: Wrapper });
    expect(mocks.listArgs.at(-1)).toEqual({
      status: 'held',
      heldReason: undefined,
      source: undefined,
      sort: 'remaining',
    });

    fireEvent.click(screen.getByTestId('admin-filter-heldReason'));
    fireEvent.click(screen.getByTestId('admin-filter-heldReason-risk_review'));
    const { to, replace, search } = mocks.navigate.mock.calls.at(-1)![0];
    expect(to).toBe('/admin');
    expect(replace).toBe(true);
    expect(search({ tab: 'waitlist', inviteSection: 'pending', pendingStatus: 'held' })).toMatchObject({
      tab: 'waitlist',
      inviteSection: 'pending',
      pendingStatus: 'held',
      pendingReason: 'risk_review',
    });
  });

  it('defaults the sort to oldest', () => {
    render(<PendingSection />, { wrapper: Wrapper });
    expect(mocks.listArgs.at(-1)).toMatchObject({ sort: 'oldest' });
  });

  it('explains what Pending means when nothing is pending', () => {
    mocks.list = listOf([]);
    render(<PendingSection />, { wrapper: Wrapper });
    expect(screen.getByText('No pending signup grants')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-clear-filters-btn')).not.toBeInTheDocument();
  });

  it('treats a sort alone as no filter when nothing is pending', () => {
    mocks.list = listOf([]);
    mocks.search = { pendingSort: 'remaining' };
    render(<PendingSection />, { wrapper: Wrapper });
    expect(screen.getByText('No pending signup grants')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-clear-filters-btn')).not.toBeInTheDocument();
  });

  it('clears the selection when a filter changes', () => {
    render(<PendingSection />, { wrapper: Wrapper });
    selectFirstRow();
    expect(screen.getByTestId('admin-bulk-action-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-filter-heldReason'));
    fireEvent.click(screen.getByTestId('admin-filter-heldReason-risk_review'));
    expect(screen.queryByTestId('admin-bulk-action-bar')).not.toBeInTheDocument();
  });

  it('offers to clear filters when filters match nothing', () => {
    mocks.list = listOf([]);
    mocks.search = { pendingStatus: 'blocked' };
    render(<PendingSection />, { wrapper: Wrapper });
    expect(screen.getByText('No accounts match these filters')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pending-clear-filters-btn'));
    const { search } = mocks.navigate.mock.calls.at(-1)![0];
    expect(search({ pendingStatus: 'blocked', pendingSort: 'remaining' })).toMatchObject({
      pendingStatus: undefined,
      pendingSort: undefined,
    });
  });

  it('loads the next page only when there is one', () => {
    const fetchNextPage = vi.fn();
    mocks.list = listOf([row()], { hasNextPage: true, fetchNextPage });
    const { unmount } = render(<PendingSection />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('pending-load-more-btn'));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    unmount();

    mocks.list = listOf([row()]);
    render(<PendingSection />, { wrapper: Wrapper });
    expect(screen.queryByTestId('pending-load-more-btn')).not.toBeInTheDocument();
  });

  it.each([
    ['invite-center-open-held-grants-btn', AdminTab.HeldSignupGrants],
    ['pending-open-domain-holds-btn', AdminTab.SignupDomainHolds],
    ['pending-open-risk-review-btn', AdminTab.SignupRiskReview],
  ])('%s opens its admin tab', (testId, tab) => {
    render(<PendingSection />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId(testId));
    expect(useAdminModal.getState().activeTab).toBe(tab);
  });

  it('opens the bulk dialog for the selected accounts', () => {
    render(<PendingSection />, { wrapper: Wrapper });
    expect(screen.queryByTestId('admin-bulk-action-bar')).not.toBeInTheDocument();
    selectFirstRow();
    fireEvent.click(screen.getByTestId('pending-bulk-block-btn'));
    const dialog = screen.getByTestId('pending-bulk-dialog-stub');
    expect(dialog).toHaveAttribute('data-kind', 'block');
    expect(dialog).toHaveAttribute('data-ids', 'a'.repeat(24));
    expect(screen.queryByTestId('admin-select-all-matching-btn')).not.toBeInTheDocument();
  });

  it('hides Release from a viewer who cannot release', () => {
    mocks.list = listOf([row()], {}, false);
    render(<PendingSection />, { wrapper: Wrapper });
    selectFirstRow();
    expect(screen.getByTestId('pending-bulk-block-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-bulk-release-btn')).not.toBeInTheDocument();
  });

  it('shows Release to a full admin', () => {
    render(<PendingSection />, { wrapper: Wrapper });
    selectFirstRow();
    expect(screen.getByTestId('pending-bulk-release-btn')).toBeInTheDocument();
  });
});
