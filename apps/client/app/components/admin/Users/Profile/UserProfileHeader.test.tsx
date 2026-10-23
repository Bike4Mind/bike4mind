import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ReactNode } from 'react';
import { UserProfileHeader, type AdminUserProfile } from './UserProfileHeader';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const profile = (overrides: Partial<AdminUserProfile> = {}) =>
  ({
    id: 'u1',
    name: 'Ada Lovelace',
    username: 'ada',
    email: 'ada@example.com',
    level: 'PaidUser',
    isAdmin: false,
    isBanned: false,
    isModerated: false,
    emailVerified: true,
    organizationId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: new Date('2026-10-20T00:00:00Z'),
    ...overrides,
  }) as AdminUserProfile;

const renderHeader = (user: AdminUserProfile) =>
  render(<UserProfileHeader user={user} actions={<button data-testid="stub-action" />} />, { wrapper: TestWrapper });

describe('UserProfileHeader', () => {
  it('shows identity, plan, verification and both dates, plus the actions it is given', () => {
    renderHeader(profile());

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('@ada - ada@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-badge-email')).toHaveTextContent('Email verified');
    expect(screen.getByTestId('user-profile-badge-level')).toHaveTextContent('PaidUser');
    expect(screen.getByTestId('user-profile-created')).toHaveTextContent(/^Created /);
    expect(screen.getByTestId('user-profile-last-active')).toHaveTextContent(/^Last active /);
    expect(screen.getByTestId('stub-action')).toBeInTheDocument();
  });

  it('shows the moderation state, admin role, org and signup method when they apply', () => {
    renderHeader(
      profile({
        emailVerified: false,
        isBanned: true,
        isModerated: true,
        isAdmin: true,
        organizationId: { name: 'Acme' } as AdminUserProfile['organizationId'],
        acquisition: { signupMethod: 'google', capturedAt: new Date() },
      })
    );

    expect(screen.getByTestId('user-profile-badge-email')).toHaveTextContent('Email unverified');
    expect(screen.getByTestId('user-profile-badge-banned')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-badge-moderated')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-badge-admin')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-badge-org')).toHaveTextContent('Acme');
    expect(screen.getByTestId('user-profile-badge-signup')).toHaveTextContent('Signed up via google');
  });

  it('leaves out badges that do not apply', () => {
    renderHeader(profile());

    for (const badge of ['banned', 'moderated', 'admin', 'org', 'signup']) {
      expect(screen.queryByTestId(`user-profile-badge-${badge}`)).not.toBeInTheDocument();
    }
  });
});
