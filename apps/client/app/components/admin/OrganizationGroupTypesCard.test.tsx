import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  // Both directions matter. Asserting only the disabled state is satisfied by a button that is
  // permanently disabled - i.e. a regression where an admin can never grant a type at all would
  // be invisible. The enabled case is the positive control.
  it('disables the save button until the selection changes, and enables it after', async () => {
    renderCard(makeOrg({ allowedGroupTypes: [] }));
    const save = screen.getByTestId('org-group-types-save-btn');
    expect(save).toBeDisabled();

    const input = screen.getByTestId('org-group-types-input').querySelector('input')!;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('option')[0]);

    await waitFor(() => expect(screen.getByTestId('org-group-types-save-btn')).not.toBeDisabled());
  });

  it('submits the selected group types', async () => {
    setOrganizationGroupTypes.mockResolvedValue({ added: ['sales'], removed: [] });
    renderCard(makeOrg({ allowedGroupTypes: [] }));

    const input = screen.getByTestId('org-group-types-input').querySelector('input')!;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('option')[0]);
    fireEvent.click(screen.getByTestId('org-group-types-save-btn'));

    await waitFor(() => expect(setOrganizationGroupTypes).toHaveBeenCalledWith('org1', [expect.any(String)]));
  });
});
