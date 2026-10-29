import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import UserSelector from './UserSelector';

const mockUseGetUsers = vi.fn();
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: (params: unknown) => mockUseGetUsers(params),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeUser = (overrides: Partial<AdminUserListItem>): AdminUserListItem =>
  ({ id: 'u1', name: 'Ada Lovelace', username: 'ada', email: 'ada@example.com', ...overrides }) as AdminUserListItem;

const ADA = makeUser({});
const GRACE = makeUser({ id: 'u2', name: 'Grace Hopper', username: 'grace', email: 'grace@example.com' });

const setUsers = (users: AdminUserListItem[] | undefined, isLoading = false) =>
  mockUseGetUsers.mockReturnValue({ data: users ? { users } : undefined, isLoading });

const input = (): HTMLInputElement =>
  screen.getByTestId('user-selector-autocomplete').querySelector('input') as HTMLInputElement;

const renderSelector = (props: Partial<React.ComponentProps<typeof UserSelector>> = {}) => {
  const onChange = vi.fn();
  const ui = (p: Partial<React.ComponentProps<typeof UserSelector>>) => (
    <TestWrapper>
      <UserSelector label="User" value={null} onChange={onChange} {...p} />
    </TestWrapper>
  );
  const utils = render(ui(props));
  return { onChange, rerenderWith: (p: Partial<React.ComponentProps<typeof UserSelector>>) => utils.rerender(ui(p)) };
};

describe('UserSelector', () => {
  beforeEach(() => {
    mockUseGetUsers.mockReset();
    setUsers([ADA, GRACE]);
  });

  it('renders the label and the default placeholder', () => {
    renderSelector();
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(input().placeholder).toBe('Search for a user...');
    expect(input()).not.toBeRequired();
    expect(screen.queryByText('Pick someone')).not.toBeInTheDocument();
  });

  it('honours custom placeholder, required and helper text', () => {
    renderSelector({ placeholder: 'Find', required: true, helperText: 'Pick someone' });
    expect(input().placeholder).toBe('Find');
    expect(input()).toBeRequired();
    expect(screen.getByText('Pick someone')).toBeInTheDocument();
  });

  it('queries users sorted by name with the initial empty search', () => {
    renderSelector();
    expect(mockUseGetUsers).toHaveBeenCalledWith({
      search: '',
      page: 1,
      limit: 20,
      sortField: 'name',
      sortOrder: 'asc',
    });
  });

  it('shows a spinner while loading and tolerates missing data', () => {
    setUsers(undefined, true);
    renderSelector();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('lists options and reports the picked user id', () => {
    const { onChange } = renderSelector();
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(screen.getByTestId('user-option-u1')).toHaveTextContent('@ada');
    fireEvent.click(screen.getByTestId('user-option-u2'));
    expect(onChange).toHaveBeenCalledWith('u2');
  });

  it('excludes the given user from the options', () => {
    renderSelector({ excludeUserId: 'u1' });
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(screen.queryByTestId('user-option-u1')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-option-u2')).toBeInTheDocument();
  });

  it('reports null when the selection is cleared', async () => {
    const { onChange } = renderSelector({ value: 'u1' });
    await waitFor(() => expect(input().value).toBe('Ada Lovelace'));
    fireEvent.click(screen.getByTitle('Clear'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows the selected user from the current results', async () => {
    renderSelector({ value: 'u1' });
    await waitFor(() => expect(input().value).toBe('Ada Lovelace'));
  });

  it('keeps the selected user from cache once results no longer contain it', async () => {
    const { rerenderWith } = renderSelector({ value: 'u1' });
    await waitFor(() => expect(input().value).toBe('Ada Lovelace'));
    setUsers([GRACE]);
    rerenderWith({ value: 'u1' });
    await waitFor(() => expect(input().value).toBe('Ada Lovelace'));
  });

  it('shows nothing selected when the value is unknown and uncached', () => {
    renderSelector({ value: 'missing' });
    expect(input().value).toBe('');
  });

  it('labels a selected user by username, email or a fallback when the name is empty', async () => {
    const byUsername = makeUser({ id: 'a', name: '', username: 'only-username', email: 'a@example.com' });
    const byEmail = makeUser({ id: 'b', name: '', username: '', email: 'only@example.com' });
    const unknown = makeUser({ id: 'c', name: '', username: '', email: '' });
    setUsers([byUsername, byEmail, unknown]);
    const { rerenderWith } = renderSelector({ value: 'a' });
    await waitFor(() => expect(input().value).toBe('only-username'));
    rerenderWith({ value: 'b' });
    await waitFor(() => expect(input().value).toBe('only@example.com'));
    rerenderWith({ value: 'c' });
    await waitFor(() => expect(input().value).toBe('Unknown User'));
  });

  it('updates the search as the user types', async () => {
    renderSelector();
    await userEvent.type(input(), 'gra');
    expect(input().value).toBe('gra');
    await waitFor(() =>
      expect(mockUseGetUsers).toHaveBeenLastCalledWith({
        search: 'gra',
        page: 1,
        limit: 20,
        sortField: 'name',
        sortOrder: 'asc',
      })
    );
  });
});
