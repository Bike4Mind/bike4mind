import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import OrganizationGroups from './OrganizationGroups';

const fetchOrganizationGroups = vi.fn();

vi.mock('@client/app/utils/groupsAPICalls', () => ({
  fetchOrganizationGroups: (...args: unknown[]) => fetchOrganizationGroups(...args),
  assignGroupMember: vi.fn(),
  unassignGroupMember: vi.fn(),
  renameOrganizationGroup: vi.fn(),
  setOrganizationAdmins: vi.fn(),
}));

const members: IUserDocument[] = [
  { id: 'u1', name: 'Alice', email: 'alice@acme.test' },
  { id: 'u2', name: 'Bob', email: 'bob@acme.test' },
] as unknown as IUserDocument[];

vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => ({ data: members }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderGroups = (org: WithId<IOrganizationDocument>, canSetAdmins: boolean) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<OrganizationGroups organization={org} canSetAdmins={canSetAdmins} />, { wrapper: Wrapper });
};

const org = { id: 'org1', name: 'Acme', personal: false, adminUserIds: [] } as unknown as WithId<IOrganizationDocument>;

describe('OrganizationGroups', () => {
  beforeEach(() => {
    fetchOrganizationGroups.mockReset();
    fetchOrganizationGroups.mockResolvedValue([]);
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
});
