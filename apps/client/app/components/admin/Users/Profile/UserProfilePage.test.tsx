import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ReactNode } from 'react';
import { UserProfilePage } from './UserProfilePage';

type BlockerArgs = { current: { pathname: string }; next: { pathname: string } };
type BlockerOptions = { shouldBlockFn: (args: BlockerArgs) => boolean; enableBeforeUnload: () => boolean };

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useGetUser: vi.fn(),
  blockerOptions: undefined as BlockerOptions | undefined,
  blocker: { status: 'idle' } as { status: string; proceed?: () => void; reset?: () => void },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useBlocker: (options: BlockerOptions) => {
    mocks.blockerOptions = options;
    return mocks.blocker;
  },
}));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUser: mocks.useGetUser }));
vi.mock('../../AdminProfileModal', () => ({ default: () => null }));
vi.mock('../ComplianceModal', () => ({ default: () => null }));
// The card is covered by FullUsersView.test.tsx; this stub exposes the props the page wires.
vi.mock('../Views/FullUsersView', () => ({
  FullUsersView: (props: {
    variant: string;
    tab: string;
    onUnsavedFieldsChange: (keys: string[]) => void;
    onUserDeleted: () => void;
  }) => (
    <div data-testid="stub-full-users-view" data-variant={props.variant} data-tab={props.tab}>
      <button data-testid="stub-stage-edit" onClick={() => props.onUnsavedFieldsChange(['tags'])} />
      <button data-testid="stub-delete" onClick={props.onUserDeleted} />
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

const renderPage = (userId = USER_ID) =>
  render(<UserProfilePage userId={userId} tab="activity" onTabChange={vi.fn()} />, { wrapper: TestWrapper });

const leaving = { current: { pathname: `/admin/users/${USER_ID}` }, next: { pathname: '/admin' } };
const switchingTab = {
  current: { pathname: `/admin/users/${USER_ID}` },
  next: { pathname: `/admin/users/${USER_ID}` },
};

describe('UserProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.blocker = { status: 'idle' };
    mocks.useGetUser.mockReturnValue(loadedUser());
  });

  it('renders the user as the page variant on the tab from the URL', () => {
    renderPage();

    expect(mocks.useGetUser).toHaveBeenCalledWith(USER_ID);
    const view = screen.getByTestId('stub-full-users-view');
    expect(view).toHaveAttribute('data-variant', 'page');
    expect(view).toHaveAttribute('data-tab', 'activity');
  });

  it('shows not-found for a malformed id without asking the API', () => {
    mocks.useGetUser.mockReturnValue({ isLoading: false, isFetching: false, error: null, data: undefined });
    renderPage('../organizations');

    expect(mocks.useGetUser).toHaveBeenCalledWith(null);
    expect(screen.getByTestId('user-profile-not-found')).toBeInTheDocument();
  });

  it('shows not-found when the API says the user does not exist', () => {
    mocks.useGetUser.mockReturnValue({ isLoading: false, isFetching: false, error: notFoundError(), data: undefined });
    renderPage();

    expect(screen.getByTestId('user-profile-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-full-users-view')).not.toBeInTheDocument();
  });

  it('offers a retry, not not-found, for any other load failure', () => {
    mocks.useGetUser.mockReturnValue({
      isLoading: false,
      isFetching: false,
      error: new Error('boom'),
      data: undefined,
      refetch: vi.fn(),
    });
    renderPage();

    expect(screen.getByTestId('user-profile-error')).toBeInTheDocument();
    expect(screen.queryByTestId('user-profile-not-found')).not.toBeInTheDocument();
  });

  it('guards leaving the page only while edits are unsaved, and never a tab switch', () => {
    renderPage();
    expect(mocks.blockerOptions?.shouldBlockFn(leaving)).toBe(false);
    expect(mocks.blockerOptions?.enableBeforeUnload()).toBe(false);

    act(() => fireEvent.click(screen.getByTestId('stub-stage-edit')));

    expect(mocks.blockerOptions?.shouldBlockFn(leaving)).toBe(true);
    expect(mocks.blockerOptions?.shouldBlockFn(switchingTab)).toBe(false);
    expect(mocks.blockerOptions?.enableBeforeUnload()).toBe(true);
  });

  it('names the unsaved fields when a navigation is blocked, and leaves only on discard', () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    mocks.blocker = { status: 'blocked', proceed, reset };
    renderPage();
    act(() => fireEvent.click(screen.getByTestId('stub-stage-edit')));

    expect(screen.getByTestId('user-profile-leave-modal')).toHaveTextContent('Tags and product access');
    fireEvent.click(screen.getByTestId('user-profile-leave-cancel-btn'));
    expect(reset).toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('user-profile-leave-confirm-btn'));
    expect(proceed).toHaveBeenCalled();
  });

  it('goes back to the Users list once the user is deleted, without asking about staged edits', () => {
    renderPage();
    act(() => fireEvent.click(screen.getByTestId('stub-stage-edit')));

    fireEvent.click(screen.getByTestId('stub-delete'));

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'users' } });
    expect(mocks.blockerOptions?.shouldBlockFn(leaving)).toBe(false);
  });
});
