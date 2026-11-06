import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ReactNode } from 'react';
import { UserProfilePage } from './UserProfilePage';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useGetUser: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUser: mocks.useGetUser }));
vi.mock('../ComplianceModal', () => ({ default: () => <div data-testid="stub-compliance-modal" /> }));
// The view is covered by UserProfileView.test.tsx; this stub exposes the props the page wires.
vi.mock('./UserProfileView', () => ({
  UserProfileView: (props: {
    user: { id: string };
    tab: string;
    onTabChange: (tab: string) => void;
    onBack: () => void;
  }) => (
    <div data-testid="stub-user-profile-view" data-tab={props.tab} data-user-id={props.user.id}>
      <button data-testid="stub-tab-btn" onClick={() => props.onTabChange('credits')} />
      <button data-testid="stub-back-btn" onClick={props.onBack} />
    </div>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const USER_ID = '0123456789abcdef01234567';

const loadedUser = () => ({
  isLoading: false,
  isFetching: false,
  error: null,
  data: { id: USER_ID, name: 'Ada' },
  refetch: vi.fn(),
});

const notFoundError = () =>
  new AxiosError('Not found', '404', undefined, undefined, {
    status: 404,
    statusText: 'Not Found',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const renderPage = (userId = USER_ID, onTabChange = vi.fn()) => {
  render(<UserProfilePage userId={userId} tab="activity" onTabChange={onTabChange} />, { wrapper: TestWrapper });
  return { onTabChange };
};

describe('UserProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useGetUser.mockReturnValue(loadedUser());
  });

  it('renders the profile view for the loaded user on the tab from the URL', () => {
    renderPage();

    expect(mocks.useGetUser).toHaveBeenCalledWith(USER_ID);
    const view = screen.getByTestId('stub-user-profile-view');
    expect(view).toHaveAttribute('data-tab', 'activity');
    expect(view).toHaveAttribute('data-user-id', USER_ID);
    expect(screen.getByTestId('user-profile-page')).toBeInTheDocument();
  });

  it('mounts the compliance modal the header opens, which the view does not render itself', () => {
    renderPage();

    expect(screen.getByTestId('stub-compliance-modal')).toBeInTheDocument();
  });

  it('hands tab changes to the route', () => {
    const { onTabChange } = renderPage();

    fireEvent.click(screen.getByTestId('stub-tab-btn'));

    expect(onTabChange).toHaveBeenCalledWith('credits');
  });

  it('goes back to the Users list from the view', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('stub-back-btn'));

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'users' } });
  });

  it('shows a progress bar while the user loads', () => {
    mocks.useGetUser.mockReturnValue({ isLoading: true, isFetching: true, error: null, data: undefined });
    renderPage();

    expect(screen.getByTestId('user-profile-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-user-profile-view')).not.toBeInTheDocument();
  });

  it('shows not-found for a malformed id without asking the API', () => {
    mocks.useGetUser.mockReturnValue({ isLoading: false, isFetching: false, error: null, data: undefined });
    renderPage('../organizations');

    expect(mocks.useGetUser).toHaveBeenCalledWith(null);
    expect(screen.getByTestId('user-profile-not-found')).toBeInTheDocument();
  });

  it('shows not-found when the API says the user does not exist, with a way back', () => {
    mocks.useGetUser.mockReturnValue({ isLoading: false, isFetching: false, error: notFoundError(), data: undefined });
    renderPage();

    expect(screen.getByTestId('user-profile-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-user-profile-view')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('user-profile-back-btn'));

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'users' } });
  });

  it('offers a retry, not not-found, for any other load failure', () => {
    const refetch = vi.fn();
    mocks.useGetUser.mockReturnValue({
      isLoading: false,
      isFetching: false,
      error: new Error('boom'),
      data: undefined,
      refetch,
    });
    renderPage();

    expect(screen.getByTestId('user-profile-error')).toBeInTheDocument();
    expect(screen.queryByTestId('user-profile-not-found')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
