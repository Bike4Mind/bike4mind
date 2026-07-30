import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import OrganizationGroups from './OrganizationGroups';

const fetchOrganizationGroups = vi.fn();
const unassignGroupMember = vi.fn();

vi.mock('@client/app/utils/groupsAPICalls', () => ({
  fetchOrganizationGroups: (...args: unknown[]) => fetchOrganizationGroups(...args),
  assignGroupMember: vi.fn(),
  unassignGroupMember: (...args: unknown[]) => unassignGroupMember(...args),
  renameOrganizationGroup: vi.fn(),
  setOrganizationAdmins: vi.fn(),
}));

// `owner1` mirrors the real hook, which appends organization.userId to the member list even though
// the owner is never a users[] row. Without it here the picker filter would be a no-op in tests.
const members: IUserDocument[] = [
  { id: 'u1', name: 'Alice', email: 'alice@acme.test' },
  { id: 'u2', name: 'Bob', email: 'bob@acme.test' },
  { id: 'owner1', name: 'Olivia Owner', email: 'olivia@acme.test' },
] as unknown as IUserDocument[];

vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => ({ data: members }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderGroups = (org: WithId<IOrganizationDocument>, canSetAdmins: boolean) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  const result = render(wrapper(<OrganizationGroups organization={org} canSetAdmins={canSetAdmins} />));
  return { ...result, queryClient, wrapper };
};

// `users` carries the real member rows. The billing owner is deliberately NOT among them (the
// server never puts the owner in users[]), which is what the picker filter keys on.
const org = {
  id: 'org1',
  name: 'Acme',
  personal: false,
  adminUserIds: [],
  userId: 'owner1',
  users: [{ userId: 'u1' }, { userId: 'u2' }],
} as unknown as WithId<IOrganizationDocument>;

describe('OrganizationGroups', () => {
  beforeEach(() => {
    fetchOrganizationGroups.mockReset();
    unassignGroupMember.mockReset();
    fetchOrganizationGroups.mockResolvedValue([]);
    unassignGroupMember.mockResolvedValue(undefined);
  });

  it('renders group instances and resolves member ids to names', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: ['u1'], memberCount: 1 },
    ]);
    renderGroups(org, false);

    await waitFor(() => expect(screen.getByTestId('org-group-card-sales')).toBeInTheDocument());
    expect(screen.getByTestId('org-group-card-sales')).toHaveTextContent('Alice');
    expect(screen.getByTestId(`org-group-unassign-sales-u1`)).toBeInTheDocument();
  });

  it('shows an empty state when no groups are provisioned', async () => {
    renderGroups(org, false);
    await waitFor(() => expect(screen.getByTestId('org-groups-empty')).toBeInTheDocument());
  });

  it('hides the admins editor when the viewer may not set admins', async () => {
    renderGroups(org, false);
    await waitFor(() => expect(screen.getByTestId('org-groups-section')).toBeInTheDocument());
    expect(screen.queryByTestId('org-admins-card')).not.toBeInTheDocument();
  });

  it('shows the admins editor when the viewer may set admins', async () => {
    renderGroups(org, true);
    await waitFor(() => expect(screen.getByTestId('org-admins-card')).toBeInTheDocument());
  });

  it('unassigns a member through the API when the chip delete is clicked', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: ['u1'], memberCount: 1 },
    ]);
    renderGroups(org, false);

    const remove = await screen.findByTestId('org-group-unassign-sales-u1');
    fireEvent.click(remove);

    await waitFor(() => expect(unassignGroupMember).toHaveBeenCalledWith('org1', 'g1', 'u1'));
  });

  // A failed groups fetch must NOT render the empty state - telling an org that already has groups
  // to go ask an administrator for group types is worse than saying nothing.
  it('distinguishes a failed fetch from an empty result', async () => {
    fetchOrganizationGroups.mockRejectedValue(new Error('boom'));
    renderGroups(org, false);

    await waitFor(() => expect(screen.getByTestId('org-groups-error')).toBeInTheDocument());
    expect(screen.queryByTestId('org-groups-empty')).not.toBeInTheDocument();
  });

  // react-query reports isError for a failed REFETCH while still holding the last good data. The
  // rendered roster must survive that, or a transient blip strands the operator mid-task.
  it('keeps the rendered list when a refetch fails', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: ['u1'], memberCount: 1 },
    ]);
    const { queryClient } = renderGroups(org, false);
    await screen.findByTestId('org-group-card-sales');

    fetchOrganizationGroups.mockRejectedValue(new Error('transient'));
    await queryClient.refetchQueries({ queryKey: ['organizations', 'org1', 'groups'] });
    // Confirm the refetch really ran and then let React commit the resulting state. Without this
    // flush the assertions below run before any re-render and would pass even if the component
    // dropped the list - i.e. the test would be vacuous.
    await waitFor(() => expect(fetchOrganizationGroups).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId('org-group-card-sales')).toBeInTheDocument();
    expect(screen.queryByTestId('org-groups-error')).not.toBeInTheDocument();
  });

  // The billing owner is returned by the members hook but is never a users[] row, so the server
  // rejects assigning them. They must not be offered in either picker.
  it('excludes the billing owner from the assign and admins pickers', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: [], memberCount: 0 },
    ]);
    renderGroups(org, true);

    const assign = await screen.findByTestId('org-group-assign-input-sales');
    const input = assign.querySelector('input')!;
    // ArrowDown, not click: MUI Joy's Autocomplete opens the listbox on keyboard interaction, and
    // jsdom does not produce the pointer sequence a click would need.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));

    const options = screen.getAllByRole('option').map(o => o.textContent);
    // Alice/Bob are the positive control - without them an empty list would satisfy the negative
    // assertion vacuously.
    expect(options).toContain('Alice');
    expect(options).toContain('Bob');
    expect(options).not.toContain('Olivia Owner');
  });

  // The admins roster must follow the persisted set. PUT /admins is a full replace, so a stale
  // local selection would silently de-appoint whoever was added elsewhere.
  it('resyncs the admins selection when the persisted set changes', async () => {
    const { rerender, wrapper } = renderGroups({ ...org, adminUserIds: ['u1'] } as typeof org, true);
    await waitFor(() => expect(screen.getByTestId('org-admins-card')).toHaveTextContent('Alice'));

    rerender(
      wrapper(<OrganizationGroups organization={{ ...org, adminUserIds: ['u2'] } as typeof org} canSetAdmins />)
    );

    await waitFor(() => expect(screen.getByTestId('org-admins-card')).toHaveTextContent('Bob'));
    expect(screen.getByTestId('org-admins-card')).not.toHaveTextContent('Alice');
  });
});
