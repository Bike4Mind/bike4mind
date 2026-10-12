import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import UserCard from './UserCard';

const mocks = vi.hoisted(() => ({ byEmail: undefined as undefined | { id: string } }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUserByEmail: () => ({ data: mocks.byEmail }) }));
vi.mock('@client/app/utils/s3', () => ({ getAppFileUrl: () => '' }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('UserCard', () => {
  it('keeps the profile link on a pending row that has an id but no email', () => {
    mocks.byEmail = undefined;
    render(
      <UserCard user={{ id: 'user-id', name: 'Invitee', photoUrl: undefined }} inviteStatus="pending" hideEmail />,
      {
        wrapper: TestWrapper,
      }
    );
    expect(screen.getByTestId('user-card-view-btn')).toBeTruthy();
  });

  it('omits the profile link when a pending row resolves to no user', () => {
    mocks.byEmail = undefined;
    render(
      <UserCard
        user={{ name: 'Unknown', email: 'unknown@example.test', photoUrl: undefined }}
        inviteStatus="pending"
      />,
      {
        wrapper: TestWrapper,
      }
    );
    expect(screen.queryByTestId('user-card-view-btn')).toBeNull();
  });
});
