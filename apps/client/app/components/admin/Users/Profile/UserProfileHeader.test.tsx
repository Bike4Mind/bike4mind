import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ReactNode } from 'react';
import { UserProfileHeader } from './UserProfileHeader';
import type { AdminUserProfile } from './userProfileModel';
import { buildProfile } from './profileTestUtils';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderHeader = (user: AdminUserProfile = buildProfile()) => {
  const onAction = vi.fn();
  const onCompliance = vi.fn();
  render(<UserProfileHeader user={user} onAction={onAction} onCompliance={onCompliance} />, { wrapper: TestWrapper });
  return { onAction, onCompliance };
};

describe('UserProfileHeader', () => {
  it('shows identity, level, status and both dates', () => {
    renderHeader();

    expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('test-user-1')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-status-chip')).toHaveTextContent('Active');
    expect(screen.getByTestId('user-profile-status-chip')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('user-profile-level-chip')).toHaveTextContent('Paid');
    expect(screen.getByTestId('user-profile-joined')).toHaveTextContent(/^Joined /);
    expect(screen.getByTestId('user-profile-last-active')).toHaveTextContent(/^Active /);
  });

  it('shows Suspended and Restricted status, suspension winning over restriction', () => {
    const { unmount } = render(
      <UserProfileHeader
        user={buildProfile({ isBanned: true, isModerated: true })}
        onAction={vi.fn()}
        onCompliance={vi.fn()}
      />,
      { wrapper: TestWrapper }
    );
    expect(screen.getByTestId('user-profile-status-chip')).toHaveTextContent('Suspended');
    expect(screen.getByTestId('user-profile-status-chip')).toHaveAttribute('data-tone', 'bad');
    unmount();

    renderHeader(buildProfile({ isModerated: true }));
    expect(screen.getByTestId('user-profile-status-chip')).toHaveTextContent('Restricted');
    expect(screen.getByTestId('user-profile-status-chip')).toHaveAttribute('data-tone', 'warn');
  });

  it('names the signup method and the organization when they are known', () => {
    renderHeader(
      buildProfile({
        organizationId: { name: 'Acme' } as AdminUserProfile['organizationId'],
        acquisition: { signupMethod: 'google', capturedAt: new Date() },
      })
    );

    expect(screen.getByTestId('user-profile-joined')).toHaveTextContent(/^Joined with Google \u00b7 /);
    expect(screen.getByTestId('user-profile-org-chip')).toHaveTextContent('Acme');
  });

  it('shows an unlisted signup method and level as stored', () => {
    renderHeader(
      buildProfile({
        level: 'TrialUser' as AdminUserProfile['level'],
        photoUrl: 'https://example.com/a.png',
        acquisition: { signupMethod: 'saml', capturedAt: new Date() },
      })
    );

    expect(screen.getByTestId('user-profile-joined')).toHaveTextContent(/^Joined with saml \u00b7 /);
    expect(screen.getByTestId('user-profile-level-chip')).toHaveTextContent('TrialUser');
  });

  it('leaves out the level chip and email when the account has neither', () => {
    renderHeader(buildProfile({ level: undefined, email: null }));

    expect(screen.queryByTestId('user-profile-level-chip')).not.toBeInTheDocument();
    expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument();
  });

  it('leaves the org chip out while the org is an unpopulated id, as an update response carries it', () => {
    renderHeader(buildProfile({ organizationId: 'org-1' as unknown as AdminUserProfile['organizationId'] }));

    expect(screen.queryByTestId('user-profile-org-chip')).not.toBeInTheDocument();
  });

  it('falls back to the username, then the email, when there is no name', () => {
    renderHeader(buildProfile({ name: '  ' }));

    expect(screen.getByRole('heading', { name: 'ada' })).toBeInTheDocument();
  });

  it('puts Adjust credits and Suspend up front and reports them', () => {
    const { onAction } = renderHeader();

    fireEvent.click(screen.getByTestId('user-profile-adjust-credits-btn'));
    fireEvent.click(screen.getByTestId('user-profile-suspend-btn'));

    expect(onAction).toHaveBeenNthCalledWith(1, 'credits');
    expect(onAction).toHaveBeenNthCalledWith(2, 'suspend');
  });

  it('hides Suspend for an account that is already suspended', () => {
    renderHeader(buildProfile({ isBanned: true }));

    expect(screen.queryByTestId('user-profile-suspend-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-profile-adjust-credits-btn')).toBeInTheDocument();
  });

  it.each([
    'editProfile',
    'loginAs',
    'message',
    'subscription',
    'role',
    'productAccess',
    'restrict',
    'shadowTier',
    'delete',
  ])('the More menu reports %s', async action => {
    const { onAction } = renderHeader();

    fireEvent.click(screen.getByTestId('user-profile-more-btn'));
    fireEvent.click(await screen.findByTestId(`user-profile-menu-${action}-item`));

    expect(onAction).toHaveBeenCalledWith(action);
  });

  it('the More menu opens the compliance record through onCompliance, not onAction', async () => {
    const { onAction, onCompliance } = renderHeader();

    fireEvent.click(screen.getByTestId('user-profile-more-btn'));
    fireEvent.click(await screen.findByTestId('user-profile-menu-compliance-item'));

    expect(onCompliance).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('turns the restrict item into Lift restriction for a restricted account', async () => {
    renderHeader(buildProfile({ isModerated: true }));

    fireEvent.click(screen.getByTestId('user-profile-more-btn'));

    expect(await screen.findByTestId('user-profile-menu-restrict-item')).toHaveTextContent('Lift restriction');
  });

  it('offers Move to limited tier to an unrestricted account', async () => {
    renderHeader();
    fireEvent.click(screen.getByTestId('user-profile-more-btn'));
    expect(await screen.findByTestId('user-profile-menu-shadowTier-item')).toHaveTextContent('Move to limited tier');
    expect(screen.queryByTestId('user-profile-shadow-tier-chip')).not.toBeInTheDocument();
  });

  it('offers Move to limited tier and no chip when the tier is none', async () => {
    const throttle = { tier: 'none', source: 'admin', reason: 'ok', changedAt: new Date('2026-10-01') } as const;
    renderHeader(buildProfile({ throttle }));
    fireEvent.click(screen.getByTestId('user-profile-more-btn'));
    expect(await screen.findByTestId('user-profile-menu-shadowTier-item')).toHaveTextContent('Move to limited tier');
    expect(screen.queryByTestId('user-profile-shadow-tier-chip')).not.toBeInTheDocument();
  });

  it('offers Remove limited tier and shows a chip once shadowed', async () => {
    const throttle = { tier: 'shadow', source: 'admin', reason: 'abuse', changedAt: new Date('2026-10-01') } as const;
    renderHeader(buildProfile({ throttle }));
    fireEvent.click(screen.getByTestId('user-profile-more-btn'));
    expect(await screen.findByTestId('user-profile-menu-shadowTier-item')).toHaveTextContent('Remove limited tier');
    expect(screen.getByTestId('user-profile-shadow-tier-chip')).toHaveTextContent('Limited tier');
  });

  it('marks the chip not in effect for an exempt shadowed user', () => {
    const throttle = { tier: 'shadow', source: 'admin', reason: 'abuse', changedAt: new Date('2026-10-01') } as const;
    renderHeader(buildProfile({ throttle, isAdmin: true }));
    expect(screen.getByTestId('user-profile-shadow-tier-chip')).toHaveTextContent('Limited tier (not in effect)');
  });

  it('marks the chip not in effect for a Developer-tagged shadowed user', () => {
    const throttle = { tier: 'shadow', source: 'admin', reason: 'abuse', changedAt: new Date('2026-10-01') } as const;
    renderHeader(buildProfile({ throttle, tags: ['Developer'] }));
    expect(screen.getByTestId('user-profile-shadow-tier-chip')).toHaveTextContent('Limited tier (not in effect)');
  });

  it('shows the plain chip for a normal shadowed user', () => {
    const throttle = { tier: 'shadow', source: 'admin', reason: 'abuse', changedAt: new Date('2026-10-01') } as const;
    renderHeader(buildProfile({ throttle }));
    expect(screen.getByTestId('user-profile-shadow-tier-chip')).toHaveTextContent(/^Limited tier$/);
  });
});
