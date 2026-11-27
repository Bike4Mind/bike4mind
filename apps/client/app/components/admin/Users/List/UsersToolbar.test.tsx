import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileTestWrapper } from '../Profile/profileTestUtils';
import { DEFAULT_USERS_PARAMS } from '../usersTabSearch';
import { UsersToolbar } from './UsersToolbar';

const ROLE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const mocks = vi.hoisted(() => ({ get: vi.fn(), fetchClients: vi.fn(), canReadRoles: true }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'reviewer', isAdmin: mocks.canReadRoles } }),
}));
vi.mock('@client/app/utils/oauthClientAPICalls', () => ({
  OAUTH_CLIENTS_QUERY_KEY: 'admin-oauth-clients',
  fetchOAuthClients: mocks.fetchClients,
}));
vi.mock('@client/app/hooks/data/user', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/user')>()),
  useGetUserTags: () => ({ data: [] }),
}));
vi.mock('@client/app/utils/organizationAPICalls', () => ({ useGetAllOrganizations: () => ({ data: [] }) }));

const renderToolbar = () => {
  const onChange = vi.fn();
  render(
    <UsersToolbar
      params={{ ...DEFAULT_USERS_PARAMS, adminRole: ROLE_ID }}
      search=""
      onSearchChange={vi.fn()}
      onChange={onChange}
    />,
    { wrapper: ProfileTestWrapper }
  );
  return onChange;
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.fetchClients.mockReset().mockResolvedValue([]);
  mocks.canReadRoles = true;
});

describe('UsersToolbar selected admin role knowledge', () => {
  it('keeps a failed role lookup unknown and still lets the filter be removed', async () => {
    mocks.get.mockRejectedValue(new Error('network'));
    const onChange = renderToolbar();
    expect(await screen.findByText('Role unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('admin-filter-adminRole')).not.toHaveTextContent('Deleted role');
    fireEvent.click(screen.getByTestId('admin-filter-clear-adminRole-btn'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ adminRole: undefined }));
  });

  it('does not call an unreadable role deleted when the query is disabled', () => {
    mocks.canReadRoles = false;
    renderToolbar();
    expect(screen.getByTestId('admin-filter-adminRole')).toHaveTextContent('Role unavailable');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('keeps a pending role lookup distinct from a successful empty result', () => {
    mocks.get.mockReturnValue(new Promise<never>(() => {}));
    renderToolbar();
    expect(screen.getByTestId('admin-filter-adminRole')).toHaveTextContent('...');
    expect(screen.getByTestId('admin-filter-adminRole')).not.toHaveTextContent('Deleted role');
  });

  it('names a role after a successful read', async () => {
    mocks.get.mockResolvedValue({ data: { roles: [{ id: ROLE_ID, name: 'Support' }] } });
    renderToolbar();
    expect(await screen.findByText('Support')).toBeInTheDocument();
  });

  it('uses deleted only after a successful list omits the selected role', async () => {
    mocks.get.mockResolvedValue({ data: { roles: [] } });
    renderToolbar();
    expect(await screen.findByText('Deleted role')).toBeInTheDocument();
  });
});

describe('UsersToolbar signup client filter', () => {
  const CLIENT_ID = 'b4m_my_app_0011aabb';
  const renderWithClient = () => {
    mocks.get.mockResolvedValue({ data: { roles: [] } });
    const onChange = vi.fn();
    render(
      <UsersToolbar
        params={{ ...DEFAULT_USERS_PARAMS, signupClient: CLIENT_ID }}
        search=""
        onSearchChange={vi.fn()}
        onChange={onChange}
      />,
      { wrapper: ProfileTestWrapper }
    );
    return onChange;
  };

  it('names the client once the list loads', async () => {
    mocks.fetchClients.mockResolvedValue([{ clientId: CLIENT_ID, name: 'My App' }]);
    renderWithClient();
    expect(await screen.findByText('My App')).toBeInTheDocument();
  });

  it('shows the raw id for a client that no longer exists and still lets the filter be removed', async () => {
    const onChange = renderWithClient();
    await waitFor(() => expect(screen.getByTestId('admin-filter-signupClient')).toHaveTextContent(CLIENT_ID));
    fireEvent.click(screen.getByTestId('admin-filter-clear-signupClient-btn'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ signupClient: undefined }));
  });

  it('shows a placeholder while the client list is loading', () => {
    mocks.fetchClients.mockReturnValue(new Promise<never>(() => {}));
    renderWithClient();
    expect(screen.getByTestId('admin-filter-signupClient')).toHaveTextContent('...');
  });
});
