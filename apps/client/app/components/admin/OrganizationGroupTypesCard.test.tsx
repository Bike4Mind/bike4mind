import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, WithId } from '@bike4mind/common';
import OrganizationGroupTypesCard from './OrganizationGroupTypesCard';

const fetchOrganizationGroups = vi.fn();
const setOrganizationGroupTypes = vi.fn();

vi.mock('@client/app/utils/groupsAPICalls', () => ({
  fetchOrganizationGroups: (...args: unknown[]) => fetchOrganizationGroups(...args),
  setOrganizationGroupTypes: (...args: unknown[]) => setOrganizationGroupTypes(...args),
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
  return render(<OrganizationGroupTypesCard org={org} />, { wrapper: Wrapper });
};

const makeOrg = (overrides: Partial<IOrganizationDocument>): WithId<IOrganizationDocument> =>
  ({ id: 'org1', name: 'Acme', personal: false, allowedGroupTypes: [], ...overrides }) as WithId<IOrganizationDocument>;

describe('OrganizationGroupTypesCard', () => {
  beforeEach(() => {
    fetchOrganizationGroups.mockReset();
    setOrganizationGroupTypes.mockReset();
    fetchOrganizationGroups.mockResolvedValue([]);
  });

  it('shows a personal-org notice and no picker for personal organizations', () => {
    renderCard(makeOrg({ personal: true }));
    expect(screen.getByText(/Personal organizations cannot be granted group types/i)).toBeInTheDocument();
    expect(screen.queryByTestId('org-group-types-input')).not.toBeInTheDocument();
    expect(fetchOrganizationGroups).not.toHaveBeenCalled();
  });

  it('renders the picker and lists provisioned groups with member counts', async () => {
    fetchOrganizationGroups.mockResolvedValue([
      { id: 'g1', name: 'Sales', type: 'sales', organizationId: 'org1', memberIds: ['u1', 'u2'], memberCount: 2 },
    ]);
    renderCard(makeOrg({ allowedGroupTypes: ['sales'] }));

    expect(screen.getByTestId('org-group-types-input')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('org-group-types-provisioned-sales')).toHaveTextContent('Sales (2)'));
  });

  it('disables the save button until the selection changes', () => {
    renderCard(makeOrg({ allowedGroupTypes: [] }));
    expect(screen.getByTestId('org-group-types-save-btn')).toBeDisabled();
  });
});
