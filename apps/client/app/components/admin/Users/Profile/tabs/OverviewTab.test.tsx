import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { buildProfile, ProfileTestWrapper } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  currentUser: { id: 'admin1' } as { id: string; isAdmin: boolean; adminPermissions?: string[] },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useGetUserProductAccess: () => mocks.access,
}));
vi.mock('../../../Subscriptions/SubscriptionSummaryList', () => ({ SubscriptionSummaryList: () => null }));
vi.mock('../RiskEvidenceCard', () => ({
  RiskEvidenceCard: ({ userId }: { userId: string }) => <div data-testid="risk-evidence-card-stub">{userId}</div>,
}));
vi.mock('../SignupClassificationCard', () => ({
  SignupClassificationCard: () => <div data-testid="signup-classification-stub" />,
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
  mocks.access = { data: undefined, isLoading: false };
});

// Covered by OAuthClientRolesCard.test.tsx, for the same reason as InterventionHolds below.
vi.mock('./OAuthClientRolesCard', () => ({
  OAuthClientRolesCard: ({ user }: { user: { id: string } }) => <div data-testid={`oauth-roles-card-${user.id}`} />,
}));

// Covered by InterventionHolds.test.tsx; its own queries would shift this file's api mocks.
vi.mock('../../../InterventionHolds', () => ({
  InterventionDecisionsPanel: () => null,
  InterventionHoldsCard: () => null,
}));

describe('OverviewTab app roles', () => {
  it('shows the app roles card for the user', () => {
    render(<OverviewTab user={buildProfile()} onAction={vi.fn()} onViewActivity={vi.fn()} onViewCredits={vi.fn()} />, {
      wrapper: ProfileTestWrapper,
    });
    expect(screen.getByTestId('oauth-roles-card-test-user-1')).toBeInTheDocument();
  });
});

describe('OverviewTab internal account row', () => {
  it.each([
    [{ isInternal: false }, 'Customer'],
    [{ isInternal: true }, 'Internal account'],
    [{ isInternal: false, isAdmin: true }, 'Internal account (admin)'],
    [{ accountSegment: 'partner' as const }, 'Partner account'],
    [{ accountSegment: 'partner' as const, isAdmin: true }, 'Internal account (admin)'],
    [{ accountSegment: 'partner' as const, isInternal: true }, 'Internal account'],
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

describe('OverviewTab partner mark', () => {
  it.each([
    [undefined, 'Mark partner'],
    ['partner' as const, 'Unmark partner'],
  ])('with segment %s the button reads %s and opens the partner action', (accountSegment, label) => {
    const onAction = vi.fn();
    render(
      <OverviewTab
        user={buildProfile({ accountSegment })}
        onAction={onAction}
        onViewActivity={vi.fn()}
        onViewCredits={vi.fn()}
      />,
      { wrapper: ProfileTestWrapper }
    );

    expect(screen.getByTestId('user-profile-partner-btn')).toHaveTextContent(label);
    fireEvent.click(screen.getByTestId('user-profile-partner-btn'));
    expect(onAction).toHaveBeenCalledWith('partnerAccount');
  });
});

describe('OverviewTab file indexing window row', () => {
  it('opens the reset action', () => {
    mocks.currentUser = { id: 'admin1', isAdmin: true };
    const onAction = vi.fn();
    render(<OverviewTab user={buildProfile()} onAction={onAction} onViewActivity={vi.fn()} onViewCredits={vi.fn()} />, {
      wrapper: ProfileTestWrapper,
    });

    fireEvent.click(screen.getByTestId('user-actions-reset-file-embedding-window'));
    expect(onAction).toHaveBeenCalledWith('fileEmbeddingWindowReset');
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

describe('OverviewTab file indexing window reset row', () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue({ data: { entries: [], nextCursor: null, notes: [], items: [] } });
  });

  it('is disabled with the missing permission for a delegate without settings:manage', () => {
    mocks.currentUser = { id: 'd1', isAdmin: false, adminPermissions: ['support:read'] };
    renderTab();
    expect(screen.getByTestId('user-actions-reset-file-embedding-window')).toBeDisabled();
    expect(screen.getByTestId('user-actions-reset-file-embedding-window-reason')).toHaveAttribute(
      'aria-label',
      'Missing permission: settings:manage'
    );
  });

  it('is enabled for a delegate with settings:manage', () => {
    mocks.currentUser = { id: 'd1', isAdmin: false, adminPermissions: ['settings:manage'] };
    renderTab();
    expect(screen.getByTestId('user-actions-reset-file-embedding-window')).toBeEnabled();
  });
});

describe('OverviewTab Access card admin access', () => {
  const SUPPORT_ROLE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const BILLING_ROLE = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const SUPPORT_AGENT = { id: SUPPORT_ROLE, name: 'Support agent', permissions: ['support:read', 'users:moderate'] };

  // Routes the role list to the admin-roles query and a benign payload to the timeline fetch.
  const serveRoles = (roles: unknown[] | Error) =>
    mocks.get.mockImplementation(async (url: string) => {
      if (url.includes('admin-roles')) {
        if (roles instanceof Error) throw roles;
        return { data: { roles } };
      }
      return { data: { entries: [], nextCursor: null, notes: [], items: [] } };
    });

  const renderCard = (user: Parameters<typeof buildProfile>[0]) =>
    render(
      <OverviewTab user={buildProfile(user)} onAction={vi.fn()} onViewActivity={vi.fn()} onViewCredits={vi.fn()} />,
      { wrapper: ProfileTestWrapper }
    );

  beforeEach(() => {
    mocks.currentUser = { id: 'admin1', isAdmin: true };
  });

  it('names held roles and labels each effective permission with its source', async () => {
    serveRoles([SUPPORT_AGENT]);
    renderCard({ adminPermissions: ['users:moderate'], adminRoleIds: [SUPPORT_ROLE] });

    expect(await screen.findByText('Support agent')).toBeInTheDocument();
    expect(await screen.findByTestId('user-profile-admin-permission-support-read')).toHaveTextContent(
      'Support read (from Support agent)'
    );
    expect(screen.getByTestId('user-profile-admin-permission-users-moderate')).toHaveTextContent(
      'Moderate users (from Support agent; granted directly)'
    );
  });

  it('falls back to a role count when the list cannot name them', async () => {
    serveRoles(new Error('boom'));
    renderCard({ adminRoleIds: [SUPPORT_ROLE, BILLING_ROLE] });

    await waitFor(() => expect(screen.getByTestId('user-profile-fact-admin-roles')).toHaveTextContent('2 roles'));
    expect(await screen.findByText('Role permissions unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-fact-admin-permissions')).not.toHaveTextContent('None');
  });

  it('keeps known direct permissions visible without claiming the failed role permissions are complete', async () => {
    serveRoles(new Error('role list failed'));
    renderCard({ adminPermissions: ['support:read'], adminRoleIds: [SUPPORT_ROLE] });
    expect(await screen.findByText('Role permissions unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-admin-permission-support-read')).toHaveTextContent('granted directly');
  });

  it('does not claim no permissions while a held role is still loading', () => {
    mocks.get.mockImplementation((url: string) =>
      url.includes('admin-roles')
        ? new Promise<never>(() => {})
        : Promise.resolve({ data: { entries: [], nextCursor: null, notes: [], items: [] } })
    );
    renderCard({ adminRoleIds: [SUPPORT_ROLE] });
    expect(screen.getByTestId('user-profile-fact-admin-permissions')).toHaveTextContent('Loading role permissions');
    expect(screen.getByTestId('user-profile-fact-admin-permissions')).not.toHaveTextContent('None');
  });

  it('can report no permissions when the account holds no roles even if the role list fails', async () => {
    serveRoles(new Error('role list failed'));
    renderCard({ adminPermissions: [], adminRoleIds: [] });
    expect(screen.getByTestId('user-profile-fact-admin-permissions')).toHaveTextContent('None');
  });

  it('shows All (Super Admin) with Edit for the permissions the role does not imply, and no Admin roles row', () => {
    serveRoles([SUPPORT_AGENT]);
    renderCard({ isAdmin: true, adminRoleIds: [SUPPORT_ROLE], adminPermissions: ['credits:self_grant'] });

    expect(screen.getByTestId('user-profile-fact-admin-permissions')).toHaveTextContent('All (Super Admin)');
    expect(screen.getByTestId('user-profile-admin-permission-credits-self_grant')).toBeInTheDocument();
    expect(screen.queryByTestId('user-profile-admin-permission-support-read')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-profile-fact-admin-roles')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-profile-admin-permissions-btn')).toBeInTheDocument();
  });

  it('offers no Edit on the viewer own profile', () => {
    serveRoles([SUPPORT_AGENT]);
    renderCard({ id: 'admin1', adminPermissions: ['support:read'] });

    expect(screen.queryByTestId('user-profile-admin-permissions-btn')).not.toBeInTheDocument();
  });
});

describe('OverviewTab account and access rows', () => {
  const empty = { data: { entries: [], nextCursor: null, notes: [], items: [] } };
  const SUPPORT_ROLE = 'aaaaaaaaaaaaaaaaaaaaaaaa';

  const renderWith = (user: Parameters<typeof buildProfile>[0] = {}) => {
    const onAction = vi.fn();
    render(
      <OverviewTab user={buildProfile(user)} onAction={onAction} onViewActivity={vi.fn()} onViewCredits={vi.fn()} />,
      {
        wrapper: ProfileTestWrapper,
      }
    );
    return onAction;
  };

  beforeEach(() => {
    mocks.get.mockResolvedValue(empty);
  });

  it.each([
    [true, 'Verified', 'Mark unverified'],
    [false, 'Unverified', 'Mark verified'],
  ])('with emailVerified %s shows %s and offers %s', (emailVerified, chip, button) => {
    const onAction = renderWith({ emailVerified });
    expect(screen.getByTestId('user-profile-fact-email')).toHaveTextContent(chip);
    expect(screen.getByTestId('user-profile-email-verification-btn')).toHaveTextContent(button);
    fireEvent.click(screen.getByTestId('user-profile-email-verification-btn'));
    expect(onAction).toHaveBeenCalledWith('emailVerification');
  });

  it('joins the signup method, date and country', () => {
    renderWith({
      acquisition: { signupMethod: 'google' },
      signupMeta: { country: 'Norway' },
    } as Parameters<typeof buildProfile>[0]);
    expect(screen.getByText(/google \u00b7 .* \u00b7 Norway/)).toBeInTheDocument();
  });

  it('leaves the signup row empty when nothing is known about it', () => {
    renderWith({ createdAt: undefined } as unknown as Parameters<typeof buildProfile>[0]);
    expect(screen.queryByText(/\u00b7/)).not.toBeInTheDocument();
  });

  it.each([
    [{ totpEnabled: true, passkeyEnabled: false }, 'Authenticator app'],
    [{ totpEnabled: false, passkeyEnabled: true }, 'Passkey'],
    [{ totpEnabled: true, passkeyEnabled: true }, 'Authenticator app + Passkey'],
  ])('shows %o as %s and opens the MFA reset', (mfa, text) => {
    const onAction = renderWith({ mfa } as Parameters<typeof buildProfile>[0]);
    expect(screen.getByTestId('user-profile-fact-mfa')).toHaveTextContent(text);
    fireEvent.click(screen.getByTestId('user-profile-mfa-reset-btn'));
    expect(onAction).toHaveBeenCalledWith('mfaReset');
  });

  it('shows Not set up without MFA', () => {
    renderWith();
    expect(screen.getByTestId('user-profile-fact-mfa')).toHaveTextContent('Not set up');
    expect(screen.queryByTestId('user-profile-mfa-reset-btn')).not.toBeInTheDocument();
  });

  it('shows a trusted key state and opens the trust action', () => {
    mocks.currentUser = { id: 'admin1', isAdmin: true };
    const onAction = renderWith({ apiKeyTrustApproved: true });
    expect(screen.getByTestId('user-profile-fact-key-trust')).toHaveTextContent('Trusted');
    fireEvent.click(screen.getByTestId('user-profile-key-trust-btn'));
    expect(onAction).toHaveBeenCalledWith('apiKeyTrust');
  });

  it('shows a lifted spend cap and opens the spend cap action', () => {
    const onAction = renderWith({ newAccountSpendCapLifted: true });
    expect(screen.getByTestId('user-profile-fact-spend-cap')).toHaveTextContent('Lifted');
    fireEvent.click(screen.getByTestId('user-profile-spend-cap-btn'));
    expect(onAction).toHaveBeenCalledWith('newAccountSpendCap');
  });

  it('shows the default spend cap text', () => {
    renderWith();
    expect(screen.getByTestId('user-profile-fact-spend-cap')).toHaveTextContent('Applies while the account is new');
  });

  it.each([
    [2.5e9, '2.5 GB'],
    [5e6, '5.0 MB'],
    [3e3, '3 KB'],
  ])('formats %d bytes of storage as %s', (currentStorageSize, text) => {
    renderWith({ currentStorageSize });
    expect(screen.getByText(new RegExp(`^${text.replace('.', '\\.')} of `))).toBeInTheDocument();
  });

  it('opens the role, tags and grant subscription actions', () => {
    const onAction = renderWith();
    fireEvent.click(screen.getByTestId('user-profile-change-role-btn'));
    fireEvent.click(screen.getByTestId('user-profile-tags-btn'));
    fireEvent.click(screen.getByTestId('user-profile-grant-subscription-btn'));
    expect(onAction.mock.calls.map(call => call[0])).toEqual(['role', 'tags', 'subscription']);
  });

  it('lists custom tags and treats a missing tag list as none', () => {
    renderWith({ tags: ['vip'] });
    expect(screen.getByTestId('user-profile-fact-tags')).toHaveTextContent('vip');
  });

  it('shows None for tags when the profile has no tag list', () => {
    renderWith({ tags: undefined });
    expect(screen.getByTestId('user-profile-fact-tags')).toHaveTextContent('None');
  });

  it('shows the product access states and opens the manage action', () => {
    mocks.access = { data: undefined, isLoading: true };
    const onAction = renderWith();
    expect(screen.getByTestId('user-profile-fact-products')).toHaveTextContent('...');
    fireEvent.click(screen.getByTestId('user-profile-product-access-btn'));
    expect(onAction).toHaveBeenCalledWith('productAccess');
  });

  it('names only the held product entitlements', () => {
    mocks.access = {
      data: {
        entitlements: [
          { key: 'studio', held: true },
          { key: 'labs', held: false },
        ],
      },
      isLoading: false,
    };
    renderWith();
    const row = screen.getByTestId('user-profile-fact-products');
    expect(row).toHaveTextContent('studio');
    expect(row).not.toHaveTextContent('labs');
  });

  it('shows None when no entitlement is held', () => {
    mocks.access = { data: { entitlements: [{ key: 'labs', held: false }] }, isLoading: false };
    renderWith();
    expect(screen.getByTestId('user-profile-fact-products')).toHaveTextContent('None');
  });

  it('says None when the held role ids match no known role', async () => {
    mocks.currentUser = { id: 'admin1', isAdmin: true };
    mocks.get.mockImplementation(async (url: string) =>
      url.includes('admin-roles') ? { data: { roles: [] } } : empty
    );
    renderWith({ adminRoleIds: [SUPPORT_ROLE] });
    await waitFor(() => expect(screen.getByTestId('user-profile-fact-admin-roles')).toHaveTextContent('None'));
  });

  it('shows a singular role count when the list is unavailable', async () => {
    mocks.currentUser = { id: 'admin1', isAdmin: true };
    mocks.get.mockImplementation(async (url: string) => {
      if (url.includes('admin-roles')) throw new Error('boom');
      return empty;
    });
    renderWith({ adminRoleIds: [SUPPORT_ROLE] });
    await waitFor(() => expect(screen.getByTestId('user-profile-fact-admin-roles')).toHaveTextContent('1 role'));
  });

  it('opens the permissions editor for a full admin viewing another account', () => {
    mocks.currentUser = { id: 'admin1', isAdmin: true };
    const onAction = renderWith();
    fireEvent.click(screen.getByTestId('user-profile-admin-permissions-btn'));
    expect(onAction).toHaveBeenCalledWith('permissions');
  });

  it('closes the audit drawer from its close button', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [adminRow], nextCursor: null } });
    renderWith();
    fireEvent.click(await screen.findByTestId('user-profile-recent-activity-row-open-btn'));
    expect(await screen.findByTestId('audit-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('audit-drawer-close-btn'));
    await waitFor(() => expect(screen.queryByTestId('audit-drawer')).not.toBeInTheDocument());
  });
});
