import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import UserCard from './UserCard';

const mocks = vi.hoisted(() => ({ byEmail: undefined as undefined | { id: string; name?: string } }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUserByEmail: () => ({ data: mocks.byEmail }) }));
vi.mock('@client/app/utils/s3', () => ({ getAppFileUrl: () => '' }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({}) }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('Project UserCard', () => {
  // The by-email lookup answers with only { id, name }, so a resolved pending row must layer that
  // over the invite it came from - substituting it drops the one address the row has to show.
  it('keeps showing the invitee address when the lookup resolves the pending row', () => {
    mocks.byEmail = { id: 'resolved-user-id', name: 'Ada' };
    render(<UserCard user={{ name: 'Ada', email: 'invitee@example.test', photoUrl: null }} inviteStatus="pending" />, {
      wrapper: TestWrapper,
    });
    expect(screen.getByText('invitee@example.test')).toBeTruthy();
  });

  it('shows the invitee address when the lookup resolves nothing', () => {
    mocks.byEmail = undefined;
    render(
      <UserCard user={{ name: 'Unknown', email: 'unknown@example.test', photoUrl: null }} inviteStatus="pending" />,
      { wrapper: TestWrapper }
    );
    expect(screen.getByText('unknown@example.test')).toBeTruthy();
  });
});
