import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

const { useSearchOrganizationsMock, idleMutation } = vi.hoisted(() => ({
  useSearchOrganizationsMock: vi.fn(),
  idleMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: useSearchOrganizationsMock,
  useCreateOrganization: idleMutation,
}));
vi.mock('@client/app/hooks/data/adminOrganizations', () => ({
  useAdjustOrgSeats: idleMutation,
  useAdminOrgGrants: () => ({ data: [] }),
  useConvertOrgToPaid: idleMutation,
  useGrantOrganization: idleMutation,
  useReconcileOrgSeats: idleMutation,
  useRevokeOrganization: idleMutation,
  useTopUpOrganization: idleMutation,
}));
vi.mock('@client/app/hooks/data/user', () => ({ useGetPendingOrganizationUsers: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useTeamSeatLimits: () => ({ maxSeats: 100 }) }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/Member', () => ({ default: () => null }));
vi.mock('@client/app/components/admin/Subscriptions/components/PaginationControls', () => ({ default: () => null }));
vi.mock('./OrganizationProfileModal', () => ({ default: () => null }));

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import OrganizationsTab from './OrganizationsTab';
import { DEFAULT_ORGANIZATIONS_PARAMS } from './organizationsTabSearch';
import { useOrganizationsTab } from './useOrganizationsTabParams';
import { AdminCommandPalette } from './shared/AdminCommandPalette';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const appTheme = extendTheme({ ...getThemeConfig() });

const organization = (id: string, name: string) => ({
  id,
  name,
  personal: false,
  users: [],
  userId: 'owner',
  currentCredits: 0,
});

const mockList = (overrides: Record<string, unknown> = {}) =>
  useSearchOrganizationsMock.mockReturnValue({
    data: {
      data: [organization(ORG_A, 'Alpha Org'), organization(ORG_B, 'Beta Org')],
      totalOrganizations: 20,
      totalPages: 2,
    },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <OrganizationsTab />
    </CssVarsProvider>
  );

beforeEach(() => {
  localStorage.removeItem('admin-organizations-tab-01');
  useSearchOrganizationsMock.mockReset();
  mockList();
  act(() => {
    useOrganizationsTab.setState({ params: { ...DEFAULT_ORGANIZATIONS_PARAMS } });
    fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 1 });
  });
});

describe('OrganizationsTab', () => {
  it('focuses the real Organizations search with /', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <div data-admin-surface>
          <AdminCommandPalette />
          <OrganizationsTab />
        </div>
      </CssVarsProvider>
    );
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByTestId('admin-organizations-search-input')).toHaveFocus();
  });

  it('replace-navigates a page past the end back to the last page in a single navigate', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 9 }));
    renderTab();

    expect(fakeAdminRouter.search).toMatchObject({ tab: 'organizations', orgsPage: 2 });
    expect(fakeAdminRouter.navigate).toHaveBeenCalledTimes(1);
    expect(fakeAdminRouter.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });

  it('puts the row organization id in the URL when its Edit button is clicked', () => {
    renderTab();

    const row = screen.getByText('Beta Org').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /edit/i }));

    expect(fakeAdminRouter.search).toMatchObject({ tab: 'organizations', orgId: ORG_B });
  });
});
