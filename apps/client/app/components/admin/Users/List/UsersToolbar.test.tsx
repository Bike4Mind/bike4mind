import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileTestWrapper } from '../Profile/profileTestUtils';
import { DEFAULT_USERS_PARAMS } from '../usersTabSearch';
import { UsersToolbar } from './UsersToolbar';

const ROLE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const mocks = vi.hoisted(() => ({ get: vi.fn(), canReadRoles: true }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'reviewer', isAdmin: mocks.canReadRoles } }),
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
