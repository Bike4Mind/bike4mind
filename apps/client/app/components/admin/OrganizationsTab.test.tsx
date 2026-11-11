import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

const { useSearchOrganizationsMock, useAdminOrgGrantsMock, useAdjustOrgSeatsMock, idleMutation } = vi.hoisted(() => ({
  useSearchOrganizationsMock: vi.fn(),
  useAdminOrgGrantsMock: vi.fn(),
  useAdjustOrgSeatsMock: vi.fn(),
  idleMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: useSearchOrganizationsMock,
  useCreateOrganization: idleMutation,
}));
vi.mock('@client/app/hooks/data/adminOrganizations', () => ({
  useAdjustOrgSeats: useAdjustOrgSeatsMock,
  useAdminOrgGrants: useAdminOrgGrantsMock,
  useConvertOrgToPaid: idleMutation,
  useGrantOrganization: idleMutation,
  useRevokeOrganization: idleMutation,
  useTopUpOrganization: idleMutation,
}));
vi.mock('@client/app/hooks/data/user', () => ({ useGetPendingOrganizationUsers: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useTeamSeatLimits: () => ({ maxSeats: 100 }) }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/Member', () => ({ default: () => null }));
vi.mock('./OrganizationProfileModal', () => ({ default: () => null }));

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import OrganizationsTab from './OrganizationsTab';
import { DEFAULT_ORGANIZATIONS_PARAMS } from './organizationsTabSearch';
import { useOrganizationsTab } from './useOrganizationsTabParams';
import { AdminCommandPalette } from './shared/AdminCommandPalette';
import { useSubscriptionsTab } from './Subscriptions/useSubscriptionsTabParams';
import { CLEARED_FILTER_PARAMS } from './Subscriptions/subscriptionsTabSearch';
import { ADMIN_SUBSCRIPTIONS_TAB_SLUG } from './Subscriptions/Detail/subscriptionDetailModel';
import { UndoToastProvider } from './shared/UndoToast';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const appTheme = extendTheme({ ...getThemeConfig() });

const organization = (id: string, name: string) => ({
  id,
  name,
  personal: false,
  users: [],
  userId: 'owner',
  seats: 4,
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
      <UndoToastProvider>
        <OrganizationsTab />
      </UndoToastProvider>
    </CssVarsProvider>
  );

beforeEach(() => {
  localStorage.removeItem('admin-organizations-tab-01');
  useSearchOrganizationsMock.mockReset();
  mockList();
  useAdminOrgGrantsMock.mockReturnValue({ data: [] });
  useAdjustOrgSeatsMock.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({ seats: 6 }), isPending: false });
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
          <UndoToastProvider>
            <OrganizationsTab />
          </UndoToastProvider>
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

    fireEvent.click(screen.getByTestId(`admin-table-row-${ORG_B}`));

    expect(fakeAdminRouter.search).toMatchObject({ tab: 'organizations', orgId: ORG_B });
  });

  it("offers View subscription only on a granted org and opens the grant's subscription record", () => {
    const GRANT_ID = 'c'.repeat(24);
    useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: GRANT_ID, ownerId: ORG_A }] });
    // The fake router models only the /admin search; the detail route is a path change.
    fakeAdminRouter.navigate.mockImplementationOnce(() => undefined);
    renderTab();

    fireEvent.click(screen.getByTestId(`org-actions-${ORG_B}`));
    expect(screen.queryByTestId(`view-subscription-${ORG_B}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
    fireEvent.click(screen.getByTestId(`view-subscription-${ORG_A}`));

    expect(fakeAdminRouter.navigate).toHaveBeenCalledWith({
      to: '/admin/subscriptions/$subscriptionId',
      params: { subscriptionId: GRANT_ID },
    });
  });

  it('offers Sync from Stripe on a paid org and opens the subscriptions list narrowed to its customer', () => {
    const GRANT_ID = 'c'.repeat(24);
    useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: GRANT_ID, ownerId: ORG_B }] });
    mockList({
      data: {
        data: [
          { ...organization(ORG_A, 'Alpha Org'), stripeCustomerId: 'cus_alpha' },
          organization(ORG_B, 'Beta Org'),
          { ...organization('d'.repeat(24), 'Solo Org'), personal: true },
        ],
        totalOrganizations: 3,
        totalPages: 1,
      },
    });
    renderTab();

    fireEvent.click(screen.getByTestId(`org-actions-${ORG_B}`));
    expect(screen.queryByTestId(`sync-from-stripe-${ORG_B}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`org-actions-${'d'.repeat(24)}`));
    expect(screen.queryByTestId(`sync-from-stripe-${'d'.repeat(24)}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
    fireEvent.click(screen.getByTestId(`sync-from-stripe-${ORG_A}`));

    expect(useSubscriptionsTab.getState().params).toMatchObject({ ...CLEARED_FILTER_PARAMS, search: 'cus_alpha' });
    expect(fakeAdminRouter.search).toMatchObject({ tab: ADMIN_SUBSCRIPTIONS_TAB_SLUG });
  });

  it('shows skeletons while loading, then an actionable empty state', () => {
    mockList({ data: undefined, isLoading: true, isFetching: true });
    const { rerender } = renderTab();
    expect(screen.getAllByTestId('admin-table-skeleton-row')).toHaveLength(8);

    mockList({ data: { data: [], totalOrganizations: 0, totalPages: 0 } });
    rerender(
      <CssVarsProvider theme={appTheme}>
        <UndoToastProvider>
          <OrganizationsTab />
        </UndoToastProvider>
      </CssVarsProvider>
    );
    expect(screen.getByText('No organizations yet')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-empty-action-btn'));
    expect(screen.getByTestId('org-create-dialog')).toBeInTheDocument();
  });

  it('shows a retry action instead of stale rows after an error', () => {
    const refetch = vi.fn();
    mockList({ isError: true, refetch });
    renderTab();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Organizations could not be loaded.');
    expect(screen.queryByText('Alpha Org')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('clears a type filter when no organizations match', () => {
    mockList({ data: { data: [], totalOrganizations: 0, totalPages: 0 } });
    renderTab();
    fireEvent.click(screen.getByTestId('admin-filter-org-type'));
    fireEvent.click(screen.getByTestId('admin-filter-org-type-true'));
    expect(screen.getByText('No organizations match these filters')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-empty-action-btn'));
    expect(useOrganizationsTab.getState().params.personal).toBeUndefined();
  });

  it('keeps server sort and direction choices available', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-filter-org-sort'));
    fireEvent.click(screen.getByTestId('admin-filter-org-sort-createdAt'));
    fireEvent.click(screen.getByTestId('admin-filter-org-direction'));
    fireEvent.click(screen.getByTestId('admin-filter-org-direction-desc'));

    expect(useOrganizationsTab.getState().params).toMatchObject({ sortBy: 'createdAt', sortDirection: 'desc' });
    expect(fakeAdminRouter.search).toMatchObject({ orgsSort: 'createdAt', orgsOrder: 'desc' });
  });

  it('keeps the shared table page size in the URL', () => {
    renderTab();
    fireEvent.mouseDown(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-25'));

    expect(useOrganizationsTab.getState().params.limit).toBe(25);
    expect(fakeAdminRouter.search).toMatchObject({ orgsLimit: 25, orgsPage: 1 });
  });

  it('changes granted seats with a reason and offers an audited undo', async () => {
    useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: 'c'.repeat(24), ownerId: ORG_A }] });
    const mutateAsync = vi.fn().mockResolvedValue({ seats: 6 });
    useAdjustOrgSeatsMock.mockReturnValue({ mutateAsync, isPending: false });
    renderTab();
    fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
    fireEvent.click(screen.getByTestId(`adjust-seats-${ORG_A}`));
    fireEvent.change(screen.getByTestId('seats-native-input'), { target: { value: '6' } });
    expect(screen.getByTestId('org-seats-preview-after')).toHaveTextContent('6');
    fireEvent.click(screen.getByTestId('seats-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('seats-submit'));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ organizationId: ORG_A, seats: 6, reason: 'Customer request' })
    );
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenLastCalledWith({
        organizationId: ORG_A,
        seats: 4,
        reason: 'Undo: Customer request',
      })
    );
  });
});
