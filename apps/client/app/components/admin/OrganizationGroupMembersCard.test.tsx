import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import OrganizationGroupMembersCard from './OrganizationGroupMembersCard';

const fetchOrganizationGroups = vi.fn();
const assignGroupMember = vi.fn();

vi.mock('@client/app/utils/groupsAPICalls', () => ({
  fetchOrganizationGroups: (...args: unknown[]) => fetchOrganizationGroups(...args),
  assignGroupMember: (...args: unknown[]) => assignGroupMember(...args),
  unassignGroupMember: vi.fn(),
  renameOrganizationGroup: vi.fn(),
}));

// Mirrors the real hook: it appends organization.userId (the billing owner) even though the owner
// is never a users[] row, so the card must filter them out of the assign picker.
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
const renderCard = (org: WithId<IOrganizationDocument>) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<OrganizationGroupMembersCard org={org} />, { wrapper: Wrapper });
};

const org = {
  id: 'org1',
  name: 'Acme',
  personal: false,
  userId: 'owner1',
  users: [{ userId: 'u1' }, { userId: 'u2' }],
} as unknown as WithId<IOrganizationDocument>;

describe('OrganizationGroupMembersCard', () => {
  beforeEach(() => {
    fetchOrganizationGroups.mockReset();
    assignGroupMember.mockReset();
    fetchOrganizationGroups.mockResolvedValue([]);
    assignGroupMember.mockResolvedValue(undefined);
  });

  it('renders nothing and fetches nothing for a personal org', () => {
    renderCard({ ...org, personal: true } as typeof org);
    expect(screen.queryByTestId('org-group-members-card')).not.toBeInTheDocument();
    expect(fetchOrganizationGroups).not.toHaveBeenCalled();
  });

  it('points the admin at the Group Types card above instead of telling them to contact an admin', async () => {
    // The shared list's default empty-state copy is customer-facing ("Contact your Bike4Mind
    // administrator"). In this panel the reader IS that administrator, so the card overrides it.
    // This is the first-visit state for any org with no granted types.
    fetchOrganizationGroups.mockResolvedValue([]);
    renderCard(org);

    const empty = await screen.findByTestId('org-groups-empty');
    expect(empty).toHaveTextContent('Grant one in the Group Types card above');
    expect(empty).not.toHaveTextContent('Contact your Bike4Mind administrator');
  });

  it('renders the shared groups list with a member-assignment picker', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: ['u1'], memberCount: 1 },
    ]);
    renderCard(org);

    expect(screen.getByTestId('org-group-members-card')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('org-group-card-sales')).toBeInTheDocument());
    expect(screen.getByTestId('org-group-card-sales')).toHaveTextContent('Alice');
    expect(screen.getByTestId('org-group-assign-input-sales')).toBeInTheDocument();
  });

  it('assigns a member through the API and excludes the billing owner from the picker', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: [], memberCount: 0 },
    ]);
    renderCard(org);

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

    fireEvent.click(screen.getByText('Alice'));
    await waitFor(() => expect(assignGroupMember).toHaveBeenCalledWith('org1', 'g1', 'u1'));
  });

  it('surfaces the billing owner as a non-removable implicit chip on a group they are granted', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: [], memberCount: 0 },
    ]);
    renderCard({ ...org, allowedGroupTypes: ['sales'] } as typeof org);

    const card = await screen.findByTestId('org-group-card-sales');
    const ownerChip = await screen.findByTestId('org-group-owner-sales');
    expect(ownerChip).toHaveTextContent('Olivia Owner');
    expect(ownerChip).toHaveTextContent('implicit');
    // Not removable: unlike an assigned-member chip, there is no ChipDelete/unassign control on it.
    expect(ownerChip.querySelector('[data-testid^="org-group-unassign-"]')).not.toBeInTheDocument();
    // "No members assigned" still shows too - the owner's access is implicit, not an explicit row.
    expect(card).toHaveTextContent('No members assigned.');
  });

  it('does not surface the owner chip for a group type the org no longer has granted', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: [], memberCount: 0 },
    ]);
    // allowedGroupTypes omits 'sales' - e.g. the type was revoked after the group was provisioned.
    renderCard({ ...org, allowedGroupTypes: [] } as typeof org);

    await screen.findByTestId('org-group-card-sales');
    expect(screen.queryByTestId('org-group-owner-sales')).not.toBeInTheDocument();
  });
});
