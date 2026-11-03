import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';
import { InviteCenterShell } from './InviteCenterShell';
import { useAdminModal } from './useAdminModal';

const routerMock = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => routerMock.search,
  useNavigate: () => routerMock.navigate,
}));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const renderShell = () =>
  render(<InviteCenterShell waitlist={<div data-testid="waitlist-child">list</div>} />, { wrapper: Wrapper });

describe('InviteCenterShell', () => {
  beforeEach(() => {
    routerMock.search = {};
    routerMock.navigate.mockClear();
    useAdminModal.setState(useAdminModal.getInitialState());
  });

  it('shows the header and the waitlist by default', () => {
    renderShell();
    expect(screen.getByText('Invite Center')).toBeInTheDocument();
    expect(screen.getByTestId('invite-center-section-waitlist')).toContainElement(screen.getByTestId('waitlist-child'));
  });

  it('falls back to the waitlist for an unknown section', () => {
    routerMock.search = { inviteSection: 'bogus' };
    renderShell();
    expect(screen.getByTestId('waitlist-child')).toBeInTheDocument();
  });

  it('renders the section named in the URL', () => {
    routerMock.search = { inviteSection: 'pending' };
    renderShell();
    expect(screen.getByTestId('invite-center-section-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('waitlist-child')).not.toBeInTheDocument();
    expect(screen.getByText('Pending grants are coming here')).toBeInTheDocument();
  });

  it('navigates with replace, keeping other params', () => {
    renderShell();
    fireEvent.click(screen.getByTestId('invite-center-sections-schedule-btn'));

    const { to, replace, search } = routerMock.navigate.mock.calls[0][0];
    expect(to).toBe('/admin');
    expect(replace).toBe(true);
    expect(search({ tab: 'waitlist', emergency_access: 'x' })).toEqual({
      tab: 'waitlist',
      emergency_access: 'x',
      inviteSection: 'schedule',
    });
  });

  it('writes undefined when the default section is selected', () => {
    routerMock.search = { inviteSection: 'rewards' };
    renderShell();
    fireEvent.click(screen.getByTestId('invite-center-sections-waitlist-btn'));

    const { search } = routerMock.navigate.mock.calls[0][0];
    expect(search({ tab: 'waitlist', inviteSection: 'rewards' })).toEqual({
      tab: 'waitlist',
      inviteSection: undefined,
    });
  });

  it.each([
    ['packages', 'Packages are coming here'],
    ['schedule', 'The signup credit schedule is coming here'],
    ['pending', 'Pending grants are coming here'],
    ['rewards', 'Rewards are coming here'],
  ])('shows the %s empty state', (id, title) => {
    routerMock.search = { inviteSection: id };
    renderShell();
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it('has no action buttons on the schedule and rewards stubs', () => {
    for (const id of ['schedule', 'rewards']) {
      routerMock.search = { inviteSection: id };
      const { unmount } = renderShell();
      expect(screen.getByTestId('admin-empty-state').querySelector('button')).toBeNull();
      unmount();
    }
  });

  it.each([
    ['packages', 'invite-center-open-invites-btn', AdminTab.RegistrationInvites],
    ['packages', 'invite-center-open-partner-signups-btn', AdminTab.PartnerSignupRules],
    ['pending', 'invite-center-open-held-grants-btn', AdminTab.HeldSignupGrants],
  ])('on %s, %s opens its admin tab', (id, testId, tab) => {
    routerMock.search = { inviteSection: id };
    renderShell();
    fireEvent.click(screen.getByTestId(testId));
    expect(useAdminModal.getState().activeTab).toBe(tab);
  });
});
