import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
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
  status: null as unknown,
  decisionFails: false,
  updatePermissions: vi.fn(),
  updateRole: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@client/app/hooks/data/adminAccessReview', () => ({
  useAccessReviewReport: () => ({ data: mocks.report, isPending: false, isError: false, refetch: vi.fn() }),
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
    mocks.updatePermissions(input);
  },
}));

vi.mock('../Users/Profile/actions/useAdminUserRoleUpdate', () => ({
  useAdminUserRoleUpdate: () => async (input: unknown) => {
    mocks.calls.push('role');
    mocks.updateRole(input);
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithTheme = (ui: React.ReactNode) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <UndoToastProvider>{ui}</UndoToastProvider>
    </CssVarsProvider>
  );

const row = (overrides: Partial<AccessReviewRow>): AccessReviewRow => ({
  userId: ME,
  email: 'me@example.com',
  username: 'me',
  fullAdmin: true,
  permissions: [],
  directPermissions: [],
  adminRoleIds: [],
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
  admins,
  record: null,
});

const rowOf = (userId: string) => screen.getByTestId(`admin-access-review-row-${userId}`);

const openActions = (userId: string) =>
  fireEvent.click(within(rowOf(userId)).getByTestId('admin-access-review-row-actions'));

const revoke = async (userId: string) => {
  openActions(userId);
  fireEvent.click(await screen.findByTestId('admin-access-review-revoke-btn'));
  fireEvent.change(await screen.findByTestId('admin-access-review-revoke-reason-input'), {
    target: { value: 'left the team' },
  });
  fireEvent.click(screen.getByTestId('admin-access-review-revoke-confirm-btn'));
};

describe('AccessReviewTab', () => {
  beforeEach(() => {
    mocks.calls = [];
    mocks.decisionFails = false;
    mocks.updatePermissions.mockReset();
    mocks.updateRole.mockReset();
    mocks.mutate.mockReset();
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
        grantedBy: { userId: ME, name: 'Me', email: 'me@example.com' },
        grantedAt: '2026-10-01T00:00:00.000Z',
      }),
    ]);
  });

  it('blocks confirming your own access and allows confirming another admin', async () => {
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(ME)).getByTestId('admin-access-review-row-actions')).toBeDisabled();
    openActions(OTHER_FULL);
    const confirm = await screen.findByTestId('admin-access-review-confirm-btn');
    expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
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
    expect(within(rowOf(OTHER_FULL)).getByText('None in 12 months')).toBeInTheDocument();
    expect(within(rowOf(OTHER_FULL)).getByText('Unknown (before audit log)')).toBeInTheDocument();
    expect(within(rowOf(ME)).queryByTestId('admin-access-review-dormant-chip')).toBeNull();
    expect(within(rowOf(ME)).queryByTestId('admin-access-review-no-mfa-chip')).toBeNull();
    expect(within(rowOf(DELEGATE)).getByText('users:moderate, settings:manage')).toBeInTheDocument();
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

  it('revokes a full admin through the role update', async () => {
    renderWithTheme(<AccessReviewTab />);
    await revoke(OTHER_FULL);
    await waitFor(() => expect(mocks.calls).toEqual(['role', 'decision:revoked']));
    expect(mocks.updateRole).toHaveBeenCalledWith({ isAdmin: false, reason: 'left the team' });
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
            decision: 'revoked',
            reviewer: { userId: ME, name: 'Me' },
            decidedAt: '2026-11-02T00:00:00.000Z',
          },
        ],
      },
    };
    renderWithTheme(<AccessReviewTab />);
    expect(within(rowOf(DELEGATE)).getByText('Revoked')).toBeInTheDocument();
    expect(within(rowOf(DELEGATE)).queryByTestId('admin-access-review-row-actions')).toBeNull();
    expect(within(rowOf(DELEGATE)).getAllByText('\u2014')).toHaveLength(2);
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
    renderWithTheme(<AccessReviewOverdueBanner isFullAdmin onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('admin-access-review-overdue-open-btn'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('stays hidden for a delegate and when the review is not overdue', () => {
    mocks.status = { quarter: '2026-Q4', overdue: true, completedAt: null };
    const { unmount } = renderWithTheme(<AccessReviewOverdueBanner isFullAdmin={false} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('admin-access-review-overdue-banner')).toBeNull();
    unmount();
    mocks.status = { quarter: '2026-Q4', overdue: false, completedAt: '2026-11-03T00:00:00.000Z' };
    renderWithTheme(<AccessReviewOverdueBanner isFullAdmin onOpen={vi.fn()} />);
    expect(screen.queryByTestId('admin-access-review-overdue-banner')).toBeNull();
  });
});
