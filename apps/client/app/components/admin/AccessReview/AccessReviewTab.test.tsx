import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AccessReviewReport, AccessReviewRow } from '@client/app/hooks/data/adminAccessReview';
import { AdminTab } from '../adminSidebarConfig';
import { canOpenAdminTab } from '../adminTabPermissions';
import { UndoToastProvider } from '../shared';
import AccessReviewTab from './AccessReviewTab';
import { AccessReviewOverdueBanner } from './AccessReviewOverdueBanner';

const ME = 'a'.repeat(24);
const OTHER_FULL = 'b'.repeat(24);
const DELEGATE = 'c'.repeat(24);

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  report: null as unknown,
  reportError: false,
  status: null as unknown,
  decisionFails: false,
  updatePermissions: vi.fn(),
  updateRole: vi.fn(),
  mutate: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: mocks.apiPut, post: mocks.apiPost } }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
    to,
    ...rest
  }: {
    children: React.ReactNode;
    params: { userId: string };
    to: string;
  } & Record<string, unknown>) => (
    <a href={to.replace('$userId', params.userId)} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@client/app/hooks/data/adminAccessReview', () => ({
  useAccessReviewReport: () => ({ data: mocks.report, isPending: false, isError: mocks.reportError, refetch: vi.fn() }),
  useAccessReviewStatus: (enabled: boolean) => ({ data: enabled ? mocks.status : undefined }),
  useAccessReviewDecision: () => ({
    mutate: mocks.mutate,
    mutateAsync: async (input: { decision: string }) => {
      mocks.calls.push(`decision:${input.decision}`);
      if (mocks.decisionFails) throw new Error('network');
      return { completed: false, pending: 1, pendingSelf: false };
    },
    isPending: false,
  }),
  downloadAccessReviewCsv: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: ME, isAdmin: true } }),
}));

vi.mock('../Users/Profile/actions/useAdminUserPermissionsUpdate', () => ({
  useAdminUserPermissionsUpdate: () => async (input: unknown) => {
    mocks.calls.push('permissions');
    return mocks.updatePermissions(input);
  },
}));

vi.mock('../Users/Profile/actions/useAdminUserRoleUpdate', () => ({
  useAdminUserRoleUpdate: () => async (input: unknown) => {
    mocks.calls.push('role');
    return mocks.updateRole(input);
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithTheme = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <UndoToastProvider>{ui}</UndoToastProvider>
      </CssVarsProvider>
    </QueryClientProvider>
  );

const row = (overrides: Partial<AccessReviewRow>): AccessReviewRow => ({
  userId: ME,
  email: 'me@example.com',
  username: 'me',
  fullAdmin: true,
  permissions: [],
  directPermissions: [],
  adminRoleIds: [],
  roles: [],
  permissionSources: [],
  lastAdminActionAt: '2026-11-01T00:00:00.000Z',
  lastSignInAt: '2026-11-10T00:00:00.000Z',
  mfaEnabled: true,
  grantedBy: null,
  grantedAt: null,
  dormant: false,
  noMfa: false,
  decision: null,
  ...overrides,
});

const report = (admins: AccessReviewRow[]): AccessReviewReport => ({
  quarter: '2026-Q4',
  generatedAt: '2026-11-16T00:00:00.000Z',
  dormantDays: 90,
  overdue: true,
  overdueSince: '2026-10-31T00:00:00.000Z',
  admins,
  roles: [],
  record: null,
});

const SUPPORT = { id: 'support', name: 'Support agent' };

const rowOf = (userId: string) => screen.getByTestId(`admin-access-review-row-${userId}`);

const openRevoke = (userId: string) =>
  fireEvent.click(within(rowOf(userId)).getByTestId('admin-access-review-revoke-btn'));

const revoke = async (userId: string) => {
  openRevoke(userId);
  fireEvent.change(await screen.findByTestId('admin-access-review-revoke-reason-input'), {
    target: { value: 'left the team' },
  });
  fireEvent.click(screen.getByTestId('admin-access-review-revoke-confirm-btn'));
};

describe('AccessReviewTab', () => {
  beforeEach(() => {
    mocks.calls = [];
    mocks.reportError = false;
    mocks.decisionFails = false;
    mocks.updatePermissions.mockReset();
    mocks.updateRole.mockReset();
    mocks.mutate.mockReset();
    mocks.apiPut.mockReset().mockResolvedValue({ data: {} });
    mocks.apiPost.mockReset().mockResolvedValue({ data: { completed: false, pending: 0, pendingSelf: false } });
    mocks.report = report([
      row({}),
      row({
        userId: OTHER_FULL,
        email: 'b@example.com',
        mfaEnabled: false,
        noMfa: true,
        dormant: true,
        lastAdminActionAt: null,
        lastSignInAt: null,
      }),
      row({
        userId: DELEGATE,
        email: 'c@example.com',
        fullAdmin: false,
        permissions: ['users:moderate', 'settings:manage'],
        directPermissions: ['users:moderate', 'users:read'],
        adminRoleIds: ['support'],
        roles: [{ ...SUPPORT, deleted: false }],
        permissionSources: [
          { permission: 'users:moderate', direct: true, roles: [SUPPORT] },
          { permission: 'settings:manage', direct: false, roles: [SUPPORT] },
        ],
        grantedBy: { userId: ME, name: 'Me', email: 'me@example.com' },
        grantedAt: '2026-10-01T00:00:00.000Z',
      }),
    ]);
  });

  it('blocks confirming your own access and allows confirming another admin', () => {
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(ME)).getByTestId('admin-access-review-confirm-btn')).toBeDisabled();
    expect(within(rowOf(ME)).getByTestId('admin-access-review-revoke-btn')).toBeDisabled();
    const confirm = within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-confirm-btn');
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(mocks.mutate).toHaveBeenCalledWith(
      { userId: OTHER_FULL, decision: 'confirmed', dormantDays: 90 },
      expect.anything()
    );
  });

  it('flags dormant and no-MFA admins and shows provenance and sign-in fallbacks', () => {
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-dormant-chip')).toBeInTheDocument();
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-no-mfa-chip')).toBeInTheDocument();
    expect(within(rowOf(OTHER_FULL)).getByTitle('None in 12 months')).toBeInTheDocument();
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-granted-unknown')).toHaveTextContent(
      'Before audit log'
    );
    expect(within(rowOf(ME)).queryByTestId('admin-access-review-dormant-chip')).toBeNull();
    expect(within(rowOf(ME)).queryByTestId('admin-access-review-no-mfa-chip')).toBeNull();
  });

  it('shows each permission with its direct grant and roles, and the roles the admin holds', () => {
    renderWithTheme(<AccessReviewTab />);
    const delegate = rowOf(DELEGATE);
    expect(within(delegate).getByText('users:moderate - direct + role "Support agent"')).toBeInTheDocument();
    expect(within(delegate).getByText('settings:manage - role "Support agent"')).toBeInTheDocument();
    expect(within(delegate).getByTestId('admin-access-review-role-chip-support')).toHaveTextContent('Support agent');
    expect(within(rowOf(ME)).getByText('Full admin')).toBeInTheDocument();
    expect(within(rowOf(ME)).queryByTestId('admin-access-review-permission-sources')).toBeNull();
  });

  it('marks a deleted role the account still lists', () => {
    mocks.report = report([
      row({
        userId: DELEGATE,
        fullAdmin: false,
        adminRoleIds: ['dead'],
        roles: [{ id: 'dead', name: null, deleted: true }],
      }),
    ]);
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(DELEGATE)).getByTestId('admin-access-review-deleted-role-chip-dead')).toHaveTextContent(
      'Deleted role'
    );
    expect(within(rowOf(DELEGATE)).queryByTestId('admin-access-review-permission-sources')).toBeNull();
  });

  it('lists every admin role with its permissions and members', () => {
    mocks.report = {
      ...report([row({})]),
      roles: [
        {
          ...SUPPORT,
          description: 'Handles support tickets',
          permissions: ['support:read', 'users:moderate'],
          members: [
            { userId: DELEGATE, email: 'c@example.com', username: 'c', status: 'active' },
            { userId: OTHER_FULL, email: null, username: 'b', status: 'banned' },
          ],
        },
        { id: 'empty', name: 'Billing ops', description: '', permissions: ['credits:adjust'], members: [] },
      ],
    };
    renderWithTheme(<AccessReviewTab />);
    const support = screen.getByTestId('admin-access-review-role-row-support');
    expect(within(support).getByText('support:read, users:moderate')).toBeInTheDocument();
    expect(within(support).getByText('2 members')).toBeInTheDocument();
    expect(within(support).getByText('c@example.com')).toBeInTheDocument();
    expect(within(support).getByText('b (banned)')).toBeInTheDocument();
    const empty = screen.getByTestId('admin-access-review-role-row-empty');
    expect(within(empty).getByText('Billing ops')).toBeInTheDocument();
    expect(within(empty).getByText('0 members')).toBeInTheDocument();
  });

  it('collapses the admin roles section to one line when no admin roles are defined', () => {
    mocks.report = report([row({})]);
    renderWithTheme(<AccessReviewTab />);
    expect(screen.getByTestId('admin-access-review-no-roles')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-access-review-roles-table')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Roles' })).toBeNull();
  });

  it('reports a failed load once, not again under the admin roles table', () => {
    mocks.report = undefined;
    mocks.reportError = true;
    renderWithTheme(<AccessReviewTab />);
    expect(screen.getAllByText('The access review could not be loaded.')).toHaveLength(1);
    expect(screen.queryByTestId('admin-access-review-roles-table')).not.toBeInTheDocument();
  });

  it('names the roles a revoke removes', async () => {
    renderWithTheme(<AccessReviewTab />);
    openRevoke(DELEGATE);
    expect(await screen.findByText(/Roles removed: Support agent\./)).toBeInTheDocument();
  });

  it('revokes a delegate through the permissions update, then records the decision', async () => {
    renderWithTheme(<AccessReviewTab />);
    await revoke(DELEGATE);
    await waitFor(() => expect(mocks.calls).toEqual(['permissions', 'decision:revoked']));
    expect(mocks.updatePermissions).toHaveBeenCalledWith({
      before: ['users:moderate'],
      adminPermissions: [],
      beforeAdminRoleIds: ['support'],
      adminRoleIds: [],
      reason: 'left the team',
    });
    expect(mocks.updateRole).not.toHaveBeenCalled();
  });

  it('normalizes duplicate role ID aliases before revocation without changing authority or action order', async () => {
    const roleId = 'abcdef000000000000000001';
    mocks.report = report([
      row({
        userId: DELEGATE,
        fullAdmin: false,
        permissions: ['credits:adjust'],
        directPermissions: [],
        adminRoleIds: [roleId.toUpperCase(), roleId],
        roles: [{ id: roleId, name: 'Billing', deleted: false }],
      }),
    ]);
    renderWithTheme(<AccessReviewTab />);
    await revoke(DELEGATE);
    await waitFor(() => expect(mocks.calls).toEqual(['permissions', 'decision:revoked']));
    expect(mocks.updatePermissions).toHaveBeenCalledWith({
      before: [],
      adminPermissions: [],
      beforeAdminRoleIds: [roleId],
      adminRoleIds: [],
      reason: 'left the team',
    });
    expect(mocks.updateRole).not.toHaveBeenCalled();
  });

  it('revokes a full admin through the role update', async () => {
    renderWithTheme(<AccessReviewTab />);
    await revoke(OTHER_FULL);
    await waitFor(() => expect(mocks.calls).toEqual(['role', 'decision:revoked']));
    expect(mocks.updateRole).toHaveBeenCalledWith({ isAdmin: false, reason: 'left the team' });
  });

  it('reconciles a committed removal after its response was lost without replaying the stale write', async () => {
    mocks.report = report([row({ userId: DELEGATE, fullAdmin: false, directPermissions: ['support:read'] })]);
    mocks.updatePermissions.mockRejectedValueOnce(new Error('response lost after commit'));
    renderWithTheme(<AccessReviewTab />);
    await revoke(DELEGATE);
    expect(await screen.findByTestId('admin-access-review-revoke-retry')).toHaveTextContent('could not be confirmed');
    fireEvent.click(screen.getByTestId('admin-access-review-revoke-retry-btn'));
    await waitFor(() => expect(mocks.calls).toEqual(['permissions', 'decision:revoked']));
    expect(mocks.updatePermissions).toHaveBeenCalledTimes(1);
  });

  it('does not replay an uncertain removal when server reconciliation also fails', async () => {
    mocks.report = report([row({ userId: DELEGATE, fullAdmin: false, directPermissions: ['support:read'] })]);
    mocks.updatePermissions.mockRejectedValueOnce(new Error('network'));
    mocks.decisionFails = true;
    renderWithTheme(<AccessReviewTab />);
    await revoke(DELEGATE);
    await screen.findByTestId('admin-access-review-revoke-retry');
    fireEvent.click(screen.getByTestId('admin-access-review-revoke-retry-btn'));
    await waitFor(() => expect(mocks.calls).toEqual(['permissions', 'decision:revoked']));
    expect(mocks.updatePermissions).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('admin-access-review-revoke-dialog')).toBeInTheDocument();
  });

  it('offers a retry that records the decision without removing access again', async () => {
    mocks.decisionFails = true;
    renderWithTheme(<AccessReviewTab />);
    await revoke(DELEGATE);
    expect(await screen.findByTestId('admin-access-review-revoke-retry')).toBeInTheDocument();
    mocks.decisionFails = false;
    fireEvent.click(screen.getByTestId('admin-access-review-revoke-retry-btn'));
    await waitFor(() => expect(mocks.calls).toEqual(['permissions', 'decision:revoked', 'decision:revoked']));
    expect(mocks.updatePermissions).toHaveBeenCalledTimes(1);
  });

  it('explains that your own row needs a second reviewer when it is the last one undecided', () => {
    const decided = { decision: 'confirmed' as const, reviewer: { userId: ME, name: 'Me' } };
    mocks.report = report([
      row({}),
      row({
        userId: OTHER_FULL,
        decision: { ...decided, userId: OTHER_FULL, email: null, fullAdmin: true, permissions: [], decidedAt: '' },
      }),
    ]);
    renderWithTheme(<AccessReviewTab />);
    expect(screen.getByTestId('admin-access-review-pending-self')).toBeInTheDocument();
  });

  it('labels an undecided admin as added after a completed review, next to the decision buttons', () => {
    mocks.report = {
      ...report([row({ userId: OTHER_FULL })]),
      record: { completedAt: '2026-11-10T00:00:00.000Z', decisions: [] } as unknown as AccessReviewReport['record'],
    };
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-added-after-chip')).toBeInTheDocument();
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-confirm-btn')).toBeInTheDocument();
  });

  it('shows the decision buttons without the added-after chip while the review is incomplete', () => {
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-pending-decision')).toBeInTheDocument();
    expect(within(rowOf(OTHER_FULL)).queryByTestId('admin-access-review-added-after-chip')).toBeNull();
  });

  it('lists an account revoked this quarter from the review record', () => {
    const base = report([row({})]);
    mocks.report = {
      ...base,
      record: {
        id: 'r1',
        quarter: '2026-Q4',
        dormantDays: 90,
        startedAt: '2026-11-01T00:00:00.000Z',
        startedBy: { userId: ME, name: 'Me' },
        completedAt: null,
        completedBy: null,
        decisions: [
          {
            userId: DELEGATE,
            email: 'c@example.com',
            fullAdmin: false,
            permissions: ['users:read'],
            roles: [SUPPORT, { id: 'gone', name: null }],
            decision: 'revoked',
            reviewer: { userId: ME, name: 'Me' },
            decidedAt: '2026-11-02T00:00:00.000Z',
          },
        ],
      },
    };
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(DELEGATE)).getByText('Revoked')).toBeInTheDocument();
    expect(within(rowOf(DELEGATE)).getByTestId('admin-access-review-decided-by')).toHaveTextContent(
      'by Me, Nov 2, 2026'
    );
    expect(rowOf(DELEGATE)).toHaveAttribute('data-row-muted');
    expect(within(rowOf(DELEGATE)).queryByText('Full admin')).toBeNull();
    expect(within(rowOf(DELEGATE)).queryByTestId('admin-access-review-row-actions')).toBeNull();
    expect(within(rowOf(DELEGATE)).queryByTestId('admin-access-review-revoke-btn')).toBeNull();
    expect(within(rowOf(DELEGATE)).getAllByText('\u2014')).toHaveLength(4);
    expect(within(rowOf(DELEGATE)).getByText('via roles: Support agent, a deleted role')).toBeInTheDocument();
  });

  it('shows overdue progress on the page instead of a link to itself', () => {
    renderWithTheme(<AccessReviewTab />);
    expect(screen.getByTestId('admin-access-review-progress-banner')).toHaveTextContent(
      '3 of 3 still pending, overdue since Oct 31, 2026.'
    );
    expect(screen.queryByTestId('admin-access-review-overdue-open-btn')).toBeNull();
  });

  it('filters by status with counts and lists pending rows first', () => {
    const confirmed = {
      decision: 'confirmed' as const,
      reviewer: { userId: ME, name: 'Me' },
      email: null,
      fullAdmin: true,
      permissions: [],
      decidedAt: '2026-11-05T00:00:00.000Z',
    };
    mocks.report = report([
      row({ userId: OTHER_FULL, decision: { ...confirmed, userId: OTHER_FULL } }),
      row({ userId: DELEGATE, fullAdmin: false }),
    ]);
    renderWithTheme(<AccessReviewTab />);
    const order = screen.getAllByTestId(/^admin-access-review-row-[a-f0-9]{24}$/).map(el => el.dataset.rowId);
    expect(order).toEqual([DELEGATE, OTHER_FULL]);
    expect(screen.getByTestId('admin-access-review-status-filter-pending')).toHaveTextContent('Pending (1)');
    expect(screen.getByTestId('admin-access-review-status-filter-confirmed')).toHaveTextContent('Confirmed (1)');
    fireEvent.click(screen.getByTestId('admin-access-review-status-filter-confirmed'));
    expect(screen.queryByTestId(`admin-access-review-row-${DELEGATE}`)).toBeNull();
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-decided-by')).toHaveTextContent(
      'by Me, Nov 5, 2026'
    );
    // A confirmed row keeps the menu for a later revoke instead of the pending row's buttons.
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-row-actions')).toBeInTheDocument();
    expect(within(rowOf(OTHER_FULL)).queryByTestId('admin-access-review-confirm-btn')).toBeNull();
  });

  it('marks a dormant full admin with no MFA as a suggested revoke and shows only problem flags', () => {
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(OTHER_FULL)).getByTestId('admin-access-review-suggested-revoke')).toBeInTheDocument();
    expect(within(rowOf(DELEGATE)).queryByTestId('admin-access-review-suggested-revoke')).toBeNull();
    expect(within(rowOf(DELEGATE)).queryByText('MFA')).toBeNull();
  });

  it('links each admin to their profile', () => {
    renderWithTheme(<AccessReviewTab />);
    expect(screen.getByTestId(`admin-access-review-profile-link-${DELEGATE}`)).toHaveAttribute(
      'href',
      `/admin/users/${DELEGATE}`
    );
  });

  it('bulk revokes the selected admins through the audited routes, one admin at a time', async () => {
    renderWithTheme(<AccessReviewTab />);
    expect(screen.getByTestId(`admin-table-select-${ME}`).querySelector('input')).toBeDisabled();
    fireEvent.click(screen.getByTestId(`admin-table-select-${OTHER_FULL}`).querySelector('input') as Element);
    fireEvent.click(screen.getByTestId(`admin-table-select-${DELEGATE}`).querySelector('input') as Element);
    fireEvent.click(screen.getByTestId('admin-access-review-bulk-revoke-btn'));
    const list = await screen.findByTestId('admin-access-review-bulk-revoke-list');
    expect(within(list).getByText('b@example.com')).toBeInTheDocument();
    expect(within(list).getByText('c@example.com')).toBeInTheDocument();
    expect(within(list).queryByText('me@example.com')).toBeNull();
    fireEvent.change(screen.getByTestId('admin-access-review-bulk-revoke-dialog-reason-input'), {
      target: { value: 'left the team' },
    });
    fireEvent.click(screen.getByTestId('admin-access-review-bulk-revoke-dialog-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-access-review-bulk-revoke-dialog')).not.toBeInTheDocument());
    expect(mocks.apiPut.mock.calls.map(([url]) => url)).toEqual([
      `/api/admin/users/${OTHER_FULL}/role`,
      `/api/admin/users/${DELEGATE}/permissions`,
    ]);
    expect(mocks.apiPost.mock.calls).toEqual([
      ['/api/admin/access-review/decisions', { userId: OTHER_FULL, decision: 'revoked', dormantDays: 90 }],
      ['/api/admin/access-review/decisions', { userId: DELEGATE, decision: 'revoked', dormantDays: 90 }],
    ]);
  });

  it('is not openable by a delegate holding settings:manage', () => {
    expect(canOpenAdminTab({ isAdmin: false, adminPermissions: ['settings:manage'] }, AdminTab.AccessReview)).toBe(
      false
    );
  });
});

describe('AccessReviewOverdueBanner', () => {
  it('shows for a full admin when the review is overdue and opens the tab', () => {
    mocks.status = { quarter: '2026-Q4', overdue: true, completedAt: null };
    const onOpen = vi.fn();
    renderWithTheme(<AccessReviewOverdueBanner isFullAdmin hidden={false} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('admin-access-review-overdue-open-btn'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('stays hidden for a delegate and when the review is not overdue', () => {
    mocks.status = { quarter: '2026-Q4', overdue: true, completedAt: null };
    const { unmount } = renderWithTheme(
      <AccessReviewOverdueBanner isFullAdmin={false} hidden={false} onOpen={vi.fn()} />
    );
    expect(screen.queryByTestId('admin-access-review-overdue-banner')).toBeNull();
    unmount();
    mocks.status = { quarter: '2026-Q4', overdue: false, completedAt: '2026-11-03T00:00:00.000Z' };
    renderWithTheme(<AccessReviewOverdueBanner isFullAdmin hidden={false} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('admin-access-review-overdue-banner')).toBeNull();
  });

  it('stays hidden on the access review page, which shows its own progress', () => {
    mocks.status = { quarter: '2026-Q4', overdue: true, overdueSince: '2026-10-31T00:00:00.000Z', completedAt: null };
    renderWithTheme(<AccessReviewOverdueBanner isFullAdmin hidden onOpen={vi.fn()} />);
    expect(screen.queryByTestId('admin-access-review-overdue-banner')).toBeNull();
  });
});
